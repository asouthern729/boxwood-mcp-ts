import { randomBytes } from "node:crypto"
import type { AmsLineExtraction, AmsProposalExtraction } from "./amsProposalExtraction.js"
import { buildClProposalDoc, type ServiceTeamMember } from "./clProposalDoc.js"
import { completeUmbrellas, overviewFor, periodLabel, SLOT_TITLES, type LineTable, type SlotLine } from "./clProposalLines.js"
import { executiveSummary, whyBoxwood } from "./clProposalText.js"
import { mergeQuotesIntoProposal, pageLabel, slotFor, type QuoteSource } from "./clQuoteMerge.js"
import { orderLines } from "./clRenewalSummaryGenerate.js"
import { sanitizeForFilename } from "./docArchive.js"
import type { ProposalAttachment } from "./proposalAttachments.js"
import type { ProposalCreator, ProposalEntry } from "./proposalBuilderArchive.js"
import { AGENCY } from "./proposalStyle.js"
import type { LocationRow } from "./riskProfileDoc.js"

// Builds a Proposal Builder document purely from uploaded files, in the CL Renewal Summary's
// Commercial Insurance Proposal layout (clProposalDoc.ts). An AMS360 proposal supplies the expiring
// program — sections, schedules, named insureds, locations and service team — and carrier quotes
// replace or add lines exactly as they do on a Renewal Summary (clQuoteMerge.ts: a quoted line takes
// over the same line from the same carrier, keeping the AMS360 schedules of what's insured). Built
// from quotes alone, every section comes from the quotes. No premiums anywhere (Andrew, 2026-10-10)
// — the AMS360 Premium Summary's expiring premiums are stored on the attachment, not printed.

const QUOTE_COMMENT = /^Added by Claude from uploaded quote/

// Columns never printed from an AMS360 table even if the extraction kept them: premium, and driver
// PII (date of birth, license number — same rule as the Pre-Renewal Review's driver schedule).
const DROPPED_COLUMN = /\bpremium\b(?!\s*basis)|\bdob\b|date of birth|birth ?date|licen[sc]e ?(#|no\b|num)/i

// AMS360 repeats a long value on every row (the Subjects of Insurance address, once per subject) —
// a column like that moves to one line under the table so the rows stay short (Andrew, 2026-10-10).
// Short repeated values (a state, an "x") stay in their column.
const REPEATED_MIN_ROWS = 3
const REPEATED_MIN_LENGTH = 16

function table(kind: LineTable["kind"], t: { title: string; headers: string; rows: string[] }): LineTable | null {
  const cells = (text: string) => text.split("|").map((cell) => cell.trim())
  const allHeaders = cells(t.headers)
  const printable = allHeaders.map((h) => !DROPPED_COLUMN.test(h))
  const allRows = t.rows.map((r) => cells(r)).filter((r) => r.some((c, i) => printable[i] && c && c !== "—"))
  if(allRows.length === 0 || !printable.some(Boolean)) return null

  const repeated = allHeaders.map((_, i) => printable[i]
    && allRows.length >= REPEATED_MIN_ROWS
    && (allRows[0][i] ?? "").length >= REPEATED_MIN_LENGTH
    && allRows.every((r) => r[i] === allRows[0][i]))
  const keep = printable.map((p, i) => p && !repeated[i])
  if(!keep.some(Boolean)) return null

  const notes = allHeaders.flatMap((h, i) => (repeated[i] ? [`${ h }: ${ allRows[0][i] } (all rows)`] : []))
  return {
    kind,
    title: t.title,
    headers: allHeaders.filter((_, i) => keep[i]),
    rows: allRows.map((r) => r.filter((_, i) => keep[i])),
    ...(notes.length > 0 ? { footnote: notes.join("; ") } : {})
  }
}

function amsComment(filename: string, pages: number[]): string {
  return `Added by Claude from uploaded AMS360 proposal "${ filename }"${ pageLabel(pages) }. Please verify against it before sending to the client.`
}

function amsLine(line: AmsLineExtraction, filename: string): SlotLine {
  const slot = line.line_of_business === "specialty_addon" ? "other" : slotFor(line)
  const carrier = line.carrier ?? line.writing_company ?? ""
  const withDeductible = line.limits.some((l) => l.deductible)

  const keyFacts: [string, string][] = [
    ...(carrier ? [["Carrier", carrier] as [string, string]] : []),
    ...(line.writing_company && line.writing_company !== carrier ? [["Writing Company", line.writing_company] as [string, string]] : []),
    ...line.key_facts.map((f): [string, string] => [f.label, f.value])
  ]

  const tables = [
    ...line.limit_schedules.map((t) => table("limits", t)),
    ...(line.limits.length > 0
      ? [{
          kind: "limits" as const,
          title: line.limit_schedules.length > 0 ? "Additional Coverage Limits" : "Coverage Limits",
          headers: withDeductible ? ["Coverage", "Limit", "Deductible"] : ["Coverage", "Limit"],
          rows: line.limits.map((l) => (withDeductible ? [l.coverage, l.limit, l.deductible ?? ""] : [l.coverage, l.limit])),
          fractions: withDeductible ? [0.5, 0.25, 0.25] : [0.6, 0.4]
        }]
      : []),
    ...line.exposure_schedules.map((t) => table("schedule", t))
  ].filter((t): t is LineTable => t !== null)

  return {
    slot,
    title: slot === "other" ? line.title : SLOT_TITLES[slot],
    carrier,
    polno: line.policy_number ?? "",
    period: line.policy_period ? periodLabel(line.policy_period) : "",
    overview: overviewFor(slot, line.title),
    keyFacts,
    tables,
    bulletGroups: line.endorsements.length > 0 ? [{ title: "Included Options & Endorsements", items: line.endorsements.map((e) => e.text) }] : [],
    comment: amsComment(filename, line.pages)
  }
}

function addressKey(l: LocationRow): string {
  return `${ l.address.toLowerCase().replace(/\broad\b/g, "rd").replace(/[^a-z0-9]/g, "") }|${ l.zip.slice(0, 5) }`
}

function amsLocations(amsSources: AmsProposalExtraction[]): LocationRow[] {
  const seen = new Map<string, LocationRow>()
  for(const l of amsSources.flatMap((a) => a.locations)) {
    const row = { locNo: l.loc_no, address: l.address, city: l.city, state: l.state, zip: l.zip.slice(0, 5) }
    if(!seen.has(addressKey(row))) seen.set(addressKey(row), row)
  }
  return [...seen.values()]
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, string>()
  for(const name of names.map((n) => n.trim()).filter(Boolean)) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "")
    if(!seen.has(key)) seen.set(key, name)
  }
  return [...seen.values()]
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for(const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
}

function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" }).format(new Date())
}

export class ProposalBuildError extends Error {}

export type BuildProposalInput = {
  attachments: ProposalAttachment[]
  creator: ProposalCreator
  // "Firstname Lastname" as the person told Claude in the chat — printed as Prepared By and, without
  // an AMS360 service team, the "Your Contact" row. Never the Auth0 identity (Andrew, 2026-10-10:
  // that printed "andrew@tyneside.io").
  preparedBy: string
  clientName?: string
  // Rebuilding an existing proposal keeps its filename and creation time.
  existing?: ProposalEntry
  refreshReason?: string
}

export async function buildProposal(input: BuildProposalInput): Promise<{ buffer: Buffer; entry: ProposalEntry; includedSections: string[] }> {
  const ready = input.attachments.filter((a) => a.status === "done")
  const amsSources = ready.filter((a) => a.ams).map((a) => ({ filename: a.filename, ams: a.ams! }))
  const quotes: QuoteSource[] = ready.filter((a) => a.quote).map((a) => ({ filename: a.filename, extraction: a.quote! }))
  if(amsSources.length === 0 && quotes.length === 0) throw new ProposalBuildError("None of these files has been read successfully, so there's nothing to build from.")

  const amsLines = amsSources.flatMap(({ filename, ams }) => ams.lines.map((line) => amsLine(line, filename)))
  const merged = mergeQuotesIntoProposal(amsLines, quotes)
  const lines = orderLines(merged.lines)
  completeUmbrellas(lines)

  const clientName = input.clientName?.trim()
    || input.existing?.client_name
    || amsSources.find((s) => s.ams.named_insured)?.ams.named_insured
    || quotes.find((q) => q.extraction.named_insured)?.extraction.named_insured
    || "Client"

  const periods = lines.map((l) => l.period).filter(Boolean)
  const policyPeriod = mostCommon(periods)
  const policyPeriodsDiffer = new Set(periods).size > 1
  for(const line of lines) {
    if(line.period && line.period !== policyPeriod) line.overview = `${ line.overview } Written for the policy period ${ line.period }.`.trim()
  }

  const locations = amsLocations(amsSources.map((s) => s.ams))
  const namedInsureds = uniqueNames([clientName, ...amsSources.flatMap((s) => [s.ams.named_insured ?? "", ...s.ams.additional_named_insureds])])
  const vehicleCount = lines
    .filter((l) => l.slot === "commercial_auto")
    .flatMap((l) => l.tables.filter((t) => t.kind === "schedule" && /vehicle/i.test(t.title)))
    .reduce((n, t) => n + t.rows.length, 0)

  const narrativeFacts = {
    clientName,
    lines,
    policyPeriod,
    policyPeriodsDiffer,
    // With quotes it presents the renewal program; from an AMS360 proposal alone, the current one.
    isRenewal: quotes.length > 0,
    locationStates: locations.map((l) => l.state).filter(Boolean),
    locationCount: locations.length,
    vehicleCount,
    namedInsuredCount: namedInsureds.length
  }

  const amsTeam = amsSources.flatMap((s) => s.ams.service_team)
  const serviceTeam: ServiceTeamMember[] = [
    ...(amsTeam.length > 0
      ? amsTeam.map((m) => ({ role: m.role, name: m.name, phone: m.phone ?? AGENCY.phone, email: m.email ?? "" }))
      : [{ role: "Your Contact", name: input.preparedBy, phone: AGENCY.phone, email: "" }]),
    { role: "Agency", name: AGENCY.name, phone: AGENCY.phone, email: AGENCY.website }
  ]

  const { buffer, includedSections } = await buildClProposalDoc({
    clientName,
    clientAddress: amsSources.find((s) => s.ams.mailing_address)?.ams.mailing_address ?? "",
    policyPeriod: policyPeriod || "See individual coverage sections",
    policyPeriodsDiffer,
    allTermsCurrent: quotes.length === 0,
    quoteNote: merged.quoteNote,
    preparedBy: { name: input.preparedBy, email: "", phone: AGENCY.phone },
    proposalDate: todayInChicago(),
    executiveSummary: executiveSummary(narrativeFacts),
    namedInsureds,
    locations,
    lines,
    bindConditions: {
      items: [...merged.bindConditions.items, ...amsSources.flatMap((s) => s.ams.subject_to.map((c) => c.text))],
      comment: merged.bindConditions.comment
    },
    specialtyAddOns: merged.specialtyAddOns,
    whyBoxwood: whyBoxwood(narrativeFacts),
    serviceTeam
  })

  const now = new Date().toISOString()
  const entry: ProposalEntry = {
    filename: input.existing?.filename ?? `${ sanitizeForFilename(clientName) }_Proposal_${ randomBytes(4).toString("hex") }.docx`,
    client_name: clientName,
    line_type: "commercial",
    created_by: input.existing?.created_by ?? input.creator,
    prepared_by: input.preparedBy,
    generated_at: input.existing?.generated_at ?? now,
    ...(input.existing ? { last_refreshed_at: now, last_refresh_reason: input.refreshReason ?? "Rebuilt" } : {}),
    sections: [
      ...lines.map((l) => ({ title: l.title, carrier: l.carrier, source: QUOTE_COMMENT.test(l.comment ?? "") ? "quote" as const : "ams" as const })),
      ...merged.specialtyAddOns.map((a) => ({ title: a.title, carrier: "", source: "quote" as const }))
    ],
    sources: input.attachments.map((a) => ({ id: a.id, filename: a.filename, kind: a.kind }))
  }

  return { buffer, entry, includedSections }
}
