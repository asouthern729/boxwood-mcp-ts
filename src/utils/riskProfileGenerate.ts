import { archiveRiskProfile, sanitizeForFilename } from "./riskProfileArchive.js"
import {
  buildPolicySummary, combineExposures, fetchPolicyData, formatDate, renewalDateFields, type ResolvedPolicy
} from "./clPolicyData.js"
import { buildRiskProfileDoc } from "./riskProfileDoc.js"

export type GeneratedRiskProfile = {
  buffer: Buffer
  // Client-facing name for a download link — the archive keeps its own, more specific filename.
  filename: string
  includedSections: string[]
  combining: boolean
  polnoLabel: string
}

// Builds and archives the Pre-Renewal Review for already-resolved policies of one customer — shared
// by the risk_profile MCP tool and scripts/monthlyRiskProfiles.ts, so the monthly batch files
// exactly what an on-demand request would. Resolution (which policies) stays with each caller.
export async function generateRiskProfile(matches: ResolvedPolicy[], clientName: string): Promise<GeneratedRiskProfile> {
  const primaryPolicy = matches[0]
  const combining = matches.length > 1

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
    polids: matches.map((m) => m.polid),
    ...renewalDateFields(matches)
  })

  return { buffer, filename, includedSections, combining, polnoLabel }
}
