import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { archiveClRenewalSummary } from "../../utils/clRenewalSummaryArchive.js"
import { sanitizeForFilename } from "../../utils/docArchive.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import {
  buildPolicySummary, combineExposures, fetchPolicyData, formatDate, renewalDateFields, resolveClPolicies
} from "../../utils/clPolicyData.js"
import { VEHICLE_COLUMNS, combineCoverageData, fetchPolicyCoverageData } from "../../utils/clCoverageData.js"
import { buildRenewalSummaryDoc } from "../../utils/riskProfileDoc.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// CL Renewal Summary (roadmap item #4) — the Pre-Renewal Risk Profile's document (risk_profile)
// plus coverage limits per line of business. Patrick (9/11/2026): "Pre Renewal Risk Profile- only
// exposures and building limits, veh, driver etc. CL Renewal Summary- incl all that plus coverage
// limits for liability etc. data pulled from MCP." Policy resolution, combining, and every exposure
// schedule are shared with risk_profile (utils/clPolicyData.ts), so the two documents always agree
// on which terms they cover; the limits come from utils/clCoverageData.ts. Scope decisions confirmed
// with Andrew 2026-09-22: no premiums, per-vehicle auto coverages, umbrella limits only (no schedule
// of underlying policies), and the blank Renewal Exposure/Payroll meeting columns kept.
export function registerClRenewalSummaryTool(server: McpServer) {
  server.registerTool(
    "cl_renewal_summary",
    {
      description: "Builds a branded \"Renewal Summary\" Word document (.docx) for one or more commercial-lines policies — everything in risk_profile's Pre-Renewal Review (Named Insureds, Locations, Property, General Liability Exposure, Equipment, Vehicles, Drivers, Workers' Comp Exposure) PLUS the current coverage limits and deductibles per line of business: General Liability limits (Each Occurrence, General Aggregate, Products/Completed Ops, etc.), Property one row per subject of insurance (Limit / Valuation / Cause of Loss / Deductible, wind/hail deductibles inline), per-vehicle auto coverages (liability, med pay, UM/UIM, comp/collision deductibles) plus hired & non-owned auto, Workers' Comp Employer's Liability limits, Umbrella limits (occurrence / aggregate / retention — no schedule of underlying policies), Inland Marine and any other line's limits. NO premiums — those are renewal_premium_summary's job. Use this instead of risk_profile whenever coverage limits are wanted; use risk_profile for the exposures-only version. Same inputs and policy resolution as risk_profile: pass polno and/or custid; commercial lines only (typeofbus=2); resolves to the customer's current in-force term(s) by poleffdate/polexpdate; several current policies for the SAME customer combine into one document (up to 12), with a cover-page policy summary table; matches across DIFFERENT customers are treated as ambiguous and no document is built. Sections with no data are omitted. The General Liability and Workers' Comp exposure tables keep their intentionally blank \"Renewal Exposure\"/\"Renewal Payroll\" meeting columns — never populate these. Some carriers record coverages under a bare internal code (e.g. \"WTRBN\") with no description available anywhere in AMS360; those lines are kept as-is in the document and listed back in unresolved_coverage_codes so the CSR can relabel them. A 24-hour download link is always returned — there is no email-sending here. Every generated document is also archived to scripts/output/cl-renewal-summary/ with a manifest.json entry (same shape as risk_profile's) backing the CSR-grouped Renewal Summary index — one archived file per policy (polid), or per exact combined policy set, regenerating overwrites its own prior copy.",
      inputSchema: {
        polno: z.string().describe("Partial match against policy number or short policy number — narrows to one customer's current, in-force commercial policy/policies (combine with custid to disambiguate if needed). Matching more than one policy for the same customer combines them into one document; matching across different customers is treated as ambiguous.").optional(),
        custid: z.string().uuid().describe("Filter to a specific customer's current commercial policy/policies — with no polno, ALL of that customer's current commercial policies (optionally further scoped by renewal_within_days) are combined into one document").optional(),
        renewal_within_days: z.number().int().positive().describe("Only include policies whose renewal (polexpdate) falls within this many days from today — e.g. 90 for \"renewing over the next 3 months.\" Use this to scope a combined document to the policies actually renewing soon rather than every current commercial policy the customer has. Omit for no date scoping.").optional()
      }
    },
    async ({ polno, custid, renewal_within_days }) => {
      try {
        const resolution = await resolveClPolicies({ polno, custid, renewal_within_days })

        if(resolution.kind === "error") return errorResult(resolution.error)
        if(resolution.kind === "ambiguous") return textResult(resolution.payload)

        const { matches, combining, primaryPolicy, clientName } = resolution

        const [perPolicyData, perPolicyCoverage, policySummary] = await Promise.all([
          Promise.all(matches.map((policy) => fetchPolicyData(policy))),
          Promise.all(matches.map((policy) => fetchPolicyCoverageData(policy.polid))),
          buildPolicySummary(matches, combining)
        ])

        // property (the Risk Profile's one-row-per-address Building/BPP table) is replaced here by
        // coverage.propertySubjects — one row per subject of insurance with its own limit.
        const { property: _property, ...exposures } = combineExposures(perPolicyData, clientName)
        const coverage = combineCoverageData(perPolicyCoverage)

        const { buffer, includedSections } = await buildRenewalSummaryDoc({
          clientName,
          currentPeriod: `${ formatDate(primaryPolicy.poleffdate) } – ${ formatDate(primaryPolicy.polexpdate) }`,
          renewalDate: formatDate(primaryPolicy.polexpdate),
          policySummary,
          ...exposures,
          propertySubjects: coverage.propertySubjects,
          vehicleCoverages: coverage.vehicleCoverages,
          vehicleCoverageColumns: VEHICLE_COLUMNS
            .filter((c) => coverage.vehicleCoverages.some((v) => v.values[c.key]))
            .map(({ key, label }) => ({ key, label })),
          hiredNonOwned: coverage.hiredNonOwned,
          coverageSections: coverage.sections
        })

        const polnoLabel = matches.map((m) => m.polno).join(", ")
        const filename = combining
          ? `${ sanitizeForFilename(clientName) }_Renewal_Summary_Combined.docx`
          : `${ sanitizeForFilename(clientName) }_Renewal_Summary.docx`
        const token = storeDownload(buffer, filename, DOCX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        // Same keying as risk_profile's archive (see its comment): polid for a single policy term,
        // the full polno set for a combined document.
        const archiveFilename = combining
          ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches.map((m) => m.polno).join("_")) }_combined.docx`
          : `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(primaryPolicy.polno) }_${ primaryPolicy.polid }.docx`

        archiveClRenewalSummary(buffer, {
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
            ? `Built the combined Renewal Summary for ${ clientName } (${ matches.length } policies: ${ polnoLabel }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`
            : `Built the Renewal Summary for ${ clientName } (policy ${ primaryPolicy.polno }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }.`,
          download_url: downloadUrl,
          included_sections: includedSections,
          ...(coverage.carrierCodes.length > 0 ? { unresolved_coverage_codes: coverage.carrierCodes } : {})
        })
      } catch(error) {
        logger.error({ err: error, polno, custid }, "cl_renewal_summary failed")
        return errorResult(error)
      }
    }
  )
}
