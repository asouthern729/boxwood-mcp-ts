import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, ImageRun, PageBreak, Paragraph,
  ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType
} from "docx"

// The visual language of Patrick's insurance-proposal skill (SKILL.md "Global brand spec") — palette,
// page width, banners, sub-headers and data tables — shared by the CL Renewal Summary
// (clProposalDoc.ts) and the Pre-Renewal Review (riskProfileDoc.ts, restyled to match 2026-10-10).
// Every size, colour, margin and spacing below is the skill's own figure.

export const GREEN = "458B61"
export const DARK_GREEN = "2D6B47"
export const HEADER_FILL = "C8DED1"
export const STRIPE = "F7F7F7"
export const TEXT = "1A1A1A"
export const MUTED = "555555"
export const FAINT = "999999"
export const BORDER = "CCCCCC"

export const PAGE_WIDTH = 12240
export const MARGIN = 900
// Every table and banner spans the full text width (Andrew, 2026-10-08: "it should always
// take up the available space"). The skill specifies 9360 DXA, which with its 0.625" margins left
// tables ~0.75" short of the right margin and narrower than the sub-header rules above them.
export const TABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN // 10440 DXA

export const AGENCY = {
  name: "Boxwood Insurance Group, LLC",
  address: "3020 Stansberry Lane, Suite 202, Franklin, TN 37069",
  phone: "615-245-5851",
  website: "www.boxwoodins.com"
}

export const PROPOSAL_LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-proposal-logo.png")


export type Block = Paragraph | Table
export type DocComment = { id: number; text: string }

export function run(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({ text, font: "Arial", bold: opts.bold, italics: opts.italics, size: opts.size, color: opts.color })
}

export function logo(widthEmu: number, heightEmu: number, after = 120): Paragraph {
  return new Paragraph({
    spacing: { after },
    children: [new ImageRun({ type: "png", data: readFileSync(PROPOSAL_LOGO_PATH), transformation: { width: widthEmu / 9525, height: heightEmu / 9525 } })]
  })
}

export function pageBreak(): Paragraph {
  return new Paragraph({ children: [new PageBreak()] })
}

export function spacer(): Paragraph {
  return new Paragraph({ children: [run(" ", { size: 12 })] })
}

// The green full-width banner every major section opens with, preceded by the small logo (skill:
// every section except the very first after the cover, i.e. the Executive Summary).
export function banner(title: string, { withLogo, comment }: { withLogo: boolean; comment?: DocComment }): Block[] {
  const text = run(title.toUpperCase(), { bold: true, color: "FFFFFF", size: 28 })
  const children = comment
    ? [new CommentRangeStart(comment.id), text, new CommentRangeEnd(comment.id), new TextRun({ children: [new CommentReference(comment.id)] })]
    : [text]

  return [
    ...(withLogo ? [logo(1809750, 523875)] : []),
    new Table({
      width: { size: TABLE_WIDTH, type: WidthType.DXA },
      columnWidths: [TABLE_WIDTH],
      layout: TableLayoutType.FIXED,
      rows: [new TableRow({
        children: [new TableCell({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          shading: { fill: GREEN, type: ShadingType.CLEAR },
          borders: noBorders(),
          margins: { top: 100, bottom: 100, left: 200, right: 200 },
          children: [new Paragraph({ keepNext: true, children })]
        })]
      })]
    }),
    spacer()
  ]
}

export function subHeader(text: string): Paragraph {
  return new Paragraph({
    keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 2 } },
    spacing: { before: 180, after: 80 },
    children: [run(text, { bold: true, color: GREEN, size: 24 })]
  })
}


function noBorders() {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
  return { top: none, bottom: none, left: none, right: none }
}

function cellBorders() {
  const side = { style: BorderStyle.SINGLE, size: 4, color: BORDER }
  return { top: side, bottom: side, left: side, right: side }
}

// ---------- DATA TABLES ----------
// Fixed DXA widths (skill: never AUTOFIT — LibreOffice also collapses auto widths, see
// riskProfileDoc.ts's header comment). Without explicit fractions, width follows content: each
// column's longest cell (capped, so one long address doesn't starve the rest) with a floor at its
// header's longest word, so a header only ever wraps between words.

const MIN_COLUMN = 700
const MAX_CHARS = 42
// Roughly the width of one 9pt Arial character (bold, for headers) in DXA, and a cell's left+right
// margins (130 each) — enough that a column's longest word or figure fits on one line.
const CHAR_DXA = 105
export const CELL_PADDING = 300

function longestToken(text: string): number {
  return Math.max(0, ...text.split(/\s+/).map((w) => w.length))
}

// Each column gets at least the width of its longest unbreakable word or figure (header or cell),
// so "$3,933,000" or "Building" never wraps mid-word (seen on the first quote-built property table,
// 2026-10-08); what's left is shared by the given fractions, or else by each column's content length.
export function columnWidths(headers: string[], rows: string[][], fractions?: number[]): number[] {
  const floors = headers.map((h, i) => Math.max(
    MIN_COLUMN,
    CELL_PADDING + CHAR_DXA * Math.max(longestToken(h), ...rows.map((r) => longestToken(r[i] ?? "")))
  ))
  const weights = fractions ?? headers.map((h, i) => Math.max(h.length * 0.6, ...rows.map((r) => Math.min(MAX_CHARS, (r[i] ?? "").length))))
  const floorTotal = floors.reduce((a, b) => a + b, 0)

  // Too many columns to honour every floor: scale the floors down evenly (rare — the extractor is
  // asked for six columns at most).
  if(floorTotal >= TABLE_WIDTH) return fitToTable(floors.map((f) => Math.floor(f * TABLE_WIDTH / floorTotal)))

  const spare = TABLE_WIDTH - floorTotal
  const weightTotal = weights.reduce((a, b) => a + b, 0) || 1
  return fitToTable(floors.map((f, i) => f + Math.floor(spare * weights[i] / weightTotal)))
}

// Rounding leaves the sum a few DXA off; the widest column absorbs it so the table is exactly
// TABLE_WIDTH.
function fitToTable(widths: number[]): number[] {
  const widest = widths.indexOf(Math.max(...widths))
  widths[widest] += TABLE_WIDTH - widths.reduce((a, b) => a + b, 0)
  return widths
}

// Money columns (and their counts/percentages) read right-aligned, as in Patrick's example; IDs —
// location, vehicle and driver numbers, VIN digits — stay left like his schedules.
const NUMERIC_CELL = /^(\$[\d,.]+\*?( \/ \$[\d,.]+)*|[\d,.]+%?|—)$/

function numericColumns(rows: string[][], columnCount: number): boolean[] {
  return Array.from({ length: columnCount }, (_, i) => {
    const values = rows.map((r) => r[i] ?? "").filter((v) => v !== "" && v !== "—")
    return values.length > 0 && values.every((v) => NUMERIC_CELL.test(v)) && values.some((v) => /[$%]/.test(v))
  })
}

function tableCell(text: string, width: number, opts: { header: boolean; fill: string; right: boolean }): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { fill: opts.fill, type: ShadingType.CLEAR },
    borders: cellBorders(),
    verticalAlign: VerticalAlign.CENTER,
    margins: opts.header ? { top: 80, bottom: 80, left: 130, right: 130 } : { top: 70, bottom: 70, left: 130, right: 130 },
    children: [new Paragraph({
      alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [run(text, opts.header ? { bold: true, color: DARK_GREEN, size: 18 } : { size: 18 })]
    })]
  })
}

// Empty cells print "—" unless keepBlank — the Risk Profile's write-in columns (Description, Renewal
// Exposure, Renewal Payroll) stay blank for staff to fill in by hand.
export function dataTable(headers: string[], rows: string[][], fractions?: number[], { keepBlank = false }: { keepBlank?: boolean } = {}): Table {
  const filled = rows.map((r) => headers.map((_, i) => (r[i] ?? "").trim() || (keepBlank ? "" : "—")))
  const widths = columnWidths(headers, filled, fractions)
  const right = numericColumns(filled, headers.length)

  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: headers.map((h, i) => tableCell(h, widths[i], { header: true, fill: HEADER_FILL, right: right[i] }))
      }),
      ...filled.map((r, rowIndex) => new TableRow({
        cantSplit: true,
        children: r.map((text, i) => tableCell(text, widths[i], { header: false, fill: rowIndex % 2 === 0 ? "FFFFFF" : STRIPE, right: right[i] }))
      }))
    ]
  })
}


export function centered(children: TextRun[], spacing: { before?: number; after?: number } = {}): Paragraph {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing, children })
}

export function divider(color: string, size: number): Paragraph {
  return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size, color, space: 1 } }, children: [] })
}

