import { PERSONAL_BOOK, formatDate, resolveClPolicies } from "./clPolicyData.js"
import type { ClPolicyFilters, ResolvedPolicy } from "./clPolicyData.js"
import { sanitizeForFilename } from "./docArchive.js"
import { fetchPlPolicyCoverage, orderPlSections } from "./plCoverageData.js"
import { buildPlRenewalSummaryDoc } from "./plRenewalSummaryDoc.js"
import { archivePlRenewalSummary } from "./plRenewalSummaryArchive.js"
import type { PlRenewalSummaryManifestEntry } from "./plRenewalSummaryArchive.js"
import { dedupeSamePolicyNumber, withDownloadedRenewalTerms } from "./plRenewalTerms.js"

// Build + archive one PL Renewal Summary. Shared by the pl_renewal_summary MCP tool (chat / on
// demand) and scripts/dailyPlRenewalPremiumChange.ts (built automatically for each client with a new
// PL renewal download — Patrick, 2026-09-29: "auto triggered when on download report & user
// initiated"), so both produce the same document under the same archive filename.

export type PlRenewalSummaryBuild =
  | { kind: "error"; error: Error }
  | { kind: "ambiguous"; payload: unknown }
  | {
    kind: "ok"
    buffer: Buffer
    filename: string
    clientName: string
    // "Last, First" for the tool page list and chat (the document itself prints clientName).
    clientSortName: string
    polnos: string[]
    renewedPolnos: string[]
    // Policy numbers with more than one current term AMS360 couldn't tell apart — a rep should check.
    duplicateTermPolnos: string[]
    includedSections: string[]
    carrierCodes: string[]
    combining: boolean
  }

// The date a policy next renews, as the summary sees it: a policy shown on its downloaded renewal
// term renews on that term's effective date; everything else on its current expiration.
function renewsOn(policy: ResolvedPolicy, renewedPolids: Set<string>): string {
  return formatDate(renewedPolids.has(policy.polid) ? policy.poleffdate : policy.polexpdate)
}

export type PlRenewalSummaryDoc = {
  buffer: Buffer
  entry: PlRenewalSummaryManifestEntry
  clientName: string
  clientSortName: string
  polnos: string[]
  renewedPolnos: string[]
  duplicateTermPolnos: string[]
  includedSections: string[]
  carrierCodes: string[]
  combining: boolean
}

// Builds the document from the client's current in-force terms without archiving it — shared by
// buildAndArchivePlRenewalSummary below and scripts/rebuildPlRenewalSummaries.ts. singlePolicy marks
// a polno request that resolved to one policy, which is filed per term instead of per renewal date.
export async function buildPlRenewalSummary(currentTerms: ResolvedPolicy[], clientName: string, singlePolicy: boolean): Promise<PlRenewalSummaryDoc> {
  const deduped = await dedupeSamePolicyNumber(currentTerms)
  const { policies: matches, renewedPolids } = await withDownloadedRenewalTerms(deduped.policies)
  const renewedPolnos = matches.filter((m) => renewedPolids.has(m.polid)).map((m) => m.polno)
  const combining = matches.length > 1
  const primaryPolicy = matches[0]

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

  const renewalDates = [...new Set(matches.map((m) => renewsOn(m, renewedPolids)))].sort()
  const soonestRenewal = renewalDates[0]

  // One archived file per single policy term (polid), or — for an account-level summary, the
  // automatic kind — one per client per upcoming renewal date, so a later download for the same
  // renewal rebuilds that file instead of adding another.
  const filename = singlePolicy && !combining
    ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(primaryPolicy.polno) }_${ primaryPolicy.polid }.docx`
    : `${ sanitizeForFilename(clientName) }_${ soonestRenewal }_Personal_Insurance_Summary.docx`

  const clientSortName = primaryPolicy.customer_sort_name?.trim() || clientName

  return {
    buffer,
    entry: {
      filename,
      generated_at: new Date().toISOString(),
      csr_code: primaryPolicy.csrcode,
      csr_name: primaryPolicy.csr_name,
      client_name: clientSortName,
      polnos: matches.map((m) => m.polno).join(", "),
      renewal_date: soonestRenewal,
      renewal_date_label: renewalDates.length === 1 ? renewalDates[0] : `${ renewalDates[0] } – ${ renewalDates[renewalDates.length - 1] }`,
      // The current terms the document was built from (before any downloaded renewal term was
      // swapped in), so a rebuild can resolve exactly these terms again. Absent before 2026-11-21.
      polids: deduped.policies.map((m) => m.polid)
    },
    clientName,
    clientSortName,
    polnos: matches.map((m) => m.polno),
    renewedPolnos,
    duplicateTermPolnos: deduped.unresolvedPolnos,
    includedSections,
    carrierCodes,
    combining
  }
}

export async function buildAndArchivePlRenewalSummary(filters: ClPolicyFilters): Promise<PlRenewalSummaryBuild> {
  const resolution = await resolveClPolicies(filters, PERSONAL_BOOK)
  if(resolution.kind !== "ok") return resolution

  const { buffer, entry, ...built } = await buildPlRenewalSummary(resolution.matches, resolution.clientName, Boolean(filters.polno))
  archivePlRenewalSummary(buffer, entry)

  return { kind: "ok", buffer, filename: entry.filename, ...built }
}
