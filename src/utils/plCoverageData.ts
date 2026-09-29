import { runReadOnlyQuery } from "../db.js"
import { clean, formatDate, numericMoney } from "./clPolicyData.js"
import type { ResolvedPolicy } from "./clPolicyData.js"

// Coverage data for pl_renewal_summary, the personal-lines counterpart to clCoverageData.ts. Personal
// lines keep every coverage in afw_coverage (afw_cprem is commercial-only), attached at one of these
// levels. Each attachtype's join was confirmed book-wide, 100% of the current PL rows, 2026-09-29:
//   - 121: per vehicle, attachid = afw_vehicle.vehid (personal auto)
//   - 86: per location, attachid = afw_location.locid (homeowners / dwelling fire)
//   - 578: scheduled personal property, attachid = the line's own lobid
//   - 85: line-of-business level, attachid = lobid (umbrella, auto/home package credits)
// Many rows are rating artifacts with no limit or deductible (peril premiums like "Fire" or "Theft",
// "Multi policy credit", "Number of Autos"). Only rows that carry a limit or a deductible are
// coverages worth showing, so everything below filters on that rather than on iscoverage.
//
// Layout follows the client-supplied sample (Patrick_Baggett_Personal_Insurance_Summary, 2026-09-28):
// Auto coverage highlights + scheduled vehicles, a Homeowners Coverage A–F table per property, the
// Personal Articles total scheduled limit, and Umbrella limits. Andrew's decisions (2026-09-28): DFIRE
// reuses the Homeowners table; any other personal line (boat, flood, ...) gets a generic
// Coverage/Limit/Deductible table; an auto coverage goes in the highlights only when it's identical
// on every vehicle, otherwise it goes in the Coverage by Vehicle table below the vehicle list.

const COVERAGE_QUERY = `
  SELECT lob.lineofbus, lob.descriptionlobs, c.lobid, c.attachtype, c.attachid,
    c.coveragecode, c.descrcov, c.limit1, c.limit2, c.limit3, c.deduct1, c.deducttype1
  FROM (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.polid, c.lobid, c.coverageid ORDER BY c.effdate DESC) AS rn
    FROM afw_coverage c
    WHERE c.polid = $1
  ) c
  LEFT JOIN LATERAL (
    SELECT rtrim(l.lineofbus) AS lineofbus, lo.descriptionlobs
    FROM afw_lineofbusiness l
    LEFT JOIN afw_lobsetup lo ON lo.namelobs = l.lineofbus
    WHERE l.polid = c.polid AND l.lobid = c.lobid
    LIMIT 1
  ) lob ON true
  WHERE c.rn = 1 AND c.status != 'D'
  ORDER BY lob.lineofbus, c.attachid, c.sortno NULLS LAST, c.coveragecode
`

// Every line on the policy, including ones with no afw_coverage rows at all: none of the 37 current
// FLOOD policies has any (2026-09-29), and they'd otherwise vanish from the document silently.
const LOB_QUERY = `
  SELECT l.lobid, rtrim(l.lineofbus) AS lineofbus, lo.descriptionlobs
  FROM afw_lineofbusiness l
  LEFT JOIN afw_lobsetup lo ON lo.namelobs = l.lineofbus
  WHERE l.polid = $1
  ORDER BY l.sortno
`

// Explicit column list only, never v.* (column-level grants on afw_vehicle, see policyQuery.ts).
// lobid matters: an auto + umbrella policy (one polid, AUTOP and PUMBR lines) carries a second copy
// of the vehicle schedule on the umbrella line, with its own vehids and no coverages attached (Ashley
// Breeding's VU0158, 2026-09-29). Only the auto line's own vehicles belong in its section.
const VEHICLE_QUERY = `
  SELECT v.lobid, v.vehid, v.vehicleno, v.vehyear, v.make, v.model, v.vin
  FROM (
    SELECT v.lobid, v.vehid, v.vehicleno, v.vehyear, v.make, v.model, v.vin, v.status,
      ROW_NUMBER() OVER (PARTITION BY v.polid, v.lobid, v.vehid ORDER BY v.effdate DESC) AS rn
    FROM afw_vehicle v
    WHERE v.polid = $1
  ) v
  WHERE v.rn = 1 AND v.status != 'D'
  ORDER BY v.vehicleno
`

const LOCATION_QUERY = `
  SELECT l.locid, l.locno, l.addr1, l.addr2, l.city, l.state, l.zipcode
  FROM (
    SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.polid, l.lobid, l.locid ORDER BY l.effdate DESC) AS rn
    FROM afw_location l
    WHERE l.polid = $1
  ) l
  WHERE l.rn = 1 AND l.status != 'D'
  ORDER BY l.locno
`

// Fallback for the Personal Articles total when the 578 coverage row carries no limit (22 of 408
// scheduled-property lines have no summary row at all, so this is a fallback, not the source).
const SPP_SUMMARY_QUERY = `
  SELECT s.lobid, s.class, s.spplimit
  FROM (
    SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.polid, s.lobid, s.spsumid ORDER BY s.effdate DESC) AS rn
    FROM afw_sppsummary s
    WHERE s.polid = $1
  ) s
  WHERE s.rn = 1 AND s.status != 'D'
`

type Money = string | number | null

type CoverageRow = {
  lineofbus: string | null; descriptionlobs: string | null; lobid: string; attachtype: number | null; attachid: string | null
  coveragecode: string | null; descrcov: string | null
  limit1: Money; limit2: Money; limit3: Money; deduct1: Money; deducttype1: string | null
}

type VehicleQueryRow = { lobid: string; vehid: string; vehicleno: string | null; vehyear: string | number | null; make: string | null; model: string | null; vin: string | null }
type LocationQueryRow = { locid: string; locno: string | null; addr1: string | null; addr2: string | null; city: string | null; state: string | null; zipcode: string | null }
type SppSummaryRow = { lobid: string; class: string | null; spplimit: Money }
type LobQueryRow = { lobid: string; lineofbus: string | null; descriptionlobs: string | null }

// ---------- OUTPUT TYPES ----------

export type LabeledValue = { label: string; value: string }
export type PlCoverageRow = { coverage: string; limit: string; deductible: string }
export type PlVehicle = { year: string; makeModel: string; vin: string; values: Record<string, string> }

// Identifies which policy a section came from. The document shows it under the section heading
// only when that's needed to tell policies apart (several carriers, or the same line twice).
export type PlSectionSource = { polno: string; carrier: string; term: string }

export type PlSection =
  | { kind: "auto"; title: string; source: PlSectionSource; highlights: LabeledValue[]; vehicleColumns: { key: string; label: string }[]; vehicles: PlVehicle[] }
  | { kind: "property"; title: string; source: PlSectionSource; address: string; rows: LabeledValue[] }
  | { kind: "personalArticles"; title: string; source: PlSectionSource; totalScheduledLimit: string }
  | { kind: "umbrella"; title: string; source: PlSectionSource; rows: LabeledValue[] }
  | { kind: "other"; title: string; source: PlSectionSource; rows: PlCoverageRow[] }
  | { kind: "noDetail"; title: string; source: PlSectionSource }

export type PlPolicyCoverage = { sections: PlSection[]; carrierCodes: string[] }

// ---------- FORMATTING ----------

// afw_coverage leaves an unused limit slot as NULL or 0; either way it isn't a limit.
function limitText(raw: Money): string {
  const text = numericMoney(raw)
  return text === "$0" ? "" : text
}

function hasValue(raw: Money): boolean {
  return limitText(raw) !== ""
}

// deducttype1 on personal lines is only ever 'Flat', 'Flat per $1000', 'Percent' or NULL
// (2026-09-29), and NULL means dollars. Only a small number under 'Percent' is a percentage deductible.
function deductibleText(raw: Money, type: string | null): string {
  const text = limitText(raw)
  if(!text) return ""

  const num = Number(String(raw).replace(/[$,]/g, ""))
  if(/percent|%/i.test(clean(type)) && Number.isFinite(num) && num <= 100) return `${ num }%`
  return text
}

// Wind/hail deductibles are a percentage of Coverage A when deducttype1 is 'Percent' (0.5 to 5), but
// a handful carry no type at all. Those with no type are dollar amounts ($500 and up), so a bare
// value of 10 or less can only be a percentage.
function windHailDeductibleText(raw: Money, type: string | null): string {
  const num = Number(String(raw ?? "").replace(/[$,]/g, ""))
  if(Number.isFinite(num) && num > 0 && (/percent/i.test(clean(type)) || num <= 10)) return `${ num }% of Dwelling`
  return deductibleText(raw, type)
}

// Rating counts, not coverages. Some carriers put a number in limit1 ("Number of Autos" and "Number
// of Residences" on an Acuity umbrella both carry 500000), which would otherwise render as a limit.
const COUNT_ROW_PATTERN = /^number of\b/i

function carriesValue(r: CoverageRow): boolean {
  if(COUNT_ROW_PATTERN.test(clean(r.coveragecode))) return false
  return hasValue(r.limit1) || hasValue(r.limit2) || hasValue(r.limit3) || hasValue(r.deduct1)
}

// Carrier-specific codes (e.g. "CAPAE", "LLDWV") have no AMS360 description beyond what the carrier
// put in descrcov — same pattern as clCoverageData.ts's CARRIER_CODE_PATTERN.
const CARRIER_CODE_PATTERN = /^[A-Z0-9]{4,6}$/

// coveragecode is AMS360's standardized name ("Dwelling", "Personal umbrella"), descrcov the
// carrier's own text ("A. Dwelling Amount"). The standard name reads better, except when it's a bare
// carrier code, where the carrier's description is the only readable label there is.
function coverageLabel(r: CoverageRow): string {
  const code = clean(r.coveragecode)
  const descr = clean(r.descrcov)
  if(CARRIER_CODE_PATTERN.test(code) && descr) return headlineCase(descr)
  return headlineCase(code || descr)
}

const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "if", "in", "of", "on", "or", "per", "the", "to", "with"])

// AMS360's standard coverage names are sentence case ("Auto death indemnity or benefits"), which
// looks out of place next to the document's title-cased labels. Only an all-lowercase tail is
// converted, so carrier text that already has its own capitals ("Medical Payments if Wearing a Seat
// Belt", "UM/UIM") is left exactly as written.
function headlineCase(label: string): string {
  if(label.slice(1) !== label.slice(1).toLowerCase()) return label
  return label.split(" ").map((word, i) => (i > 0 && MINOR_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(" ")
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

// AMS360 carrier downloads often truncate the make to 4 or 5 letters ("SUBA", "TOYT", "LNDR"). Taken
// from every make on current personal auto policies, 2026-09-29. MERC and RIVA read as Mercedes-Benz
// and Rivian (Andrew, 2026-09-29) rather than Mercury or the Riva boat builder.
const MAKE_NAMES: Record<string, string> = {
  ACUR: "Acura", BUIC: "Buick", CADI: "Cadillac", CHEV: "Chevrolet", CHEVR: "Chevrolet", CHEVY: "Chevrolet",
  CHRY: "Chrysler", DODG: "Dodge", GENE: "Genesis", GENS: "Genesis", HARLE: "Harley-Davidson", HOND: "Honda",
  HYUN: "Hyundai", HYUND: "Hyundai", INFI: "Infiniti", INFIN: "Infiniti", JAGU: "Jaguar", KAWAS: "Kawasaki",
  KAWSKI: "Kawasaki", LEXS: "Lexus", LINC: "Lincoln", LNDR: "Land Rover", MAZD: "Mazda", MERCB: "Mercedes-Benz",
  MERC: "Mercedes-Benz", MERCU: "Mercury", MERZ: "Mercedes-Benz", MITS: "Mitsubishi", MNNI: "Mini", NISS: "Nissan", NISSA: "Nissan",
  OLDS: "Oldsmobile", POLA: "Polaris", POLAR: "Polaris", PORS: "Porsche", RIVA: "Rivian", SUBA: "Subaru", SUBAR: "Subaru",
  TESL: "Tesla", TOYO: "Toyota", TOYOT: "Toyota", TOYT: "Toyota", VOLK: "Volkswagen", VOLV: "Volvo", YAMAH: "Yamaha"
}

function expandMake(make: string | null): string {
  const [first, ...rest] = clean(make).split(/\s+/)
  const expanded = first ? MAKE_NAMES[first.toUpperCase()] : undefined
  return expanded ? [expanded, ...rest].join(" ") : clean(make)
}

// Short vehicle words that are ordinary words rather than trim/drive acronyms.
const VEHICLE_WORDS = new Set(["CAB", "VAN", "CAR", "BUS", "BED", "BOX", "TOP", "SUT"])

// AMS360 stores vehicle make/model in capitals ("GMC SIERRA 1500 CREW CAB"). Title case reads better
// and matches the client's sample ("GMC Sierra 1500 Crew Cab"). Short tokens stay capitalised, since
// they're almost always acronyms (GMC, BMW, XL, SLT, AWD), as do tokens with digits (F150, 4WD).
function vehicleName(make: string | null, model: string | null): string {
  return [expandMake(make), clean(model)].filter(Boolean).join(" ")
    .split(/\s+/)
    .map((word) => ((/^[A-Z]{2,3}$/.test(word) && !VEHICLE_WORDS.has(word)) || /\d/.test(word) ? word : titleCase(word)))
    .join(" ")
}

function formatPropertyAddress(loc: LocationQueryRow | undefined): string {
  if(!loc) return ""
  const street = [clean(loc.addr1), clean(loc.addr2)].filter(Boolean).map(titleCase).join(", ")
  const city = titleCase(clean(loc.city))
  // 5-digit ZIP, as in the client's sample (AMS360 usually carries ZIP+4 here).
  const stateZip = [clean(loc.state), clean(loc.zipcode).slice(0, 5)].filter(Boolean).join(" ")
  return [street, city, stateZip].filter(Boolean).join(", ")
}

// ---------- AUTO ----------

// Display order for the highlights list and the Coverage by Vehicle rows. Liability, UM/UIM and UM PD are
// assembled from several rows (see autoValues), so they aren't matched directly here.
const AUTO_DISPLAY_ORDER: { key: string; label: string }[] = [
  { key: "liability", label: "Liability" },
  { key: "um", label: "Uninsured/Underinsured Motorist" },
  { key: "uim", label: "Underinsured Motorist" },
  { key: "umpd", label: "Uninsured Motorist Property Damage" },
  { key: "medpay", label: "Medical Payments" },
  { key: "pip", label: "Personal Injury Protection" },
  { key: "comp", label: "Comprehensive Deductible" },
  { key: "coll", label: "Collision Deductible" },
  { key: "rental", label: "Rental Reimbursement" },
  { key: "roadside", label: "Roadside Assistance" }
]

// Match precedence, most specific first ("Uninsured motorist combined single limit" also contains
// "combined single limit"; "Uninsured motorist property damage" also contains "property damage").
const AUTO_MATCH_ORDER: { key: string; match: RegExp }[] = [
  { key: "umpd", match: /(un|under)insured motorist property damage|^umpd/i },
  { key: "uim", match: /underinsured/i },
  { key: "um", match: /uninsured/i },
  { key: "csl", match: /combined single limit/i },
  { key: "bi", match: /bodily injury/i },
  { key: "pd", match: /^property damage/i },
  { key: "medpay", match: /^medical payments$/i },
  { key: "pip", match: /personal injury protection|^pip\b/i },
  { key: "comp", match: /^comprehensive|other than collision/i },
  { key: "coll", match: /^collision/i },
  { key: "rental", match: /rental/i },
  { key: "roadside", match: /towing|roadside/i }
]

function joinedLimits(r: CoverageRow): string {
  return [limitText(r.limit1), limitText(r.limit2), limitText(r.limit3)].filter(Boolean).join(" / ")
}

// A split UM limit ("Uninsured Motorist Liab / BI") is per person / per accident; a CSL row is one
// number that the sample shows as "$500,000 Combined Single Limit".
function umValue(r: CoverageRow): string {
  const limits = joinedLimits(r)
  if(!limits) return ""
  return /combined single limit|csl/i.test(`${ clean(r.coveragecode) } ${ clean(r.descrcov) }`) ? `${ limits } Combined Single Limit` : limits
}

// One vehicle's coverage values, keyed like AUTO_DISPLAY_ORDER plus "x:<label>" for any other row
// that carries a limit or deductible (so nothing with a real value is silently dropped).
function autoValues(rows: CoverageRow[]): { values: Record<string, string>; extraLabels: Map<string, string> } {
  const matched = new Map<string, CoverageRow>()
  const values: Record<string, string> = {}
  const extraLabels = new Map<string, string>()

  for(const r of rows) {
    const label = coverageLabel(r)
    const column = AUTO_MATCH_ORDER.find((c) => c.match.test(label))

    if(column) {
      if(!matched.has(column.key)) matched.set(column.key, r)
      continue
    }

    const value = hasValue(r.deduct1) && !hasValue(r.limit1) ? deductibleText(r.deduct1, r.deducttype1) : joinedLimits(r)
    if(value) {
      values[`x:${ label.toLowerCase() }`] = value
      extraLabels.set(`x:${ label.toLowerCase() }`, label)
    }
  }

  // Liability: a CSL row already includes property damage (Cincinnati records the same $500,000 again
  // as "Property damage-single limit" on a CSL policy), so PD only shows alongside split BI limits.
  const csl = matched.get("csl")
  const bi = matched.get("bi")
  const pd = matched.get("pd")
  if(csl && limitText(csl.limit1)) values.liability = `${ limitText(csl.limit1) } Combined Single Limit`
  else if(bi || pd) values.liability = [bi ? joinedLimits(bi) : "", pd ? limitText(pd.limit1) : ""].filter(Boolean).join(" / ")

  // UM/UIM: one combined line when only a UM row exists (the usual "UM/UIM CSL" row), separate lines
  // when the carrier records UIM on its own row. UM PD is part of a UM CSL, same as liability's PD.
  const um = matched.get("um")
  const uim = matched.get("uim")
  if(um) values.um = umValue(um)
  if(uim) {
    if(um && umValue(uim) === values.um) {
      // Same limit on both: the combined "Uninsured/Underinsured Motorist" line says it all.
    } else if(!um) {
      values.um = umValue(uim)
    } else {
      values.uim = umValue(uim)
    }
  }
  const umpd = matched.get("umpd")
  const umIsCsl = um ? /combined single limit/i.test(values.um ?? "") : false
  if(umpd && !umIsCsl) values.umpd = joinedLimits(umpd)

  for(const key of ["medpay", "pip"]) {
    const r = matched.get(key)
    if(r) values[key] = joinedLimits(r)
  }
  // Rental's two limits are per day / maximum ("$50 / $1,500"); most carriers fill only limit1.
  const rental = matched.get("rental")
  if(rental) {
    const [perDay, max] = [limitText(rental.limit1), limitText(rental.limit2)]
    values.rental = perDay && max ? `${ perDay } per day / ${ max } maximum` : perDay || max
  }
  for(const key of ["comp", "coll"]) {
    const r = matched.get(key)
    if(r) values[key] = deductibleText(r.deduct1, r.deducttype1)
  }
  // Roadside/towing is often recorded with no amount at all; the row's presence is the coverage.
  const roadside = matched.get("roadside")
  if(roadside) values.roadside = limitText(roadside.limit1) || "Included"

  for(const [key, value] of Object.entries(values)) if(!value) delete values[key]

  return { values, extraLabels }
}

// A safety net behind VEHICLE_QUERY's lobid scoping: one entry per VIN (or per year/make/model when
// there's no VIN), keeping the copy with the most coverage values, and the first of equals. Replacing a
// Map entry keeps its original position, so vehicle order doesn't change.
function dedupeVehicles(vehicles: PlVehicle[]): PlVehicle[] {
  const byKey = new Map<string, PlVehicle>()

  for(const v of vehicles) {
    const key = v.vin ? v.vin.toUpperCase() : `${ v.year }|${ v.makeModel.toLowerCase() }`
    const existing = byKey.get(key)
    if(!existing || Object.keys(v.values).length > Object.keys(existing.values).length) byKey.set(key, v)
  }

  return [...byKey.values()]
}

function buildAutoSection(rows: CoverageRow[], vehicles: VehicleQueryRow[], source: PlSectionSource, title: string): PlSection {
  const vehicleRows = rows.filter((r) => r.attachtype === 121)
  const extraLabels = new Map<string, string>()

  const perVehicle = dedupeVehicles(vehicles.map((v) => {
    const { values, extraLabels: labels } = autoValues(vehicleRows.filter((r) => r.attachid === v.vehid))
    for(const [k, l] of labels) extraLabels.set(k, l)
    return { year: clean(String(v.vehyear ?? "")), makeModel: vehicleName(v.make, v.model), vin: clean(v.vin), values }
  }))

  // Policy-level auto rows (attachtype 85 etc.) that carry a real value, e.g. an endorsement limit —
  // they apply to every vehicle, so they go straight into the highlights.
  const policyLevel = autoValues(rows.filter((r) => r.attachtype !== 121))
  for(const [k, l] of policyLevel.extraLabels) extraLabels.set(k, l)

  const order = [
    ...AUTO_DISPLAY_ORDER,
    ...[...extraLabels.entries()].map(([key, label]) => ({ key, label }))
  ]

  const highlights: LabeledValue[] = []
  const vehicleColumns: { key: string; label: string }[] = []

  for(const { key, label } of order) {
    const vehicleValues = perVehicle.map((v) => v.values[key] ?? "")
    const policyValue = policyLevel.values[key]

    if(policyValue && vehicleValues.every((v) => !v)) {
      highlights.push({ label, value: policyValue })
    } else if(vehicleValues.some(Boolean)) {
      if(new Set(vehicleValues).size === 1) highlights.push({ label, value: vehicleValues[0] })
      else vehicleColumns.push({ key, label })
    }
  }

  for(const v of perVehicle) {
    for(const col of vehicleColumns) if(!v.values[col.key]) v.values[col.key] = "None"
  }

  return { kind: "auto", title, source, highlights, vehicleColumns, vehicles: perVehicle }
}

// ---------- HOME / DWELLING FIRE ----------

// Coverage A–F in the sample's order (it lists Medical Payments before Personal Liability), followed
// by the deductibles. Dwelling fire records Coverage D as "Fair rental value" or the carrier code
// ALEFR (additional living expense / fair rental), and its liability as premises or lessor's
// liability under carrier-specific codes (PMSL, "Lessors Liab"), so each has an alias list. A DFIRE
// policy never carries both a homeowners-style and a premises-style liability row.
const PROPERTY_CATEGORIES: { label: string; match: RegExp }[] = [
  { label: "Dwelling", match: /^dwelling$/i },
  { label: "Other Structures", match: /^other structures?$/i },
  { label: "Personal Property", match: /^personal property$/i },
  { label: "Loss of Use", match: /^loss of use$/i },
  { label: "Fair Rental Value", match: /^fair rental value|^alefr$/i },
  { label: "Medical Payments", match: /^medical payments|^lessors medical$/i },
  { label: "Personal Liability", match: /^personal liability$/i },
  { label: "Premises Liability", match: /^pmsl$|^lessors liab$|premises liab/i }
]

function buildPropertyRows(rows: CoverageRow[], kind: "HOME" | "DFIRE"): LabeledValue[] {
  const out: LabeledValue[] = []

  for(const category of PROPERTY_CATEGORIES) {
    const row = rows.find((r) => category.match.test(clean(r.coveragecode)))
    if(!row) continue

    const limit = limitText(row.limit1)
    // A homeowners Loss of Use row with no limit is the ALS form — no amount exists anywhere in the
    // data (303 of 845 HOME rows, all other columns null too, 2026-09-29), and the client's own sample
    // shows it as "Actual Loss Sustained". Dwelling fire rows always carry a limit.
    if(!limit && category.label === "Loss of Use" && kind === "HOME") out.push({ label: category.label, value: "Actual Loss Sustained" })
    else if(limit) out.push({ label: category.label, value: limit })
  }

  const dwelling = rows.find((r) => /^dwelling$/i.test(clean(r.coveragecode)))
  const deductible = dwelling ? deductibleText(dwelling.deduct1, dwelling.deducttype1) : ""
  if(deductible) out.push({ label: "Deductible", value: deductible })

  const windHail = rows.find((r) => /wind|hail/i.test(coverageLabel(r)) && hasValue(r.deduct1))
  if(windHail) out.push({ label: "Wind/Hail Deductible", value: windHailDeductibleText(windHail.deduct1, windHail.deducttype1) })

  return out
}

// ---------- UMBRELLA ----------

function buildUmbrellaRows(rows: CoverageRow[]): LabeledValue[] {
  const out: LabeledValue[] = []
  const umbrella = rows.find((r) => /umbrella/i.test(clean(r.coveragecode)) && hasValue(r.limit1))

  if(umbrella) out.push({ label: "Personal Liability", value: limitText(umbrella.limit1) })

  const excessUm = rows.find((r) => /uninsured|underinsured/i.test(coverageLabel(r)) && hasValue(r.limit1))
  if(excessUm) out.push({ label: "Excess Uninsured/Underinsured Motorist", value: limitText(excessUm.limit1) })

  if(umbrella && hasValue(umbrella.deduct1)) out.push({ label: "Self-Insured Retention", value: deductibleText(umbrella.deduct1, umbrella.deducttype1) })

  // Anything else on the umbrella that carries a real limit (e.g. an excess employer's liability).
  for(const r of rows) {
    if(r === umbrella || r === excessUm || !hasValue(r.limit1)) continue
    out.push({ label: coverageLabel(r), value: joinedLimits(r) })
  }

  return out
}

// ---------- GENERIC ----------

function buildGenericRows(rows: CoverageRow[]): PlCoverageRow[] {
  const seen = new Set<string>()
  const out: PlCoverageRow[] = []

  for(const r of rows) {
    const row = { coverage: coverageLabel(r), limit: joinedLimits(r), deductible: deductibleText(r.deduct1, r.deducttype1) }
    const key = `${ row.coverage.toLowerCase() }|${ row.limit }|${ row.deductible }`
    if(seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }

  return out
}

// ---------- PER POLICY ----------

const SECTION_TITLES: Record<string, string> = {
  AUTOP: "Automobile Insurance",
  HOME: "Homeowners Insurance",
  DFIRE: "Dwelling Fire Insurance",
  INMRP: "Personal Articles Coverage",
  PUMBR: "Umbrella Liability Insurance"
}

function otherTitle(lineofbus: string, description: string | null): string {
  const name = clean(description) || lineofbus
  return /insurance|coverage/i.test(name) ? name : `${ name } Insurance`
}

export async function fetchPlPolicyCoverage(policy: ResolvedPolicy): Promise<PlPolicyCoverage> {
  const [lobs, allRows, vehicles, locations, sppSummaries] = await Promise.all([
    runReadOnlyQuery(LOB_QUERY, [policy.polid]) as Promise<LobQueryRow[]>,
    runReadOnlyQuery(COVERAGE_QUERY, [policy.polid]) as Promise<CoverageRow[]>,
    runReadOnlyQuery(VEHICLE_QUERY, [policy.polid]) as Promise<VehicleQueryRow[]>,
    runReadOnlyQuery(LOCATION_QUERY, [policy.polid]) as Promise<LocationQueryRow[]>,
    runReadOnlyQuery(SPP_SUMMARY_QUERY, [policy.polid]) as Promise<SppSummaryRow[]>
  ])

  const source: PlSectionSource = {
    polno: policy.polno,
    carrier: clean(policy.carrier_name),
    term: `${ formatDate(policy.poleffdate) } – ${ formatDate(policy.polexpdate) }`
  }

  const byLob = new Map<string, { lineofbus: string; description: string | null; rows: CoverageRow[] }>()
  for(const lob of lobs) byLob.set(lob.lobid, { lineofbus: clean(lob.lineofbus) || "OTHER", description: lob.descriptionlobs, rows: [] })
  // Loss of Use is the one row kept without a value: an empty one is the ALS form (buildPropertyRows).
  for(const r of allRows.filter((row) => carriesValue(row) || /^loss of use$/i.test(clean(row.coveragecode)))) {
    let group = byLob.get(r.lobid)
    if(!group) {
      group = { lineofbus: clean(r.lineofbus) || "OTHER", description: r.descriptionlobs, rows: [] }
      byLob.set(r.lobid, group)
    }
    group.rows.push(r)
  }

  const sections: PlSection[] = []
  const renderedLabels: string[] = []

  for(const [lobid, { lineofbus, description, rows: lobRows }] of byLob) {
    const title = SECTION_TITLES[lineofbus] ?? otherTitle(lineofbus, description)
    const sectionCount = sections.length

    if(lobRows.length === 0 && !(lineofbus === "INMRP" && sppSummaries.some((sp) => sp.lobid === lobid))) {
      sections.push({ kind: "noDetail", title, source })
      continue
    }

    if(lineofbus === "AUTOP") {
      const section = buildAutoSection(lobRows, vehicles.filter((v) => v.lobid === lobid), source, title)
      if(section.kind === "auto") renderedLabels.push(...section.highlights.map((h) => h.label), ...section.vehicleColumns.map((c) => c.label))
      sections.push(section)
    } else if(lineofbus === "HOME" || lineofbus === "DFIRE") {
      // One table per insured location. Line-level rows (attachtype 85) apply to every location.
      const lineLevel = lobRows.filter((r) => r.attachtype !== 86)
      const locationIds = [...new Set(lobRows.filter((r) => r.attachtype === 86).map((r) => r.attachid))]
      const groups = locationIds.length > 0 ? locationIds : [null]

      for(const locid of groups) {
        const locRows = [...lobRows.filter((r) => r.attachtype === 86 && r.attachid === locid), ...lineLevel]
        const propertyRows = buildPropertyRows(locRows, lineofbus)
        if(propertyRows.length === 0) continue
        sections.push({
          kind: "property", title, source,
          address: formatPropertyAddress(locations.find((l) => l.locid === locid) ?? (locations.length === 1 ? locations[0] : undefined)),
          rows: propertyRows
        })
      }
    } else if(lineofbus === "INMRP") {
      const sppRows = lobRows.filter((r) => r.attachtype === 578)
      const total = sppRows.reduce((sum, r) => sum + (Number(String(r.limit1 ?? 0).replace(/[$,]/g, "")) || 0), 0)
      const fallback = sppSummaries
        .filter((s) => s.lobid === lobid)
        .reduce((sum, s) => sum + (Number(String(s.spplimit ?? 0).replace(/[$,]/g, "")) || 0), 0)
      const totalValue = total || fallback

      if(totalValue > 0) sections.push({ kind: "personalArticles", title, source, totalScheduledLimit: limitText(totalValue) })

      const otherRows = lobRows.filter((r) => r.attachtype !== 578)
      if(otherRows.length > 0) {
        const generic = buildGenericRows(otherRows)
        renderedLabels.push(...generic.map((g) => g.coverage))
        sections.push({ kind: "other", title: otherTitle(lineofbus, description), source, rows: generic })
      }
    } else if(lineofbus === "PUMBR") {
      const umbrellaRows = buildUmbrellaRows(lobRows)
      renderedLabels.push(...umbrellaRows.map((r) => r.label))
      if(umbrellaRows.length > 0) sections.push({ kind: "umbrella", title, source, rows: umbrellaRows })
    } else {
      const generic = buildGenericRows(lobRows)
      renderedLabels.push(...generic.map((g) => g.coverage))
      if(generic.length > 0) sections.push({ kind: "other", title, source, rows: generic })
    }

    // Rows existed but none mapped to anything showable (e.g. a HOME line with only credits).
    if(sections.length === sectionCount) sections.push({ kind: "noDetail", title, source })
  }

  return {
    sections,
    carrierCodes: [...new Set(renderedLabels.filter((label) => CARRIER_CODE_PATTERN.test(label)))]
  }
}

// Sample order: Auto, Home (and dwelling fire), Personal Articles, Umbrella, then anything else.
const SECTION_ORDER: PlSection["kind"][] = ["auto", "property", "personalArticles", "umbrella", "other", "noDetail"]

export function orderPlSections(sections: PlSection[]): PlSection[] {
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.s.kind) - SECTION_ORDER.indexOf(b.s.kind) || a.i - b.i)
    .map(({ s }) => s)
}
