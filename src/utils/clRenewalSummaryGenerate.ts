import { runReadOnlyQuery } from "../db.js"
import { archiveClRenewalSummary } from "./clRenewalSummaryArchive.js"
import { completedQuoteExtractions } from "./clQuoteStore.js"
import { mergeQuotesIntoRenewalSummary } from "./clQuoteMerge.js"
import { sanitizeForFilename, type DocArchiveEntry } from "./docArchive.js"
import {
  buildPolicySummary, combineExposures, fetchPolicyData, formatDate, renewalDateFields, resolveClPolicies, type ResolvedPolicy
} from "./clPolicyData.js"
import { VEHICLE_COLUMNS, combineCoverageData, fetchPolicyCoverageData } from "./clCoverageData.js"
import { buildRenewalSummaryDoc } from "./riskProfileDoc.js"

export type GeneratedClRenewalSummary = {
  buffer: Buffer
  // Client-facing name for a download link — the archive keeps its own, more specific filename.
  filename: string
  archiveFilename: string
  includedSections: string[]
  combining: boolean
  polnoLabel: string
  carrierCodes: string[]
}

// Same keying as risk_profile's archive (see riskProfileGenerate.ts): polid for a single policy
// term, the full polno set for a combined document. Uploaded quotes are stored under this name too
// (clQuoteStore.ts), so a rebuild of the same terms picks them back up.
function archiveFilenameFor(matches: ResolvedPolicy[], clientName: string): string {
  return matches.length > 1
    ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches.map((m) => m.polno).join("_")) }_combined.docx`
    : `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches[0].polno) }_${ matches[0].polid }.docx`
}

// Builds and archives the CL Renewal Summary for already-resolved policies of one customer — shared
// by the cl_renewal_summary MCP tool and scripts/dailyClRenewalSummaries.ts, so the scheduled job
// files exactly what an on-demand request would. Resolution (which policies) stays with each caller;
// any quotes uploaded against these terms are merged in (clQuoteMerge.ts).
export async function generateClRenewalSummary(matches: ResolvedPolicy[], clientName: string): Promise<GeneratedClRenewalSummary> {
  const primaryPolicy = matches[0]
  const combining = matches.length > 1
  const archiveFilename = archiveFilenameFor(matches, clientName)

  const [perPolicyData, perPolicyCoverage, policySummary] = await Promise.all([
    Promise.all(matches.map((policy) => fetchPolicyData(policy))),
    Promise.all(matches.map((policy) => fetchPolicyCoverageData(policy.polid))),
    buildPolicySummary(matches, combining)
  ])

  // property (the Risk Profile's one-row-per-address Building/BPP table) is replaced here by
  // coverage.propertySubjects — one row per subject of insurance with its own limit.
  const { property: _property, ...exposures } = combineExposures(perPolicyData, clientName)
  const coverage = combineCoverageData(perPolicyCoverage)

  const { buffer, includedSections } = await buildRenewalSummaryDoc(mergeQuotesIntoRenewalSummary({
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
  }, completedQuoteExtractions(archiveFilename)))

  const polnoLabel = matches.map((m) => m.polno).join(", ")
  const filename = combining
    ? `${ sanitizeForFilename(clientName) }_Renewal_Summary_Combined.docx`
    : `${ sanitizeForFilename(clientName) }_Renewal_Summary.docx`

  archiveClRenewalSummary(buffer, {
    filename: archiveFilename,
    generated_at: new Date().toISOString(),
    csr_code: primaryPolicy.csrcode,
    csr_name: primaryPolicy.csr_name,
    client_name: clientName,
    polnos: polnoLabel,
    polids: matches.map((m) => m.polid),
    ...renewalDateFields(matches)
  })

  return { buffer, filename, archiveFilename, includedSections, combining, polnoLabel, carrierCodes: coverage.carrierCodes }
}

// The policy terms an archived document covers. Entries archived before polids were recorded
// (2026-10-01) only carry them in a single-policy filename; a legacy combined document can't be
// rebuilt in place and has to be regenerated from the chat first.
export function archivedPolids(entry: DocArchiveEntry): string[] | null {
  if(entry.polids && entry.polids.length > 0) return entry.polids
  const match = entry.filename.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.docx$/i)
  return match ? [match[1]] : null
}

export class ClRenewalSummaryRebuildError extends Error {}

// Rebuilds an archived document in place — after a quote upload or deletion — from the same policy
// terms it was built from. Resolution goes back through resolveClPolicies (same in-force filter and
// joins as every other build) for the terms' customer, then keeps exactly the archived terms.
export async function rebuildClRenewalSummary(entry: DocArchiveEntry): Promise<GeneratedClRenewalSummary> {
  const polids = archivedPolids(entry)
  if(!polids) throw new ClRenewalSummaryRebuildError("This document predates quote uploads — build it again from the chat, then upload the quote.")

  const owners = await runReadOnlyQuery("SELECT DISTINCT custid FROM afw_basicpolinfo WHERE polid = ANY($1::uuid[])", [polids]) as { custid: string }[]
  if(owners.length !== 1) throw new ClRenewalSummaryRebuildError("Couldn't find this document's policies in AMS360 any more.")

  // A wide window: the account-level default (90 days) would drop a term renewing later than that.
  const resolution = await resolveClPolicies({ custid: owners[0].custid, renewal_within_days: 400 })
  if(resolution.kind !== "ok") throw new ClRenewalSummaryRebuildError("This document's policies are no longer in force, so it can't be rebuilt.")

  const matches = polids.flatMap((polid) => resolution.matches.filter((m) => m.polid === polid))
  if(matches.length !== polids.length) throw new ClRenewalSummaryRebuildError("Some of this document's policies are no longer in force, so it can't be rebuilt.")

  return generateClRenewalSummary(matches, resolution.clientName)
}
