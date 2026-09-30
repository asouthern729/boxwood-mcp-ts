import { readFileSync } from "node:fs"
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, ImageRun, LevelFormat, Packer, Paragraph,
  ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType
} from "docx"
import { GREEN, LIGHTGREEN, LOGO_PATH, NEARBLACK } from "./riskProfileDoc.js"
import type { LabeledValue, PlScheduleClass, PlSection } from "./plCoverageData.js"

// The "Personal Insurance Portfolio Summary" document for pl_renewal_summary. Unlike the CL documents
// (riskProfileDoc.ts: a cover page, then page-fit sections), this reproduces the client-supplied
// sample (Patrick_Baggett_Personal_Insurance_Summary, 2026-09-28): a compact, letter-style page with
// a letterhead, a disclaimer, and short sections. Its fonts, sizes, margins and colours are taken
// from that sample's XML: Calibri throughout, a light-green table header with thin borders, no row
// striping, and 0.35"/0.625" margins. Same brand colours as the CL documents.

const FONT = "Calibri"
const PAGE_WIDTH = 12240
const MARGIN_X = 900
const MARGIN_Y = 500
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN_X // 10440 DXA
const BULLETS = "pl-bullets"

const NOTICE = "This summary provides a high-level overview of your current personal insurance coverage. This is intended for informational purposes only and does not replace or supersede your official policy documents. Coverage details, exclusions, and conditions are governed solely by the terms outlined in your policies. Please refer to those documents for complete information."

function run(text: string, opts: { bold?: boolean; size?: number; color?: string; italics?: boolean } = {}): TextRun {
  return new TextRun({ text, font: FONT, bold: opts.bold, italics: opts.italics, size: opts.size ?? 20, color: opts.color ?? NEARBLACK })
}

// "Label: value" on one line, label bold, as the sample does for Insured, Carrier and Property Address.
function labeledLine(label: string, value: string, after = 80): Paragraph {
  return new Paragraph({ spacing: { after }, children: [run(`${ label }: `, { bold: true }), run(value)] })
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 160, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 2 } },
    children: [run(text, { bold: true, size: 24, color: GREEN })]
  })
}

function subheading(text: string): Paragraph {
  return new Paragraph({ keepNext: true, spacing: { before: 100, after: 40 }, children: [run(text, { bold: true })] })
}

function cellBorders() {
  const side = { style: BorderStyle.SINGLE, size: 4, color: "auto" }
  return { top: side, bottom: side, left: side, right: side }
}

function cell(text: string, width: number, header: boolean): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders(),
    shading: header ? { fill: LIGHTGREEN, type: ShadingType.CLEAR } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: [run(text, { bold: header, size: 19 })] })]
  })
}

// Column widths as fractions of the page width. Fixed DXA widths rather than percentages, for the
// LibreOffice reason in riskProfileDoc.ts's header comment.
function table(headers: string[], rows: string[][], fractions: number[]): Table {
  const widths = fractions.map((f) => Math.floor(USABLE_WIDTH * f))
  widths[widths.length - 1] += USABLE_WIDTH - widths.reduce((a, b) => a + b, 0)

  return new Table({
    width: { size: USABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h, i) => cell(h, widths[i], true)) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((text, i) => cell(text, widths[i], false)) }))
    ]
  })
}

function labeledValueTable(headers: [string, string], rows: LabeledValue[], split: [number, number]): Table {
  return table(headers, rows.map((r) => [r.label, r.value]), split)
}

// Coverages that differ between vehicles go in their own table below the vehicle list: one row per
// coverage, one column per vehicle (Andrew, 2026-09-29 — it grows downward, not sideways). Past
// MAX_MATRIX_VEHICLES the vehicle columns get too narrow to read, so larger fleets are split across
// several tables of up to that many vehicles each.
const MAX_MATRIX_VEHICLES = 4

function coverageByVehicleTables(section: Extract<PlSection, { kind: "auto" }>): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = []

  for(let start = 0; start < section.vehicles.length; start += MAX_MATRIX_VEHICLES) {
    const chunk = section.vehicles.slice(start, start + MAX_MATRIX_VEHICLES)
    if(start > 0) blocks.push(new Paragraph({ spacing: { after: 80 }, children: [] }))
    blocks.push(table(
      ["Coverage", ...chunk.map((v) => [v.year, v.makeModel].filter(Boolean).join(" "))],
      section.vehicleColumns.map((c) => [c.label, ...chunk.map((v) => v.values[c.key] ?? "")]),
      [0.28, ...Array(chunk.length).fill(0.72 / chunk.length)]
    ))
  }

  return blocks
}

// The policy/carrier line under a section heading, shown only when the reader needs it to tell
// policies apart: several carriers, or the same line of business on two policies.
function sourceLine(section: PlSection): Paragraph {
  const { polno, carrier, term } = section.source
  return new Paragraph({
    keepNext: true,
    spacing: { after: 60 },
    children: [run([carrier && `Carrier: ${ carrier }`, `Policy #: ${ polno }`, `Term: ${ term }`].filter(Boolean).join("   ·   "), { size: 18 })]
  })
}

// The full scheduled property list, one table per class (Patrick, 2026-09-29).
function scheduleBlocks(schedule: PlScheduleClass[]): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [subheading("Scheduled Items:")]
  for(const cls of schedule) {
    const heading = [cls.className, cls.classLimit && `Scheduled Limit ${ cls.classLimit }`].filter(Boolean).join(" — ")
    blocks.push(new Paragraph({ keepNext: true, spacing: { before: 60, after: 40 }, children: [run(heading, { bold: true })] }))
    blocks.push(table(["Item #", "Description", "Value"], cls.items.map((i) => [i.number, i.description, i.value]), [0.1, 0.7, 0.2]))
    if(cls.moreCount > 0) {
      blocks.push(new Paragraph({ spacing: { before: 40, after: 80 }, children: [run(`…and ${ cls.moreCount } more ${ cls.className.toLowerCase() } item${ cls.moreCount === 1 ? "" : "s" }. The complete schedule is in your policy documents.`, { italics: true })] }))
    }
  }
  return blocks
}

function sectionBlocks(section: PlSection, showSource: boolean): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [sectionHeading(section.title)]
  if(showSource) blocks.push(sourceLine(section))

  switch(section.kind) {
    case "auto": {
      if(section.highlights.length > 0) {
        blocks.push(new Paragraph({ keepNext: true, spacing: { after: 40 }, children: [run("Coverage Highlights:", { bold: true })] }))
        for(const h of section.highlights) {
          blocks.push(new Paragraph({ numbering: { reference: BULLETS, level: 0 }, spacing: { after: 20 }, children: [run(`${ h.label }: ${ h.value }`)] }))
        }
      }
      if(section.vehicles.length > 0) {
        blocks.push(subheading("Scheduled Vehicles:"))
        blocks.push(table(["Year", "Make & Model", "VIN"], section.vehicles.map((v) => [v.year, v.makeModel, v.vin]), [0.12, 0.48, 0.40]))
      }
      if(section.vehicleColumns.length > 0 && section.vehicles.length > 0) {
        blocks.push(subheading("Coverage by Vehicle:"))
        blocks.push(...coverageByVehicleTables(section))
      }
      break
    }
    case "property":
      if(section.address) blocks.push(labeledLine("Property Address", section.address))
      blocks.push(labeledValueTable(["Coverage Category", "Amount"], section.rows, [0.55, 0.45]))
      if(section.schedule?.length) blocks.push(...scheduleBlocks(section.schedule))
      break
    case "personalArticles":
      blocks.push(labeledLine("Total Scheduled Limit", section.totalScheduledLimit, 40))
      if(section.schedule?.length) blocks.push(...scheduleBlocks(section.schedule))
      else blocks.push(new Paragraph({ spacing: { after: 80 }, children: [run("A detailed item schedule is included in the attached policy document.")] }))
      break
    case "umbrella":
      blocks.push(labeledValueTable(["Coverage Type", "Limit"], section.rows, [0.65, 0.35]))
      break
    case "other": {
      const showDeductible = section.rows.some((r) => r.deductible)
      blocks.push(showDeductible
        ? table(["Coverage", "Limit", "Deductible"], section.rows.map((r) => [r.coverage, r.limit, r.deductible]), [0.5, 0.25, 0.25])
        : table(["Coverage", "Limit"], section.rows.map((r) => [r.coverage, r.limit]), [0.65, 0.35]))
      break
    }
    case "noDetail":
      blocks.push(new Paragraph({ spacing: { after: 80 }, children: [run("Coverage details for this policy are not available in this summary. Please refer to your policy documents.", { italics: true })] }))
      break
  }

  return blocks
}

function letterhead(producerEmail: string | null): Paragraph[] {
  const contact = ["(615) 245-5851", producerEmail].filter(Boolean).join(" | ")

  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      // Sample's logo size: 2476500 x 676275 EMU.
      children: [new ImageRun({ type: "png", data: readFileSync(LOGO_PATH), transformation: { width: 2476500 / 9525, height: 676275 / 9525 } })]
    }),
    new Paragraph({ spacing: { after: 0 }, children: [run("Boxwood Insurance Group", { bold: true, size: 21 })] }),
    new Paragraph({ spacing: { after: 0 }, children: [run("Trusted Insurance Advisors", { size: 19 })] }),
    new Paragraph({ spacing: { after: 0 }, children: [run("Franklin, TN", { size: 19 })] }),
    new Paragraph({
      spacing: { after: 140 },
      children: [
        run(`${ contact } | `, { size: 19 }),
        new ExternalHyperlink({
          link: "https://www.boxwoodins.com",
          children: [new TextRun({ text: "www.boxwoodins.com", font: FONT, size: 19, color: "1155CC", underline: {} })]
        })
      ]
    })
  ]
}

function footer(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 0 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 4 } },
        children: [run("Boxwood Insurance Group, LLC", { bold: true, size: 19 })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60 },
        children: [run("3020 Stansberry Lane, Suite 202, Franklin, TN 37069 | 615-245-5851", { size: 17 })]
      })
    ]
  })
}

export type PlRenewalSummaryInput = {
  clientName: string
  // One carrier across every included policy goes in the header, as in the sample. With several,
  // the header line is dropped and each section names its own carrier instead.
  carriers: string[]
  producerEmail: string | null
  sections: PlSection[]
}

export async function buildPlRenewalSummaryDoc(input: PlRenewalSummaryInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const singleCarrier = input.carriers.length === 1 ? input.carriers[0] : null
  const titleCounts = new Map<string, number>()
  for(const s of input.sections) titleCounts.set(s.title, (titleCounts.get(s.title) ?? 0) + 1)

  const body: (Paragraph | Table)[] = [
    ...letterhead(input.producerEmail),
    new Paragraph({
      spacing: { after: singleCarrier ? 0 : 120 },
      children: [run("Personal Insurance Portfolio Summary   ", { bold: true }), run("Insured: ", { bold: true }), run(input.clientName)]
    }),
    ...(singleCarrier ? [labeledLine("Carrier", singleCarrier, 120)] : []),
    new Paragraph({ spacing: { after: 160 }, children: [run("Important Notice: ", { bold: true }), run(NOTICE)] }),
    ...input.sections.flatMap((s) => sectionBlocks(s, !singleCarrier || (titleCounts.get(s.title) ?? 0) > 1))
  ]

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 20, color: NEARBLACK } } } },
    numbering: {
      config: [{
        reference: BULLETS,
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "●", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      }]
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_WIDTH, height: 15840 },
          margin: { top: MARGIN_Y, right: MARGIN_X, bottom: MARGIN_Y, left: MARGIN_X, footer: 300 }
        }
      },
      footers: { default: footer() },
      children: body
    }]
  })

  const rawBuffer = await Packer.toBuffer(doc)
  const includedSections = [...new Set(input.sections.map((s) => s.title))]

  return { buffer: Buffer.from(rawBuffer as unknown as Uint8Array), includedSections }
}
