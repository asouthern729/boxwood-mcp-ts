import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, Document, Footer, ImageRun, LevelFormat,
  Packer, PageBreak, Paragraph, SectionType, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType
} from "docx"
import type { LocationRow } from "./riskProfileDoc.js"

// The CL Renewal Summary document, in the layout of Patrick's insurance-proposal skill (org-shared
// Claude skill, SKILL.md "Global brand spec") — the format he asked cl_renewal_summary to produce
// (email "FW: TN Equine", 2026-10-07, with TEH_Land_Tennessee_Equine_Hospital_Proposal.docx as the
// example), minus the Premium Summary page: "we will use the renewal premium tool for that". Every
// size, colour, margin and spacing below is the skill's own figure. The Risk Profile keeps its older
// layout (riskProfileDoc.ts) — the skill bans that palette, so the two share nothing visual.
//
// This file only renders. What goes in each section — AMS360 data, uploaded quotes, the template
// narratives — is assembled in clProposalLines.ts / clQuoteMerge.ts / clProposalText.ts.

const GREEN = "458B61"
const DARK_GREEN = "2D6B47"
const HEADER_FILL = "C8DED1"
const STRIPE = "F7F7F7"
const TEXT = "1A1A1A"
const MUTED = "555555"
const FAINT = "999999"
const BORDER = "CCCCCC"

const PAGE_WIDTH = 12240
const MARGIN = 900
// Every table, banner and callout spans the full text width (Andrew, 2026-10-08: "it should always
// take up the available space"). The skill specifies 9360 DXA, which with its 0.625" margins left
// tables ~0.75" short of the right margin and narrower than the sub-header rules above them.
const TABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN // 10440 DXA
const BULLETS = "proposal-bullets"

export const PROPOSAL_LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-proposal-logo.png")

const AGENCY = {
  name: "Boxwood Insurance Group, LLC",
  address: "3020 Stansberry Lane, Suite 202, Franklin, TN 37069",
  phone: "615-245-5851",
  website: "www.boxwoodins.com"
}

const DISCLAIMER = "This proposal contains only a summary of your insurance coverage. Review the actual policy for complete terms, conditions, exclusions, and endorsements. In any inconsistency between this proposal and the policy, the policy controls."

// ---------- INPUT ----------

export type ProposalTable = {
  title: string
  headers: string[]
  rows: string[][]
  // Column widths as fractions of the table width; content-proportional when omitted.
  fractions?: number[]
  footnote?: string
}

export type ProposalBulletGroup = { title: string; items: string[] }

// One coverage line's section (skill Section 3). `comment` marks a section filled from an uploaded
// quote — a Word comment on its banner naming the file and pages, for the account manager to verify.
export type ProposalLine = {
  title: string
  overview: string
  keyFacts: [string, string][]
  tables: ProposalTable[]
  bulletGroups: ProposalBulletGroup[]
  comment?: string
  // Set while this line still shows the expiring term because its renewal isn't in AMS360 yet —
  // rendered as a callout under the banner so nobody mistakes these figures for the renewal.
  pendingNote?: string
}

// Skill Section 5 — a quoted add-on that doesn't fit a standard line (e.g. a wind/hail deductible
// buy-back). Only ever comes from an uploaded quote.
export type ProposalSpecialtyAddOn = {
  title: string
  paragraph: string
  terms: [string, string][]
  schedule?: ProposalTable
  comment?: string
}

export type ServiceTeamMember = { role: string; name: string; phone: string; email: string }

export type ClProposalInput = {
  clientName: string
  clientAddress: string
  policyPeriod: string
  // When the document's lines don't share one policy period (skill: "see individual coverage
  // sections for details").
  policyPeriodsDiffer: boolean
  // Set while AMS360 has no renewal term yet for some line, so the coverage shown is still the
  // expiring program — a callout on the cover rather than presented as the renewal (Andrew,
  // 2026-10-08: "it should be apparent that we are awaiting the renewal values").
  renewalNote?: string
  // Every line shows the expiring term: the cover's period is labelled "Current Policy Period".
  allTermsCurrent: boolean
  // e.g. "Cincinnati quote prepared 08/20/2026 – valid for 60 days" — only from an uploaded quote.
  quoteNote?: string
  preparedBy: { name: string; email: string; phone: string } | null
  proposalDate: string
  executiveSummary: string[]
  namedInsureds: string[]
  locations: LocationRow[]
  lines: ProposalLine[]
  bindConditions: { items: string[]; comment?: string }
  specialtyAddOns: ProposalSpecialtyAddOn[]
  whyBoxwood: string[]
  serviceTeam: ServiceTeamMember[]
}

// ---------- BUILDING BLOCKS ----------

type Block = Paragraph | Table
type DocComment = { id: number; text: string }

function run(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({ text, font: "Arial", bold: opts.bold, italics: opts.italics, size: opts.size, color: opts.color })
}

function logo(widthEmu: number, heightEmu: number, after = 120): Paragraph {
  return new Paragraph({
    spacing: { after },
    children: [new ImageRun({ type: "png", data: readFileSync(PROPOSAL_LOGO_PATH), transformation: { width: widthEmu / 9525, height: heightEmu / 9525 } })]
  })
}

function pageBreak(): Paragraph {
  return new Paragraph({ children: [new PageBreak()] })
}

function spacer(): Paragraph {
  return new Paragraph({ children: [run(" ", { size: 12 })] })
}

// The green full-width banner every major section opens with, preceded by the small logo (skill:
// every section except the very first after the cover, i.e. the Executive Summary).
function banner(title: string, { withLogo, comment }: { withLogo: boolean; comment?: DocComment }): Block[] {
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

function subHeader(text: string): Paragraph {
  return new Paragraph({
    keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 2 } },
    spacing: { before: 180, after: 80 },
    children: [run(text, { bold: true, color: GREEN, size: 24 })]
  })
}

function keyFact(label: string, value: string): Paragraph {
  return new Paragraph({ spacing: { before: 50, after: 50 }, children: [run(`${ label }: `, { bold: true }), run(value, { color: MUTED })] })
}

function overview(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 80 }, children: [run(text, { italics: true })] })
}

function plain(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: [run(text)] })
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    style: "ListParagraph",
    numbering: { reference: BULLETS, level: 0 },
    spacing: { before: 30, after: 30 },
    children: [run(text, { size: 19 })]
  })
}

function footnote(text: string): Paragraph {
  return new Paragraph({ spacing: { before: 40, after: 80 }, children: [run(text, { italics: true, size: 16, color: MUTED })] })
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
const CELL_PADDING = 300

function longestToken(text: string): number {
  return Math.max(0, ...text.split(/\s+/).map((w) => w.length))
}

// Each column gets at least the width of its longest unbreakable word or figure (header or cell),
// so "$3,933,000" or "Building" never wraps mid-word (seen on the first quote-built property table,
// 2026-10-08); what's left is shared by the given fractions, or else by each column's content length.
function columnWidths(headers: string[], rows: string[][], fractions?: number[]): number[] {
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

function dataTable(headers: string[], rows: string[][], fractions?: number[]): Table {
  const filled = rows.map((r) => headers.map((_, i) => (r[i] ?? "").trim() || "—"))
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

function tableBlocks(table: ProposalTable): Block[] {
  if(table.rows.length === 0) return []
  return [
    subHeader(table.title),
    dataTable(table.headers, table.rows, table.fractions),
    ...(table.footnote ? [footnote(table.footnote)] : [])
  ]
}

function bulletGroupBlocks(group: ProposalBulletGroup): Block[] {
  if(group.items.length === 0) return []
  return [subHeader(group.title), ...group.items.map(bullet)]
}

// ---------- SECTIONS ----------

function centered(children: TextRun[], spacing: { before?: number; after?: number } = {}): Paragraph {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing, children })
}

function divider(color: string, size: number): Paragraph {
  return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size, color, space: 1 } }, children: [] })
}

function coverPage(input: ClProposalInput): Block[] {
  const prepared = input.preparedBy
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 720 }, children: [new ImageRun({ type: "png", data: readFileSync(PROPOSAL_LOGO_PATH), transformation: { width: 3048000 / 9525, height: 885825 / 9525 } })] }),
    centered([run("COMMERCIAL INSURANCE PROPOSAL", { bold: true, color: GREEN, size: 52 })], { before: 600, after: 160 }),
    divider(HEADER_FILL, 4),
    centered([run(input.clientName, { bold: true, size: 44 })], { before: 280, after: 120 }),
    ...(input.clientAddress ? [centered([run(input.clientAddress, { color: MUTED, size: 22 })])] : []),
    centered([run(`${ input.allTermsCurrent ? "Current Policy Period" : "Policy Period" }: ${ input.policyPeriod }`, { size: 26 })], { before: 120 }),
    ...(input.policyPeriodsDiffer ? [centered([run("(see individual coverage sections for details)", { color: MUTED, size: 20 })])] : []),
    ...(input.renewalNote ? [new Paragraph({ spacing: { before: 200 }, children: [] }), callout("RENEWAL TERMS PENDING", input.renewalNote)] : []),
    ...(input.quoteNote ? [centered([run(input.quoteNote, { italics: true, color: MUTED, size: 18 })])] : []),
    new Paragraph({ spacing: { before: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN, space: 1 } }, children: [] }),
    ...(prepared
      ? [
          centered([run("Prepared By", { bold: true })], { before: 240 }),
          centered([run(prepared.name, { bold: true, size: 26 })]),
          centered([run([prepared.email, prepared.phone].filter(Boolean).join(" | "), { color: MUTED, size: 21 })], { after: 240 })
        ]
      : [new Paragraph({ spacing: { after: 240 }, children: [] })]),
    centered([run(AGENCY.name, { bold: true, color: GREEN, size: 22 })]),
    centered([run(AGENCY.address, { color: MUTED })]),
    centered([run(`Proposal Date: ${ input.proposalDate }`, { color: MUTED })]),
    pageBreak()
  ]
}

function executiveSummary(input: ClProposalInput): Block[] {
  return [
    ...banner("Executive Summary", { withLogo: false }),
    ...input.executiveSummary.map(plain),
    ...tableBlocks({ title: "Named Insureds", headers: ["Named Insured"], rows: input.namedInsureds.map((n) => [n]) }),
    ...tableBlocks({
      title: "Location Schedule",
      headers: ["Loc.", "Address", "City", "State", "Zip"],
      rows: input.locations.map((l) => [l.locNo, l.address, l.city, l.state, l.zip]),
      fractions: [0.08, 0.44, 0.24, 0.1, 0.14]
    })
  ]
}

// A shaded, bordered box for "renewal pending" notices — brand palette only (the skill bans other
// colours), so it stands out by its border and fill rather than a warning colour.
function callout(heading: string, text: string): Table {
  const side = { style: BorderStyle.SINGLE, size: 12, color: DARK_GREEN }
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: [TABLE_WIDTH],
    layout: TableLayoutType.FIXED,
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        width: { size: TABLE_WIDTH, type: WidthType.DXA },
        shading: { fill: HEADER_FILL, type: ShadingType.CLEAR },
        borders: { top: side, bottom: side, left: side, right: side },
        margins: { top: 100, bottom: 100, left: 200, right: 200 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run(heading, { bold: true, color: DARK_GREEN, size: 22 })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40 }, children: [run(text, { color: TEXT, size: 19 })] })
        ]
      })]
    })]
  })
}

function lineSection(line: ProposalLine, comments: DocComment[]): Block[] {
  return [
    pageBreak(),
    ...banner(line.title, { withLogo: true, comment: register(comments, line.comment) }),
    ...(line.pendingNote ? [callout("RENEWAL TERMS PENDING", line.pendingNote), spacer()] : []),
    ...(line.overview ? [overview(line.overview)] : []),
    ...line.keyFacts.map(([label, value]) => keyFact(label, value)),
    ...line.tables.flatMap(tableBlocks),
    ...line.bulletGroups.flatMap(bulletGroupBlocks)
  ]
}

function register(comments: DocComment[], text: string | undefined): DocComment | undefined {
  if(!text) return undefined
  const comment = { id: comments.length, text }
  comments.push(comment)
  return comment
}

// Skill Section 4 puts "Bind Conditions & Notes" under the Premium Summary, on a page of its own.
// The premium table is dropped here (Patrick, 2026-10-07), so the notes keep that page by themselves.
function bindConditions(input: ClProposalInput, comments: DocComment[]): Block[] {
  if(input.bindConditions.items.length === 0) return []
  return [
    pageBreak(),
    ...banner("Bind Conditions & Notes", { withLogo: true, comment: register(comments, input.bindConditions.comment) }),
    ...input.bindConditions.items.map(bullet)
  ]
}

function specialtyAddOn(addOn: ProposalSpecialtyAddOn, comments: DocComment[]): Block[] {
  return [
    ...banner(addOn.title, { withLogo: true, comment: register(comments, addOn.comment) }),
    ...(addOn.paragraph ? [plain(addOn.paragraph)] : []),
    ...tableBlocks({ title: "Coverage Terms", headers: ["Field", "Value"], rows: addOn.terms, fractions: [0.4, 0.6] }),
    ...(addOn.schedule ? tableBlocks(addOn.schedule) : [])
  ]
}

// Patrick (2026-10-08): Why Boxwood always closes the document on a page by itself. It gets its own
// section (so it starts a new page) and that section alone carries footerStrip as its page footer.
function whyBoxwood(input: ClProposalInput): Block[] {
  return [
    ...banner("Why Boxwood Insurance Group", { withLogo: true }),
    ...input.whyBoxwood.map(plain),
    ...tableBlocks({
      title: "Your Service Team",
      headers: ["Role", "Name", "Phone", "Email"],
      rows: input.serviceTeam.map((m) => [m.role, m.name, m.phone, m.email]),
      fractions: [0.24, 0.26, 0.18, 0.32]
    })
  ]
}

// A real page footer rather than body text, so it sits at the bottom of the last page and can't split across pages.
function footerStrip(): Paragraph[] {
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new ImageRun({ type: "png", data: readFileSync(PROPOSAL_LOGO_PATH), transformation: { width: 1905000 / 9525, height: 552450 / 9525 } })] }),
    centered([run(`${ AGENCY.website } | ${ AGENCY.address } | ${ AGENCY.phone }`, { color: MUTED, size: 18 })]),
    centered([run(DISCLAIMER, { italics: true, color: FAINT, size: 16 })], { before: 60 })
  ]
}

export async function buildClProposalDoc(input: ClProposalInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const comments: DocComment[] = []
  const lineBlocks = input.lines.flatMap((line) => lineSection(line, comments))
  const bindBlocks = bindConditions(input, comments)
  const addOnBlocks = input.specialtyAddOns.flatMap((addOn) => specialtyAddOn(addOn, comments))

  const pageProperties = {
    size: { width: PAGE_WIDTH, height: 15840 },
    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN, footer: MARGIN / 2 }
  }

  const doc = new Document({
    comments: {
      children: comments.map((c) => ({ id: c.id, author: "Claude", initials: "CL", date: new Date(), children: [new Paragraph(c.text)] }))
    },
    styles: {
      default: { document: { run: { font: "Arial", size: 20, color: TEXT } } },
      paragraphStyles: [
        { id: "ListParagraph", name: "List Paragraph", basedOn: "Normal", quickFormat: true, run: { font: "Arial", size: 19 } }
      ]
    },
    numbering: {
      config: [{
        reference: BULLETS,
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 560, hanging: 280 } } } }]
      }]
    },
    sections: [{
      properties: { page: pageProperties },
      children: [
        ...coverPage(input),
        ...executiveSummary(input),
        ...lineBlocks,
        ...bindBlocks,
        // Add-ons flow on from whatever precedes them (skill: no forced break), except Bind Conditions keeps its page alone.
        ...(bindBlocks.length > 0 && addOnBlocks.length > 0 ? [pageBreak()] : []),
        ...addOnBlocks
      ]
    }, {
      properties: { type: SectionType.NEXT_PAGE, page: pageProperties },
      footers: { default: new Footer({ children: footerStrip() }) },
      children: whyBoxwood(input)
    }]
  })

  const includedSections = [
    "Executive Summary",
    ...input.lines.map((l) => l.title),
    ...(input.bindConditions.items.length > 0 ? ["Bind Conditions & Notes"] : []),
    ...input.specialtyAddOns.map((a) => a.title),
    "Why Boxwood Insurance Group"
  ]

  return { buffer: Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array), includedSections }
}
