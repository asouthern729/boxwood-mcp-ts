import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph,
  ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType
} from "docx"

// Ported from the client-supplied pre-renewal-review Skill's scripts/build-template.js (see
// prr-template-export/ in the repo root, not installed as a Skill — only this engine is reused).
// That file's own header comment documents three previously-debugged constraints this port
// preserves exactly:
//   - True `TableLayoutType.AUTOFIT` + `WidthType.AUTO` cells collapse to near-zero width under
//     LibreOffice headless conversion and aren't reliably better in Word either — content-based
//     FIXED widths (autofitWidths below) are the workaround.
//   - Table column widths must sum to exactly the usable page width (9360 DXA on US Letter with
//     1" margins) or the last column clips off the page edge.
//   - Unconditional PageBreaks after every section either waste half a page or split a table
//     awkwardly across a page boundary — layoutSections() estimates each section's height and only
//     breaks when the next section genuinely won't fit in what's left.
// Unlike the original template, section data here comes from already-queried Postgres rows (see
// src/tools/policies/commercialRenewalSummary.ts), not a `data` JSON blob read from disk.

const GREEN = "459361"
const NEARBLACK = "231F20"
const LIGHTGREEN = "E3F0E7"
const BORDERGRAY = "CCCCCC"

export function money(v: number | string | null | undefined): string {
  if(v === null || v === undefined || v === "") return ""
  if(typeof v === "string") return v

  return `$${ Number(v).toLocaleString("en-US") }`
}

function cellBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 1, color: BORDERGRAY },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDERGRAY },
    left: { style: BorderStyle.SINGLE, size: 1, color: BORDERGRAY },
    right: { style: BorderStyle.SINGLE, size: 1, color: BORDERGRAY }
  }
}

function headerCell(text: string, width: number): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { fill: GREEN, type: ShadingType.CLEAR },
    borders: cellBorders(),
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Arial", size: 18 })]
    })]
  })
}

function bodyCell(text: string, width: number, rowIndex: number): TableCell {
  const fill = rowIndex % 2 === 0 ? LIGHTGREEN : "FFFFFF"

  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { fill, type: ShadingType.CLEAR },
    borders: cellBorders(),
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), font: "Arial", size: 18 })]
    })]
  })
}

// ---------- CONTENT-BASED "AUTOFIT" WIDTHS ----------
const USABLE_WIDTH = 9360 // US Letter minus 1" margins each side, in DXA
const MIN_COL = 760
const MAX_COL = 4200
const PER_CHAR = 125 // approx DXA per character at 9pt Arial, tuned for condensed fit
const FLEX_THRESHOLD = 1400 // columns naturally wider than this absorb shrink/growth

function autofitWidths(headers: string[], rows: string[][]): number[] {
  const natural = headers.map((h, i) => {
    let maxLen = String(h).length

    for(const r of rows) {
      const len = String(r[i]).length
      if(len > maxLen) maxLen = len
    }

    return Math.min(MAX_COL, Math.max(MIN_COL, maxLen * PER_CHAR))
  })

  const fixedIdx: number[] = []
  const flexIdx: number[] = []
  natural.forEach((w, i) => (w <= FLEX_THRESHOLD ? fixedIdx : flexIdx).push(i))

  const fixedSum = fixedIdx.reduce((a, i) => a + natural[i], 0)
  const flexNaturalSum = flexIdx.reduce((a, i) => a + natural[i], 0)
  const budgetForFlex = USABLE_WIDTH - fixedSum

  const widths = natural.slice()

  if(flexIdx.length > 0 && flexNaturalSum > 0) {
    const factor = budgetForFlex / flexNaturalSum
    flexIdx.forEach((i) => { widths[i] = Math.max(MIN_COL, Math.floor(natural[i] * factor)) })
  } else if(fixedSum !== USABLE_WIDTH && fixedIdx.length > 0) {
    const factor = USABLE_WIDTH / fixedSum
    fixedIdx.forEach((i) => { widths[i] = Math.floor(natural[i] * factor) })
  }

  const diff = USABLE_WIDTH - widths.reduce((a, b) => a + b, 0)
  widths[widths.length - 1] += diff
  return widths
}

function buildTable(headers: string[], rows: string[][]): Table {
  const widths = autofitWidths(headers, rows)
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => headerCell(h, widths[i]))
  })
  const bodyRows = rows.map((r, idx) => new TableRow({
    cantSplit: true,
    children: r.map((cellText, i) => bodyCell(cellText, widths[i], idx))
  }))

  return new Table({
    width: { size: USABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [headerRow, ...bodyRows]
  })
}

function h1(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] })
}

function h2(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] })
}

function fieldValueTable(pairs: [string, string][]): Table {
  return buildTable(["Field", "Value"], pairs.map(([f, v]) => [f, v]))
}

// ---------- HEIGHT ESTIMATION / PAGE-FIT LOGIC ----------
// Calibrated in the original template against real rendered PDFs — if font sizes, cell margins, or
// PER_CHAR above ever change, re-verify against a rendered PDF rather than assuming these still hold.
const PAGE_HEIGHT = 15840
const MARGIN = 1440
const PAGE_USABLE_HEIGHT = PAGE_HEIGHT - 2 * MARGIN // 12960 twips of usable vertical space per page

const ROW_LINE_HEIGHT = 220
const ROW_VPAD = 70
const H1_HEIGHT = 640
const H2_HEIGHT = 460
const BODY_LINE_HEIGHT = 260
const TEXT_CHAR_WIDTH = 95 // deliberately different from PER_CHAR (125) — reusing that figure here
                           // overestimates wrapped lines and pushes sections to the next page more
                           // than necessary

function estimateCellLines(text: string, width: number): number {
  const charsPerLine = Math.max(1, Math.floor(width / TEXT_CHAR_WIDTH))
  return Math.max(1, Math.ceil(String(text).length / charsPerLine))
}

function estimateRowHeight(rowValues: string[], widths: number[]): number {
  let maxLines = 1

  for(let i = 0; i < rowValues.length; i++) {
    const lines = estimateCellLines(rowValues[i], widths[i])
    if(lines > maxLines) maxLines = lines
  }

  return maxLines * ROW_LINE_HEIGHT + ROW_VPAD
}

function estimateTableHeight(headers: string[], rows: string[][]): number {
  const widths = autofitWidths(headers, rows)
  let h = estimateRowHeight(headers, widths)
  for(const r of rows) h += estimateRowHeight(r, widths)
  return h
}

type DocSection = { height: number; blocks: (Paragraph | Table)[] }

// A section taller than a full page still starts fresh on its own page and naturally continues
// flowing onto subsequent pages — the `cursor > 0` guard matters: without it, a section bigger than
// a full page would trigger a spurious page break even when already sitting at the top of a fresh
// page.
function layoutSections(sectionList: DocSection[]): (Paragraph | Table)[] {
  let cursor = 0
  const out: (Paragraph | Table)[] = []

  for(const sec of sectionList) {
    const remaining = PAGE_USABLE_HEIGHT - cursor

    if(sec.height > remaining && cursor > 0) {
      out.push(new Paragraph({ children: [new PageBreak()] }))
      cursor = 0
    }

    out.push(...sec.blocks)
    cursor = sec.height <= PAGE_USABLE_HEIGHT ? cursor + sec.height : sec.height % PAGE_USABLE_HEIGHT
  }

  return out
}

// ---------- SECTION INPUT TYPES ----------
export type LocationRow = { locNo: string; address: string; city: string; state: string; zip: string }
export type PropertyRow = { subjectOfInsurance: string; coverage: string; limit: string; deductible: string; coinsurance: string }
export type GlExposureRow = { location: string; classCode: string; classification: string; basis: string; exposure: string }
export type EquipmentBlanket = { category: string; subcategory: string; totalItems: string; amountOfInsurance: string; coinsurance: string }
export type EquipmentItemRow = { itemNo: string; manufacturer: string; model: string; description: string; serialNo: string; value: string }
export type VehicleRow = { vehNo: string; year: string; make: string; model: string; vin: string }
export type DriverRow = { driverNo: string; name: string; licenseState: string; dateHired: string }
export type WcExposureRow = { location: string; classCode: string; classification: string; payroll: string }

export type RenewalSummaryInput = {
  clientName: string
  additionalNamedInsureds: string[]
  currentPeriod: string
  renewalDate: string
  locations: LocationRow[]
  property: PropertyRow[]
  glExposure: GlExposureRow[]
  equipmentBlanket: EquipmentBlanket | null
  equipmentItems: EquipmentItemRow[]
  vehicles: VehicleRow[]
  drivers: DriverRow[]
  wcExposure: WcExposureRow[]
}

function namedInsuredsSection(clientName: string, additional: string[]): DocSection {
  const lines = [clientName, ...additional]

  return {
    height: H1_HEIGHT + lines.length * BODY_LINE_HEIGHT + 60,
    blocks: [
      h1("Named Insureds"),
      ...lines.map((name) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(name)] }))
    ]
  }
}

function locationsSection(rows: LocationRow[]): DocSection | null {
  if(rows.length === 0) return null

  const headers = ["Loc #", "Address", "City", "State", "Zip"]
  const tableRows = rows.map((l) => [l.locNo, l.address, l.city, l.state, l.zip])

  return {
    height: H1_HEIGHT + estimateTableHeight(headers, tableRows),
    blocks: [h1("Locations Schedule"), buildTable(headers, tableRows)]
  }
}

// Property Coverage cannot be grouped by location (afw_cprem carries no reliable location link in
// this tenant's synced data — see the tool's own comments) — presented policy-wide instead, one row
// per coverage line, rather than the client example's by-address layout.
function propertySection(rows: PropertyRow[]): DocSection | null {
  if(rows.length === 0) return null

  // Header reads "Coverage" rather than "Causes of Loss Form" — afw_cprem.coverage (the source
  // column) mixes genuine causes-of-loss form text ("Special form"/"Basic form") with standalone
  // endorsement/extension names ("Diamond Prop Plus Cov", "Electronic Data Restoration Expense"),
  // confirmed against real data — "Causes of Loss Form" would misdescribe the latter.
  const headers = ["Subject of Insurance", "Coverage", "Limit", "Deductible", "Coinsurance"]
  const tableRows = rows.map((p) => [p.subjectOfInsurance, p.coverage, p.limit, p.deductible, p.coinsurance])

  return {
    height: H1_HEIGHT + estimateTableHeight(headers, tableRows),
    blocks: [h1("Property Coverage"), buildTable(headers, tableRows)]
  }
}

function glSection(rows: GlExposureRow[]): DocSection | null {
  if(rows.length === 0) return null

  const headers = ["Location", "Class Code", "Classification", "Basis", "Current Exposure", "Renewal Exposure"]
  const tableRows = rows.map((g) => [g.location, g.classCode, g.classification, g.basis, g.exposure, ""])

  return {
    height: H1_HEIGHT + estimateTableHeight(headers, tableRows),
    blocks: [h1("General Liability Exposure"), buildTable(headers, tableRows)]
  }
}

function equipmentSection(blanket: EquipmentBlanket | null, items: EquipmentItemRow[]): DocSection | null {
  if(!blanket && items.length === 0) return null

  const blocks: (Paragraph | Table)[] = [h1("Equipment List & Value")]
  let height = H1_HEIGHT

  if(blanket) {
    const pairs: [string, string][] = [
      ["Category", blanket.category],
      ["Subcategory", blanket.subcategory],
      ["Total Scheduled Items", blanket.totalItems],
      ["Amount of Insurance", blanket.amountOfInsurance],
      ["Coinsurance", blanket.coinsurance]
    ]
    blocks.push(h2("Blanket Summary"), fieldValueTable(pairs))
    height += H2_HEIGHT + estimateTableHeight(["Field", "Value"], pairs.map(([f, v]) => [f, v]))
  }

  if(items.length > 0) {
    const headers = ["Item #", "Manufacturer", "Model", "Description", "Serial #", "Value"]
    const tableRows = items.map((e) => [e.itemNo, e.manufacturer, e.model, e.description, e.serialNo, e.value])
    blocks.push(h2("Scheduled Items"), buildTable(headers, tableRows))
    height += H2_HEIGHT + estimateTableHeight(headers, tableRows)
  }

  return { height, blocks }
}

function vehiclesSection(rows: VehicleRow[]): DocSection | null {
  if(rows.length === 0) return null

  const headers = ["Veh #", "Year", "Make", "Model", "VIN"]
  const tableRows = rows.map((v) => [v.vehNo, v.year, v.make, v.model, v.vin])

  return {
    height: H1_HEIGHT + estimateTableHeight(headers, tableRows),
    blocks: [h1("Vehicle List"), buildTable(headers, tableRows)]
  }
}

// Only includes columns that actually exist in the source — no DOB/license number here, since
// afw_127driver carries neither a populated nor a granted column for either (see the tool's own
// comments); showing them as blank/"[NOT PROVIDED]" for every row would misleadingly imply the data
// should have been there.
function driversSection(rows: DriverRow[]): DocSection | null {
  if(rows.length === 0) return null

  const headers = ["Driver #", "Name", "License State", "Date Hired"]
  const tableRows = rows.map((d) => [d.driverNo, d.name, d.licenseState, d.dateHired])

  return {
    height: H1_HEIGHT + estimateTableHeight(headers, tableRows),
    blocks: [h1("Driver Information Schedule"), buildTable(headers, tableRows)]
  }
}

function wcSection(rows: WcExposureRow[]): DocSection | null {
  if(rows.length === 0) return null

  const headers = ["Location", "Class Code", "Classification", "Current Payroll", "Renewal Payroll"]
  const tableRows = rows.map((w) => [w.location, w.classCode, w.classification, w.payroll, ""])

  return {
    height: H1_HEIGHT + estimateTableHeight(headers, tableRows),
    blocks: [h1("Workers' Compensation Exposure"), buildTable(headers, tableRows)]
  }
}

const LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-logo.png")

function coverPageChildren(clientName: string, currentPeriod: string, renewalDate: string): Paragraph[] {
  const logoData = readFileSync(LOGO_PATH)

  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 720 },
      children: [new ImageRun({
        type: "png",
        data: logoData,
        transformation: { width: 5335507 / 9525, height: 1450591 / 9525 }
      })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480, after: 240 },
      children: [new TextRun({ text: "PRE-RENEWAL REVIEW", bold: true, color: GREEN, size: 72, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: clientName, bold: true, color: NEARBLACK, size: 56, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Current Policy Period: ${ currentPeriod }`, color: NEARBLACK, size: 28, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [new TextRun({ text: `Renewal Effective: ${ renewalDate }`, color: NEARBLACK, size: 28, font: "Arial" })]
    }),
    new Paragraph({ children: [new PageBreak()] })
  ]
}

// Returns the section names actually included, in document order — the caller reports this back to
// the user so they know which sections were present in the source data (never surfaced in the
// document itself, matching the skill's own "no commentary in the deliverable" rule).
export async function buildRenewalSummaryDoc(input: RenewalSummaryInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const sections: { name: string; section: DocSection | null }[] = [
    { name: "Named Insureds", section: namedInsuredsSection(input.clientName, input.additionalNamedInsureds) },
    { name: "Locations Schedule", section: locationsSection(input.locations) },
    { name: "Property Coverage", section: propertySection(input.property) },
    { name: "General Liability Exposure", section: glSection(input.glExposure) },
    { name: "Equipment List & Value", section: equipmentSection(input.equipmentBlanket, input.equipmentItems) },
    { name: "Vehicle List", section: vehiclesSection(input.vehicles) },
    { name: "Driver Information Schedule", section: driversSection(input.drivers) },
    { name: "Workers' Compensation Exposure", section: wcSection(input.wcExposure) }
  ]

  const included = sections.filter((s): s is { name: string; section: DocSection } => s.section !== null)

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22, color: NEARBLACK } }
      },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { font: "Arial", size: 30, bold: true, color: GREEN },
          paragraph: {
            spacing: { before: 240, after: 120 }, outlineLevel: 0,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 1 } }
          }
        },
        {
          id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { font: "Arial", size: 24, bold: true, color: GREEN },
          paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 1 }
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children: [
        ...coverPageChildren(input.clientName, input.currentPeriod, input.renewalDate),
        ...layoutSections(included.map((s) => s.section))
      ]
    }]
  })

  const rawBuffer = await Packer.toBuffer(doc)

  return { buffer: Buffer.from(rawBuffer as unknown as Uint8Array), includedSections: included.map((s) => s.name) }
}
