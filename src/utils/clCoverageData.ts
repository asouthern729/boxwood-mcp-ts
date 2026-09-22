import { runReadOnlyQuery } from "../db.js"
import { clean, formatAddress, numericMoney } from "./clPolicyData.js"
import { money } from "./riskProfileDoc.js"
import type {
  CoverageLimitRow, CoverageSection, HiredNonOwnedRow, PropertySubjectRow, VehicleCoverageRow
} from "./riskProfileDoc.js"

// Coverage limits/deductibles for cl_renewal_summary — everything the Pre-Renewal Risk Profile
// deliberately leaves out. Patrick (9/11/2026): "CL Renewal Summary- incl all that plus coverage
// limits for liability etc. data pulled from MCP." No premiums (confirmed with Andrew 2026-09-22 —
// those live in the Renewal Premium Summary .xlsx).
//
// Everything here comes from afw_cprem (AMS360's per-coverage-line rating table), deduped the same
// way the rest of clPolicyData.ts's queries are — partition by (polid, lobid, cpremid), latest
// effdate, then drop 'D'. Where each line of business keeps its limits, confirmed against the live
// tenant (current commercial terms) and Trace Construction's own policies while building this:
//   - GL (CGL/BOPGL): the policy-level rows (attachtype 85 / covlevel 'A') — Each Occurrence,
//     General Aggregate, Products/Completed Ops Aggregate, etc. The rated 'R' rows attached to each
//     hazard (attachtype 330, "Premises/Operations") carry premium only, never a limit (20 of 1,721).
//   - Auto (AUTOB): per vehicle — attachtype 336 rows whose attachid is the afw_127vehicle.vehdid
//     (13/13 matched on Trace's auto policy). attachtype 603 = hired auto, 604 = non-owned auto.
//     The 'A'-level rows repeat the policy's liability limit and are only used when a policy has no
//     per-vehicle rows at all (e.g. a symbol-1 "any auto" policy with no schedule).
//   - Property (PROP/BOPPR): attachtype 320 rows, linked to their subject of insurance and premise
//     address through the same afw_140subofins/afw_140premiseinfo chain PROPERTY_QUERY uses.
//   - WC (WORK): the policy-level "WC & Employer's liability" / "Increased employer's liability"
//     row carries the three Employer's Liability limits as ilimit1/2/3 = Each Accident /
//     Disease-Policy Limit / Disease-Each Employee — confirmed by the tenant's one non-uniform
//     combination (100,000 / 500,000 / 100,000, the standard statutory split).
//   - Umbrella (CUMBR): "Umbrella(C)" at policy level — ilimit1 = Each Occurrence, ilimit2 =
//     Aggregate, deduct = Self-Insured Retention. AMS360 can carry several identical copies of this
//     row (8 on Trace's package), hence the display-level dedupe below.
//   - Everything else (Inland Marine, Crime, EPLI, Cyber, D&O, ...): every row that carries a limit,
//     under its line of business's own description.
const COVERAGE_QUERY = `
  SELECT lob.lineofbus, lob.descriptionlobs, cp.attachtype, cp.covlevel, cp.coverage,
    cp.vlimit1, cp.ilimit1, cp.vlimit2, cp.ilimit2, cp.vlimit3, cp.ilimit3, cp.vlimit4, cp.ilimit4,
    cp.deduct, cp.dedtype
  FROM (
    SELECT cp.*, ROW_NUMBER() OVER (PARTITION BY cp.polid, cp.lobid, cp.cpremid ORDER BY cp.effdate DESC) AS rn
    FROM afw_cprem cp
    WHERE cp.polid = $1
  ) cp
  LEFT JOIN LATERAL (
    SELECT rtrim(l.lineofbus) AS lineofbus, lo.descriptionlobs
    FROM afw_lineofbusiness l
    LEFT JOIN afw_lobsetup lo ON lo.namelobs = l.lineofbus
    WHERE l.polid = cp.polid AND l.lobid = cp.lobid
    LIMIT 1
  ) lob ON true
  WHERE cp.rn = 1 AND cp.status != 'D'
    AND cp.attachtype NOT IN (320, 336)
  ORDER BY lob.lineofbus, cp.sortno NULLS LAST, cp.coverage
`

// Same chain and dedup as clPolicyData.ts's PROPERTY_QUERY, but every subject of insurance (not just
// Building/BPP) and with valuation — this document's Property section is one row per subject of
// insurance, matching the AMS360 proposal-builder layout Sarah Schultz produced for Defatta
// (9/14/2026): Address / Subject of Insurance / Limit / Valuation / Cause of Loss / Deductible.
const PROPERTY_SUBJECT_QUERY = `
  WITH cprem_320 AS (
    SELECT * FROM (
      SELECT cp.*,
        ROW_NUMBER() OVER (PARTITION BY polid, lobid, cpremid ORDER BY effdate DESC) AS rn
      FROM afw_cprem cp
      WHERE attachtype = 320 AND polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  ),
  soi AS (
    SELECT * FROM (
      SELECT s.*,
        ROW_NUMBER() OVER (PARTITION BY polid, lobid, soiid ORDER BY effdate DESC) AS rn
      FROM afw_140subofins s
      WHERE polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  ),
  pi AS (
    SELECT * FROM (
      SELECT p.*,
        ROW_NUMBER() OVER (PARTITION BY polid, lobid, piid ORDER BY effdate DESC) AS rn
      FROM afw_140premiseinfo p
      WHERE polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  ),
  loc AS (
    SELECT * FROM (
      SELECT c.*,
        ROW_NUMBER() OVER (PARTITION BY polid, clocid ORDER BY effdate DESC) AS rn
      FROM afw_clocation c
      WHERE polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  )
  SELECT pi.piid, soi.soiid, loc.locno, loc.addr1, loc.city, loc.state, loc.zip,
    soi.subofins, soi.isubamt, COALESCE(soi.valuation, cprem_320.valuation) AS valuation,
    cprem_320.coverage, cprem_320.ilimit1, cprem_320.vlimit1, cprem_320.deduct, cprem_320.dedtype
  FROM cprem_320
  JOIN soi ON soi.polid = cprem_320.polid AND soi.soiid = cprem_320.attachid
  JOIN pi ON pi.polid = soi.polid AND pi.piid = soi.piid
  JOIN loc ON loc.polid = pi.polid AND loc.clocid = pi.clocid
  ORDER BY loc.locno, pi.piid, soi.soiid, (cprem_320.ilimit1 IS NULL), cprem_320.coverage
`

const VEHICLE_COVERAGE_QUERY = `
  SELECT v.vehno, v.vehyear, v.make, v.model, cp.coverage,
    cp.vlimit1, cp.ilimit1, cp.vlimit2, cp.ilimit2, cp.vlimit3, cp.ilimit3, cp.vlimit4, cp.ilimit4,
    cp.deduct, cp.dedtype
  FROM (
    SELECT cp.*, ROW_NUMBER() OVER (PARTITION BY cp.polid, cp.lobid, cp.cpremid ORDER BY cp.effdate DESC) AS rn
    FROM afw_cprem cp
    WHERE cp.polid = $1 AND cp.attachtype = 336
  ) cp
  JOIN (
    SELECT t.* FROM (
      SELECT t.*, ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.vehdid ORDER BY t.effdate DESC) AS rn
      FROM afw_127vehicle t
      WHERE t.polid = $1
    ) t WHERE t.rn = 1 AND t.status != 'D'
  ) v ON v.vehdid = cp.attachid
  WHERE cp.rn = 1 AND cp.status != 'D'
  ORDER BY v.vehno, cp.coverage
`

type LimitColumns = {
  vlimit1: string | null; ilimit1: number | null; vlimit2: string | null; ilimit2: number | null
  vlimit3: string | null; ilimit3: number | null; vlimit4: string | null; ilimit4: number | null
  deduct: number | null; dedtype: string | null
}

type CoverageQueryRow = LimitColumns & {
  lineofbus: string | null; descriptionlobs: string | null; attachtype: number | null; covlevel: string | null; coverage: string | null
}

type PropertySubjectQueryRow = {
  piid: string; soiid: string; locno: string | null; addr1: string | null; city: string | null; state: string | null; zip: string | null
  subofins: string | null; isubamt: number | null; valuation: string | null
  coverage: string | null; ilimit1: number | null; vlimit1: string | null; deduct: number | null; dedtype: string | null
}

type VehicleCoverageQueryRow = LimitColumns & {
  vehno: string | null; vehyear: string | null; make: string | null; model: string | null; coverage: string | null
}

// ilimitN is the parsed integer copy of vlimitN — preferred when present (0 treated as "no limit",
// which is how AMS360 leaves an unused slot), falling back to the text copy otherwise (it sometimes
// carries a non-numeric label like "Included" or "Statutory").
function limitPart(i: number | null, v: string | null): string {
  if(i !== null && i !== 0) return money(i)
  const text = numericMoney(v)
  return text === "$0" ? "" : text
}

function limitParts(r: LimitColumns): string[] {
  return [
    limitPart(r.ilimit1, r.vlimit1), limitPart(r.ilimit2, r.vlimit2),
    limitPart(r.ilimit3, r.vlimit3), limitPart(r.ilimit4, r.vlimit4)
  ]
}

function joinedLimit(r: LimitColumns): string {
  return limitParts(r).filter(Boolean).join(" / ")
}

// afw_cprem.dedtype is free text (15 distinct values tenant-wide, 2026-09-22) and mostly says
// nothing beyond "dollars" (Flat / Dollars / Per accident / Per claim / null). The ones that change
// the unit: 'Percent' with a small number is a percentage deductible (e.g. 2% wind/hail), while a
// large number under 'Percent' is a data-entry quirk seen on real Wind/Hail rows (100000 'Percent')
// that the client's own reference document shows as a flat dollar amount; 'Hours'/'Number of Hours'
// is a time-element waiting period (business income, civil authority — "24"), and 'Number Of Days'
// likewise in days. Hours values above a week are dollar amounts mislabeled (seen up to 5000).
function formatDeductible(deduct: number | null, dedtype: string | null): string {
  if(deduct === null || deduct === 0) return ""

  const type = clean(dedtype).toLowerCase()
  if(type === "percent" && deduct <= 100) return `${ deduct }%`
  if((type === "hours" || type === "number of hours") && deduct <= 168) return `${ deduct } hours`
  if(type === "number of days" && deduct <= 365) return `${ deduct } days`
  return money(deduct)
}

// Carrier-specific coverage codes (e.g. "WTRBN", "DPPRM") show up in afw_cprem.coverage with no
// description anywhere in the synced schema (checked afw_prcode and every *cov*/*code* table,
// 2026-09-22). They're kept in the document as-is — dropping them would hide a real limit — but
// collected so the tool can tell the CSR which lines to relabel by hand.
const CARRIER_CODE_PATTERN = /^[A-Z0-9]{4,6}$/

function isCarrierCode(coverage: string): boolean {
  return CARRIER_CODE_PATTERN.test(coverage)
}

// Keyed on the rendered values, not cpremid — AMS360 carries several identical rows for the same
// coverage (8 identical "Umbrella(C)" rows on Trace's package) and several attach points can share a
// limit with different deductibles (Trace's two builders-risk sub-records at $2,500 vs $5,000).
// Rows with the same coverage + limit merge, their distinct deductibles joined.
function mergeRows(rows: CoverageLimitRow[]): CoverageLimitRow[] {
  const merged = new Map<string, CoverageLimitRow>()

  for(const row of rows) {
    const key = `${ row.coverage.toLowerCase() }|${ row.limit }`
    const existing = merged.get(key)

    if(!existing) {
      merged.set(key, { ...row })
    } else if(row.deductible && !existing.deductible.split(" / ").includes(row.deductible)) {
      existing.deductible = existing.deductible ? `${ existing.deductible } / ${ row.deductible }` : row.deductible
    }
  }

  return [...merged.values()]
}

// Display order for the standard CGL limits — anything else (Employee Benefits, Cyber, EPLI
// endorsements on the GL line, ...) follows in AMS360's own order.
const GL_LIMIT_ORDER = [
  "each occurrence", "general aggregate", "products/completed ops aggregate",
  "personal & advertising injury", "fire damage", "medical expense"
]

function sortGlRows(rows: CoverageLimitRow[]): CoverageLimitRow[] {
  const rank = (r: CoverageLimitRow) => {
    const idx = GL_LIMIT_ORDER.indexOf(r.coverage.toLowerCase())
    return idx === -1 ? GL_LIMIT_ORDER.length : idx
  }
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r)
}

const EMPLOYERS_LIABILITY_PATTERN = /employer'?s liability/i
const UMBRELLA_PATTERN = /^(umbrella|excess)/i

// The three EL components, taking the highest value seen for each across the WC line's EL rows —
// "Increased employer's liability" (when present) is the limit actually in force over the base
// "WC & Employer's liability" row.
function employersLiabilityRows(rows: CoverageQueryRow[]): CoverageLimitRow[] {
  const labels = ["Each Accident", "Disease – Policy Limit", "Disease – Each Employee"]
  const best: (number | null)[] = [null, null, null]
  const text: string[] = ["", "", ""]

  for(const r of rows) {
    const values = [r.ilimit1, r.ilimit2, r.ilimit3]
    const texts = [r.vlimit1, r.vlimit2, r.vlimit3]

    values.forEach((value, i) => {
      if(value !== null && value !== 0 && (best[i] === null || value > best[i]!)) best[i] = value
      else if(best[i] === null && !text[i]) text[i] = limitPart(null, texts[i])
    })
  }

  return labels
    .map((label, i) => ({ coverage: `Employer's Liability – ${ label }`, limit: best[i] !== null ? money(best[i]!) : text[i], deductible: "" }))
    .filter((r) => r.limit !== "")
}

function umbrellaRows(r: CoverageQueryRow): CoverageLimitRow[] {
  const [occurrence, aggregate] = limitParts(r)
  const retention = formatDeductible(r.deduct, r.dedtype)

  return [
    { coverage: "Each Occurrence", limit: occurrence, deductible: "" },
    { coverage: "Aggregate", limit: aggregate, deductible: "" },
    { coverage: "Self-Insured Retention", limit: retention, deductible: "" }
  ].filter((row) => row.limit !== "")
}

function genericRow(r: CoverageQueryRow): CoverageLimitRow {
  return { coverage: clean(r.coverage), limit: joinedLimit(r), deductible: formatDeductible(r.deduct, r.dedtype) }
}

// Section title per line of business; anything not listed uses AMS360's own LOB description.
// Order in this map is also the order sections appear in the document relative to each other.
const LOB_SECTION_TITLES: Record<string, string> = {
  PROP: "Additional Property Coverages",
  BOPPR: "Business Owners Property Coverages",
  CGL: "General Liability Limits",
  BOPGL: "Business Owners Liability Limits",
  INMRC: "Inland Marine Coverages",
  AUTOB: "Auto Policy Coverages",
  WORK: "Workers' Compensation – Employer's Liability",
  CUMBR: "Umbrella Liability Limits"
}

export type CoverageSectionKey = "property" | "liability" | "inlandMarine" | "auto" | "workersComp" | "umbrella" | "other"

// Which part of the document each LOB's limits table sits next to — liability limits right before
// the GL Exposure schedule, EL limits right before the WC payroll schedule, etc.
const LOB_SECTION_KEYS: Record<string, CoverageSectionKey> = {
  PROP: "property", BOPPR: "property",
  CGL: "liability", BOPGL: "liability",
  INMRC: "inlandMarine", BLDRK: "inlandMarine", CONTR: "inlandMarine",
  AUTOB: "auto",
  WORK: "workersComp",
  CUMBR: "umbrella"
}

export type KeyedCoverageSection = CoverageSection & { key: CoverageSectionKey; lob: string }

export type PolicyCoverageData = {
  propertySubjects: PropertySubjectRow[]
  vehicleCoverages: VehicleCoverageRow[]
  hiredNonOwned: HiredNonOwnedRow[]
  sections: KeyedCoverageSection[]
  carrierCodes: string[]
}

function buildLobSections(rows: CoverageQueryRow[], hasVehicleCoverages: boolean): { sections: KeyedCoverageSection[]; hiredNonOwned: HiredNonOwnedRow[] } {
  const byLob = new Map<string, CoverageQueryRow[]>()
  const hiredNonOwned: HiredNonOwnedRow[] = []

  for(const r of rows) {
    // Hired (603) / non-owned (604) auto get their own small table next to the vehicle schedule.
    if(r.attachtype === 603 || r.attachtype === 604) {
      const limit = joinedLimit(r)
      const deductible = formatDeductible(r.deduct, r.dedtype)
      if(limit || deductible) {
        hiredNonOwned.push({ exposure: r.attachtype === 603 ? "Hired Auto" : "Non-Owned Auto", coverage: clean(r.coverage), limit, deductible })
      }
      continue
    }

    const lob = clean(r.lineofbus) || "OTHER"
    const list = byLob.get(lob)
    if(list) list.push(r); else byLob.set(lob, [r])
  }

  const sections: KeyedCoverageSection[] = []

  for(const [lob, lobRows] of byLob) {
    // Per-vehicle rows already show the auto liability limits; the policy-level copies are only
    // useful when there's no vehicle schedule to show them on.
    if(lob === "AUTOB" && hasVehicleCoverages) continue

    let out: CoverageLimitRow[] = []

    if(lob === "WORK") {
      const elRows = lobRows.filter((r) => EMPLOYERS_LIABILITY_PATTERN.test(clean(r.coverage)))
      out.push(...employersLiabilityRows(elRows))
      out.push(...lobRows.filter((r) => !EMPLOYERS_LIABILITY_PATTERN.test(clean(r.coverage))).map(genericRow).filter((r) => r.limit !== ""))
    } else if(lob === "CUMBR") {
      for(const r of lobRows) {
        if(UMBRELLA_PATTERN.test(clean(r.coverage))) out.push(...umbrellaRows(r))
        else {
          const row = genericRow(r)
          if(row.limit !== "") out.push(row)
        }
      }
    } else {
      // A limit is what earns a row here — deductible-only lines are almost always carrier rating
      // codes or form references (Trace's "BRBKT"/"EMRMV" rows) rather than a coverage the client
      // would review, and flat-premium lines (taxes, minimum-premium adjustments) never carry one.
      out = lobRows.map(genericRow).filter((r) => r.limit !== "")
    }

    out = mergeRows(out)
    if(lob === "CGL" || lob === "BOPGL") out = sortGlRows(out)
    if(out.length === 0) continue

    // "OTHER" = a cprem row whose lobid has no afw_lineofbusiness row (seen once in a 60-account sweep).
    const description = clean(lobRows[0].descriptionlobs) || (lob === "OTHER" ? "Other" : lob)
    sections.push({
      key: LOB_SECTION_KEYS[lob] ?? "other",
      lob,
      title: LOB_SECTION_TITLES[lob] ?? `${ description } Coverages`,
      rows: out
    })
  }

  return { sections, hiredNonOwned: mergeHiredNonOwned(hiredNonOwned) }
}

function mergeHiredNonOwned(rows: HiredNonOwnedRow[]): HiredNonOwnedRow[] {
  const seen = new Set<string>()
  return rows.filter((r) => {
    const key = `${ r.exposure }|${ r.coverage }|${ r.limit }|${ r.deductible }`
    if(seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Wind/hail (and similar peril-specific) deductibles are recorded two ways in AMS360: as their own
// "Wind/Hail Deductible" cprem line on the same subject of insurance, or as a separate subject of
// insurance with no limit ("Wind Hail Ded"). Either way the client's reference layout shows them
// inline on the Deductible column — "$1,000 ($100,000 Wind/Hail)" — not as a row of their own.
const PERIL_DEDUCTIBLE_PATTERN = /wind|hail|earthquake|named storm|hurricane/i

function perilLabel(text: string): string {
  if(/wind|hail/i.test(text)) return "Wind/Hail"
  if(/earthquake/i.test(text)) return "Earthquake"
  if(/named storm|hurricane/i.test(text)) return "Named Storm"
  return text
}

const VALUATION_LABELS: Record<string, string> = {
  RC: "Replacement Cost", ACV: "Actual Cash Value", ALS: "Actual Loss Sustained", Replacement: "Replacement Cost",
  "REPLACEMENT COST": "Replacement Cost", "ACTUAL CASH VALUE": "Actual Cash Value"
}

// Some carriers (Cincinnati-style rating) attach every coverage line for a building to its subject
// of insurance, each carrying a limit: the cause-of-loss forms themselves ("Special form", "Basic
// Group I - Detail"), valuation/rating markers that just repeat the building limit ("RC",
// "Inflation guard (C)", "Theft extension"), and genuine additional coverages with their own limit
// ("Building ordinance or law coverage", "Building Demolition", "Tenants Improvements and
// Betterments"). Confirmed against a live policy 2026-09-22. Classified so the forms become the
// Cause of Loss column, the markers disappear, and the additional coverages get their own row under
// the same address rather than being mistaken for a cause of loss.
const CAUSE_OF_LOSS_PATTERN = /special|broad form|basic|group i|named peril|spcl prop/i
const VALUATION_MARKER_PATTERN = /^(rc|acv|replacement cost|actual cash value)$/i
const RATING_MARKER_PATTERN = /inflation guard|theft extension|coinsurance/i

function buildPropertySubjectRows(rows: PropertySubjectQueryRow[]): PropertySubjectRow[] {
  const bySubject = new Map<string, PropertySubjectQueryRow[]>()
  for(const r of rows) {
    const list = bySubject.get(r.soiid)
    if(list) list.push(r); else bySubject.set(r.soiid, [r])
  }

  type Pending = PropertySubjectRow & { piid: string; perilDeductibles: string[] }
  const pending: Pending[] = []
  const addressPerilDeductibles = new Map<string, string[]>()
  const hasLimit = (r: PropertySubjectQueryRow) => (r.ilimit1 !== null && r.ilimit1 !== 0) || limitPart(null, r.vlimit1) !== ""

  for(const subjectRows of bySubject.values()) {
    const first = subjectRows[0]
    const subject = clean(first.subofins)
    const address = formatAddress(first.addr1, first.city, first.state, first.zip)
    const valuationText = clean(first.valuation)
    let valuation = VALUATION_LABELS[valuationText] ?? valuationText

    const limitRows = subjectRows.filter(hasLimit)
    const perilRows = subjectRows.filter((r) => !hasLimit(r) && r.deduct && PERIL_DEDUCTIBLE_PATTERN.test(clean(r.coverage)))

    // A limit-less subject of insurance that's really a peril deductible ("Wind Hail Ded") —
    // attach its deductible to every other subject at the same premise.
    if(limitRows.length === 0) {
      const deductible = subjectRows.find((r) => r.deduct)
      if(deductible && PERIL_DEDUCTIBLE_PATTERN.test(subject)) {
        const list = addressPerilDeductibles.get(first.piid) ?? []
        list.push(`${ formatDeductible(deductible.deduct, deductible.dedtype) } ${ perilLabel(subject) }`)
        addressPerilDeductibles.set(first.piid, list)
      } else if(first.isubamt) {
        // No cprem limit but the subject itself carries an amount of insurance.
        pending.push({
          piid: first.piid, address, subject, limit: money(first.isubamt), valuation,
          causeOfLoss: subjectRows.map((r) => clean(r.coverage)).find((c) => CAUSE_OF_LOSS_PATTERN.test(c)) ?? "",
          deductible: formatDeductible(first.deduct, first.dedtype), perilDeductibles: []
        })
      }
      continue
    }

    const causeRows = limitRows.filter((r) => CAUSE_OF_LOSS_PATTERN.test(clean(r.coverage)))
    const additionalRows = limitRows.filter((r) => {
      const coverage = clean(r.coverage)
      return !CAUSE_OF_LOSS_PATTERN.test(coverage) && !VALUATION_MARKER_PATTERN.test(coverage) && !RATING_MARKER_PATTERN.test(coverage)
    })
    if(!valuation && limitRows.some((r) => VALUATION_MARKER_PATTERN.test(clean(r.coverage)))) {
      const marker = limitRows.find((r) => VALUATION_MARKER_PATTERN.test(clean(r.coverage)))!
      valuation = VALUATION_LABELS[clean(marker.coverage).toUpperCase()] ?? clean(marker.coverage)
    }

    // With no recognizable cause-of-loss form, the subject's own first limit line is its limit
    // (e.g. a Tenants Improvements subject rated on its own line) and isn't repeated as an
    // additional coverage below.
    const main = causeRows[0] ?? additionalRows.shift() ?? limitRows[0]

    // The broadest form wins when several are listed (Special form over the Basic Group I/II
    // detail lines some carriers also carry); otherwise every distinct form, in order.
    const forms = [...new Set(causeRows.map((r) => clean(r.coverage)).filter(Boolean))]
    const special = forms.find((f) => /special/i.test(f))
    const causeOfLoss = special ?? forms.join("; ")

    pending.push({
      piid: first.piid, address, subject,
      limit: limitPart(main.ilimit1, main.vlimit1),
      valuation,
      causeOfLoss,
      deductible: formatDeductible(main.deduct, main.dedtype),
      perilDeductibles: perilRows.map((r) => `${ formatDeductible(r.deduct, r.dedtype) } ${ perilLabel(clean(r.coverage)) }`)
    })

    for(const r of additionalRows) {
      pending.push({
        piid: first.piid, address, subject: clean(r.coverage),
        limit: limitPart(r.ilimit1, r.vlimit1), valuation: "", causeOfLoss: "",
        deductible: formatDeductible(r.deduct, r.dedtype), perilDeductibles: []
      })
    }
  }

  const seen = new Set<string>()

  return pending
    .filter((r) => {
      const key = `${ r.piid }|${ r.subject.toLowerCase() }|${ r.limit }|${ r.deductible }`
      if(seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(({ piid, perilDeductibles, ...row }) => {
      // Peril deductibles only ride along on the subject's own row, not its additional coverages.
      const extras = row.causeOfLoss || perilDeductibles.length > 0
        ? [...new Set([...perilDeductibles, ...(addressPerilDeductibles.get(piid) ?? [])])]
        : []
      const deductible = extras.length === 0 ? row.deductible : `${ row.deductible }${ row.deductible ? " " : "" }(${ extras.join("; ") })`
      return { ...row, deductible }
    })
}

type VehicleColumn = { key: string; label: string; match: RegExp; value: "limit" | "deductible" }

// Display order (left to right in the Vehicle Coverages table).
export const VEHICLE_COLUMNS: VehicleColumn[] = [
  { key: "csl", label: "Liability (CSL)", match: /combined single limit|auto liability/i, value: "limit" },
  { key: "bi", label: "Bodily Injury", match: /^bodily injury/i, value: "limit" },
  { key: "pd", label: "Property Damage", match: /^property damage/i, value: "limit" },
  { key: "medpay", label: "Med Pay", match: /medical payments/i, value: "limit" },
  { key: "pip", label: "PIP", match: /personal injury protection|^pip\b/i, value: "limit" },
  { key: "um", label: "Uninsured Motorist", match: /uninsured/i, value: "limit" },
  { key: "uim", label: "Underinsured Motorist", match: /underinsured/i, value: "limit" },
  { key: "umpd", label: "UM Property Damage", match: /uninsured motorist property damage/i, value: "limit" },
  { key: "comp", label: "Comp Ded", match: /^comprehensive|other than collision|specified (causes|perils)/i, value: "deductible" },
  { key: "coll", label: "Collision Ded", match: /^collision/i, value: "deductible" },
  { key: "towing", label: "Towing", match: /towing/i, value: "limit" },
  { key: "rental", label: "Rental", match: /rental/i, value: "limit" }
]

// Match precedence, separate from display order — the more specific patterns must be tried first,
// since "Uninsured motorist combined single limit" also contains "combined single limit" and
// "Uninsured motorist property damage" also contains "uninsured".
const VEHICLE_COLUMN_MATCH_ORDER = ["umpd", "uim", "um", "csl", "bi", "pd", "medpay", "pip", "comp", "coll", "towing", "rental"]
  .map((key) => VEHICLE_COLUMNS.find((c) => c.key === key)!)

function buildVehicleCoverageRows(rows: VehicleCoverageQueryRow[]): VehicleCoverageRow[] {
  const byVehicle = new Map<string, VehicleCoverageRow>()

  for(const r of rows) {
    const vehNo = clean(r.vehno)
    let vehicle = byVehicle.get(vehNo)
    if(!vehicle) {
      vehicle = { vehNo, description: [clean(r.vehyear), clean(r.make), clean(r.model)].filter(Boolean).join(" "), values: {} }
      byVehicle.set(vehNo, vehicle)
    }

    const coverage = clean(r.coverage)
    const column = VEHICLE_COLUMN_MATCH_ORDER.find((c) => c.match.test(coverage))
    if(!column) continue

    const value = column.value === "limit" ? joinedLimit(r) : formatDeductible(r.deduct, r.dedtype)
    if(value && !vehicle.values[column.key]) vehicle.values[column.key] = value
  }

  return [...byVehicle.values()]
}

export async function fetchPolicyCoverageData(polid: string): Promise<PolicyCoverageData> {
  const [coverageRows, propertyRows, vehicleRows] = await Promise.all([
    runReadOnlyQuery(COVERAGE_QUERY, [polid]) as Promise<CoverageQueryRow[]>,
    runReadOnlyQuery(PROPERTY_SUBJECT_QUERY, [polid]) as Promise<PropertySubjectQueryRow[]>,
    runReadOnlyQuery(VEHICLE_COVERAGE_QUERY, [polid]) as Promise<VehicleCoverageQueryRow[]>
  ])

  const vehicleCoverages = buildVehicleCoverageRows(vehicleRows)
  const { sections, hiredNonOwned } = buildLobSections(coverageRows, vehicleCoverages.length > 0)
  const propertySubjects = buildPropertySubjectRows(propertyRows)

  const carrierCodes = [
    ...sections.flatMap((s) => s.rows.map((r) => r.coverage)),
    ...propertySubjects.flatMap((p) => [p.subject, ...p.causeOfLoss.split("; ")]),
    ...hiredNonOwned.map((h) => h.coverage)
  ].filter(isCarrierCode)

  return { propertySubjects, vehicleCoverages, hiredNonOwned, sections, carrierCodes: [...new Set(carrierCodes)] }
}

// Combines several policies' coverage data into one document's worth — sections for the same line
// of business (rare: two separate CGL policies) merge under one title rather than repeating it.
export function combineCoverageData(perPolicy: PolicyCoverageData[]): PolicyCoverageData {
  const sectionsByTitle = new Map<string, KeyedCoverageSection>()

  for(const section of perPolicy.flatMap((p) => p.sections)) {
    const existing = sectionsByTitle.get(section.title)
    if(existing) existing.rows = mergeRows([...existing.rows, ...section.rows])
    else sectionsByTitle.set(section.title, { ...section, rows: [...section.rows] })
  }

  return {
    propertySubjects: perPolicy.flatMap((p) => p.propertySubjects),
    vehicleCoverages: perPolicy.flatMap((p) => p.vehicleCoverages),
    hiredNonOwned: mergeHiredNonOwned(perPolicy.flatMap((p) => p.hiredNonOwned)),
    sections: [...sectionsByTitle.values()],
    carrierCodes: [...new Set(perPolicy.flatMap((p) => p.carrierCodes))]
  }
}
