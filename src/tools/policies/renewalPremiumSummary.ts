import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { runReadOnlyQuery } from "../../db.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { sendMailWithAttachment } from "../../utils/mailer.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { fetchPolicyLobInfo } from "../../utils/policyLineOfBusiness.js"
import type { ExtraRow, KnownLobCode, LobRowFill, OtherPolicyRow } from "../../utils/renewalPremiumSummaryWorkbook.js"
import { LOB_ROW_ORDER, buildRenewalPremiumSummaryWorkbook } from "../../utils/renewalPremiumSummaryWorkbook.js"

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"

// Same "genuinely in force today" filter commercial_renewal_summary/policy_query/upcoming_renewals
// all standardize on. Unlike commercial_renewal_summary, this always pulls EVERY current commercial
// policy on the account (not just ones matching a polno) — the whole point of this tool is splitting
// that set into "renewing soon" (main table) vs. "everything else" (the account's other current
// policies), per Patrick's own spec (see this file's header comment below).
//
// Deliberately does NOT filter on renewalrptflag='A' (client-corrected 2026-09-14, Defatta Custom
// Homes LLC — see commercialRenewalSummary.ts's RESOLVE_POLICY_QUERY comment for the full story):
// AMS360 can flip a term's flag to 'R' the moment its successor is bound, weeks before that successor
// actually starts, so the flag alone can miss the term that's genuinely in force today. The
// poleffdate/polexpdate bounds below already do all the real work of defining "in force."
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
      // Client-requested (Patrick, roadmap item #1, 9/10 — see CL_Renewal_Premium_Summary.xlsx he
      // emailed, permission given to reuse the file directly) as a per-LINE-OF-BUSINESS premium
      // breakdown ("Auto is going up x amount, Umbrella is going up y amount, not just the entire
      // package is going up x%"). Investigated before building (2026-09-11, real data): summing
      // afw_cprem.premium by line of business is NOT trustworthy for exactly the policies where it
      // would matter — commercial Package policies. Confirmed on a real multi-LOB Package policy that
      // afw_cprem's per-line premium sums to only 62% of the policy's actual
      // afw_basicpolinfo.fulltermpremium (AMS360 itself bills these as one blended package rate —
      // afw_policytranpremium.lineofbus reads 'CPKGE', never split by line). Per client feedback
      // (2026-09-13), a Package policy's full blended premium goes on its "primary" line instead of
      // attempting an unreliable split (see LOB_ROW_ORDER in renewalPremiumSummaryWorkbook.ts). Also
      // per that same feedback: the tool only needs to fill Coverage/Current/Carrier — everything
      // else (Renewal, Percent Change, Trending, market-option carriers) is either already baked
      // into the template as a static value/formula, or filled in by hand later.
      description: "Builds Patrick's \"Commercial Renewal Premium Overview\" .xlsx (his actual template, reused directly — see assets/templates/commercial-renewal-template.xlsx) for a commercial account. Fills in Current premium and Carrier for each of the template's 8 fixed lines of business (General Liability, Property, Auto, Umbrella, Workers Comp, EPLI, Inland Marine, D&O) among policies renewing within the given window; a monoline policy maps directly to its one line, a Package policy's full (unsplit) premium goes on its \"primary\" bundled line since AMS360 doesn't reliably support splitting a blended package rate per line. A policy whose line(s) don't match any of the 8 goes in one of a few spare rows the template also keeps blank for a coverage added at renewal that wasn't in the current term. A second table lists the account's other current commercial policies (not in the window) with their expiration dates, for later quote notes. Always account-scoped (custid, not polno) since the whole point is separating \"renewing soon\" from \"everything else on the account.\" TOTAL PREMIUM, each line's Percent Change, and the Trending Percent Increase ranges are already live formulas/static values in the template — never touched here. \"Renewal\"/\"Carrier\" (renewal side)/the per-carrier market-option columns (Grange, Frankenmuth, Accident Fund, Philadelphia, Travelers, CRC) are always left blank — not knowable until the renewal is actually priced/bound or shopped, filled in by hand. By default the finished workbook is emailed to the account's CSR (resolved from csrcode) and a 24-hour download link is also returned; pass send_email=false to skip the email and just get the link, or override_recipient to send to a specific address instead of the real CSR — required when the account's current policies resolve to more than one distinct CSR (no single real CSR to default to).",
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

        // Maps each included policy onto the template's fixed 8-line-of-business rows (General
        // Liability/Property/Auto/Umbrella/Workers Comp/EPLI/Inland Marine/D&O) rather than one row
        // per policy — those rows, their Percent Change formulas, and their Trending ranges are
        // already baked into commercial-renewal-template.xlsx. A monoline policy maps directly to
        // its one line; a Package policy's full (blended, unsplit) premium goes on its "primary"
        // line — the first of its bundled lines in LOB_ROW_ORDER, General Liability first as the
        // usual anchor coverage for a bundled program (client feedback, 2026-09-13: don't attempt an
        // unreliable per-line split). Two policies landing on the same row (e.g. two monoline Auto
        // policies) sum their premiums and combine carrier names. Anything matching none of the 8
        // known lines at all goes to extraRows instead, filling the template's spare rows.
        const lobRows: Partial<Record<KnownLobCode, LobRowFill>> = {}
        const extraRows: ExtraRow[] = []

        for(const policy of included) {
          const { lobDescriptions, lobCodes } = lobByPolid.get(policy.polid)!
          const primaryCode = LOB_ROW_ORDER.find((code) => lobCodes.includes(code))
          const current = toNumber(policy.fulltermpremium)
          const carrier = policy.carrier_name?.trim() || "—"

          // Client feedback (2026-09-15): drop the "Package —"/"Monoline —" prefix, and lead with
          // whichever bundled line of business actually corresponds to the row this policy landed
          // on (primaryCode) — lobDescriptions/lobCodes are parallel arrays in afw_lineofbusiness's
          // own order, which doesn't necessarily already put the row's own line first (e.g. a
          // Package's GL coverage could come back listed after Umbrella/Property) — the rest of the
          // bundle follows in its original order. Policy # is kept separate from the coverage text
          // (not concatenated into one string) so the workbook builder can render it smaller/italic
          // to the right of the coverage text, rather than needing a taller row for a second line.
          const primaryIdx = primaryCode ? lobCodes.indexOf(primaryCode) : -1
          const orderedDescriptions = primaryIdx > 0
            ? [lobDescriptions[primaryIdx], ...lobDescriptions.filter((_, i) => i !== primaryIdx)]
            : lobDescriptions
          const coverage = orderedDescriptions.length > 0 ? orderedDescriptions.join(", ") : "—"

          if(primaryCode) {
            const existing = lobRows[primaryCode]
            lobRows[primaryCode] = existing
              ? {
                  current: existing.current !== null || current !== null ? (existing.current ?? 0) + (current ?? 0) : null,
                  carrier: existing.carrier.split("; ").includes(carrier) ? existing.carrier : `${ existing.carrier }; ${ carrier }`,
                  coverage: existing.coverage.split("; ").includes(coverage) ? existing.coverage : `${ existing.coverage }; ${ coverage }`,
                  policyNos: existing.policyNos.split(", ").includes(policy.polno) ? existing.policyNos : `${ existing.policyNos }, ${ policy.polno }`
                }
              : { current, carrier, coverage, policyNos: policy.polno }
          } else {
            extraRows.push({ coverage, policyNos: policy.polno, current, carrier })
          }
        }

        const otherPolicies: OtherPolicyRow[] = other.map((policy) => {
          const { classification } = lobByPolid.get(policy.polid)!
          return {
            coveragePolicy: `${ policy.polno } — ${ classification || "Policy" } (${ policy.carrier_name?.trim() || "—" })`,
            expirationDate: formatDate(policy.polexpdate)
          }
        })

        const renewalDates = [...new Set(included.map((p) => formatDate(p.polexpdate)))]
        const renewalDateLabel = renewalDates.length === 1 ? renewalDates[0] : `${ renewalDates[0] } – ${ renewalDates[renewalDates.length - 1] }`

        const buffer = await buildRenewalPremiumSummaryWorkbook({ clientName, renewalDateLabel, lobRows, extraRows, otherPolicies })

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
          included_policies: [
            ...Object.entries(lobRows).map(([code, r]) => ({ coverage: code, current_premium: r.current, carrier: r.carrier })),
            ...extraRows.map((r) => ({ coverage: r.coverage, current_premium: r.current, carrier: r.carrier }))
          ],
          other_policies: otherPolicies
        })
      } catch(error) {
        logger.error({ err: error, custid, renewal_within_days, send_email }, "renewal_premium_summary failed")
        return errorResult(error)
      }
    }
  )
}
