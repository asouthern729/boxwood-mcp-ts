import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { archivePlRenewalSummary } from "../../utils/plRenewalSummaryArchive.js"
import { sanitizeForFilename } from "../../utils/docArchive.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { PERSONAL_BOOK, renewalDateFields, resolveClPolicies } from "../../utils/clPolicyData.js"
import { fetchPlPolicyCoverage, orderPlSections } from "../../utils/plCoverageData.js"
import { buildPlRenewalSummaryDoc } from "../../utils/plRenewalSummaryDoc.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// PL Renewal Summary: the personal-lines counterpart to cl_renewal_summary. It builds the "Personal
// Insurance Portfolio Summary" in the layout of the client-supplied sample
// (Patrick_Baggett_Personal_Insurance_Summary, 2026-09-28). Policy resolution is cl_renewal_summary's
// (utils/clPolicyData.ts) against the personal book; coverages come from utils/plCoverageData.ts.
// Andrew's decisions (2026-09-28): every in-force personal policy by default (no 90-day window);
// dedicated Auto/Home/Personal Articles/Umbrella sections, with DFIRE reusing Home's and any other
// line getting a generic table; the letterhead shows the producer's email; no premiums.
export function registerPlRenewalSummaryTool(server: McpServer) {
  server.registerTool(
    "pl_renewal_summary",
    {
      description: "Builds a branded \"Personal Insurance Portfolio Summary\" Word document (.docx) for a personal-lines client — the renewal summary for personal lines, the counterpart to cl_renewal_summary (commercial). One compact document covering the household's in-force personal policies: Automobile (coverage highlights — liability CSL or split limits, UM/UIM, med pay, comp/collision deductibles, rental, roadside — plus a Year / Make & Model / VIN table of scheduled vehicles; a coverage that differs between vehicles moves out of the highlights into its own column in that table), Homeowners and Dwelling Fire (per property address: Dwelling, Other Structures, Personal Property, Loss of Use / Fair Rental Value, Medical Payments, Personal/Premises Liability, Deductible, Wind/Hail Deductible), Personal Articles (total scheduled limit only; the item schedule is in the policy), Umbrella (personal liability limit, excess UM/UIM, retention), and a generic Coverage / Limit / Deductible table for any other personal line (boat, etc.). A line with no coverage detail on file (e.g. every flood policy) still gets a heading with a note to see the policy documents. NO premiums. Inputs: customer_name, polno, and/or custid. customer_name matches only customers with a current personal-lines policy, so the client's separate business account with a similar name never competes (no need to call customer_lookup first). Personal lines only (typeofbus=1), current in-force terms by poleffdate/polexpdate. An account-level request includes EVERY in-force personal policy on the account by default, whatever its renewal date (up to 20) — pass renewal_within_days only to narrow that. Matches across DIFFERENT customers are treated as ambiguous and no document is built. Some carriers record coverages under a bare internal code with no description available anywhere in AMS360; those are kept as-is and listed back in unresolved_coverage_codes so the CSR can relabel them. A 24-hour download link is always returned — there is no email-sending here. Every generated document is also archived to scripts/output/pl-renewal-summary/ with a manifest.json entry (same shape as cl_renewal_summary's) backing the CSR-grouped PL Renewal Summary index — one archived file per policy (polid), or per exact combined policy set; regenerating overwrites its own prior copy.",
      inputSchema: {
        polno: z.string().describe("Partial match against policy number or short policy number — narrows to one customer's current, in-force personal policy/policies (combine with custid to disambiguate if needed). Matching more than one policy for the same customer combines them into one document; matching across different customers is treated as ambiguous.").optional(),
        custid: z.string().uuid().describe("Filter to a specific customer's current personal policies — with no polno, every in-force personal policy on that account is combined into one document").optional(),
        customer_name: z.string().describe("Partial, case-insensitive match against the customer's name (first/last, DBA, or firm name) — matched ONLY among customers with a current in-force personal-lines policy. Prefer this over resolving a name through customer_lookup first. Combine with polno/custid to narrow further.").optional(),
        renewal_within_days: z.number().int().positive().describe("Only include policies whose renewal (polexpdate) falls within this many days from today. No default — omit it to include every in-force personal policy on the account. Pass it only when asked for a window (e.g. \"just what renews in the next 60 days\").").optional()
      }
    },
    async ({ polno, custid, customer_name, renewal_within_days }) => {
      try {
        const resolution = await resolveClPolicies({ polno, custid, customer_name, renewal_within_days }, PERSONAL_BOOK)

        if(resolution.kind === "error") return errorResult(resolution.error)
        if(resolution.kind === "ambiguous") return textResult(resolution.payload)

        const { matches, combining, primaryPolicy, clientName } = resolution

        const perPolicy = await Promise.all(matches.map((policy) => fetchPlPolicyCoverage(policy)))
        const sections = orderPlSections(perPolicy.flatMap((p) => p.sections))
        const carrierCodes = [...new Set(perPolicy.flatMap((p) => p.carrierCodes))]
        const carriers = [...new Set(matches.map((m) => m.carrier_name?.trim()).filter((c): c is string => Boolean(c)))]

        const { buffer, includedSections } = await buildPlRenewalSummaryDoc({
          clientName,
          carriers,
          producerEmail: primaryPolicy.producer_email,
          sections
        })

        const polnoLabel = matches.map((m) => m.polno).join(", ")
        const filename = `${ sanitizeForFilename(clientName) }_Personal_Insurance_Summary.docx`
        const token = storeDownload(buffer, filename, DOCX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        // Same keying as cl_renewal_summary's archive: polid for a single policy term, the full polno
        // set for a combined document. Personal policies often share one polno across lines (A01/H01
        // 1067679), so the set is deduped before joining.
        const archiveFilename = combining
          ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename([...new Set(matches.map((m) => m.polno))].join("_")) }_combined.docx`
          : `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(primaryPolicy.polno) }_${ primaryPolicy.polid }.docx`

        archivePlRenewalSummary(buffer, {
          filename: archiveFilename,
          generated_at: new Date().toISOString(),
          csr_code: primaryPolicy.csrcode,
          csr_name: primaryPolicy.csr_name,
          client_name: clientName,
          polnos: polnoLabel,
          ...renewalDateFields(matches)
        })

        return textResult({
          message: combining
            ? `Built the Personal Insurance Portfolio Summary for ${ clientName } (${ matches.length } policies: ${ polnoLabel }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`
            : `Built the Personal Insurance Portfolio Summary for ${ clientName } (policy ${ primaryPolicy.polno }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`,
          download_url: downloadUrl,
          included_sections: includedSections,
          ...(carrierCodes.length > 0 ? { unresolved_coverage_codes: carrierCodes } : {})
        })
      } catch(error) {
        logger.error({ err: error, polno, custid, customer_name }, "pl_renewal_summary failed")
        return errorResult(error)
      }
    }
  )
}
