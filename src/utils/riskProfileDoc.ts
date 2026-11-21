import { Document, LineRuleType, Packer, Paragraph, SectionType } from "docx"
import { blocksPiece, createLayout, type Block, type BlockPiece, type Piece, tablePiece } from "./docLayout.js"
import {
  COVER_MARGINS, FOOTER_STYLE, CHAR, PAGE_HEIGHT, PAGE_WIDTH, closingFooter, coverPage as brandCover, interiorFooter,
  interiorHeader, sectionOpener, subHeader
} from "./proposalBrand.js"

// The Pre-Renewal Review (risk_profile). Content follows Patrick's pre-renewal-review skill:
// exposures and schedules only — no coverage summaries, nothing about premium — with sections only
// for lines in force, in the skill's order. Section data comes from already-queried Postgres rows
// (clPolicyData.ts).
//
// Styled in Boxwood's house style (proposalBrand.ts, Patrick 2026-11-21: every output document
// shares it): the house cover (no advisor block — Patrick removed it; the charcoal band lists the
// program's carriers and lines instead), the logo + client-name page header and page-number footer,
// compact section openers, charcoal-header data tables, and the mint contact band at the foot of the
// last page. Side margins stay 0.625" so the six-column tables keep their room.
//
// Page breaks (the skill's "keep it condensed"): an unconditional break per section wastes half a
// page or splits a table awkwardly, so layoutSections() estimates each section's height and only
// breaks when the next section won't fit in what's left. The content after the last break is the
// closing page, cut to one page by docLayout's splitForClosing so the band prints there only.

const MARGIN_X = 900
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X // 10440 DXA
const MARGINS = { top: 1300, right: MARGIN_X, bottom: 900, left: MARGIN_X, header: 400, footer: 400 }

const layout = createLayout(TEXT_WIDTH)

export function money(v: number | string | null | undefined): string {
  if(v === null || v === undefined || v === "") return ""
  // node-postgres returns bigint/numeric columns as strings: a bare amount ("500000") still gets
  // "$" and commas, while text labels ("Included", "Statutory", "$1,000") pass through unchanged.
  if(typeof v === "string") return /^-?\d+(\.\d+)?$/.test(v.trim()) ? `$${ Number(v).toLocaleString("en-US") }` : v

  return `$${ Number(v).toLocaleString("en-US") }`
}

// ---------- HEIGHT ESTIMATION / PAGE-FIT LOGIC ----------
// Table heights come from docLayout; the rest are this document's own figures, in twips.
const PAGE_USABLE_HEIGHT = Math.floor(0.97 * (PAGE_HEIGHT - MARGINS.top - MARGINS.bottom))
// A page carrying the full-size closing band, with docLayout's safety margin.
const CLOSING_PAGE_HEIGHT = Math.floor(0.92 * (PAGE_HEIGHT - MARGINS.top - 2900))
const SECTION_GAP = 560 // the extra space between sections, ~0.4" — exact line height, so it's precise
const OPENER_HEIGHT = 1050 // measured from a render: eyebrow, rule, 14pt headline and their spacing
const SUB_HEADER_HEIGHT = 580

const pad = (n: number) => String(n).padStart(2, "0")

type SectionBody = { title: string; pieces: Piece[] }
// A section opener can also force its own page break (pageBreakBefore) when layoutSections starts
// the section on a new page.
type Section = Piece[]

function opener(title: string, index: number, total: number): BlockPiece {
  return blocksPiece(OPENER_HEIGHT, (_startsPage, breakBefore) => sectionOpener({
    eyebrowText: `Section ${ pad(index + 1) } of ${ pad(total) }`, title, compact: true, before: 0, pageBreak: breakBefore, textWidth: TEXT_WIDTH
  }), { keepWithNext: true })
}

// Dropped when it would open a page.
const sectionGap = () => blocksPiece(SECTION_GAP, (startsPage) => startsPage ? [] : [
  new Paragraph({ spacing: { before: 0, after: 0, line: SECTION_GAP, lineRule: LineRuleType.EXACT }, children: [] })
])

const sectionHeight = (section: Section) => section.reduce((h, p) => h + layout.pieceHeight(p), 0)

// The gap goes before every section except one starting a page. A section taller than a page still
// starts on a fresh page and flows on — the `cursor > 0` guard keeps it from breaking when already
// at the top of one. "break" marks a forced page break.
type Item = Piece | "break"

function layoutSections(sections: Section[]): Item[] {
  let cursor = 0
  const out: Item[] = []

  for(const sec of sections) {
    const height = sectionHeight(sec)
    const gapHeight = cursor > 0 ? SECTION_GAP : 0

    if(cursor > 0 && gapHeight + height > PAGE_USABLE_HEIGHT - cursor) {
      out.push("break")
      cursor = 0
    } else if(gapHeight > 0) {
      out.push(sectionGap())
      cursor += gapHeight
    }

    out.push(...sec)
    cursor = cursor + height <= PAGE_USABLE_HEIGHT ? cursor + height : (cursor + height) % PAGE_USABLE_HEIGHT
  }

  return out
}

function renderFlow(items: Item[]): Block[] {
  const out: Block[] = []
  let breakNext = false
  for(const item of items) {
    if(item === "break") { breakNext = true; continue }
    out.push(...(item.kind === "table" ? layout.render([item], false) : item.render(false, breakNext)))
    breakNext = false
  }
  return out
}

function tableSection(title: string, headers: string[], rows: string[][], opts: { keepBlank?: boolean } = {}): SectionBody | null {
  if(rows.length === 0) return null
  return { title, pieces: [tablePiece(headers, rows, opts)] }
}

// ---------- SECTION INPUT TYPES ----------
// No per-row "Policy #" tag — even when combining several monoline policies into one document (see
// riskProfile.ts), each section's rows only ever come from one of those policies in
// practice (Property/GL from the property policy, Vehicles/Drivers from auto, etc.), so the column
// was pure noise. Each section's header names its line of business (Andrew, 2026-10-10), and the
// cover's Carrier | Line of Business table says what's combined.
export type LocationRow = { locNo: string; address: string; city: string; state: string; zip: string }
// One row per premise/address (see PROPERTY_QUERY in riskProfile.ts for how Building vs
// BPP limits and the Causes of Loss Form/Deductible pairing are derived) — Building/BPP limits are
// summed separately per address, but Causes of Loss Form and Deductible are shared columns across
// both, since AMS360 doesn't split those by subject of insurance the way it does the limit itself.
// `description` is always blank — a free-text field for staff to annotate by hand during the renewal
// meeting, matching the client's own reference layout; the tool has nothing to put there.
export type PropertyRow = { address: string; buildingLimit: string; bppLimit: string; causesOfLossForm: string; deductible: string; description: string }
// locNo is only shown by the CL Renewal Summary's classification schedule (clProposalLines.ts).
export type GlExposureRow = { locNo?: string; location: string; classCode: string; classification: string; basis: string; exposure: string }
// Field set/order matches the client's own reference layout (client feedback, 2026-09-15): Covered
// Location and Coverage/Deductible come from a separate join (afw_146locations/afw_clocation and
// afw_cprem respectively — see EQUIPMENT_BLANKET_QUERY's comment), not columns on
// afw_146equipsummary itself. scheduledUnscheduled is already a resolved label (afw_prcode's ISU
// AttrCode), not a raw code.
export type EquipmentBlanket = { coveredLocation: string; category: string; scheduledUnscheduled: string; coverage: string; amountOfInsurance: string; totalItems: string; deductible: string }
export type EquipmentItemRow = { itemNo: string; manufacturer: string; model: string; description: string; serialNo: string; value: string }
export type VehicleRow = { vehNo: string; year: string; make: string; model: string; vin: string }
export type DriverRow = { driverNo: string; name: string; licenseState: string }
// No location here per Patrick's feedback (9/13): "Don't have to have addresses for workers comp
// payroll. Just class codes and exposure."
export type WcExposureRow = { classCode: string; classification: string; payroll: string }

// One row per policy on the cover — carrier and line of business only (Andrew, 2026-10-10: "just need
// the carrier and line of business"), shown for single-policy documents too. No premium anywhere in
// this document: premiums are the Renewal Premium Spreadsheet's job.
export type CoverPolicyRow = { carrier: string; lineOfBusiness: string }

export type RiskProfileInput = {
  clientName: string
  additionalNamedInsureds: string[]
  currentPeriod: string
  renewalDate: string
  coverPolicies: CoverPolicyRow[]
  locations: LocationRow[]
  property: PropertyRow[]
  glExposure: GlExposureRow[]
  equipmentBlanket: EquipmentBlanket[]
  equipmentItems: EquipmentItemRow[]
  vehicles: VehicleRow[]
  drivers: DriverRow[]
  wcExposure: WcExposureRow[]
}

function namedInsuredsSection(clientName: string, additional: string[]): SectionBody | null {
  return tableSection("Named Insureds", ["Named Insured"], [clientName, ...additional].map((n) => [n]))
}

function locationsSection(rows: LocationRow[]): SectionBody | null {
  return tableSection("Locations Schedule", ["Loc #", "Address", "City", "State", "Zip"], rows.map((l) => [l.locNo, l.address, l.city, l.state, l.zip]))
}

// One row per premise/address — see PropertyRow's own comment and PROPERTY_QUERY in clPolicyData.ts
// for how this is derived. Description stays blank for staff to annotate.
function propertySection(rows: PropertyRow[]): SectionBody | null {
  return tableSection(
    "Property Coverage",
    ["Address", "Building Limit", "BPP Limit", "Causes of Loss Form", "Deductible", "Description"],
    rows.map((p) => [p.address, p.buildingLimit, p.bppLimit, p.causesOfLossForm, p.deductible, p.description]),
    { keepBlank: true }
  )
}

// Renewal Exposure is left blank for the renewal meeting.
function glSection(rows: GlExposureRow[]): SectionBody | null {
  return tableSection(
    "General Liability Exposure",
    ["Location", "Class Code", "Classification", "Basis", "Current Exposure", "Renewal Exposure"],
    rows.map((g) => [g.location, g.classCode, g.classification, g.basis, g.exposure, ""]),
    { keepBlank: true }
  )
}

function equipmentSection(blankets: EquipmentBlanket[], items: EquipmentItemRow[]): SectionBody | null {
  if(blankets.length === 0 && items.length === 0) return null

  const pieces: Piece[] = []
  for(const blanket of blankets) {
    const rows = [
      ["Covered Location", blanket.coveredLocation],
      ["Category", blanket.category],
      ["Scheduled / Unscheduled", blanket.scheduledUnscheduled],
      ["Coverage", blanket.coverage],
      ["Blanket Amount of Insurance", blanket.amountOfInsurance],
      ["Total Scheduled Items", blanket.totalItems],
      ["Deductible", blanket.deductible]
    ]
    pieces.push(blocksPiece(SUB_HEADER_HEIGHT, () => [subHeader("Blanket Summary")], { keepWithNext: true }), tablePiece(["Field", "Value"], rows))
  }

  if(items.length > 0) {
    const headers = ["Item #", "Manufacturer", "Model", "Description", "Serial #", "Value"]
    const rows = items.map((e) => [e.itemNo, e.manufacturer, e.model, e.description, e.serialNo, e.value])
    pieces.push(blocksPiece(SUB_HEADER_HEIGHT, () => [subHeader("Scheduled Items")], { keepWithNext: true }), tablePiece(headers, rows))
  }

  return { title: "Equipment List & Value", pieces }
}

function vehiclesSection(rows: VehicleRow[]): SectionBody | null {
  return tableSection("Vehicle List", ["Veh #", "Year", "Make", "Model", "VIN"], rows.map((v) => [v.vehNo, v.year, v.make, v.model, v.vin]))
}

// Only columns DRIVERS_QUERY selects — no DOB/license number, which are kept out of the replicated
// database on purpose (see DRIVERS_QUERY). Date Hired dropped per client feedback (9/13).
function driversSection(rows: DriverRow[]): SectionBody | null {
  return tableSection("Driver Information Schedule", ["Driver #", "Name", "License State"], rows.map((d) => [d.driverNo, d.name, d.licenseState]))
}

// No Location column per Patrick (9/13): "Just class codes and exposure." Renewal Payroll is left
// blank for the renewal meeting.
function wcSection(rows: WcExposureRow[]): SectionBody | null {
  return tableSection(
    "Workers' Compensation Exposure",
    ["Class Code", "Classification", "Current Payroll", "Renewal Payroll"],
    rows.map((w) => [w.classCode, w.classification, w.payroll, ""]),
    { keepBlank: true }
  )
}

// The house cover (proposalBrand.coverPage). The skill's cover ends with the policy period — no
// meeting date, agent or contact block (Patrick) — so the Prepared For cards are the insured and the
// "Current Policy Period" / "Renewal Effective" dates (always shown: client feedback 2026-09-15, kept
// by Andrew 2026-10-10; the primary policy's dates), and the charcoal band, instead of an advisor,
// lists every policy in the document as line of business → carrier (Andrew, 2026-10-10: "just need
// the carrier and line of business").
function coverPage(input: RiskProfileInput): Block[] {
  return brandCover({
    eyebrow: "Pre-Renewal Review",
    title: input.clientName,
    titleAccent: `Renewal effective ${ input.renewalDate }.`,
    preparedFor: {
      headline: ["Confidence in your coverage", "comes first."],
      facts: [["Named Insured", input.clientName], ["Current Policy Period", input.currentPeriod], ["Renewal Effective", input.renewalDate]]
    },
    preparedBy: input.coverPolicies.map((p) => [p.lineOfBusiness, p.carrier]),
    preparedByEyebrow: "Your Program"
  })
}

// Returns the section names actually included, in document order — the caller reports this back to
// the user so they know which sections were present in the source data (never surfaced in the
// document itself, matching the skill's own "no commentary in the deliverable" rule).
export async function buildRiskProfileDoc(input: RiskProfileInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const bodies = [
    namedInsuredsSection(input.clientName, input.additionalNamedInsureds),
    locationsSection(input.locations),
    propertySection(input.property),
    glSection(input.glExposure),
    equipmentSection(input.equipmentBlanket, input.equipmentItems),
    vehiclesSection(input.vehicles),
    driversSection(input.drivers),
    wcSection(input.wcExposure)
  ].filter((s): s is SectionBody => s !== null)
  const sections = bodies.map((b, i) => [opener(b.title, i, bodies.length), ...b.pieces])

  // The closing page is what layoutSections puts after its last page break (or everything, when
  // the sections fit on one page). Whatever of it won't fit above the band flows on before it.
  const items = layoutSections(sections)
  const lastBreak = items.lastIndexOf("break")
  const tail = items.slice(lastBreak + 1) as Piece[]
  const { before, closing } = layout.splitForClosing(tail, CLOSING_PAGE_HEIGHT, { breakBefore: lastBreak >= 0 })
  const flow = [...renderFlow(items.slice(0, Math.max(0, lastBreak))), ...before]

  const page = { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: MARGINS }
  const header = { default: interiorHeader(input.clientName, { textWidth: TEXT_WIDTH }) }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20, color: CHAR } } }, paragraphStyles: [FOOTER_STYLE] },
    sections: [
      { properties: { page: { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: COVER_MARGINS } }, children: coverPage(input) },
      ...(flow.length > 0 ? [{ properties: { type: SectionType.NEXT_PAGE, page }, headers: header, footers: { default: interiorFooter({ textWidth: TEXT_WIDTH }) }, children: flow }] : []),
      {
        properties: { type: SectionType.NEXT_PAGE, page },
        headers: header,
        footers: { default: closingFooter({ sideMargin: MARGIN_X, textWidth: TEXT_WIDTH }) },
        children: closing
      }
    ]
  })

  return { buffer: Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array), includedSections: bodies.map((b) => b.title) }
}
