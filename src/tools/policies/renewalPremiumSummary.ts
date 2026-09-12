import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { runReadOnlyQuery } from "../../db.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { sendMailWithAttachment } from "../../utils/mailer.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { fetchPolicyLobInfo } from "../../utils/policyLineOfBusiness.js"
import type { OtherPolicyRow, PremiumRow } from "../../utils/renewalPremiumSummaryWorkbook.js"
import { buildRenewalPremiumSummaryWorkbook } from "../../utils/renewalPremiumSummaryWorkbook.js"

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"

// Same "genuinely in force today" filter commercial_renewal_summary/policy_query/upcoming_renewals
// all standardize on. Unlike commercial_renewal_summary, this always pulls EVERY current commercial
// policy on the account (not just ones matching a polno) — the whole point of this tool is splitting
// that set into "renewing soon" (main table) vs. "everything else" (the account's other current
// policies), per Patrick's own spec (see this file's header comment below).
const ACCOUNT_POLICIES_QUERY = `
  SELECT p.polid, p.polno, p.polexpdate, p.custid, p.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    csr.email AS csr_email,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS csr_name,
    p.fulltermpremium
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  LEFT JOIN afw_company co ON co.cocode = p.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = p.csrcode
  WHERE p.typeofbus = 2
    AND p.renewalrptflag = 'A'
    AND p.polsubtype != 'S'
    AND p.status != 'D'
    AND p.poleffdate <= now()
    AND p.polexpdate >= now()
    AND p.custid = $1
  ORDER BY p.polexpdate
  LIMIT 30
`

type AccountPolicy = {
  polid: string
  polno: string
  polexpdate: string
  custid: string
  csrcode: string | null
  customer_name: string | null
  carrier_name: string | null
  csr_email: string | null
  csr_name: string | null
  fulltermpremium: string | number | null
}

// Patrick's template (Commercial_Renewal_Template_Reformatted.xlsx, emailed 2026-09-10) pre-fills a
// market-trend range per line of business. Only applied to a MONOLINE policy whose single line of
// business matches one of these 8 codes — a Package policy blending several lines has no single
// applicable range, so that column is left blank for it rather than guessing which range applies.
const TRENDING_RANGES: Record<string, string> = {
  CGL: "+1% to +9%",
  PROP: "flat to +10%",
  AUTOB: "+5% to +15%",
  CUMBR: "+10% to +20%",
  WORK: "-2% to +2%",
  EPLI: "0 to +5%",
  INMRC: "0 to +15%",
  DO: "0 to +5%"
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : ""
}

// AMS360's synced money-shaped fields are inconsistently text vs. numeric (see numericMoney's own
// comment in commercialRenewalSummary.ts for the same caveat) — this is that same cleanup, but
// returning a real number (for an Excel SUM formula / numFmt) instead of a formatted display string.
function toNumber(raw: string | number | null | undefined): number | null {
  if(raw === null || raw === undefined || raw === "") return null
  if(typeof raw === "number") return Number.isFinite(raw) ? raw : null

  const cleaned = raw.replace(/[$,]/g, "").trim()
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

export function registerRenewalPremiumSummaryTool(server: McpServer) {
  server.registerTool(
    "renewal_premium_summary",
    {
      // Client-requested (Patrick, roadmap item #1, 9/10 — see Commercial_Renewal_Template_Reformatted.xlsx
      // he emailed) as a per-LINE-OF-BUSINESS premium breakdown ("Auto is going up x amount, Umbrella is
      // going up y amount, not just the entire package is going up x%"). Investigated before building
      // (2026-09-11, real data): summing afw_cprem.premium by line of business is NOT trustworthy for
      // exactly the policies where it would matter — commercial Package policies. Confirmed on a real
      // multi-LOB Package policy that afw_cprem's per-line premium sums to only 62% of the policy's
      // actual afw_basicpolinfo.fulltermpremium (AMS360 itself bills these as one blended package rate —
      // afw_policytranpremium.lineofbus reads 'CPKGE', never split by line — afw_cprem's line-level
      // premium is a secondary/illustrative allocation that doesn't reconcile to what's actually charged).
      // Book-wide, 51% of current commercial policies also have no usable afw_cprem premium at all. Per
      // Patrick's own explicit fallback ("if we can only do it by policy number that is fine we can work
      // with that"), this tool reports premium PER POLICY instead — one row per policy, "Coverage" names
      // what lines of business are bundled on it (from afw_lineofbusiness) without claiming to split its
      // premium among them.
      description: "Builds Patrick's \"Commercial Renewal Premium Overview\" .xlsx for a commercial account — one row per policy renewing within the given window (premium, carrier, which lines of business are bundled on it), a TOTAL PREMIUM row, and a second table of the account's other current commercial policies (not in the window) with their expiration dates, for later quote notes. Always account-scoped (custid, not polno) since the whole point is separating \"renewing soon\" from \"everything else on the account.\" IMPORTANT: premium is reported per POLICY, not split by line of business, even though the source template has a line-of-business-shaped layout — see this tool's full description in the codebase for why (afw_cprem's line-level premium doesn't reconcile to actual billed premium on multi-LOB Package policies; AMS360 bills those as one blended rate). The \"Coverage\" column instead lists which lines of business are bundled on each policy (e.g. \"Package — General Liability, Property, Inland Marine\") so the reader knows what's included without a false precise split. A \"Trending Percent Increase\" market-benchmark range (from Patrick's template) is filled in only for a monoline policy in one of 8 known lines of business — left blank for Package policies, which blend several. \"Renewal\"/\"Carrier\" (renewal side)/\"Percent Change\"/the per-carrier market-option columns (Grange, Frankenmuth, Accident Fund, Philadelphia, Travelers, CRC) are always left blank — not knowable until the renewal is actually priced/bound or shopped, filled in by hand. By default the finished workbook is emailed to the account's CSR (resolved from csrcode) and a 24-hour download link is also returned; pass send_email=false to skip the email and just get the link, or override_recipient to send to a specific address instead of the real CSR — required when the account's current policies resolve to more than one distinct CSR (no single real CSR to default to).",
      inputSchema: {
        custid: z.string().uuid().describe("The commercial customer's ID (from customer_lookup) — every one of their current, in-force commercial policies is considered"),
        renewal_within_days: z.number().int().positive().default(90).describe("Policies whose renewal (polexpdate) falls within this many days from today go in the main premium table; everything else on the account goes in the \"other effective dates\" table. Defaults to 90 (Patrick's own example: \"the next 90 days\")."),
        send_email: z.boolean().default(true).describe("Email the finished .xlsx to the account's CSR. When false, only a download link is returned."),
        cc: z.array(z.string().email()).describe("Additional email addresses to CC alongside the CSR").optional(),
        override_recipient: z.string().email().describe("Send to this address INSTEAD of the CSR — use for testing/QA, or required when the account's policies resolve to more than one distinct CSR.").optional()
      }
    },
    async ({ custid, renewal_within_days, send_email, cc, override_recipient }) => {
      try {
        const policies = await runReadOnlyQuery(ACCOUNT_POLICIES_QUERY, [custid]) as AccountPolicy[]

        if(policies.length === 0) {
          return errorResult(new Error("No current, in-force commercial policies found for this customer. Check custid is correct and the account actually carries commercial lines (typeofbus=2)."))
        }

        const clientName = policies[0].customer_name?.trim() || "[NOT PROVIDED — PLEASE CONFIRM]"

        const cutoff = new Date(Date.now() + renewal_within_days * 24 * 60 * 60 * 1000)
        const included = policies.filter((p) => new Date(p.polexpdate) <= cutoff)
        const other = policies.filter((p) => new Date(p.polexpdate) > cutoff)

        if(included.length === 0) {
          return textResult({
            message: `${ clientName } has ${ policies.length } current commercial policy/policies, but none renew within ${ renewal_within_days } days. Soonest renewal: ${ formatDate(policies[0].polexpdate) }. Widen renewal_within_days or check the account's renewal dates.`,
            policies: policies.map((p) => ({ polno: p.polno, renewal_date: formatDate(p.polexpdate), carrier_name: p.carrier_name }))
          })
        }

        const lobInfo = await Promise.all(policies.map((p) => fetchPolicyLobInfo(p.polid)))
        const lobByPolid = new Map(policies.map((p, i) => [p.polid, lobInfo[i]]))

        const rows: PremiumRow[] = included.map((policy) => {
          const { classification, lobDescriptions, lobCodes } = lobByPolid.get(policy.polid)!
          const label = lobDescriptions.length > 0 ? lobDescriptions.join(", ") : "—"
          const coverage = classification ? `${ classification } — ${ label }` : label
          const trendingRange = lobCodes.length === 1 ? (TRENDING_RANGES[lobCodes[0]] ?? "") : ""

          return {
            coverage,
            current: toNumber(policy.fulltermpremium),
            carrier: policy.carrier_name?.trim() || "—",
            trendingRange
          }
        })

        const otherPolicies: OtherPolicyRow[] = other.map((policy) => {
          const { classification } = lobByPolid.get(policy.polid)!
          return {
            coveragePolicy: `${ policy.polno } — ${ classification || "Policy" } (${ policy.carrier_name?.trim() || "—" })`,
            expirationDate: formatDate(policy.polexpdate)
          }
        })

        const renewalDates = [...new Set(included.map((p) => formatDate(p.polexpdate)))]
        const renewalDateLabel = renewalDates.length === 1 ? renewalDates[0] : `${ renewalDates[0] } – ${ renewalDates[renewalDates.length - 1] }`

        const buffer = await buildRenewalPremiumSummaryWorkbook({ clientName, renewalDateLabel, rows, otherPolicies })

        const filename = `${ clientName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unknown" }_Renewal_Premium_Summary.xlsx`
        const token = storeDownload(buffer, filename, XLSX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        const primaryPolicy = included[0]
        let emailStatus = "Not sent (send_email=false)."

        if(send_email) {
          const distinctCsrEmails = new Set(policies.map((p) => p.csr_email).filter((e): e is string => !!e))

          if(!override_recipient && distinctCsrEmails.size > 1) {
            emailStatus = `Not sent — this account's policies resolve to ${ distinctCsrEmails.size } different CSRs; pass override_recipient to choose one, or send_email=false to just get the link.`
          } else {
            const recipient = override_recipient ?? primaryPolicy.csr_email

            if(!recipient) {
              emailStatus = `Not sent — no email on file for CSR ${ primaryPolicy.csr_name ?? primaryPolicy.csrcode ?? "(unassigned)" }.`
            } else {
              await sendMailWithAttachment({
                to: cc && cc.length > 0 ? [recipient, ...cc] : recipient,
                subject: `Boxwood Renewal Premium Overview — ${ clientName }`,
                text: `Attached is the Renewal Premium Overview for ${ clientName } (${ included.length } polic${ included.length === 1 ? "y" : "ies" } renewing within ${ renewal_within_days } days).`,
                attachment: { filename, content: buffer, contentType: XLSX_MIME_TYPE }
              })
              emailStatus = override_recipient
                ? `Emailed to ${ recipient } (override — CSR ${ primaryPolicy.csr_name ?? primaryPolicy.csrcode ?? "unassigned" } was NOT emailed).`
                : `Emailed to ${ primaryPolicy.csr_name ?? recipient } (${ recipient }).`
            }
          }
        }

        return textResult({
          message: `Built the Renewal Premium Overview for ${ clientName } — ${ included.length } polic${ included.length === 1 ? "y" : "ies" } renewing within ${ renewal_within_days } days, ${ other.length } other current polic${ other.length === 1 ? "y" : "ies" } listed separately. ${ emailStatus }`,
          download_url: downloadUrl,
          included_policies: rows.map((r) => ({ coverage: r.coverage, current_premium: r.current, carrier: r.carrier })),
          other_policies: otherPolicies
        })
      } catch(error) {
        logger.error({ err: error, custid, renewal_within_days, send_email }, "renewal_premium_summary failed")
        return errorResult(error)
      }
    }
  )
}
