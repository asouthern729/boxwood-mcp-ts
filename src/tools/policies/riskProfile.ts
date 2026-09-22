import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { archiveRiskProfile, sanitizeForFilename } from "../../utils/riskProfileArchive.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import {
  buildPolicySummary, combineExposures, fetchPolicyData, formatDate, renewalDateFields, resolveClPolicies
} from "../../utils/clPolicyData.js"
import { buildRiskProfileDoc } from "../../utils/riskProfileDoc.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// Policy resolution, per-policy exposure queries, and the multi-policy combine/dedupe logic live in
// utils/clPolicyData.ts, shared with cl_renewal_summary (which builds this same document plus
// coverage limits) — see that file for the client-confirmed behavior behind each query.
export function registerRiskProfileTool(server: McpServer) {
  server.registerTool(
    "risk_profile",
    {
      description: "Builds a branded \"Pre-Renewal Review\" Word document (.docx) for one or more commercial-lines policies — the current expiring program's exposure schedules (Named Insureds, Locations, Property Coverage, General Liability Exposure, Equipment, Vehicles, Drivers, Workers' Comp Exposure), for the CSR and client to review together ahead of the renewal. Called ad hoc (not tied to download_report) — pass customer_name, polno, and/or custid to identify the policy/policies (customer_name matches only customers with current commercial policies, so a client's separate employee-benefits account with a similar name is never a competing match — no need to call customer_lookup first). Commercial lines only (typeofbus=2); resolves to the customer's current in-force term(s) (poleffdate/polexpdate bracketing today — not the renewalrptflag column, which can lag behind a term already bound early for next year). Sections with no data are omitted entirely rather than shown empty. The General Liability and Workers' Comp tables carry an intentionally blank \"Renewal Exposure\"/\"Renewal Payroll\" column for the live meeting — never populate these. Property Coverage is one row per address (Building Limit / BPP Limit split columns, plus a blank \"Description\" column for staff to annotate by hand at the renewal meeting) — not policy-wide coverage lines. MULTIPLE POLICIES IN ONE DOCUMENT: if the polno/custid filters resolve to more than one current commercial policy for the SAME customer (e.g. custid alone, or a polno fragment matching several of that customer's policies), they're combined into a single .docx instead of erroring — one cover page with a policy summary table (policy #, type, premium, renewal date) replacing the single current-period/renewal-date line, and Named Insureds merged and deduped across policies (up to 12 policies at once). Every other section's rows are simply combined with no per-row \"Policy #\" tag, since in practice each section's data only ever comes from one of the combined policies anyway. If the filters instead match several policies across DIFFERENT customers (an ambiguous polno with no custid), that's treated as ambiguous as before — no document is built; narrow with a more specific polno or add custid. A 24-hour download link is always returned — there is no email-sending here; share the link with the CSR directly. Every generated document is also archived to scripts/output/cl-risk-profile/ (kept 30 days) with a manifest.json entry (csr_code, csr_name, client_name, polnos, generated_at, renewal_date, renewal_date_label) that backs the CSR-grouped risk-profile index page — at most one archived file per policy (polid) at a time, or per exact combined policy set — regenerating the same single policy, or the same combination of policies, overwrites its own prior copy rather than accumulating.",
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

        const { matches, combining, primaryPolicy, clientName } = resolution

        const perPolicyData = await Promise.all(matches.map((policy) => fetchPolicyData(policy)))
        const exposures = combineExposures(perPolicyData, clientName)
        const policySummary = await buildPolicySummary(matches, combining)

        const { buffer, includedSections } = await buildRiskProfileDoc({
          clientName,
          currentPeriod: `${ formatDate(primaryPolicy.poleffdate) } – ${ formatDate(primaryPolicy.polexpdate) }`,
          renewalDate: formatDate(primaryPolicy.polexpdate),
          policySummary,
          ...exposures
        })

        const polnoLabel = matches.map((m) => m.polno).join(", ")
        const filename = combining
          ? `${ sanitizeForFilename(clientName) }_Pre-Renewal_Review_Combined.docx`
          : `${ sanitizeForFilename(clientName) }_Pre-Renewal_Review.docx`
        const token = storeDownload(buffer, filename, DOCX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        // Keyed by polid (this specific policy TERM), not custid alone — a customer can carry
        // several distinct commercial policies at once (confirmed against real data: Celebration
        // Homes LLC has 4), and keying only by custid collapsed all of them onto a single file,
        // each regeneration silently overwriting a different policy's packet. polid is unique per
        // term, so: regenerating the SAME term (same policy, same renewal date) still overwrites
        // its own prior copy, a different policy for the same customer gets its own separate file,
        // and a future renewal of this same policy (a new term, new polid, new renewal_date once
        // AMS360 processes it) becomes its own new file rather than clobbering this one. A combined
        // document is instead keyed on the full set of matched polnos, so regenerating the exact
        // same combination overwrites its own prior copy, and a different combination (e.g. a 6th
        // policy added later) gets its own separate file rather than clobbering this one.
        const archiveFilename = combining
          ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches.map((m) => m.polno).join("_")) }_combined.docx`
          : `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(primaryPolicy.polno) }_${ primaryPolicy.polid }.docx`

        archiveRiskProfile(buffer, {
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
            ? `Built the combined Pre-Renewal Review for ${ clientName } (${ matches.length } policies: ${ polnoLabel }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`
            : `Built the Pre-Renewal Review for ${ clientName } (policy ${ primaryPolicy.polno }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`,
          download_url: downloadUrl,
          included_sections: includedSections
        })
      } catch(error) {
        logger.error({ err: error, polno, custid, customer_name }, "risk_profile failed")
        return errorResult(error)
      }
    }
  )
}
