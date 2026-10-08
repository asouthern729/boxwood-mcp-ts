import { runReadOnlyQuery } from "../db.js"
import { archiveClRenewalSummary } from "./clRenewalSummaryArchive.js"
import { completedQuoteExtractions } from "./clQuoteStore.js"
import { mergeQuotesIntoProposal, type QuoteSource } from "./clQuoteMerge.js"
import { sanitizeForFilename, type DocArchiveEntry } from "./docArchive.js"
import {
  clean, combineExposures, fetchPolicyData, formatAddress, renewalDateFields, resolveClPolicies, type ResolvedPolicy
} from "./clPolicyData.js"
import { LINE_SLOTS, fetchPolicyCoverageData } from "./clCoverageData.js"
import { buildClProposalDoc, type ServiceTeamMember } from "./clProposalDoc.js"
import { completeUmbrellas, longDate, policyLines, type SlotLine } from "./clProposalLines.js"
import { executiveSummary, whyBoxwood } from "./clProposalText.js"
import { withClRenewalTerms } from "./clRenewalTerms.js"

export type GeneratedClRenewalSummary = {
  buffer: Buffer
  // Client-facing name for a download link — the archive keeps its own, more specific filename.
  filename: string
  archiveFilename: string
  includedSections: string[]
  combining: boolean
  polnoLabel: string
  carrierCodes: string[]
  // Current-term policy numbers whose renewal isn't in AMS360 yet, so the document shows the
  // expiring program for them (and is rebuilt once it lands — scripts/dailyClRenewalSummaries.ts).
  renewalPendingPolnos: string[]
}

const AGENCY_PHONE = "615-245-5851"

// Same keying as risk_profile's archive (see riskProfileGenerate.ts): polid for a single policy
// term, the full polno set for a combined document. Uploaded quotes are stored under this name too
// (clQuoteStore.ts), so a rebuild of the same terms picks them back up. Always the CURRENT terms'
// identity, even when the document prints the renewal term — so the same document is rebuilt in
// place when the renewal lands.
function archiveFilenameFor(matches: ResolvedPolicy[], clientName: string): string {
  return matches.length > 1
    ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches.map((m) => m.polno).join("_")) }_combined.docx`
    : `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches[0].polno) }_${ matches[0].polid }.docx`
}

// Cover page and service team: the client's mailing address, the producer (Prepared By) and the
// CSR. afw_employee phone numbers are mostly empty (postgres peer, 2026-10-08: 4 of 21 active
// producers/CSRs) — the agency's main line stands in.
const CONTACTS_QUERY = `
  SELECT c.addr1, c.addr2, c.city, c.state, c.zipcode,
    NULLIF(TRIM(CONCAT_WS(' ', prod.firstname, prod.lastname)), '') AS producer_name,
    NULLIF(TRIM(prod.email), '') AS producer_email,
    COALESCE(NULLIF(TRIM(prod.busfullphone), ''), NULLIF(TRIM(prod.mobilefullphone), '')) AS producer_phone,
    NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), '') AS csr_name,
    NULLIF(TRIM(csr.email), '') AS csr_email,
    COALESCE(NULLIF(TRIM(csr.busfullphone), ''), NULLIF(TRIM(csr.mobilefullphone), '')) AS csr_phone
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  LEFT JOIN afw_employee prod ON prod.empcode = p.execcode
  LEFT JOIN afw_employee csr ON csr.empcode = p.csrcode
  WHERE p.polid = $1
`

type ContactsRow = {
  addr1: string | null; addr2: string | null; city: string | null; state: string | null; zipcode: string | null
  producer_name: string | null; producer_email: string | null; producer_phone: string | null
  csr_name: string | null; csr_email: string | null; csr_phone: string | null
}

function formatPhone(raw: string | null): string {
  const digits = (raw ?? "").replace(/\D/g, "")
  if(digits.length === 10) return `${ digits.slice(0, 3) }-${ digits.slice(3, 6) }-${ digits.slice(6) }`
  return clean(raw) || AGENCY_PHONE
}

function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" }).format(new Date())
}

function periodOf(policy: ResolvedPolicy): string {
  return `${ longDate(policy.poleffdate) } – ${ longDate(policy.polexpdate) }`
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for(const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
}

// Skill line order, then policy order; a line of business that appears on two policies (two CGL
// policies, say) is told apart by policy number.
function orderLines(lines: SlotLine[]): SlotLine[] {
  const ordered = lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => LINE_SLOTS.indexOf(a.line.slot) - LINE_SLOTS.indexOf(b.line.slot) || a.i - b.i)
    .map(({ line }) => line)

  const titleCounts = new Map<string, number>()
  for(const l of ordered) titleCounts.set(l.title, (titleCounts.get(l.title) ?? 0) + 1)
  return ordered.map((l) => (titleCounts.get(l.title)! > 1 && l.polno ? { ...l, title: `${ l.title } – Policy ${ l.polno }` } : l))
}

// Builds the CL Renewal Summary for already-resolved policies of one customer without filing it —
// generateClRenewalSummary below archives it. Each policy's renewal term is used when AMS360 has it
// (clRenewalTerms.ts), and any quotes uploaded against these terms are merged in (clQuoteMerge.ts).
// `quotes` defaults to the uploads stored against this document; passing them lets a preview
// build with quotes that aren't stored.
export async function buildClRenewalSummary(
  matches: ResolvedPolicy[], clientName: string, quotes?: QuoteSource[]
): Promise<GeneratedClRenewalSummary & { archiveEntry: DocArchiveEntry }> {
  const primaryPolicy = matches[0]
  const combining = matches.length > 1
  const archiveFilename = archiveFilenameFor(matches, clientName)

  // When an old term and its renewal are both in force (renewal day), both swap to the renewal —
  // keep each printed term once.
  const seen = new Set<string>()
  const terms = (await withClRenewalTerms(matches)).filter((t) => (seen.has(t.data.polid) ? false : (seen.add(t.data.polid), true)))

  const [perPolicyData, perPolicyCoverage, contactRows] = await Promise.all([
    Promise.all(terms.map((t) => fetchPolicyData(t.data))),
    Promise.all(terms.map((t) => fetchPolicyCoverageData(t.data.polid))),
    runReadOnlyQuery(CONTACTS_QUERY, [primaryPolicy.polid]) as Promise<ContactsRow[]>
  ])
  const contacts = contactRows[0]
  const exposures = combineExposures(perPolicyData, clientName)

  const amsLines = terms.flatMap((t, i) => policyLines({
    polno: t.data.polno,
    carrier: clean(t.data.carrier_name),
    period: periodOf(t.data),
    data: perPolicyData[i],
    coverage: perPolicyCoverage[i]
  }))

  const merged = mergeQuotesIntoProposal(amsLines, quotes ?? completedQuoteExtractions(archiveFilename))
  const lines = orderLines(merged.lines)
  completeUmbrellas(lines)

  // The cover shows the period most of the printed program shares — a quoted line's own period, since
  // that's the term its figures describe; a line on a different term says so in its own overview
  // (skill: never as a key fact).
  const periods = lines.map((l) => l.period).filter(Boolean)
  const policyPeriod = mostCommon(periods) || periodOf(terms[0].data)
  const policyPeriodsDiffer = new Set(periods).size > 1
  for(const line of lines) {
    if(line.period && line.period !== policyPeriod) line.overview = `${ line.overview } Written for the policy period ${ line.period }.`.trim()
  }

  // Until a policy's renewal term is in AMS360 its sections print the expiring term — flagged on the
  // cover and on each of those sections (Andrew, 2026-10-08), unless an uploaded quote has already
  // supplied that line's renewal values (a quote-built section carries a comment).
  const pending = terms.filter((t) => !t.isRenewal).map((t) => t.current)
  const pendingPolnos = new Set(pending.map((p) => p.polno))
  for(const line of lines) {
    if(pendingPolnos.has(line.polno) && !line.comment) {
      line.pendingNote = `The figures below are from the current policy term (${ line.period }). This section will be updated when the renewal terms are received.`
    }
  }
  const pendingLines = lines.filter((l) => l.pendingNote)
  const allTermsCurrent = pendingLines.length > 0 && pendingLines.length === lines.length
  const renewalNote = pendingLines.length === 0
    ? undefined
    : allTermsCurrent
      ? `Coverage shown is the current program, which renews ${ longDate(primaryPolicy.polexpdate) }. This proposal will be updated when the renewal terms are received.`
      : `Sections marked "Renewal Terms Pending" (${ pendingLines.map((l) => l.title).join(", ") }) show the current program and will be updated when the renewal terms are received.`

  const namedInsureds = [clientName, ...exposures.additionalNamedInsureds]
  const narrativeFacts = {
    clientName,
    lines,
    policyPeriod,
    policyPeriodsDiffer,
    isRenewal: pendingLines.length === 0,
    locationStates: exposures.locations.map((l) => l.state).filter(Boolean),
    locationCount: exposures.locations.length,
    vehicleCount: exposures.vehicles.length,
    namedInsuredCount: namedInsureds.length
  }

  const serviceTeam: ServiceTeamMember[] = [
    ...(contacts?.producer_name ? [{ role: "Producer", name: contacts.producer_name, phone: formatPhone(contacts.producer_phone), email: contacts.producer_email ?? "" }] : []),
    ...(contacts?.csr_name ? [{ role: "Account Manager", name: contacts.csr_name, phone: formatPhone(contacts.csr_phone), email: contacts.csr_email ?? "" }] : []),
    { role: "Agency", name: "Boxwood Insurance Group, LLC", phone: AGENCY_PHONE, email: "www.boxwoodins.com" }
  ]

  const { buffer, includedSections } = await buildClProposalDoc({
    clientName,
    clientAddress: contacts
      ? [[contacts.addr1, contacts.addr2].map(clean).filter(Boolean).join(" "), formatAddress(null, contacts.city, contacts.state, contacts.zipcode)].filter(Boolean).join(" | ")
      : "",
    policyPeriod,
    policyPeriodsDiffer,
    renewalNote,
    allTermsCurrent,
    quoteNote: merged.quoteNote,
    preparedBy: contacts?.producer_name
      ? { name: contacts.producer_name, email: contacts.producer_email ?? "", phone: formatPhone(contacts.producer_phone) }
      : null,
    proposalDate: todayInChicago(),
    executiveSummary: executiveSummary(narrativeFacts),
    namedInsureds,
    locations: exposures.locations,
    lines,
    bindConditions: merged.bindConditions,
    specialtyAddOns: merged.specialtyAddOns,
    whyBoxwood: whyBoxwood(narrativeFacts),
    serviceTeam
  })

  const polnoLabel = matches.map((m) => m.polno).join(", ")
  const filename = combining
    ? `${ sanitizeForFilename(clientName) }_Renewal_Summary_Combined.docx`
    : `${ sanitizeForFilename(clientName) }_Renewal_Summary.docx`

  const archiveEntry: DocArchiveEntry = {
    filename: archiveFilename,
    generated_at: new Date().toISOString(),
    csr_code: primaryPolicy.csrcode,
    csr_name: primaryPolicy.csr_name,
    client_name: clientName,
    polnos: polnoLabel,
    polids: matches.map((m) => m.polid),
    built_from: pending.length === 0 ? "renewal" : "current",
    renewal_polids: terms.filter((t) => t.isRenewal).map((t) => t.current.polid),
    ...renewalDateFields(matches)
  }

  return {
    buffer, filename, archiveFilename, archiveEntry, includedSections, combining, polnoLabel,
    carrierCodes: [...new Set(perPolicyCoverage.flatMap((c) => c.carrierCodes))],
    renewalPendingPolnos: pending.map((p) => p.polno)
  }
}

// Builds and archives — shared by the cl_renewal_summary MCP tool and
// scripts/dailyClRenewalSummaries.ts, so the scheduled job files exactly what an on-demand request
// would. Resolution (which policies) stays with each caller.
export async function generateClRenewalSummary(matches: ResolvedPolicy[], clientName: string): Promise<GeneratedClRenewalSummary> {
  const { archiveEntry, ...generated } = await buildClRenewalSummary(matches, clientName)
  archiveClRenewalSummary(generated.buffer, archiveEntry)
  return generated
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

// Rebuilds an archived document in place — after a quote upload or deletion, or once a renewal term
// lands — from the same policy terms it was built from. Resolution goes back through
// resolveClPolicies (same in-force filter and joins as every other build) for the terms' customer,
// then keeps exactly the archived terms.
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
