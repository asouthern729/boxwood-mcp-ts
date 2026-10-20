import { SLOT_TITLES, carrierKey, overviewFor, periodLabel } from "./clProposalLines.js"
import type { LineTable, SlotLine, UnderlyingEntry } from "./clProposalLines.js"
import type { LineSlot } from "./clCoverageData.js"
import type { ProposalSpecialtyAddOn } from "./clProposalDoc.js"
import type { LineOfBusiness, QuoteExtraction, QuoteLineExtraction } from "./quoteExtraction.js"

// Puts uploaded-quote extractions (quoteExtraction.ts) into the CL Renewal Summary's proposal layout
// (clProposalDoc.ts). This is the one template-specific piece of the quote-upload feature;
// extraction, storage, and the upload routes don't know about the layout.
//
// Rules:
//   - A quoted line takes over the AMS360 section for the same line of business from the same
//     carrier (or one with no carrier on file): carrier, A.M. Best,
//     form and key facts, limits, highlights and exclusions come from the quote (the quote is the
//     renewal; AMS360 may still hold only the expiring term). AMS360's schedules of what's insured —
//     locations, classes, vehicles, drivers, payroll, the umbrella's underlying schedule — stay.
//   - A quoted line with no such AMS360 section is added in the skill's line order, under the quote's
//     own title when the line already has a section from another carrier (Patrick's TN Equine
//     example: American Modern dwelling fire beside Cincinnati property); a stand-alone add-on
//     (specialty_addon) becomes its own Section 5 add-on.
//   - The CL Renewal Summary never shows premiums — its Premium Summary page is dropped (Patrick,
//     2026-10-07). Each quoted line still carries its premium (SlotLine.premium) for the Proposal
//     Builder's Premium Summary (Patrick, 2026-10-18).
//   - With withExposures (the Proposal Builder), a quoted line with no AMS360 schedules gets the
//     quote's own GL class, vehicle and driver tables — built from quotes alone, nothing else
//     supplies them (Patrick's Landon proposal, 2026-10-18).
//   - Bind conditions from every quote are gathered into one "Bind Conditions & Notes" section, and
//     each quote's number/expiry into the cover's validity note — Patrick's example does both.
//   - When two uploads quote the same line, the later upload wins.
//   - Every section built from a quote carries a Word comment naming the file and pages, so the
//     account manager verifies it before the document goes to the client (Andrew, 2026-10-01).

const SLOT_BY_LINE: Record<Exclude<LineOfBusiness, "specialty_addon">, LineSlot> = {
  property: "property",
  general_liability: "general_liability",
  liquor_liability: "liquor_liability",
  inland_marine: "inland_marine",
  commercial_auto: "commercial_auto",
  workers_comp: "workers_comp",
  employee_benefits_liability: "employee_benefits_liability",
  umbrella_excess: "umbrella_excess",
  directors_officers: "directors_officers",
  cyber: "cyber",
  epli: "epli",
  professional_liability: "professional_liability",
  other: "other"
}

// The extraction schema has no crime line, so a quoted crime/fidelity line arrives as "other" —
// matched to the Crime section by its title (Cincinnati's TN Equine quote, 2026-10-08).
const CRIME_TITLE = /crime|fidelity|employee (theft|dishonesty)/i

export function slotFor(line: Pick<QuoteLineExtraction, "line_of_business" | "title">): LineSlot {
  if(line.line_of_business === "other" && CRIME_TITLE.test(line.title)) return "crime"
  return SLOT_BY_LINE[line.line_of_business as Exclude<LineOfBusiness, "specialty_addon">]
}

// A quoted line with no coverage of its own to show gets no section — Cincinnati's "Terrorism"
// line is a TRIA charge, a one-line scope note and a bind condition. Its bind conditions still go to
// Bind Conditions & Notes.
function hasContent(line: QuoteLineExtraction): boolean {
  return line.limits.length > 0 || (line.schedules ?? []).length > 0 || line.enhancements.length > 0 || (line.exclusions ?? []).length > 0
}

export type QuoteSource = { filename: string; extraction: QuoteExtraction }

export type MergedProposal = {
  lines: SlotLine[]
  bindConditions: { items: string[]; comment?: string }
  specialtyAddOns: ProposalSpecialtyAddOn[]
  quoteNote?: string
}

export function pageLabel(pages: number[]): string {
  const sorted = [...new Set(pages)].filter((p) => p > 0).sort((a, b) => a - b)
  if(sorted.length === 0) return ""
  if(sorted.length === 1) return ` (page ${ sorted[0] })`

  // Collapse runs: 2,3,4,7 → "pages 2–4, 7"
  const runs: string[] = []
  let start = sorted[0]
  let prev = sorted[0]

  for(const page of [...sorted.slice(1), Number.NaN]) {
    if(page === prev + 1) {
      prev = page
      continue
    }
    runs.push(start === prev ? `${ start }` : `${ start }–${ prev }`)
    start = page
    prev = page
  }

  return ` (pages ${ runs.join(", ") })`
}

function verifyComment(filename: string, pages: number[]): string {
  return `Added by Claude from uploaded quote "${ filename }"${ pageLabel(pages) }. Please verify against the quote before sending to the client.`
}

// Vehicles and the umbrella's underlying lines come from AMS360's own schedules — the extractor
// lists them as key facts ("Vehicle 3", "Underlying: General Liability"), which would repeat them.
const SCHEDULE_FACT = /^(vehicle\b|underlying\b)/i

function quoteKeyFacts(line: QuoteLineExtraction, tabled: Set<string>): [string, string][] {
  const keyFacts: [string, string][] = []
  if(line.carrier) keyFacts.push(["Carrier", line.carrier])
  if(line.am_best_rating) keyFacts.push(["A.M. Best Rating", line.am_best_rating])
  if(line.policy_form) keyFacts.push(["Policy Form", line.policy_form])
  if(line.retroactive_date) keyFacts.push(["Retroactive Date", line.retroactive_date])
  for(const fact of line.key_facts) {
    if(!SCHEDULE_FACT.test(fact.label) && !tabled.has(fact.label)) keyFacts.push([fact.label, fact.value])
  }
  return keyFacts
}

// Columns never printed from an extracted table even if the extraction kept them: premium, and driver
// PII (date of birth, license number — same rule as the Pre-Renewal Review's driver schedule).
const DROPPED_COLUMN = /\bpremium\b(?!\s*basis)|\bdob\b|date of birth|birth ?date|licen[sc]e ?(#|no\b|num)|\bpoints\b|violation/i

// AMS360 repeats a long value on every row (the Subjects of Insurance address, once per subject) —
// a column like that moves to one line under the table so the rows stay short (Andrew, 2026-10-10).
// Short repeated values (a state, an "x") stay in their column.
const REPEATED_MIN_ROWS = 3
const REPEATED_MIN_LENGTH = 16

// An extracted " | "-joined table as a LineTable, without dropped columns or empty rows.
export function extractedTable(kind: LineTable["kind"], t: { title: string; headers: string; rows: string[] }): LineTable | null {
  const cells = (text: string) => text.split("|").map((cell) => cell.trim())
  const allHeaders = cells(t.headers)
  const printable = allHeaders.map((h) => !DROPPED_COLUMN.test(h))
  const filled = (c: string | undefined) => Boolean(c) && c !== "—"
  const rowsWithData = t.rows.map((r) => cells(r)).filter((r) => r.some((c, i) => printable[i] && filled(c)))
  // A column the extraction left blank on every row (a quote's drivers with no license state) is dropped.
  allHeaders.forEach((_, i) => { if(!rowsWithData.some((r) => filled(r[i]))) printable[i] = false })
  const allRows = rowsWithData
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

// Quotes extracted before the exposure tables (2026-10-20) list classes, vehicles and drivers as key facts:
//   "Classification 91583 (Loc 1)": "Contractors - subcontracted work - …; Premium Base O, 20000000"
//   "Vehicle 1": "2019 FORD F350, VIN 1FD8W3HT1KEF51492; Stated Amount $70,000 (…)"
//   "Rated Drivers": "Jimmie Johnson (9 points); Yohana Asgedom (0 points)"
const EXPOSURE_TITLE = /^exposure:\s*/i
const CLASS_FACT = /^Classification (\d{4,6})\b/i
const VEHICLE_FACT = /^Vehicle (\d+)$/i
const DRIVERS_FACT = /^(rated )?drivers$/i

function exposureFromFacts(line: QuoteLineExtraction): { tables: LineTable[]; tabled: Set<string> } {
  const tabled = new Set<string>()
  const tables: LineTable[] = []

  const classes = line.key_facts.flatMap((f) => {
    const code = f.label.match(CLASS_FACT)?.[1]
    if(!code) return []
    tabled.add(f.label)
    const [description, base = ""] = f.value.split(/;\s*Premium Base\s*/i)
    const basis = base.match(/\(([^)]+)\)/)?.[1] ?? base.replace(/[\d,.\s]+$/, "").replace(/,$/, "").trim()
    const amount = base.match(/([\d,.]+)\s*$/)?.[1]?.replace(/,/g, "")
    const exposure = amount && Number(amount) > 0 ? `${ /payroll|cost|sales|receipts/i.test(basis) ? "$" : "" }${ Number(amount).toLocaleString("en-US") }` : ""
    return [[code, description.trim(), basis, exposure]]
  })
  if(classes.length > 0) {
    tables.push({ kind: "schedule", title: "Classification & Exposure Schedule", headers: ["Class Code", "Description", "Basis", "Estimated Exposure"], rows: classes, fractions: [0.12, 0.54, 0.14, 0.2] })
  }

  const vehicles = line.key_facts.flatMap((f) => {
    const no = f.label.match(VEHICLE_FACT)?.[1]
    if(!no) return []
    tabled.add(f.label)
    const [head, ...rest] = f.value.split(";").map((p) => p.trim())
    const vin = head.match(/,?\s*VIN:?\s*([A-HJ-NPR-Z0-9]{11,17})/i)
    const detail = rest.filter((p) => !/^no .* shown$/i.test(p)).join("; ")
    const description = [(vin ? head.replace(vin[0], "") : head).trim(), detail].filter(Boolean).join(" – ")
    return [[no, description, vin?.[1] ?? ""]]
  })
  if(vehicles.length > 0) {
    tables.push({ kind: "schedule", title: "Scheduled Vehicle Coverage", headers: ["Veh. No.", "Vehicle Description", "VIN"], rows: vehicles, fractions: [0.1, 0.6, 0.3] })
  }

  const drivers = line.key_facts.find((f) => DRIVERS_FACT.test(f.label))
  if(drivers) {
    tabled.add(drivers.label)
    const names = drivers.value.split(/;|,(?![^(]*\))/).map((n) => n.replace(/\([^)]*\)/g, "").trim()).filter(Boolean)
    tables.push({ kind: "schedule", title: "Scheduled Drivers", headers: ["Driver No.", "Name"], rows: names.map((n, i) => [`${ i + 1 }`, n]), fractions: [0.2, 0.8] })
  }

  return { tables, tabled }
}

// The quote's own exposure tables, plus any still listed as key facts (older extractions; a table
// the quote already gives isn't rebuilt from facts).
function quoteExposures(line: QuoteLineExtraction): { tables: LineTable[]; tabled: Set<string> } {
  const extracted = (line.schedules ?? [])
    .filter((s) => EXPOSURE_TITLE.test(s.title))
    .map((s) => extractedTable("schedule", { ...s, title: s.title.replace(EXPOSURE_TITLE, "") }))
    .filter((t): t is LineTable => t !== null)
  const fromFacts = exposureFromFacts(line)
  return { tables: [...extracted, ...fromFacts.tables.filter((t) => !extracted.some((e) => e.title === t.title))], tabled: fromFacts.tabled }
}

// Per-location tables first (they carry most of a property quote), then the policy-wide limits.
// Exposure tables are left to quoteExposures.
function quoteLimitsTable(line: QuoteLineExtraction): LineTable[] {
  const cells = (text: string) => text.split("|").map((cell) => cell.trim())
  const schedules: LineTable[] = (line.schedules ?? [])
    .filter((s) => s.headers.trim() !== "" && s.rows.length > 0 && !EXPOSURE_TITLE.test(s.title))
    .map((s) => ({ kind: "limits", title: s.title, headers: cells(s.headers), rows: s.rows.map(cells) }))
  if(line.limits.length === 0) return schedules
  const withDeductible = line.limits.some((l) => l.deductible)
  return [...schedules, {
    kind: "limits",
    title: schedules.length > 0 ? "Additional Coverage Limits" : "Coverage Limits",
    headers: withDeductible ? ["Coverage", "Limit", "Deductible"] : ["Coverage", "Limit"],
    rows: line.limits.map((l) => (withDeductible ? [l.coverage, l.limit, l.deductible ?? ""] : [l.coverage, l.limit])),
    fractions: withDeductible ? [0.5, 0.25, 0.25] : [0.6, 0.4]
  }]
}

function quoteBulletGroups(line: QuoteLineExtraction) {
  return [
    { title: line.enhancement_package_name ? `${ line.enhancement_package_name } Highlights` : "Notable Enhancements & Endorsements", items: line.enhancements.map((e) => e.text) },
    { title: "Notable Exclusions", items: (line.exclusions ?? []).map((e) => e.text) }
  ].filter((g) => g.items.length > 0)
}

// What the umbrella's underlying schedule should say for a quoted line that replaces AMS360's.
function quoteUnderlying(slot: LineSlot, line: QuoteLineExtraction, carrier: string): UnderlyingEntry | undefined {
  const find = (pattern: RegExp) => line.limits.find((l) => pattern.test(l.coverage))?.limit
  if(slot === "general_liability") {
    const occurrence = find(/occurrence/i)
    const aggregate = find(/general aggregate/i)
    if(occurrence) return { line: SLOT_TITLES.general_liability, carrier, limit: aggregate ? `${ occurrence } each occurrence / ${ aggregate } general aggregate` : `${ occurrence } each occurrence` }
  }
  if(slot === "commercial_auto") {
    const csl = find(/combined single|csl|liability/i)
    if(csl) return { line: SLOT_TITLES.commercial_auto, carrier, limit: /csl/i.test(csl) ? csl : `${ csl } CSL` }
  }
  if(slot === "workers_comp") {
    const el = line.limits.filter((l) => /employer/i.test(l.coverage)).map((l) => l.limit)
    if(el.length > 0) return { line: "Workers' Compensation – Employers Liability", carrier, limit: el.join(" / ") }
  }
  return undefined
}

function sameCarrier(line: SlotLine, quoted: QuoteLineExtraction): boolean {
  if(!line.carrier || !quoted.carrier) return true
  return carrierKey(line.carrier) === carrierKey(quoted.carrier)
}

function applyQuote(existing: SlotLine | undefined, slot: LineSlot, line: QuoteLineExtraction, filename: string, ownTitle: boolean, withExposures: boolean): SlotLine {
  const carrier = line.carrier ?? existing?.carrier ?? ""
  const amsSchedules = existing?.tables.filter((t) => t.kind === "schedule" && t.title !== "Underlying Coverage Schedule") ?? []
  // AMS360's schedules win; the quote's own only fill in when AMS360 has none for this line.
  const quoted = withExposures && amsSchedules.length === 0 ? quoteExposures(line) : { tables: [], tabled: new Set<string>() }
  const schedules = [...amsSchedules, ...quoted.tables]

  return {
    slot,
    title: existing?.title ?? (slot === "other" || ownTitle ? line.title : SLOT_TITLES[slot]),
    carrier,
    polno: existing?.polno ?? "",
    period: line.policy_period ? periodLabel(line.policy_period) : existing?.period ?? "",
    // A second carrier's section for the same line (dwelling fire beside commercial property) isn't
    // what the line's standard overview describes.
    overview: existing?.overview ?? overviewFor(ownTitle ? "other" : slot, line.title),
    keyFacts: quoteKeyFacts(line, quoted.tabled),
    tables: [...quoteLimitsTable(line), ...schedules],
    // AMS360's per-vehicle coverage notes describe the expiring term, not the quote.
    bulletGroups: quoteBulletGroups(line),
    underlying: quoteUnderlying(slot, line, carrier) ?? existing?.underlying,
    premium: { amount: line.annual_premium, note: line.premium_note },
    comment: verifyComment(filename, line.pages)
  }
}

function specialtyAddOn(line: QuoteLineExtraction, filename: string): ProposalSpecialtyAddOn {
  return {
    title: line.title,
    paragraph: `${ line.title }${ line.carrier ? ` from ${ line.carrier }` : "" } is written separately from the rest of the program and responds as described below.`,
    terms: [
      ["Coverage Type", line.title],
      ...(line.carrier ? [["Carrier", line.carrier] as [string, string]] : []),
      ...(line.policy_period ? [["Policy Period", line.policy_period] as [string, string]] : []),
      ...line.key_facts.map((f): [string, string] => [f.label, f.value]),
      ...line.limits.map((l): [string, string] => [l.coverage, l.deductible ? `${ l.limit } (deductible ${ l.deductible })` : l.limit])
    ],
    comment: verifyComment(filename, line.pages)
  }
}

function quoteNote(quotes: QuoteSource[]): string | undefined {
  const notes = quotes.flatMap(({ extraction }) => {
    const carrier = extraction.lines.find((l) => l.carrier)?.carrier
    if(!extraction.quote_number && !extraction.quote_expiration_date) return []
    const label = [carrier, "quote", extraction.quote_number && `#${ extraction.quote_number }`].filter(Boolean).join(" ")
    return [extraction.quote_expiration_date ? `${ label } – valid through ${ extraction.quote_expiration_date }` : label]
  })
  return notes.length > 0 ? `${ [...new Set(notes)].join("; ") }.` : undefined
}

export function mergeQuotesIntoProposal(lines: SlotLine[], quotes: QuoteSource[], { withExposures = false } = {}): MergedProposal {
  if(quotes.length === 0) return { lines, bindConditions: { items: [] }, specialtyAddOns: [] }

  // Later uploads win per line of business and carrier: keep only the last quote's entry for each.
  // Two carriers quoting the same line are different policies (Cincinnati property and American
  // Modern dwelling fire, TN Equine), so both are kept.
  const latestByLine = new Map<string, { line: QuoteLineExtraction; filename: string }>()
  for(const { filename, extraction } of quotes) {
    for(const line of extraction.lines) {
      const lineKey = line.line_of_business === "other" || line.line_of_business === "specialty_addon"
        ? `${ line.line_of_business }:${ line.title.toLowerCase() }`
        : line.line_of_business
      const key = `${ lineKey }|${ carrierKey(line.carrier ?? "") }`
      latestByLine.set(key, { line, filename })
    }
  }

  const merged = [...lines]
  const specialtyAddOns: ProposalSpecialtyAddOn[] = []

  for(const { line, filename } of latestByLine.values()) {
    if(line.line_of_business === "specialty_addon") {
      specialtyAddOns.push(specialtyAddOn(line, filename))
      continue
    }

    if(!hasContent(line)) continue

    const slot = slotFor(line)
    // "other" lines only replace an AMS360 "other" section of the same name.
    const index = merged.findIndex((l) => l.slot === slot && sameCarrier(l, line) && (slot !== "other" || l.title.toLowerCase() === line.title.toLowerCase()))
    if(index >= 0) merged[index] = applyQuote(merged[index], slot, line, filename, false, withExposures)
    else merged.push(applyQuote(undefined, slot, line, filename, merged.some((l) => l.slot === slot), withExposures))
  }

  const used = [...latestByLine.values()]
  const bindItems = [...new Set(used.flatMap(({ line }) => line.bind_conditions.map((c) => c.text)))]
  const bindFiles = [...new Set(used.filter(({ line }) => line.bind_conditions.length > 0).map(({ filename }) => `"${ filename }"`))]

  return {
    lines: merged,
    bindConditions: {
      items: bindItems,
      comment: bindItems.length > 0 ? `Added by Claude from uploaded quote${ bindFiles.length > 1 ? "s" : "" } ${ bindFiles.join(", ") }. Please verify against the quote before sending to the client.` : undefined
    },
    specialtyAddOns,
    quoteNote: quoteNote(quotes)
  }
}
