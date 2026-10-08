import { VEHICLE_COLUMNS } from "./clCoverageData.js"
import type { CoverageLimitRow, KeyedCoverageSection, LineSlot, PolicyCoverageData, PropertySubjectRow } from "./clCoverageData.js"
import { formatLocNo } from "./clPolicyData.js"
import type { PolicyData } from "./clPolicyData.js"
import type { ProposalLine, ProposalTable } from "./clProposalDoc.js"

// Turns one policy term's AMS360 data into the proposal's per-line sections (insurance-proposal skill
// Section 3, fields per references/coverage-fields.md). Each section names its own policy's carrier.
// AMS360 has no A.M. Best ratings, enhancement lists, or exclusions — those only appear when an
// uploaded quote supplies them (clQuoteMerge.ts); nothing here prints a placeholder for them
// (Andrew, 2026-10-01, overriding the skill's "Standard policy form…" bullet).

// `kind` lets an uploaded quote replace a line's limits while keeping AMS360's schedules of what's
// insured (locations, classes, vehicles, drivers, payroll) — see clQuoteMerge.ts.
export type LineTable = ProposalTable & { kind: "limits" | "schedule" }

// What the umbrella's Underlying Coverage Schedule lists for this line, when it's one an umbrella
// sits over (skill: per-occurrence for GL/Auto, EL limits for WC).
export type UnderlyingEntry = { line: string; carrier: string; limit: string }

export type SlotLine = Omit<ProposalLine, "tables"> & {
  slot: LineSlot
  tables: LineTable[]
  carrier: string
  polno: string
  period: string
  underlying?: UnderlyingEntry
}

export const SLOT_TITLES: Record<LineSlot, string> = {
  property: "Property",
  general_liability: "General Liability",
  liquor_liability: "Liquor Liability",
  inland_marine: "Inland Marine",
  commercial_auto: "Commercial Auto",
  workers_comp: "Workers' Compensation",
  employee_benefits_liability: "Employee Benefits Liability",
  umbrella_excess: "Umbrella / Excess Liability",
  directors_officers: "Directors & Officers",
  cyber: "Cyber Liability",
  epli: "Employment Practices Liability",
  professional_liability: "Professional Liability / E&O",
  crime: "Crime",
  other: "Other Coverage"
}

// The italic overview sentence under each banner — fixed wording per line (Andrew, 2026-10-08:
// template text filled from data, no LLM pass), adapted from the skill's own examples.
const OVERVIEWS: Record<LineSlot, string> = {
  property: "Insures the buildings and business personal property at each scheduled location, so a covered loss does not stop the business from recovering.",
  general_liability: "Protects the business against third-party bodily injury and property damage claims arising from its premises and operations, along with personal and advertising injury.",
  liquor_liability: "Covers liability for injury or damage caused by an intoxicated person when the business sells, serves, or furnishes alcohol.",
  inland_marine: "Covers equipment and property that moves between locations or job sites and is not tied to a single premises.",
  commercial_auto: "Provides liability, medical payments, uninsured motorist, and physical damage coverage on the business's scheduled vehicles.",
  workers_comp: "Pays medical costs and lost wages for employees injured on the job, as each covered state requires, and protects the business against employer's liability claims.",
  employee_benefits_liability: "Covers errors or omissions in administering the business's employee benefit plans.",
  umbrella_excess: "Adds liability protection above the underlying liability policies.",
  directors_officers: "Protects the organization's directors and officers, and the organization itself, against claims alleging wrongful acts in managing the business.",
  cyber: "Pays breach response, defense, and liability costs after a data breach or other cyber incident.",
  epli: "Covers claims by employees alleging wrongful termination, discrimination, harassment, and other employment-related practices.",
  professional_liability: "Protects the business against claims alleging errors, omissions, or negligence in the professional services it provides.",
  crime: "Protects money, securities, and other assets against employee dishonesty, forgery, theft, and electronic fraud.",
  other: ""
}

export function overviewFor(slot: LineSlot, description: string): string {
  return OVERVIEWS[slot] || `Summarizes the limits and deductibles of the ${ description } coverage.`
}

export type PolicyTermData = {
  polno: string
  carrier: string
  period: string
  data: PolicyData
  coverage: PolicyCoverageData
}

// ---------- shared helpers ----------

function limitsTable(rows: CoverageLimitRow[], title = "Coverage Limits"): LineTable {
  const withDeductible = rows.some((r) => r.deductible !== "")
  return {
    kind: "limits",
    title,
    headers: withDeductible ? ["Coverage", "Limit", "Deductible"] : ["Coverage", "Limit"],
    rows: rows.map((r) => (withDeductible ? [r.coverage, r.limit, r.deductible] : [r.coverage, r.limit])),
    fractions: withDeductible ? [0.5, 0.25, 0.25] : [0.6, 0.4]
  }
}

// One key-fact value from several (one per building, vehicle, ...): the value itself when they all
// agree, otherwise the distinct values — or a pointer to the schedule when there are too many.
function agreed(values: string[], where = "location"): string {
  const distinct = [...new Set(values.filter(Boolean))]
  if(distinct.length <= 1) return distinct[0] ?? ""
  return distinct.length <= 3 ? `${ distinct.join(" / ") } (varies by ${ where })` : `Varies by ${ where } — see schedule`
}

function facts(pairs: [string, string][]): [string, string][] {
  return pairs.filter(([, value]) => value !== "")
}

function sectionsFor(term: PolicyTermData, slot: LineSlot): KeyedCoverageSection[] {
  return term.coverage.sections.filter((s) => s.key === slot)
}

function baseLine(term: PolicyTermData, slot: LineSlot, title = SLOT_TITLES[slot]): SlotLine {
  return {
    slot, title, carrier: term.carrier, polno: term.polno, period: term.period,
    overview: "", keyFacts: [], tables: [], bulletGroups: []
  }
}

// ---------- Property ----------

const BUILDING_PATTERN = /^building/i
const BPP_PATTERN = /personal property|^bpp\b|contents|stock/i
const BI_PATTERN = /business income|extra expense|earnings|rental (value|income)/i

function locBldg(r: PropertySubjectRow): string {
  return [r.locNo, r.bldgNo].filter(Boolean).join(" / ")
}

// "$10,000 Wind/Hail" → ["Wind/Hail", "$10,000"] — clCoverageData.ts builds these as amount + label.
function splitPeril(text: string): [string, string] {
  const match = text.match(/^(\S+)\s+(.+)$/)
  return match ? [match[2], match[1]] : ["Peril", text]
}

function propertyLine(term: PolicyTermData): SlotLine | null {
  const subjects = term.coverage.propertySubjects
  const policyLevel = sectionsFor(term, "property").flatMap((s) => s.rows)
  if(subjects.length === 0 && policyLevel.length === 0) return null

  const line = baseLine(term, "property")
  const main = subjects.filter((s) => !s.isAdditional)

  // One row per location/building, Building / BPP / BI side by side (Patrick's example layout).
  type Place = { locBldg: string; address: string; building: string[]; bpp: string[]; bi: string[] }
  const places = new Map<string, Place>()
  const additional: string[][] = []

  for(const s of main) {
    const key = `${ locBldg(s) }|${ s.address }`
    const place = places.get(key) ?? { locBldg: locBldg(s), address: s.address, building: [], bpp: [], bi: [] }
    places.set(key, place)

    if(BUILDING_PATTERN.test(s.subject)) place.building.push(s.limit)
    else if(BI_PATTERN.test(s.subject)) place.bi.push(s.limit)
    else if(BPP_PATTERN.test(s.subject)) place.bpp.push(s.limit)
    else additional.push([s.subject, locBldg(s) || s.address, s.limit, s.deductible])
  }

  for(const s of subjects.filter((x) => x.isAdditional)) additional.push([s.subject, locBldg(s) || s.address, s.limit, s.deductible])
  for(const r of policyLevel) additional.push([r.coverage, "All locations", r.limit, r.deductible])

  const perils = new Map<string, string[]>()
  for(const s of main) {
    for(const p of s.perilDeductibles) {
      const [label, amount] = splitPeril(p)
      perils.set(label, [...(perils.get(label) ?? []), amount])
    }
  }

  line.keyFacts = facts([
    ["Carrier", term.carrier],
    ["Covered Causes of Loss", agreed(main.map((s) => s.causeOfLoss))],
    ["Coinsurance", agreed(main.map((s) => s.coinsurance))],
    ["Valuation", agreed(main.map((s) => s.valuation))],
    ["Deductible", agreed(main.map((s) => s.deductible))],
    ...[...perils].map(([label, amounts]): [string, string] => [`${ label.replace("/", " / ") } Deductible`, agreed(amounts)])
  ])

  const placeRows = [...places.values()].filter((p) => p.building.length + p.bpp.length + p.bi.length > 0)
  if(placeRows.length > 0) {
    const withBi = placeRows.some((p) => p.bi.length > 0)
    // Limits, not a schedule of what's insured — an uploaded property quote replaces it, or the
    // document would show the expiring and renewal values side by side.
    line.tables.push({
      kind: "limits",
      title: "Coverage Limits by Location",
      headers: ["Loc. / Bldg.", "Location Address", "Building", "Business Personal Property", ...(withBi ? ["Business Income / Extra Expense"] : [])],
      rows: placeRows.map((p) => [p.locBldg, p.address, p.building.join(" / "), p.bpp.join(" / "), ...(withBi ? [p.bi.join(" / ")] : [])]),
      fractions: withBi ? [0.1, 0.36, 0.16, 0.18, 0.2] : [0.12, 0.44, 0.2, 0.24]
    })
  }

  if(additional.length > 0) {
    const withDeductible = additional.some((r) => r[3] !== "")
    line.tables.push({
      kind: "limits",
      title: "Additional Property Coverages",
      headers: ["Coverage", "Applies To", "Limit", ...(withDeductible ? ["Deductible"] : [])],
      rows: additional.map((r) => (withDeductible ? r : r.slice(0, 3))),
      fractions: withDeductible ? [0.36, 0.28, 0.18, 0.18] : [0.4, 0.34, 0.26]
    })
  }

  line.overview = placeRows.some((p) => p.bi.length > 0)
    ? "Insures the buildings and business personal property at each scheduled location, with business income and extra expense coverage, so a covered loss does not stop the business from recovering."
    : OVERVIEWS.property
  return line
}

// ---------- General Liability ----------

const GL_KEY_LABELS: Record<string, string> = {
  "each occurrence": "Each Occurrence",
  "general aggregate": "General Aggregate",
  "products/completed ops aggregate": "Products / Completed Operations Aggregate",
  "personal & advertising injury": "Personal & Advertising Injury",
  "medical expense": "Medical Payments",
  "fire damage": "Damage to Premises Rented to You"
}

function generalLiabilityLines(term: PolicyTermData): SlotLine[] {
  return sectionsFor(term, "general_liability").map((section) => {
    const line = baseLine(term, "general_liability")
    const keyRows = section.rows.filter((r) => GL_KEY_LABELS[r.coverage.toLowerCase()])
    const otherRows = section.rows.filter((r) => !GL_KEY_LABELS[r.coverage.toLowerCase()])

    line.overview = OVERVIEWS.general_liability
    line.keyFacts = facts([
      ["Carrier", term.carrier],
      ...keyRows.map((r): [string, string] => [GL_KEY_LABELS[r.coverage.toLowerCase()], r.deductible ? `${ r.limit } (deductible ${ r.deductible })` : r.limit])
    ])
    if(otherRows.length > 0) line.tables.push(limitsTable(otherRows, "Additional Liability Coverages"))

    // A package policy's exposures belong to its GL line; with two GL lines on one policy (rare —
    // CGL plus GARAG) the schedule goes with the first.
    if(section === sectionsFor(term, "general_liability")[0] && term.data.glExposure.length > 0) {
      line.tables.push({
        kind: "schedule",
        title: "Classification & Exposure Schedule",
        headers: ["Loc.", "Location Address", "Class", "Description", "Basis", "Exposure"],
        rows: [...term.data.glExposure]
          .sort((a, b) => (Number(a.locNo) || 0) - (Number(b.locNo) || 0) || a.classCode.localeCompare(b.classCode))
          .map((g) => [g.locNo ?? "", g.location, g.classCode, g.classification, g.basis, g.exposure]),
        fractions: [0.06, 0.3, 0.09, 0.27, 0.12, 0.16]
      })
    }

    const occurrence = keyRows.find((r) => r.coverage.toLowerCase() === "each occurrence")?.limit
    const aggregate = keyRows.find((r) => r.coverage.toLowerCase() === "general aggregate")?.limit
    if(occurrence) {
      line.underlying = {
        line: SLOT_TITLES.general_liability, carrier: term.carrier,
        limit: aggregate ? `${ occurrence } each occurrence / ${ aggregate } general aggregate` : `${ occurrence } each occurrence`
      }
    }
    return line
  })
}

// ---------- Inland Marine ----------

function inlandMarineLine(term: PolicyTermData): SlotLine | null {
  const rows = sectionsFor(term, "inland_marine").flatMap((s) => s.rows)
  const blanket = term.data.equipmentBlanket
  const items = term.data.equipmentItems
  if(rows.length === 0 && !blanket && items.length === 0) return null

  // The equipment blanket's own coverage/amount/deductible come from whichever cprem row it links
  // to (e.g. "Debris removal" on Trace's builders risk) — the limits table already shows every row,
  // so only the blanket's location and scheduled/unscheduled basis are repeated here.
  const line = baseLine(term, "inland_marine")
  line.overview = OVERVIEWS.inland_marine
  line.keyFacts = facts([
    ["Carrier", term.carrier],
    ["Scheduled / Unscheduled", items.length > 0 ? blanket?.scheduledUnscheduled ?? "" : ""],
    ["Covered Location", blanket?.coveredLocation ?? ""]
  ])
  if(rows.length > 0) line.tables.push(limitsTable(rows))
  if(items.length > 0) {
    line.tables.push({
      kind: "schedule",
      title: "Scheduled Equipment",
      headers: ["Item No.", "Description", "Serial No.", "Value"],
      rows: items.map((e) => [formatLocNo(e.itemNo), e.description || [e.manufacturer, e.model].filter(Boolean).join(" "), e.serialNo, e.value]),
      fractions: [0.1, 0.52, 0.22, 0.16]
    })
  }
  return line
}

// ---------- Commercial Auto ----------

const AUTO_FACT_LABELS: Record<string, string> = {
  csl: "Liability – Combined Single Limit",
  bi: "Bodily Injury Liability",
  pd: "Property Damage Liability",
  medpay: "Medical Payments",
  pip: "Personal Injury Protection",
  um: "Uninsured Motorists",
  uim: "Underinsured Motorists",
  umpd: "Uninsured Motorist Property Damage",
  comp: "Comprehensive Deductible",
  coll: "Collision Deductible",
  towing: "Towing & Labor",
  rental: "Rental Reimbursement"
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for(const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
}

function autoLine(term: PolicyTermData): SlotLine | null {
  const vehicles = term.data.vehicles
  const coverages = term.coverage.vehicleCoverages
  const policyLevel = sectionsFor(term, "commercial_auto").flatMap((s) => s.rows)
  const hiredNonOwned = term.coverage.hiredNonOwned
  if(vehicles.length === 0 && coverages.length === 0 && policyLevel.length === 0 && hiredNonOwned.length === 0) return null

  const line = baseLine(term, "commercial_auto")
  const keyFacts: [string, string][] = [["Carrier", term.carrier]]
  if(term.coverage.autoLiabilitySymbols) keyFacts.push(["Covered Autos (Liability Symbols)", term.coverage.autoLiabilitySymbols])

  // Policy-level value = what most vehicles carry; any vehicle that differs is named in one bullet
  // per coverage, so the schedule itself stays Veh. No. | Description | VIN (skill).
  const notes: string[] = []
  for(const column of VEHICLE_COLUMNS) {
    const values = coverages.map((v) => v.values[column.key] ?? "")
    if(!values.some(Boolean)) continue

    const common = mostCommon(values)
    keyFacts.push([AUTO_FACT_LABELS[column.key], common || "Not carried on most vehicles"])

    const exceptions = new Map<string, string[]>()
    coverages.forEach((v, i) => {
      if(values[i] !== common) exceptions.set(values[i], [...(exceptions.get(values[i]) ?? []), v.vehNo])
    })
    if(exceptions.size > 0) {
      const parts = [...exceptions].map(([value, vehNos]) => `${ value || "not carried" } on Veh. ${ vehNos.map(formatLocNo).join(", ") }`)
      notes.push(`${ AUTO_FACT_LABELS[column.key] }: ${ common || "not carried" } on most vehicles; ${ parts.join("; ") }`)
    }
  }

  // No vehicle-level coverage rows (e.g. a symbol-1 policy with no schedule): the policy-level rows.
  if(coverages.length === 0 && policyLevel.length > 0) line.tables.push(limitsTable(policyLevel))

  for(const exposure of ["Hired Auto", "Non-Owned Auto"]) {
    const rows = hiredNonOwned.filter((r) => r.exposure === exposure)
    if(rows.length > 0) keyFacts.push([`${ exposure } Liability`, `Yes${ rows[0].limit ? ` – ${ rows[0].limit }` : "" }`])
  }

  line.keyFacts = facts(keyFacts)
  line.overview = vehicles.length > 0
    ? `Provides liability, medical payments, uninsured motorist, and physical damage coverage on the business's ${ vehicles.length } scheduled vehicle${ vehicles.length === 1 ? "" : "s" }${ hiredNonOwned.length > 0 ? ", plus hired and non-owned auto liability for vehicles used in the business" : "" }.`
    : OVERVIEWS.commercial_auto

  if(vehicles.length > 0) {
    line.tables.push({
      kind: "schedule",
      title: "Scheduled Vehicle Coverage",
      headers: ["Veh. No.", "Vehicle Description", "VIN (Last 4)"],
      rows: vehicles.map((v) => [formatLocNo(v.vehNo), [v.year, v.make, v.model].filter(Boolean).join(" "), v.vin.slice(-4)]),
      fractions: [0.13, 0.6, 0.27]
    })
  }
  if(term.data.drivers.length > 0) {
    line.tables.push({
      kind: "schedule",
      title: "Scheduled Drivers",
      headers: ["Driver No.", "Name", "License State"],
      rows: term.data.drivers.map((d) => [formatLocNo(d.driverNo), d.name, d.licenseState]),
      fractions: [0.15, 0.6, 0.25]
    })
  }
  if(notes.length > 0) line.bulletGroups.push({ title: "Coverage Notes", items: notes })

  const csl = keyFacts.find(([label]) => label === AUTO_FACT_LABELS.csl)?.[1]
  const bi = keyFacts.find(([label]) => label === AUTO_FACT_LABELS.bi)?.[1]
  if(csl || bi) line.underlying = { line: SLOT_TITLES.commercial_auto, carrier: term.carrier, limit: csl ? `${ csl } CSL` : bi! }
  return line
}

// ---------- Workers' Compensation ----------

const EL_PATTERN = /^Employer's Liability – /

function workersCompLine(term: PolicyTermData): SlotLine | null {
  const rows = sectionsFor(term, "workers_comp").flatMap((s) => s.rows)
  const payroll = term.data.wcExposure
  if(rows.length === 0 && payroll.length === 0) return null

  const line = baseLine(term, "workers_comp")
  const elRows = rows.filter((r) => EL_PATTERN.test(r.coverage))
  const otherRows = rows.filter((r) => !EL_PATTERN.test(r.coverage))

  line.overview = OVERVIEWS.workers_comp
  line.keyFacts = facts([
    ["Carrier", term.carrier],
    ["Workers' Compensation", "Statutory (Part One)"],
    ...elRows.map((r): [string, string] => [r.coverage.replace(EL_PATTERN, "Employers Liability – "), r.limit]),
    ["States Covered", term.coverage.wcStates.join(", ")]
  ])
  if(otherRows.length > 0) line.tables.push(limitsTable(otherRows, "Additional Coverages"))
  if(payroll.length > 0) {
    line.tables.push({
      kind: "schedule",
      title: "Classification & Payroll",
      headers: ["Class Code", "Classification", "Estimated Payroll"],
      rows: payroll.map((w) => [w.classCode, w.classification, w.payroll]),
      fractions: [0.15, 0.6, 0.25]
    })
  }
  if(elRows.length > 0) line.underlying = { line: "Workers' Compensation – Employers Liability", carrier: term.carrier, limit: elRows.map((r) => r.limit).join(" / ") }
  return line
}

// ---------- Umbrella ----------

const UMBRELLA_FIELDS = ["Each Occurrence", "Aggregate", "Self-Insured Retention"]

function umbrellaLines(term: PolicyTermData): SlotLine[] {
  return sectionsFor(term, "umbrella_excess").map((section) => {
    const line = baseLine(term, "umbrella_excess")
    const detailRows = section.rows.filter((r) => UMBRELLA_FIELDS.includes(r.coverage))
    const otherRows = section.rows.filter((r) => !UMBRELLA_FIELDS.includes(r.coverage))
    const label: Record<string, string> = { "Each Occurrence": "Each Occurrence Limit", Aggregate: "Aggregate Limit", "Self-Insured Retention": "Self-Insured Retention" }

    line.keyFacts = [["Carrier", term.carrier]]
    if(detailRows.length > 0) {
      line.tables.push({
        kind: "limits",
        title: "Umbrella Policy Details",
        headers: ["Field", "Detail"],
        rows: detailRows.map((r) => [label[r.coverage], r.limit]),
        fractions: [0.45, 0.55]
      })
    }
    if(otherRows.length > 0) line.tables.push(limitsTable(otherRows, "Additional Coverages"))
    return line
  })
}

// The umbrella's overview and Underlying Coverage Schedule depend on every other line in the
// document, so they're filled in once all lines (AMS360 and quoted) are assembled.
export function completeUmbrellas(lines: SlotLine[]): void {
  const underlying = lines.filter((l) => l.slot !== "umbrella_excess" && l.underlying).map((l) => l.underlying!)

  for(const line of lines.filter((l) => l.slot === "umbrella_excess")) {
    // AMS360's details table or a quote's limits table — whichever the section now carries.
    const occurrence = line.tables.filter((t) => t.kind === "limits").flatMap((t) => t.rows).find((r) => /occurrence/i.test(r[0]))?.[1]
    const names = underlying.map((u) => u.line.replace(/ – Employers Liability$/, "").toLowerCase())
    line.overview ||= occurrence && names.length > 0
      ? `Adds ${ occurrence } of liability protection above the ${ joinList(names) } policies.`
      : OVERVIEWS.umbrella_excess

    if(underlying.length > 0 && !line.tables.some((t) => t.title === "Underlying Coverage Schedule")) {
      line.tables.push({
        kind: "schedule",
        title: "Underlying Coverage Schedule",
        headers: ["Coverage Line", "Carrier", "Applicable Limit"],
        rows: underlying.map((u) => [u.line, u.carrier, u.limit]),
        fractions: [0.3, 0.32, 0.38]
      })
    }
  }
}

// "The Cincinnati Insurance Company" (a quote) and "Cincinnati Insurance Company" (AMS360) are the
// same carrier.
const CARRIER_NOISE = /\b(the|insurance|ins|company|co|corp|corporation|group|of|and|property|casualty|mutual|inc|llc)\b|[^a-z ]/g

export function carrierKey(name: string): string {
  return name.toLowerCase().replace(CARRIER_NOISE, " ").trim().split(/\s+/)[0] ?? ""
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

// "2026-11-06…" (AMS360) or "11/06/2026" (as a quote prints it) → "November 6, 2026".
export function longDate(value: string): string {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if(iso) return `${ MONTHS[Number(iso[2]) - 1] } ${ Number(iso[3]) }, ${ iso[1] }`
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if(us) return `${ MONTHS[Number(us[1]) - 1] } ${ Number(us[2]) }, ${ us[3] }`
  return value
}

// A quote's printed policy period ("11/06/2026 to 11/06/2027 12:01 A.M. Standard Time") in the same
// form as AMS360's, so the cover can tell whether lines share a period. Left as printed when it
// doesn't carry two dates.
export function periodLabel(printed: string): string {
  const dates = printed.match(/\d{1,2}\/\d{1,2}\/\d{4}/g)
  return dates && dates.length >= 2 ? `${ longDate(dates[0]) } – ${ longDate(dates[1]) }` : printed
}

export function joinList(items: string[]): string {
  if(items.length <= 1) return items[0] ?? ""
  if(items.length === 2) return `${ items[0] } and ${ items[1] }`
  return `${ items.slice(0, -1).join(", ") }, and ${ items[items.length - 1] }`
}

// ---------- Everything else ----------

const DEDICATED_SLOTS = new Set<LineSlot>(["property", "general_liability", "inland_marine", "commercial_auto", "workers_comp", "umbrella_excess"])

function otherLines(term: PolicyTermData): SlotLine[] {
  return term.coverage.sections
    .filter((s) => !DEDICATED_SLOTS.has(s.key))
    .map((section) => {
      const title = section.key === "other" ? section.description : SLOT_TITLES[section.key]
      const line = baseLine(term, section.key, title)
      line.overview = overviewFor(section.key, section.description)
      line.keyFacts = [["Carrier", term.carrier]]
      line.tables.push(limitsTable(section.rows))
      if(section.key === "liquor_liability" || section.key === "employee_benefits_liability") {
        const first = section.rows[0]
        if(first) line.underlying = { line: title, carrier: term.carrier, limit: first.limit }
      }
      return line
    })
}

export function policyLines(term: PolicyTermData): SlotLine[] {
  return [
    propertyLine(term),
    ...generalLiabilityLines(term),
    inlandMarineLine(term),
    autoLine(term),
    workersCompLine(term),
    ...umbrellaLines(term),
    ...otherLines(term)
  ].filter((l): l is SlotLine => l !== null)
}
