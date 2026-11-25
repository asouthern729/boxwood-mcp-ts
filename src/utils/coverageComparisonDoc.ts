import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, Document, Footer, ImageRun, LevelFormat, Packer, PageBreak, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType
} from "docx"
import type { Comparison, ComparisonRow } from "./coverageComparisonAnalysis.js"

// The CL Coverage Comparison document, laid out exactly as Patrick's coverage-comparison skill
// (scripts/build_comparison.js): letter portrait, 0.5" margins, Arial 9pt body / 8.5pt tables /
// 7.5pt forms, brand green headings and table headers, logo on page 1 only, address footer on every
// page. Order: header → At a Glance → Premium Summary → Key Points → (page break) line-by-line
// tables → (page break) Forms appendix → disclaimer. It's an internal tool, so it keeps the skill's
// simple format rather than the client-facing house style (Patrick, 2026-11-24).

const GREEN = "459361", TINT = "E3F0E7", ZEBRA = "F6FAF7", INK = "231F20", GRAY = "6B6B6B", RUST = "A0522D", LINE = "BFBFBF"
const W = 10800, FONT = "Arial"

const LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-logo.png")

const DISCLAIMER = "This comparison is a summary prepared for discussion purposes only and does not amend, extend or alter coverage. Quotes and proposals are not binding until coverage is bound by the carrier. In the event of any difference, the actual policy forms, declarations and endorsements govern. Please review with your Boxwood account team before making coverage decisions."

type RunOpts = { size?: number; bold?: boolean; color?: string; italics?: boolean }
type CellValue = string | ({ text: string; fill?: string } & RunOpts)

const t = (text: string, o: RunOpts = {}) => new TextRun({ text: String(text ?? ""), font: FONT, size: o.size ?? 18, bold: o.bold, color: o.color ?? INK, italics: o.italics })
const p = (runs: TextRun | TextRun[], o: { before?: number; after?: number; keepNext?: boolean } = {}) =>
  new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { before: o.before ?? 0, after: o.after ?? 60 }, keepNext: o.keepNext })
const small = (text: string) => p(t(text, { size: 15, italics: true, color: GRAY }), { before: 60 })
const H1 = (text: string) => new Paragraph({
  children: [t(text.toUpperCase(), { size: 26, bold: true, color: GREEN })], spacing: { before: 240, after: 100 }, keepNext: true,
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN, space: 2 } }
})
const H2 = (text: string) => new Paragraph({ children: [t(text, { size: 20, bold: true })], spacing: { before: 160, after: 60 }, keepNext: true })
const bd = { style: BorderStyle.SINGLE, size: 4, color: LINE }
const borders = { top: bd, bottom: bd, left: bd, right: bd }
const pageBreak = () => new Paragraph({ children: [new PageBreak()] })

// A cell value is a string ("\n" for line breaks) or {text, bold, color, fill, size}; bold applies to the first line.
function cell(v: CellValue, width: number, base: Partial<Exclude<CellValue, string>> = {}): TableCell {
  const o = typeof v === "object" ? { ...base, ...v } : { ...base, text: v }
  const lines = String(o.text ?? "").split("\n")
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders,
    shading: o.fill ? { type: ShadingType.CLEAR, color: "auto", fill: o.fill } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: lines.map((ln, i) => p(t(ln, { size: o.size ?? 17, bold: o.bold && i === 0, color: o.color }), { after: 0 }))
  })
}

function table(widths: number[], header: string[], rows: CellValue[][], o: { size?: number } = {}): Table {
  const hdr = new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, i) => cell(h, widths[i], { fill: GREEN, color: "FFFFFF", bold: true })) })
  const body = rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i], { fill: ri % 2 ? ZEBRA : undefined, size: o.size })) }))
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows: [hdr, ...body] })
}

const money = (n: number) => (n < 0 ? "–$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US")
const amount = (v: number | string | null) => (typeof v === "number" ? money(v) : (v ?? "—"))

function diff(a: unknown, b: unknown): CellValue {
  if(typeof a !== "number" || typeof b !== "number") return ""
  const d = b - a
  return { text: (d > 0 ? "+" : "") + money(d), bold: true, color: d < 0 ? GREEN : d > 0 ? RUST : INK }
}

// The skill's comparison tag: same | a_only | b_only | different | better | worse | info (+ note).
function note(r: ComparisonRow, AS: string, BS: string): CellValue {
  const label = { same: "Same", a_only: `${ AS } only`, b_only: `${ BS } only`, different: r.note ? "" : "Different", better: `Better in ${ BS }`, worse: `Reduced in ${ BS }`, info: "" }[r.status]
  const text = [label, r.note].filter(Boolean).join(label && r.note ? "; " : "")
  const color = r.status === "same" || r.status === "better" ? GREEN : (r.status === "a_only" || r.status === "worse" || r.flag) ? RUST : INK
  return { text, color, bold: (r.status !== "info" && r.status !== "different" && r.status !== "b_only") || r.flag }
}

function premiumRow(r: Comparison["premium"]["rows"][number]): CellValue[] {
  const d = r.diff_text ? { text: r.diff_text, bold: r.total } : diff(r.a, r.b)
  if(!r.total) return [{ text: r.line, bold: true }, amount(r.a), amount(r.b), d]
  const dv = typeof d === "string" ? { text: d } : d
  return [{ text: r.line, bold: true, fill: TINT }, { text: amount(r.a), bold: true, fill: TINT }, { text: amount(r.b), bold: true, fill: TINT }, { ...dv, bold: true, fill: TINT }]
}

export async function buildCoverageComparisonDoc(D: Comparison, preparedDate: string): Promise<Buffer> {
  const A = D.set_a.label, B = D.set_b.label, AS = D.set_a.short || "Current", BS = D.set_b.short || "Proposed"
  const C: (Paragraph | Table)[] = []

  // ---------- Header ----------
  let logo: Buffer | null = null
  try { logo = readFileSync(LOGO_PATH) } catch { logo = null }
  if(logo) C.push(new Paragraph({ children: [new ImageRun({ type: "png", data: logo, transformation: { width: 221, height: 60 } })], spacing: { after: 120 } }))
  C.push(p(t("Coverage Comparison", { size: 40, bold: true }), { after: 40 }))
  C.push(p(t(D.client.name, { size: 24, bold: true, color: GREEN }), { after: 40 }))
  if(D.client.address) C.push(p(t(D.client.address, { color: GRAY }), { after: 40 }))
  C.push(p(t(`Prepared by Boxwood Insurance Group  ·  ${ preparedDate }`, { color: GRAY }), { after: 120 }))
  C.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN, space: 1 } }, spacing: { after: 120 }, children: [] }))
  C.push(p([t(`${ D.intro } Items marked `), t(`${ AS } only`, { bold: true, color: RUST }), t(` appear in the ${ AS } documents but not in the ${ BS } documents and are worth reviewing together.`)], { after: 80 }))

  // ---------- At a glance ----------
  C.push(H1("At a Glance"))
  C.push(table([2400, 4200, 4200], ["Coverage", A, B], D.glance.map((g) => [{ text: g.item, bold: true }, g.a || "—", g.b || "—"])))
  D.glance_notes.forEach((n) => C.push(small(n)))

  // ---------- Premium ----------
  if(D.premium.rows.length > 0) {
    C.push(H1("Premium Summary"))
    C.push(table([3600, 2400, 2400, 2400], ["Line of coverage", A, B, "Difference"], D.premium.rows.map(premiumRow)))
    D.premium.notes.forEach((n) => C.push(small(n)))
  }
  for(const pt of D.premium_tables) {
    C.push(H2(pt.title))
    const n = pt.header.length
    const w = n === 2 ? [5400, 5400] : n === 3 ? [5400, 2700, 2700] : Array(n).fill(Math.floor(W / n))
    C.push(table(w, pt.header, pt.rows.map((r) => pt.header.map((_, i) => r[i] ?? ""))))
    pt.notes.forEach((x) => C.push(small(x)))
  }

  // ---------- Key points ----------
  C.push(H1("Key Points to Review"))
  D.key_points.forEach((k) => C.push(new Paragraph({ numbering: { reference: "bul", level: 0 }, spacing: { after: 70 }, children: [t(`${ k.lead } `, { bold: true }), t(k.text)] })))

  // ---------- Line-by-line ----------
  if(D.lines.length > 0) C.push(pageBreak())
  for(const L of D.lines) {
    C.push(H1(L.title))
    for(const s of L.sections) {
      C.push(H2(s.title))
      if(L.single) C.push(table([4400, 6400], ["Item", L.single === "a" ? A : B], s.rows.map((r) => [r.item, (L.single === "a" ? r.a : r.b) ?? "—"])))
      else C.push(table([3000, 2700, 2700, 2400], ["Item", A, B, "Comparison"], s.rows.map((r) => [r.item, r.a ?? "—", r.b ?? "—", note(r, AS, BS)])))
    }
    if(L.extensions && L.extensions.rows.length > 0) {
      C.push(H2(L.extensions.title))
      if(L.extensions.note) C.push(p(t(L.extensions.note, { size: 16, italics: true, color: GRAY })))
      const e = L.extensions.rows, h = Math.ceil(e.length / 2), rows: string[][] = []
      for(let i = 0; i < h; i++) rows.push([e[i].item, e[i].value, e[i + h]?.item ?? "", e[i + h]?.value ?? ""])
      C.push(table([3400, 2000, 3400, 2000], ["Coverage", "Limit", "Coverage", "Limit"], rows))
    }
  }

  // ---------- Forms ----------
  if(D.forms.length > 0) {
    C.push(pageBreak())
    C.push(H1("Appendix — Forms & Endorsements"))
    for(const f of D.forms) {
      C.push(H2(f.title))
      C.push(table([1800, 1200, 7800], ["Form", "Edition", "Description"], f.rows.map((r) => [r.form, r.edition || "—", r.description]), { size: 15 }))
    }
  }

  C.push(p(t(DISCLAIMER, { size: 15, italics: true, color: GRAY }), { before: 240 }))

  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 4, color: GREEN, space: 4 } },
      children: [
        t("Boxwood Insurance Group  ·  3020 Stansberry Lane, Suite 202, Franklin, TN 37069  ·  615-245-5851  ·  Page ", { size: 14, color: GRAY }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 14, color: GRAY })
      ]
    })]
  })

  const doc = new Document({
    creator: "Boxwood Insurance Group",
    title: `Coverage Comparison — ${ D.client.name }`,
    styles: { default: { document: { run: { font: FONT, size: 18 } } } },
    numbering: { config: [{ reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }] }] },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      footers: { default: footer },
      children: C
    }]
  })
  return Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array)
}
