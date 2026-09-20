import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { generateRenewalPremiumSummary, NoCommercialPoliciesError } from "../../utils/renewalPremiumSummaryGenerate.js"

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
        const result = await generateRenewalPremiumSummary({
          custid,
          renewalWithinDays: renewal_within_days,
          sendEmail: send_email,
          cc,
          overrideRecipient: override_recipient
        })

        if(result.status === "no_policies_in_window") {
          return textResult({
            message: `${ result.clientName } has ${ result.totalPolicies } current commercial policy/policies, but none renew within ${ renewal_within_days } days. Soonest renewal: ${ result.soonestRenewalDate }. Widen renewal_within_days or check the account's renewal dates.`,
            policies: result.policies
          })
        }

        return textResult({
          message: `Built the Renewal Premium Summary for ${ result.clientName } — ${ result.includedCount } polic${ result.includedCount === 1 ? "y" : "ies" } renewing within ${ renewal_within_days } days, ${ result.otherCount } other current polic${ result.otherCount === 1 ? "y" : "ies" } listed separately. ${ result.emailStatus }`,
          download_url: result.downloadUrl,
          included_policies: result.includedPolicies,
          other_policies: result.otherPolicies
        })
      } catch(error) {
        if(error instanceof NoCommercialPoliciesError) return errorResult(error)
        logger.error({ err: error, custid, renewal_within_days, send_email }, "renewal_premium_summary failed")
        return errorResult(error)
      }
    }
  )
}
