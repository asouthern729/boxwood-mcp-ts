import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { runReadOnlyQuery } from "../../db.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { sendMailWithAttachment } from "../../utils/mailer.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { fetchPolicyLobInfo } from "../../utils/policyLineOfBusiness.js"
import type { ExtraRow, KnownLobCode, LobRowFill, OtherPolicyRow, PremiumFallbackNote } from "../../utils/renewalPremiumSummaryWorkbook.js"
import { LOB_ROW_ORDER, buildRenewalPremiumSummaryWorkbook } from "../../utils/renewalPremiumSummaryWorkbook.js"
import { archiveRenewalPremiumSummary } from "../../utils/renewalPremiumSummaryArchive.js"
import { computeCurrentRenewal } from "../../utils/renewalPremiumSummaryPolicyValues.js"
import { sanitizeForFilename } from "../../utils/riskProfileArchive.js"

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

// Placeholder recipient until reports are published to a OneDrive-based file system CSRs browse
// directly instead of being emailed individually (Andrew, 2026-09-16) — send_email is for review in
// the meantime, not a real distribution path, so it never resolves/sends to an actual CSR.
const DEFAULT_TEST_RECIPIENT = "andrew@tyneside.io"

const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"

// Same "genuinely in force today" filter risk_profile/policy_query/upcoming_renewals
// all standardize on. Unlike risk_profile, this always pulls EVERY current commercial
// policy on the account (not just ones matching a polno) — the whole point of this tool is splitting
// that set into "renewing soon" (main table) vs. "everything else" (the account's other current
// policies), per Patrick's own spec (see this file's header comment below).
//
// Deliberately does NOT filter on renewalrptflag='A' (client-corrected 2026-09-14, Defatta Custom
// Homes LLC — see riskProfile.ts's RESOLVE_POLICY_QUERY comment for the full story):
// AMS360 can flip a term's flag to 'R' the moment its successor is bound, weeks before that successor
// actually starts, so the flag alone can miss the term that's genuinely in force today. The
// poleffdate/polexpdate bounds below already do all the real work of defining "in force."
const ACCOUNT_POLICIES_QUERY = `
  SELECT p.polid, p.polno, p.polexpdate, p.custid, p.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS csr_name,
    p.fulltermpremium,
    COALESCE(
      (SELECT MAX(t.entereddate) FROM afw_policytransaction t WHERE t.polid = p.polid),
      p.changeddate
    ) AS premium_as_of,
    -- 2026-09-19 finding: a real, non-trivial share of "current" commercial terms carry
    -- fulltermpremium=0/null at the header even though their own bind/renewal transaction already
    -- recorded a real premium (confirmed against real data — see ams360-etl's trace on
    -- FSF1838131A 001: annualizedpremium=1056.00 on its one RWL transaction, header still 0.00
    -- sixteen days later). Not AMS360 catching up later — cprem (the detailed coverage-line rating
    -- table) shows the same gap, so there's nothing else in the synced schema to prefer over this.
    -- Used as a flagged Current fallback below, never silently swapped in.
    lasttxn.annualizedpremium AS last_written_premium,
    -- Andrew's finding, same date: a term nearing its own renewal can already have a bound successor
    -- term (new polid, priorpolid pointing back here) sitting in the data — and that successor's own
    -- fulltermpremium is sometimes already real/priced (e.g. polno 20WECBS9G23's successor
    -- 20WECCE7HMK: fulltermpremium=17988.00). That's not a better Current figure — it's the client's
    -- actual, already-known Renewal premium, which the template otherwise always leaves blank for
    -- hand entry (see this tool's own description). Only ever the most recently effective successor,
    -- in the rare case more than one somehow exists.
    successor.fulltermpremium AS successor_fulltermpremium
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  LEFT JOIN afw_company co ON co.cocode = p.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = p.csrcode
  LEFT JOIN LATERAL (
    SELECT t.annualizedpremium
    FROM afw_policytransaction t
    -- != 0, not just IS NOT NULL (boxwood-mcp-ts-0d review, 2026-09-19): a later $0 administrative
    -- endorsement (e.g. a mailing-address change with no premium impact) would otherwise win this
    -- ORDER BY over an earlier RWL/NBS transaction that actually carries the real premium, and the
    -- caller already treats a 0 fallback as "no real fallback" anyway (see usedFallback below) — so
    -- filtering it out here means "last" actually means "last transaction with a real premium."
    WHERE t.polid = p.polid AND t.annualizedpremium IS NOT NULL AND t.annualizedpremium != 0
    ORDER BY t.effdate DESC, t.changeddate DESC
    LIMIT 1
  ) lasttxn ON true
  LEFT JOIN LATERAL (
    SELECT s.fulltermpremium
    FROM afw_basicpolinfo s
    WHERE s.priorpolid = p.polid AND s.status != 'D'
    ORDER BY s.poleffdate DESC
    LIMIT 1
  ) successor ON true
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
  csr_name: string | null
  fulltermpremium: string | number | null
  premium_as_of: string | null
  last_written_premium: string | number | null
  successor_fulltermpremium: string | number | null
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : ""
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
      description: "Builds Patrick's \"Commercial Renewal Premium Summary\" .xlsx (his actual template, reused directly — see assets/templates/commercial-renewal-template.xlsx) for a commercial account. Fills in Current premium and Carrier for each of the template's 8 fixed lines of business (General Liability, Property, Auto, Umbrella, Workers Comp, EPLI, Inland Marine, D&O) among policies renewing within the given window; a monoline policy maps directly to its one line, a Package policy's full (unsplit) premium goes on its \"primary\" bundled line since AMS360 doesn't reliably support splitting a blended package rate per line. A policy whose line(s) don't match any of the 8 goes in one of a few spare rows the template also keeps blank for a coverage added at renewal that wasn't in the current term. A second table lists the account's other current commercial policies (not in the window) with their expiration dates, for later quote notes. Always account-scoped (custid, not polno) since the whole point is separating \"renewing soon\" from \"everything else on the account.\" TOTAL PREMIUM, each line's Percent Change, and the Trending Percent Increase ranges are already live formulas/static values in the template — never touched here. \"Renewal\"/\"Carrier\" (renewal side)/the per-carrier market-option columns (Grange, Frankenmuth, Accident Fund, Philadelphia, Travelers, CRC) are always left blank — not knowable until the renewal is actually priced/bound or shopped, filled in by hand. Below the template's own rows, an internal-only note block lists each main-table policy's \"premium as of\" date (its latest AMS360 transaction on file, or last-changed date if no transaction exists) — since Current premium is a point-in-time snapshot, this tells the account manager how current it is and flags that anything received after that date needs to be applied by hand until this is automated; clearly labeled so it's easy to delete before forwarding the workbook to the client. A 24-hour download link is always returned. Every generated workbook is also archived to scripts/output/cl-renewal-premium-summaries/ with a manifest.json entry (csr_code, csr_name, client_name, polnos, generated_at, renewal_date) that backs the CSR-grouped renewal-premium-summaries index page — one archived file per account (custid) at a time; regenerating the same account's overview overwrites its own prior copy rather than accumulating. There is deliberately no per-CSR email lookup/send here anymore — that's being replaced by a OneDrive-based file system CSRs will browse directly, not yet built. In the meantime, pass send_email=true to also email the finished .xlsx to a fixed test recipient (andrew@tyneside.io) for review, optionally overriding that address with override_recipient or adding cc.",
      inputSchema: {
        custid: z.string().uuid().describe("The commercial customer's ID (from customer_lookup) — every one of their current, in-force commercial policies is considered"),
        renewal_within_days: z.number().int().positive().default(90).describe("Policies whose renewal (polexpdate) falls within this many days from today go in the main premium table; everything else on the account goes in the \"other effective dates\" table. Defaults to 90 (Patrick's own example: \"the next 90 days\")."),
        send_email: z.boolean().default(false).describe("Also email the finished .xlsx to a fixed test recipient (andrew@tyneside.io) for review — there's no per-CSR send anymore (pending a OneDrive-based replacement). When false (default), only a download link is returned."),
        cc: z.array(z.string().email()).describe("Additional email addresses to CC alongside the test recipient").optional(),
        override_recipient: z.string().email().describe("Send to this address INSTEAD of the default test recipient (andrew@tyneside.io) — use for testing/QA.").optional()
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
        const premiumFallbackNotes: PremiumFallbackNote[] = []

        for(const policy of included) {
          const { lobDescriptions, lobCodes } = lobByPolid.get(policy.polid)!
          const primaryCode = LOB_ROW_ORDER.find((code) => lobCodes.includes(code))
          const carrier = policy.carrier_name?.trim() || "—"

          // Shared with the Refresh path (renewalPremiumSummaryPolicyValues.ts) so a refreshed cell
          // can never disagree with what a fresh full regeneration would have written for the same
          // policy. Fallback #1 (2026-09-19 finding): fulltermpremium reading 0/null doesn't mean the
          // policy has no real premium — a real share of the book has a genuine bind/renewal premium
          // sitting only in the transaction record, never rolled up to the header. Only used when the
          // header itself is 0/null, and always flagged via premiumFallbackNotes below — never
          // silently swapped in as if it were the synced header figure. Fix #2 (Andrew's finding,
          // same date): a bound successor term's own real fulltermpremium is the client's actual,
          // already-known Renewal premium — populate the template's Renewal column with it instead
          // of leaving it blank for hand entry. null (not 0) whenever no successor exists yet or the
          // successor itself hasn't been priced.
          const { current, renewal, usedFallback, fallbackAmount } = computeCurrentRenewal(policy)
          if(usedFallback) premiumFallbackNotes.push({ polno: policy.polno, amount: fallbackAmount! })

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
                  renewal: existing.renewal !== null || renewal !== null ? (existing.renewal ?? 0) + (renewal ?? 0) : null,
                  carrier: existing.carrier.split("; ").includes(carrier) ? existing.carrier : `${ existing.carrier }; ${ carrier }`,
                  coverage: existing.coverage.split("; ").includes(coverage) ? existing.coverage : `${ existing.coverage }; ${ coverage }`,
                  policyNos: existing.policyNos.split(", ").includes(policy.polno) ? existing.policyNos : `${ existing.policyNos }, ${ policy.polno }`
                }
              : { current, renewal, carrier, coverage, policyNos: policy.polno }
          } else {
            extraRows.push({ coverage, policyNos: policy.polno, current, renewal, carrier })
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

        // Patrick's feedback (roadmap, 2026-09-16): fulltermpremium is a point-in-time snapshot, not
        // itself a transaction — an AM needs to know how stale it might be so they know to check for
        // (and manually apply) anything AMS360 received after this date, until there's an automated
        // way to do that. Per policy rather than one blended report-level date, since two policies on
        // the same account can easily have different latest-transaction dates.
        const premiumAsOfNotes = included
          .map((p) => ({ polno: p.polno, date: formatDate(p.premium_as_of) }))
          .filter((n) => n.date)

        const { buffer, cellMap } = await buildRenewalPremiumSummaryWorkbook({ clientName, renewalDateLabel, lobRows, extraRows, otherPolicies, premiumAsOfNotes, premiumFallbackNotes })

        const filename = `${ clientName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unknown" }_Renewal_Premium_Summary.xlsx`
        const token = storeDownload(buffer, filename, XLSX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        // Archived under custid (not the human-readable filename above, which can collide across
        // differently-named accounts) so regenerating this same account's overview overwrites its
        // own prior copy rather than accumulating stale versions — the tool always rebuilds the
        // account's full current picture, so there's never a reason to keep an old one around. Backs
        // the CSR-grouped renewal-premium-summaries index page (src/routes/renewalPremiumSummaries.ts).
        const earliestRenewalDate = included.reduce((earliest, p) => (p.polexpdate < earliest ? p.polexpdate : earliest), included[0].polexpdate)

        archiveRenewalPremiumSummary(buffer, {
          filename: `${ sanitizeForFilename(clientName) }_${ custid }.xlsx`,
          generated_at: new Date().toISOString(),
          custid,
          csr_code: included[0].csrcode,
          csr_name: included[0].csr_name,
          client_name: clientName,
          polnos: included.map((p) => p.polno).join(", "),
          renewal_date: formatDate(earliestRenewalDate),
          renewal_date_label: renewalDateLabel,
          cell_map: cellMap
        })

        // CSR auto-email deliberately removed (Andrew, 2026-09-16) — reports will eventually be
        // published to a OneDrive-based file system CSRs browse directly instead of being emailed to
        // them individually. Until that's built, send_email just emails a fixed test recipient for
        // review rather than resolving/sending to a real CSR.
        let emailStatus = "Not sent (send_email=false)."

        if(send_email) {
          const recipient = override_recipient ?? DEFAULT_TEST_RECIPIENT

          await sendMailWithAttachment({
            to: cc && cc.length > 0 ? [recipient, ...cc] : recipient,
            subject: `Boxwood Renewal Premium Summary — ${ clientName }`,
            text: `Attached is the Renewal Premium Summary for ${ clientName } (${ included.length } polic${ included.length === 1 ? "y" : "ies" } renewing within ${ renewal_within_days } days).`,
            attachment: { filename, content: buffer, contentType: XLSX_MIME_TYPE }
          })
          emailStatus = `Emailed to ${ recipient } (test recipient — no per-CSR send).`
        }

        return textResult({
          message: `Built the Renewal Premium Summary for ${ clientName } — ${ included.length } polic${ included.length === 1 ? "y" : "ies" } renewing within ${ renewal_within_days } days, ${ other.length } other current polic${ other.length === 1 ? "y" : "ies" } listed separately. ${ emailStatus }`,
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
