import { PERSONAL_BOOK, formatDate, resolveClPolicies } from "./clPolicyData.js"
import type { ClPolicyFilters, ResolvedPolicy } from "./clPolicyData.js"
import { sanitizeForFilename } from "./docArchive.js"
import { fetchPlPolicyCoverage, orderPlSections } from "./plCoverageData.js"
import { buildPlRenewalSummaryDoc } from "./plRenewalSummaryDoc.js"
import { archivePlRenewalSummary } from "./plRenewalSummaryArchive.js"
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

export async function buildAndArchivePlRenewalSummary(filters: ClPolicyFilters): Promise<PlRenewalSummaryBuild> {
  const resolution = await resolveClPolicies(filters, PERSONAL_BOOK)
  if(resolution.kind !== "ok") return resolution

  const { clientName } = resolution
  const deduped = await dedupeSamePolicyNumber(resolution.matches)
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
  const filename = filters.polno && !combining
    ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(primaryPolicy.polno) }_${ primaryPolicy.polid }.docx`
    : `${ sanitizeForFilename(clientName) }_${ soonestRenewal }_Personal_Insurance_Summary.docx`

  archivePlRenewalSummary(buffer, {
    filename,
    generated_at: new Date().toISOString(),
    csr_code: primaryPolicy.csrcode,
    csr_name: primaryPolicy.csr_name,
    client_name: primaryPolicy.customer_sort_name?.trim() || clientName,
    polnos: matches.map((m) => m.polno).join(", "),
    renewal_date: soonestRenewal,
    renewal_date_label: renewalDates.length === 1 ? renewalDates[0] : `${ renewalDates[0] } – ${ renewalDates[renewalDates.length - 1] }`
  })

  return {
    kind: "ok", buffer, filename, clientName, clientSortName: primaryPolicy.customer_sort_name?.trim() || clientName,
    polnos: matches.map((m) => m.polno),
    renewedPolnos, duplicateTermPolnos: deduped.unresolvedPolnos, includedSections, carrierCodes, combining
  }
}
