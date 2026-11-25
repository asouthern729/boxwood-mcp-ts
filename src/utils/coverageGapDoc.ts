import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, Document, Footer, ImageRun, LevelFormat, Packer, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType
} from "docx"
import type { GapAnalysis, GapFinding } from "./coverageGapAnalysis.js"

// The Coverage Gap Analysis report, laid out per section 4 of Patrick's coverage-gap-analysis
// skill: portrait letter, Arial, near-black body, brand green headers and table header fills,
// light green alternating rows, 9pt table text. Header block → 11-step scorecard → Priority
// Findings → supporting exhibits (only for steps with findings) → validation questions → at most
// five recommendations, with the skill's footer line. Internal, so the skill's simple format rather
// than the client-facing house style (Patrick, 2026-11-24).

const GREEN = "459361", TINT = "E3F0E7", INK = "231F20", GRAY = "6B6B6B", LINE = "BFBFBF", WHITE = "FFFFFF"
const RED_FILL = "F8D7D3", AMBER_FILL = "FCEBC7"
const PRIORITY_TEXT = { High: "9B1C1C", Medium: "8A5300", Low: "1F4E79" } as const
const W = 10800, FONT = "Arial"

const LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-logo.png")
const LOGO_RATIO = 1600 / 435 // the skill's 3.678:1

const FOOTER_TEXT = "Internal working review prepared by Boxwood Insurance Group. Findings are based on the documents/data reviewed and must be confirmed against the full policy forms. Not a coverage opinion."

type RunOpts = { size?: number; bold?: boolean; color?: string; italics?: boolean }
type CellValue = string | ({ text: string; fill?: string } & RunOpts)

const t = (text: string, o: RunOpts = {}) => new TextRun({ text: String(text ?? ""), font: FONT, size: o.size ?? 18, bold: o.bold, color: o.color ?? INK, italics: o.italics })
const p = (runs: TextRun | TextRun[], o: { before?: number; after?: number; keepNext?: boolean } = {}) =>
  new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { before: o.before ?? 0, after: o.after ?? 60 }, keepNext: o.keepNext })
const H1 = (text: string) => new Paragraph({
  children: [t(text.toUpperCase(), { size: 24, bold: true, color: GREEN })], spacing: { before: 240, after: 100 }, keepNext: true,
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN, space: 2 } }
})
const H2 = (text: string) => new Paragraph({ children: [t(text, { size: 19, bold: true })], spacing: { before: 160, after: 60 }, keepNext: true })
const bd = { style: BorderStyle.SINGLE, size: 4, color: LINE }
const borders = { top: bd, bottom: bd, left: bd, right: bd }

// A cell value is a string ("\n" for line breaks) or {text, bold, color, fill, size}; bold applies to the first line.
function cell(v: CellValue, width: number, base: Partial<Exclude<CellValue, string>> = {}): TableCell {
  const o = typeof v === "object" ? { ...base, ...v } : { ...base, text: v }
  const lines = String(o.text ?? "").split("\n")
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders,
    shading: o.fill ? { type: ShadingType.CLEAR, color: "auto", fill: o.fill } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: lines.map((ln, i) => p(t(ln, { size: o.size ?? 17, bold: o.bold && i === 0, color: o.color }), { after: 0 }))
  })
}

// Brand-green header row, light green on alternate rows (a cell's own fill wins).
function table(widths: number[], header: string[], rows: CellValue[][]): Table {
  const hdr = new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, i) => cell(h, widths[i], { fill: GREEN, color: WHITE, bold: true })) })
  const body = rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i], { fill: ri % 2 ? TINT : undefined })) }))
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows: [hdr, ...body] })
}

const dash = (s: string) => (s.trim() ? s : "—")

function headerBlock(D: GapAnalysis, o: BuildOptions): Paragraph[] {
  const out: Paragraph[] = []
  try {
    const logo = readFileSync(LOGO_PATH)
    out.push(new Paragraph({ spacing: { after: 100 }, children: [new ImageRun({ type: "png", data: logo, transformation: { width: Math.round(0.5 * LOGO_RATIO * 96), height: 48 } })] }))
  } catch {
    // No logo file: the report still builds.
  }
  out.push(p(t("Coverage Gap Analysis", { size: 36, bold: true }), { after: 40 }))
  out.push(p(t(D.client_name, { size: 24, bold: true, color: GREEN }), { after: 80 }))

  // Carriers with their lines, in the order the policies were listed.
  const byCarrier = new Map<string, string[]>()
  for(const pol of D.policies) byCarrier.set(pol.carrier, [...(byCarrier.get(pol.carrier) ?? []), pol.lines])
  const carriers = [...byCarrier].map(([carrier, lines]) => `${ carrier } (${ lines.join(", ") })`).join("; ")

  const facts: [string, string][] = [
    ["Operations", D.operations],
    ["Source", o.hasNotes ? "Policy documents, plus account notes from staff" : "Policy documents"],
    ["Policies reviewed", `${ D.policies.length }${ carriers ? ` — ${ carriers }` : "" }`],
    ...(D.not_reviewed.length > 0 ? [["Not reviewed", D.not_reviewed.join("; ")] as [string, string]] : []),
    ["Review date", o.reviewDate],
    ["Prepared by", o.preparedBy]
  ]
  for(const [label, value] of facts) out.push(p([t(`${ label }: `, { bold: true }), t(value)], { after: 30 }))
  out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN, space: 1 } }, spacing: { after: 60 }, children: [] }))
  return out
}

function scorecard(D: GapAnalysis): (Paragraph | Table)[] {
  const fill = (status: string) => (status === "GAP" ? RED_FILL : status === "CONFIRM" ? AMBER_FILL : undefined)
  return [
    H1("Scorecard"),
    table([6600, 2200, 2000], ["Step", "Status", "# findings"], D.steps.map((s) => [
      `${ s.step }. ${ s.title }`,
      { text: s.status, bold: s.status === "GAP" || s.status === "CONFIRM", fill: fill(s.status) },
      s.findings > 0 ? String(s.findings) : "—"
    ]))
  ]
}

function priorityCell(f: GapFinding): CellValue {
  return { text: `${ f.priority }\n${ f.status }`, bold: true, color: PRIORITY_TEXT[f.priority] }
}

function priorityFindings(D: GapAnalysis): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [H1("Priority Findings")]
  if(D.findings.length === 0) {
    out.push(p(t("No gaps or items to confirm were found in the documents reviewed.")))
    return out
  }
  out.push(table(
    [950, 1350, 2600, 2000, 2200, 1700],
    ["Priority", "Coverage part", "Finding", "Impact", "Action", "Citation"],
    D.findings.map((f) => [priorityCell(f), { text: f.coverage_part, bold: true }, f.finding, f.impact, f.action, { text: f.citation, size: 15, color: GRAY }])
  ))
  if(D.housekeeping_merged > 0) out.push(p(t(`${ D.housekeeping_merged } low-priority items are combined in the Housekeeping row.`, { size: 15, italics: true, color: GRAY }), { before: 60 }))
  return out
}

function exhibits(D: GapAnalysis): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  const hasFindings = (step: number) => D.steps.find((s) => s.step === step)?.status === "GAP" || D.steps.find((s) => s.step === step)?.status === "CONFIRM"

  if(hasFindings(4) && D.locations.length > 0) {
    out.push(H2("Location matrix (Step 4)"))
    out.push(table([3000, 1100, 1100, 1100, 1900, 2600], ["Address", "Property", "GL / Garage", "WC", "Other policies", "Notes"],
      D.locations.map((l) => [l.address, dash(l.property), dash(l.gl), dash(l.wc), dash(l.other), l.notes])))
  }
  if(hasFindings(3) && D.term_groups.length > 0) {
    out.push(H2("Policy term grouping (Step 3)"))
    out.push(table([2800, 4600, 3400], ["Term", "Policies", "Notes"], D.term_groups.map((g) => [g.term, g.policies, g.notes])))
  }
  if(hasFindings(2) && D.named_insureds.length > 0) {
    out.push(H2("Named insured mismatches (Step 2)"))
    out.push(table([3200, 2400, 2200, 3000], ["Name as printed", "Policy", "Shown as", "Note"], D.named_insureds.map((n) => [n.name, n.policy, n.shown_as, n.note])))
  }
  if(hasFindings(9) && D.underlying.length > 0) {
    out.push(H2("Umbrella underlying check (Step 9)"))
    out.push(table([3600, 1800, 1800, 1800, 1800], ["Underlying", "Scheduled?", "No. match", "Term match", "Limits match"],
      D.underlying.map((u) => [u.underlying, dash(u.scheduled), dash(u.number_match), dash(u.term_match), dash(u.limits_match)])))
  }
  return out.length > 0 ? [H1("Supporting Exhibits"), ...out] : []
}

function listSection(title: string, items: string[], reference: "num" | "bul"): Paragraph[] {
  if(items.length === 0) return []
  return [H1(title), ...items.map((text) => new Paragraph({ numbering: { reference, level: 0 }, spacing: { after: 50 }, children: [t(text)] }))]
}

export type BuildOptions = { reviewDate: string; preparedBy: string; hasNotes: boolean }

export async function buildCoverageGapDoc(D: GapAnalysis, o: BuildOptions): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    ...headerBlock(D, o),
    ...scorecard(D),
    ...priorityFindings(D),
    ...exhibits(D),
    ...listSection("Validation Questions", D.validation_questions, "num"),
    ...listSection("Recommendations", D.recommendations, "bul")
  ]

  const grey = { size: 14, color: GRAY }
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 4, color: GREEN, space: 4 } },
      children: [
        t(`${ FOOTER_TEXT }  ·  Page `, grey),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, ...grey }),
        t(" of ", grey),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, ...grey })
      ]
    })]
  })

  const indent = { indent: { left: 360, hanging: 240 } }
  const doc = new Document({
    creator: "Boxwood Insurance Group",
    title: `Coverage Gap Analysis — ${ D.client_name }`,
    styles: { default: { document: { run: { font: FONT, size: 18, color: INK } } } },
    numbering: {
      config: [
        { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: indent } }] },
        { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: indent } }] }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 720, bottom: 720, left: 720, right: 720, footer: 360 } } },
      footers: { default: footer },
      children
    }]
  })
  return Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array)
}
