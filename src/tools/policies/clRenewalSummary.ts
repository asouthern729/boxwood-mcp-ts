import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { resolveClPolicies } from "../../utils/clPolicyData.js"
import { generateClRenewalSummary } from "../../utils/clRenewalSummaryGenerate.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// CL Renewal Summary (roadmap item #4) — since 2026-10-08 a Commercial Insurance Proposal in the
// layout of Patrick's insurance-proposal skill, filled from AMS360 (his email "FW: TN Equine",
// 2026-10-07: "This is what we would want to pull from the Renewal Summary Tool for commercial
// lines. DO NOT have to have the premium summary page"). Policy resolution and combining are shared
// with risk_profile (utils/clPolicyData.ts), so the two documents always agree on which terms they
// cover. The build+archive step lives in utils/clRenewalSummaryGenerate.ts, shared with
// scripts/dailyClRenewalSummaries.ts.
export function registerClRenewalSummaryTool(server: McpServer) {
  server.registerTool(
    "cl_renewal_summary",
    {
      description: "Builds the commercial-lines Renewal Summary: a branded Word document (.docx) in Boxwood's Commercial Insurance Proposal layout for one or more commercial policies, filled from AMS360. Cover page (client, mailing address, policy period, Prepared By = producer), Executive Summary with Named Insureds and Location Schedule, then one section per line of business naming that policy's carrier: Property (causes of loss, coinsurance, valuation, deductibles incl. wind/hail; limits by location/building — Building / BPP / Business Income; additional property coverages), General Liability (standard limits, other GL-line coverages, classification & exposure schedule), Inland Marine (limits, scheduled equipment), Commercial Auto (liability symbols, coverages at the value most vehicles carry with exceptions noted, hired/non-owned, vehicle schedule with VIN last 4, drivers), Workers' Compensation (Employers Liability limits, states, class/payroll), Umbrella (occurrence/aggregate/retention plus an underlying coverage schedule), and any other line (Crime, Cyber, D&O, EPLI, E&O...). Closes with Why Boxwood and the service team (producer, account manager, agency). NO premiums anywhere — those are renewal_premium_summary's job. When AMS360 already has a policy's renewal term, that term is printed; otherwise the current term is, the cover says renewal terms are pending, and those policies are listed back in renewal_pending_polnos (the daily job rebuilds the document once the renewal lands). Renewal quote PDFs uploaded on the dashboard add carrier ratings, highlights, exclusions and bind conditions, each flagged with a Word comment for the CSR to verify. Same inputs and policy resolution as risk_profile: pass customer_name, polno, and/or custid (customer_name matches only customers with current commercial policies, so a client's separate employee-benefits account with a similar name is never a competing match — no need to call customer_lookup first); commercial lines only (typeofbus=2); several current policies for the SAME customer combine into one document (up to 12); matches across DIFFERENT customers are treated as ambiguous and no document is built. Sections with no data are omitted. Some carriers record coverages under a bare internal code (e.g. \"WTRBN\") with no description anywhere in AMS360; those lines are kept as-is and listed back in unresolved_coverage_codes so the CSR can relabel them. A 24-hour download link is always returned — there is no email-sending here. Every generated document is also archived to scripts/output/cl-renewal-summary/ with a manifest.json entry backing the CSR-grouped Renewal Summary index — one archived file per policy (polid), or per exact combined policy set; regenerating overwrites its own prior copy.",
      inputSchema: {
        polno: z.string().describe("Partial match against policy number or short policy number — narrows to one customer's current, in-force commercial policy/policies (combine with custid to disambiguate if needed). Matching more than one policy for the same customer combines them into one document; matching across different customers is treated as ambiguous.").optional(),
        custid: z.string().uuid().describe("Filter to a specific customer's current commercial policy/policies — with no polno, that customer's current commercial policies renewing within renewal_within_days (default 90) are combined into one document").optional(),
        customer_name: z.string().describe("Partial, case-insensitive match against the customer's name (DBA, firm name, or first/last) — matched ONLY among customers with a current in-force commercial policy, so a client's separate employee-benefits/personal account with a similar name never competes with the commercial one. Prefer this over resolving a name through customer_lookup first. Combine with polno/custid to narrow further.").optional(),
        renewal_within_days: z.number().int().positive().describe("Only include policies whose renewal (polexpdate) falls within this many days from today. Defaults to 90 for an account-level request (customer_name/custid with no polno) — same default as renewal_premium_summary — so policies not renewing until much later (e.g. a surety bond renewing next spring) stay out of the document. Pass a larger value to widen it. No default when a polno is given (that policy is included whenever it renews).").optional()
      }
    },
    async ({ polno, custid, customer_name, renewal_within_days }) => {
      try {
        const resolution = await resolveClPolicies({ polno, custid, customer_name, renewal_within_days })

        if(resolution.kind === "error") return errorResult(resolution.error)
        if(resolution.kind === "ambiguous") return textResult(resolution.payload)

        const { matches, primaryPolicy, clientName } = resolution
        const { buffer, filename, includedSections, combining, polnoLabel, carrierCodes, renewalPendingPolnos } = await generateClRenewalSummary(matches, clientName)
        const token = storeDownload(buffer, filename, DOCX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        return textResult({
          message: combining
            ? `Built the combined Renewal Summary for ${ clientName } (${ matches.length } policies: ${ polnoLabel }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`
            : `Built the Renewal Summary for ${ clientName } (policy ${ primaryPolicy.polno }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`,
          download_url: downloadUrl,
          included_sections: includedSections,
          ...(renewalPendingPolnos.length > 0 ? { renewal_pending_polnos: renewalPendingPolnos } : {}),
          ...(carrierCodes.length > 0 ? { unresolved_coverage_codes: carrierCodes } : {})
        })
      } catch(error) {
        logger.error({ err: error, polno, custid, customer_name }, "cl_renewal_summary failed")
        return errorResult(error)
      }
    }
  )
}
