import { randomBytes } from "node:crypto"
import type { AmsLineExtraction, AmsProposalExtraction } from "./amsProposalExtraction.js"
import { buildClProposalDoc, type ProposalPremiumSummary, type ServiceTeamMember } from "./clProposalDoc.js"
import { carrierKey, completeUmbrellas, overviewFor, periodLabel, SLOT_TITLES, type LinePremium, type LineTable, type SlotLine } from "./clProposalLines.js"
import { whyBoxwood } from "./clProposalText.js"
import { extractedTable, mergeQuotesIntoProposal, pageLabel, slotFor, type QuoteSource } from "./clQuoteMerge.js"
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
// from quotes alone, every section comes from the quotes, GL class, vehicle and driver schedules
// included.
//
// Patrick's Landon feedback (2026-10-18), against his insurance-proposal skill's version of the same
// proposal: a Premium Summary (premiums were left out until then, Andrew 2026-10-10), schedules of
// exposures, vehicles and drivers, and a more condensed document — no Executive Summary page, excess
// layers in one section side by side, no administrative key facts.

const QUOTE_COMMENT = /^Added by Claude from uploaded quote/

function amsComment(filename: string, pages: number[]): string {
  return `Added by Claude from uploaded AMS360 proposal "${ filename }"${ pageLabel(pages) }. Please verify against it before sending to the client.`
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2)

// The AMS360 Premium Summary names lines its own way ("Commercial General Liability", "Business
// Auto"): the row sharing the most words with the section's title, preferring the same company.
function amsPremium(line: AmsLineExtraction, premiums: AmsProposalExtraction["expiring_premiums"]): LinePremium | undefined {
  const title = new Set(words(line.title))
  const carrier = carrierKey(line.carrier ?? line.writing_company ?? "")
  const best = premiums
    .filter((p) => p.premium)
    .map((p) => ({ p, score: words(p.line).filter((w) => title.has(w)).length * 2 + (p.company && carrierKey(p.company) === carrier ? 1 : 0) }))
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score)[0]
  if(!best) return undefined
  const amount = Number(best.p.premium!.replace(/[$,\s]/g, ""))
  return { amount: Number.isFinite(amount) ? amount : null, note: null, current: true }
}

function amsLine(line: AmsLineExtraction, filename: string, premiums: AmsProposalExtraction["expiring_premiums"]): SlotLine {
  const slot = line.line_of_business === "specialty_addon" ? "other" : slotFor(line)
  const carrier = line.carrier ?? line.writing_company ?? ""
  const withDeductible = line.limits.some((l) => l.deductible)

  const keyFacts: [string, string][] = [
    ...(carrier ? [["Carrier", carrier] as [string, string]] : []),
    ...(line.writing_company && line.writing_company !== carrier ? [["Writing Company", line.writing_company] as [string, string]] : []),
    ...line.key_facts.map((f): [string, string] => [f.label, f.value])
  ]

  const tables = [
    ...line.limit_schedules.map((t) => extractedTable("limits", t)),
    ...(line.limits.length > 0
      ? [{
          kind: "limits" as const,
          title: line.limit_schedules.length > 0 ? "Additional Coverage Limits" : "Coverage Limits",
          headers: withDeductible ? ["Coverage", "Limit", "Deductible"] : ["Coverage", "Limit"],
          rows: line.limits.map((l) => (withDeductible ? [l.coverage, l.limit, l.deductible ?? ""] : [l.coverage, l.limit])),
          fractions: withDeductible ? [0.5, 0.25, 0.25] : [0.6, 0.4]
        }]
      : []),
    ...line.exposure_schedules.map((t) => extractedTable("schedule", t))
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
    premium: amsPremium(line, premiums),
    comment: amsComment(filename, line.pages)
  }
}

// ---------- Condensing ----------

// Key facts a client doesn't need (Patrick's Landon example leaves them all out). Minimum premium and
// audit terms are left to Bind Conditions & Notes, where the quotes already state them.
const ADMIN_FACT = /carrier status|^premises\b|payment (options?|plans?)|syndicate|^umr$|number of employees|premium discount|description of risk|billing|minimum (earned )?premium|audit/i

function dropAdminFacts(lines: SlotLine[]): void {
  for(const line of lines) line.keyFacts = line.keyFacts.filter(([label]) => !ADMIN_FACT.test(label))
}

// Each quote is read on its own, so the same condition arrives once per quote ("Quote expires
// 11/08/2026" three times for Landon). A condition is dropped when another says the same thing or
// more; quote validity is already on the cover.
const QUOTE_VALIDITY = /^quotes? (expires?|valid)[^;.]*\.?$/i

function condensedConditions(items: string[], hasQuoteNote: boolean): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const kept = items.filter((item) => !(hasQuoteNote && QUOTE_VALIDITY.test(item.trim())))
  return kept.filter((item, i) => {
    const n = norm(item)
    return !kept.some((other, j) => j !== i && (norm(other) === n ? j < i : norm(other).includes(n)))
  })
}

// "Policy Form" (read from the quote's form field) and "Coverage Form" (a key fact) are the same row.
const FIELD_ALIASES: Record<string, string> = { "Policy Form": "Coverage Form" }

const dollars = (text: string | undefined) => Number(text?.match(/\$?\s*([\d,]+(?:\.\d+)?)/)?.[1]?.replace(/,/g, "") ?? Number.NaN)
const money = (n: number, cents = false) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })

function limitRow(line: SlotLine, pattern: RegExp): string | undefined {
  return line.tables.filter((t) => t.kind === "limits").flatMap((t) => t.rows).find((r) => pattern.test(r[0]))?.[1]
}

// Excess layers in attachment order: the smaller each-occurrence limit sits lower.
function excessLayers(lines: SlotLine[]): SlotLine[] {
  const layers = lines.filter((l) => l.slot === "umbrella_excess")
  return layers.length < 2 ? layers : [...layers].sort((a, b) => (dollars(limitRow(a, /occurrence/i)) || 0) - (dollars(limitRow(b, /occurrence/i)) || 0))
}

function layerLabel(line: SlotLine, index: number): string {
  const occurrence = limitRow(line, /occurrence/i)
  return `Excess Liability – Layer ${ index + 1 }${ occurrence ? ` (${ occurrence })` : "" }`
}

// Two or more excess layers become one section with the layers side by side (Patrick's Landon
// example). Runs before completeUmbrellas, which then adds the primary underlying lines.
function combineExcessLayers(lines: SlotLine[]): { lines: SlotLine[]; layerBelow?: { label: string; carrier: string; limit: string } } {
  const layers = excessLayers(lines)
  if(layers.length < 2) return { lines }

  const occurrence = layers.map((l) => limitRow(l, /occurrence/i))
  const aggregate = layers.map((l) => limitRow(l, /aggregate/i))
  const cell = (values: (string | undefined)[]) => values.map((v) => v || "—")

  // Every other fact or limit, one row each, so nothing a layer carried is lost.
  const otherRows = new Map<string, (string | undefined)[]>()
  layers.forEach((layer, i) => {
    const facts: [string, string][] = [
      ...layer.keyFacts.filter(([label]) => label !== "Carrier"),
      ...layer.tables.filter((t) => t.kind === "limits").flatMap((t) => t.rows).filter((r) => !/occurrence|aggregate/i.test(r[0])).map((r): [string, string] => [r[0], r.slice(1).filter(Boolean).join(" / ")])
    ]
    for(const [rawLabel, value] of facts) {
      const label = FIELD_ALIASES[rawLabel] ?? rawLabel
      if(!otherRows.has(label)) otherRows.set(label, layers.map(() => undefined))
      otherRows.get(label)![i] ??= value
    }
  })
  const periods = layers.map((l) => l.period)

  const details: LineTable = {
    kind: "limits",
    title: "Excess Policy Details",
    headers: ["Field", ...layers.map((_, i) => `Excess Layer ${ i + 1 }`)],
    rows: [
      ["Carrier", ...cell(layers.map((l) => l.carrier))],
      ["Each Occurrence Limit", ...cell(occurrence)],
      ["Annual Aggregate Limit", ...cell(aggregate)],
      ...(new Set(periods).size > 1 ? [["Policy Period", ...cell(periods)]] : []),
      ...[...otherRows].map(([label, values]) => [label, ...cell(values)])
    ],
    fractions: [0.28, ...layers.map(() => 0.72 / layers.length)]
  }

  const groups = new Map<string, Set<string>>()
  for(const group of layers.flatMap((l) => l.bulletGroups)) {
    if(!groups.has(group.title)) groups.set(group.title, new Set())
    group.items.forEach((item) => groups.get(group.title)!.add(item))
  }

  const amounts = occurrence.map(dollars)
  const overview = amounts.every((n) => n > 0)
    ? `Excess liability adds ${ layers.length } layers of limits above the primary liability policies – ${ occurrence.join(" followed by ") } – for ${ money(amounts.reduce((a, b) => a + b, 0)) } of excess limits in total.`
    : ""

  const combined: SlotLine = {
    slot: "umbrella_excess",
    title: SLOT_TITLES.umbrella_excess,
    carrier: layers[0].carrier,
    polno: "",
    period: layers[0].period,
    overview,
    keyFacts: [],
    tables: [details, ...layers.flatMap((l) => l.tables.filter((t) => t.kind === "schedule" && t.title !== "Underlying Coverage Schedule"))],
    bulletGroups: [...groups].map(([title, items]) => ({ title, items: [...items] })),
    comment: [...new Set(layers.map((l) => l.comment).filter(Boolean))].join(" ")
  }

  const first = lines.findIndex((l) => l.slot === "umbrella_excess")
  const rest = lines.filter((l) => l.slot !== "umbrella_excess")
  rest.splice(first, 0, combined)

  const below = layers[layers.length - 2]
  const belowIndex = layers.length - 2
  return {
    lines: rest,
    layerBelow: {
      label: `Excess Layer ${ belowIndex + 1 } (underlying to Layer ${ belowIndex + 2 })`,
      carrier: below.carrier,
      limit: [occurrence[belowIndex] && `${ occurrence[belowIndex] } each occurrence`, aggregate[belowIndex] && `${ aggregate[belowIndex] } aggregate`].filter(Boolean).join(" / ")
    }
  }
}

// ---------- Premium Summary ----------

function premiumSummary(lines: SlotLine[]): ProposalPremiumSummary | undefined {
  const priced = lines.filter((l) => l.premium)
  if(!priced.some((l) => l.premium!.amount !== null)) return undefined

  const layers = excessLayers(lines)
  const label = (line: SlotLine) => {
    const layer = layers.length > 1 ? layers.indexOf(line) : -1
    const title = layer >= 0 ? layerLabel(line, layer) : line.title
    return line.premium?.current ? `${ title } (current)` : title
  }

  const rows: [string, string, string][] = lines.map((l) => [
    label(l),
    l.carrier,
    l.premium?.amount != null ? money(l.premium.amount, true) : l.premium && !l.premium.current ? "See quote options" : "Not shown"
  ])
  const total = lines.reduce((sum, l) => sum + (l.premium?.amount ?? 0), 0)

  const unpriced = lines.filter((l) => l.premium?.amount == null).map((l) => l.title)
  const current = lines.some((l) => l.premium?.current)
  const notes = [
    "Quoted amounts are the annual totals shown on each quote, including taxes and fees where the quote's total includes them.",
    ...(current ? ["Lines marked (current) show the current premium from the AMS360 proposal."] : []),
    ...(unpriced.length > 0 ? [`The total excludes ${ unpriced.join(", ") }, which ${ unpriced.length > 1 ? "have" : "has" } no premium shown.`] : []),
    "All amounts are estimates, subject to change at binding."
  ]

  // The quotes' own premium notes (what the total includes, pay-in-full discounts, audit) can carry
  // reviewer remarks, so they go to the account manager in the comment, not to the client.
  const quoteNotes = lines.filter((l) => l.premium?.note).map((l) => `${ label(l) }: ${ l.premium!.note }`)
  return {
    rows,
    total: money(total, true),
    notes,
    comment: `Premiums added by Claude from the uploaded files — please verify each against its quote before sending.${ quoteNotes.length > 0 ? ` Quote notes: ${ quoteNotes.join(" | ") }` : "" }`
  }
}

// ---------- Helpers ----------

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

// Every section's review comment names the file it came from ("…uploaded quote "x.pdf" (pages …)").
function sourceFile(comment: string | undefined): string | undefined {
  return comment?.match(/"([^"]+)"/)?.[1]
}

const sectionKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, "")

export class ProposalBuildError extends Error {}

export type BuildProposalInput = {
  attachments: ProposalAttachment[]
  creator: ProposalCreator
  // "Firstname Lastname" as the person told Claude in the chat — printed as Prepared By and, without
  // an AMS360 service team, the "Your Contact" row. Never the Auth0 identity (Andrew, 2026-10-10:
  // that printed "andrew@tyneside.io").
  preparedBy: string
  clientName?: string
  // Section titles to leave out. Undefined keeps an existing proposal's earlier choice.
  omitSections?: string[]
  // Rebuilding an existing proposal keeps its filename and creation time.
  existing?: ProposalEntry
  refreshReason?: string
}

export async function buildProposal(input: BuildProposalInput): Promise<{ buffer: Buffer; entry: ProposalEntry; includedSections: string[] }> {
  const ready = input.attachments.filter((a) => a.status === "done")
  const amsSources = ready.filter((a) => a.ams).map((a) => ({ filename: a.filename, ams: a.ams! }))
  const quotes: QuoteSource[] = ready.filter((a) => a.quote).map((a) => ({ filename: a.filename, extraction: a.quote! }))
  if(amsSources.length === 0 && quotes.length === 0) throw new ProposalBuildError("None of these files has been read successfully, so there's nothing to build from.")

  const amsLines = amsSources.flatMap(({ filename, ams }) => ams.lines.map((line) => amsLine(line, filename, ams.expiring_premiums)))
  const merged = mergeQuotesIntoProposal(amsLines, quotes, { withExposures: true })

  const omitted = (input.omitSections ?? input.existing?.omitted_sections ?? []).map((t) => t.trim()).filter(Boolean)
  const omittedKeys = new Set(omitted.map(sectionKey))
  const kept = orderLines(merged.lines).filter((l) => !omittedKeys.has(sectionKey(l.title)))
  dropAdminFacts(kept)

  // An omitted line's own bind conditions go with it (Landon's cyber application), unless a kept
  // line states the same condition.
  const quoteLines = quotes.flatMap((q) => q.extraction.lines)
  const lineTitles = (l: typeof quoteLines[number]) => [l.title, l.line_of_business === "specialty_addon" ? l.title : SLOT_TITLES[slotFor(l)]].map(sectionKey)
  const omittedOnly = new Set(quoteLines.filter((l) => lineTitles(l).some((t) => omittedKeys.has(t))).flatMap((l) => l.bind_conditions.map((c) => c.text)))
  for(const l of quoteLines.filter((l) => !lineTitles(l).some((t) => omittedKeys.has(t)))) l.bind_conditions.forEach((c) => omittedOnly.delete(c.text))
  const premiums = premiumSummary(kept)

  const { lines, layerBelow } = combineExcessLayers(kept)
  completeUmbrellas(lines)
  if(layerBelow) {
    lines.find((l) => l.slot === "umbrella_excess")?.tables.find((t) => t.title === "Underlying Coverage Schedule")?.rows.push([layerBelow.label, layerBelow.carrier, layerBelow.limit])
  }

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
    executiveSummary: null,
    namedInsureds,
    locations,
    lines,
    bindConditions: {
      items: condensedConditions([...merged.bindConditions.items.filter((c) => !omittedOnly.has(c)), ...amsSources.flatMap((s) => s.ams.subject_to.map((c) => c.text))], Boolean(merged.quoteNote)),
      comment: merged.bindConditions.comment
    },
    premiumSummary: premiums,
    specialtyAddOns: merged.specialtyAddOns.filter((a) => !omittedKeys.has(sectionKey(a.title))),
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
      ...lines.map((l) => ({ title: l.title, carrier: l.carrier, source: QUOTE_COMMENT.test(l.comment ?? "") ? "quote" as const : "ams" as const, source_file: sourceFile(l.comment) })),
      ...merged.specialtyAddOns.map((a) => ({ title: a.title, carrier: "", source: "quote" as const, source_file: sourceFile(a.comment) }))
    ],
    ...(omitted.length > 0 ? { omitted_sections: omitted } : {}),
    sources: input.attachments.map((a) => ({ id: a.id, filename: a.filename, kind: a.kind }))
  }

  return { buffer, entry, includedSections }
}
