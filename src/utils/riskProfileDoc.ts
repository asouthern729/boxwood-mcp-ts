import { AlignmentType, BorderStyle, Document, ImageRun, LineRuleType, Packer, Paragraph } from "docx"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AGENCY, CELL_PADDING, GREEN as PROPOSAL_GREEN, HEADER_FILL, MARGIN, MUTED, PAGE_WIDTH, PROPOSAL_LOGO_PATH, TEXT,
  banner, centered, columnWidths, dataTable, divider, pageBreak, run, subHeader, type Block
} from "./proposalStyle.js"

// The Pre-Renewal Review, styled like the CL Renewal Summary (Andrew, 2026-10-10): same palette,
// cover, banners and data tables (proposalStyle.ts), but sections flow on from one another instead
// of each starting a page, and nothing about premium appears anywhere. Section data comes from
// already-queried Postgres rows (clPolicyData.ts).
//
// Page breaks: an unconditional break per section wastes half a page or splits a table awkwardly,
// so layoutSections() estimates each section's height and only breaks when the next section won't
// fit in what's left (ported from the client-supplied pre-renewal-review skill's build-template.js).

// The older palette — still used by the PL Renewal Summary (plRenewalSummaryDoc.ts).
export const GREEN = "459361"
export const NEARBLACK = "231F20"
export const LIGHTGREEN = "E3F0E7"
export const LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-logo.png")

export function money(v: number | string | null | undefined): string {
  if(v === null || v === undefined || v === "") return ""
  if(typeof v === "string") return v

  return `$${ Number(v).toLocaleString("en-US") }`
}

// ---------- HEIGHT ESTIMATION / PAGE-FIT LOGIC ----------
// Estimates in twips for proposalStyle's figures (9pt table text, 70/80 cell margins, 14pt banner,
// 12pt sub-header). If those change, re-check against a rendered PDF.
const PAGE_USABLE_HEIGHT = 15840 - 2 * MARGIN // 14040 twips per page
const SECTION_GAP = 560 // the extra space between sections, ~0.4" — exact line height, so it's precise
const BANNER_HEIGHT = 700 // banner row (100+100 margins + 14pt line) plus its spacer
const SUB_HEADER_HEIGHT = 560
const ROW_LINE_HEIGHT = 230
const BODY_ROW_VPAD = 140
const HEADER_ROW_VPAD = 160
const TEXT_CHAR_WIDTH = 100 // ~one 9pt Arial character, in DXA

function estimateCellLines(text: string, width: number): number {
  const charsPerLine = Math.max(1, Math.floor((width - CELL_PADDING) / TEXT_CHAR_WIDTH))
  return Math.max(1, Math.ceil(String(text).length / charsPerLine))
}

function estimateRowHeight(values: string[], widths: number[], vpad: number): number {
  const lines = Math.max(1, ...values.map((v, i) => estimateCellLines(v, widths[i])))
  return lines * ROW_LINE_HEIGHT + vpad
}

function estimateTableHeight(headers: string[], rows: string[][]): number {
  const widths = columnWidths(headers, rows)
  return estimateRowHeight(headers, widths, HEADER_ROW_VPAD) + rows.reduce((h, r) => h + estimateRowHeight(r, widths, BODY_ROW_VPAD), 0)
}

type DocSection = { height: number; blocks: Block[] }

function gap(): Paragraph {
  return new Paragraph({ spacing: { before: 0, after: 0, line: SECTION_GAP, lineRule: LineRuleType.EXACT }, children: [] })
}

// The gap goes before every section except one starting a page. A section taller than a page still
// starts on a fresh page and flows on — the `cursor > 0` guard keeps it from breaking when already
// at the top of one.
function layoutSections(sectionList: DocSection[]): Block[] {
  let cursor = 0
  const out: Block[] = []

  for(const sec of sectionList) {
    const gapHeight = cursor > 0 ? SECTION_GAP : 0

    if(cursor > 0 && gapHeight + sec.height > PAGE_USABLE_HEIGHT - cursor) {
      out.push(pageBreak())
      cursor = 0
    } else if(gapHeight > 0) {
      out.push(gap())
      cursor += gapHeight
    }

    out.push(...sec.blocks)
    cursor = cursor + sec.height <= PAGE_USABLE_HEIGHT ? cursor + sec.height : (cursor + sec.height) % PAGE_USABLE_HEIGHT
  }

  return out
}

function tableSection(title: string, headers: string[], rows: string[][], opts: { keepBlank?: boolean } = {}): DocSection | null {
  if(rows.length === 0) return null
  return {
    height: BANNER_HEIGHT + estimateTableHeight(headers, rows),
    blocks: [...banner(title, { withLogo: false }), dataTable(headers, rows, undefined, opts)]
  }
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

function namedInsuredsSection(clientName: string, additional: string[]): DocSection | null {
  return tableSection("Named Insureds", ["Named Insured"], [clientName, ...additional].map((n) => [n]))
}

function locationsSection(rows: LocationRow[]): DocSection | null {
  return tableSection("Locations Schedule", ["Loc #", "Address", "City", "State", "Zip"], rows.map((l) => [l.locNo, l.address, l.city, l.state, l.zip]))
}

// One row per premise/address — see PropertyRow's own comment and PROPERTY_QUERY in clPolicyData.ts
// for how this is derived. Description stays blank for staff to annotate.
function propertySection(rows: PropertyRow[]): DocSection | null {
  return tableSection(
    "Property Coverage",
    ["Address", "Building Limit", "BPP Limit", "Causes of Loss Form", "Deductible", "Description"],
    rows.map((p) => [p.address, p.buildingLimit, p.bppLimit, p.causesOfLossForm, p.deductible, p.description]),
    { keepBlank: true }
  )
}

// Renewal Exposure is left blank for the renewal meeting.
function glSection(rows: GlExposureRow[]): DocSection | null {
  return tableSection(
    "General Liability Exposure",
    ["Location", "Class Code", "Classification", "Basis", "Current Exposure", "Renewal Exposure"],
    rows.map((g) => [g.location, g.classCode, g.classification, g.basis, g.exposure, ""]),
    { keepBlank: true }
  )
}

function equipmentSection(blankets: EquipmentBlanket[], items: EquipmentItemRow[]): DocSection | null {
  if(blankets.length === 0 && items.length === 0) return null

  const blocks: Block[] = banner("Equipment List & Value", { withLogo: false })
  let height = BANNER_HEIGHT

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
    blocks.push(subHeader("Blanket Summary"), dataTable(["Field", "Value"], rows))
    height += SUB_HEADER_HEIGHT + estimateTableHeight(["Field", "Value"], rows)
  }

  if(items.length > 0) {
    const headers = ["Item #", "Manufacturer", "Model", "Description", "Serial #", "Value"]
    const rows = items.map((e) => [e.itemNo, e.manufacturer, e.model, e.description, e.serialNo, e.value])
    blocks.push(subHeader("Scheduled Items"), dataTable(headers, rows))
    height += SUB_HEADER_HEIGHT + estimateTableHeight(headers, rows)
  }

  return { height, blocks }
}

function vehiclesSection(rows: VehicleRow[]): DocSection | null {
  return tableSection("Vehicle List", ["Veh #", "Year", "Make", "Model", "VIN"], rows.map((v) => [v.vehNo, v.year, v.make, v.model, v.vin]))
}

// Only columns DRIVERS_QUERY selects — no DOB/license number, which are kept out of the replicated
// database on purpose (see DRIVERS_QUERY). Date Hired dropped per client feedback (9/13).
function driversSection(rows: DriverRow[]): DocSection | null {
  return tableSection("Driver Information Schedule", ["Driver #", "Name", "License State"], rows.map((d) => [d.driverNo, d.name, d.licenseState]))
}

// No Location column per Patrick (9/13): "Just class codes and exposure." Renewal Payroll is left
// blank for the renewal meeting.
function wcSection(rows: WcExposureRow[]): DocSection | null {
  return tableSection(
    "Workers' Compensation Exposure",
    ["Class Code", "Classification", "Current Payroll", "Renewal Payroll"],
    rows.map((w) => [w.classCode, w.classification, w.payroll, ""]),
    { keepBlank: true }
  )
}

// Mirrors the CL Renewal Summary's cover (clProposalDoc.ts coverPage). The "Current Policy Period" /
// "Renewal Effective" lines always show (client feedback, 2026-09-15; kept by Andrew 2026-10-10) and
// reflect the primary (first-matched) policy's dates; the Carrier | Line of Business table lists
// every policy in the document.
function coverPage(input: RiskProfileInput): Block[] {
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 720 }, children: [new ImageRun({ type: "png", data: readFileSync(PROPOSAL_LOGO_PATH), transformation: { width: 3048000 / 9525, height: 885825 / 9525 } })] }),
    centered([run("PRE-RENEWAL REVIEW", { bold: true, color: PROPOSAL_GREEN, size: 52 })], { before: 600, after: 160 }),
    divider(HEADER_FILL, 4),
    centered([run(input.clientName, { bold: true, size: 44 })], { before: 280, after: 120 }),
    centered([run(`Current Policy Period: ${ input.currentPeriod }`, { size: 26 })], { before: 120 }),
    centered([run(`Renewal Effective: ${ input.renewalDate }`, { size: 26 })], { after: 360 }),
    ...(input.coverPolicies.length > 0
      ? [dataTable(["Carrier", "Line of Business"], input.coverPolicies.map((p) => [p.carrier, p.lineOfBusiness]))]
      : []),
    new Paragraph({ spacing: { before: 360 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: PROPOSAL_GREEN, space: 1 } }, children: [] }),
    centered([run(AGENCY.name, { bold: true, color: PROPOSAL_GREEN, size: 22 })], { before: 240 }),
    centered([run(AGENCY.address, { color: MUTED })]),
    pageBreak()
  ]
}

// Returns the section names actually included, in document order — the caller reports this back to
// the user so they know which sections were present in the source data (never surfaced in the
// document itself, matching the skill's own "no commentary in the deliverable" rule).
export async function buildRiskProfileDoc(input: RiskProfileInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const sections = [
    { name: "Named Insureds", section: namedInsuredsSection(input.clientName, input.additionalNamedInsureds) },
    { name: "Locations Schedule", section: locationsSection(input.locations) },
    { name: "Property Coverage", section: propertySection(input.property) },
    { name: "General Liability Exposure", section: glSection(input.glExposure) },
    { name: "Equipment List & Value", section: equipmentSection(input.equipmentBlanket, input.equipmentItems) },
    { name: "Vehicle List", section: vehiclesSection(input.vehicles) },
    { name: "Driver Information Schedule", section: driversSection(input.drivers) },
    { name: "Workers' Compensation Exposure", section: wcSection(input.wcExposure) }
  ].filter((s): s is { name: string; section: DocSection } => s.section !== null)

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20, color: TEXT } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_WIDTH, height: 15840 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
      children: [...coverPage(input), ...layoutSections(sections.map((s) => s.section))]
    }]
  })

  return { buffer: Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array), includedSections: sections.map((s) => s.name) }
}
