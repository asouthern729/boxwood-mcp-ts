import { Document, Packer, Paragraph, SectionType } from "docx"
import type { Comparison, ComparisonRow } from "./coverageComparisonAnalysis.js"
import { blocksPiece, createLayout, tablePiece, type Block, type Piece } from "./docLayout.js"
import {
  AGENCY_PREPARED_BY, CHAR, COVER_MARGINS, FOOTER_STYLE, GREEN, INTERIOR_MARGINS, PAGE_HEIGHT, PAGE_WIDTH, TEXT_WIDTH, BULLETS, BULLET_NUMBERING,
  closingFooter, coverPage, dataTable, footnote, interiorFooter, interiorHeader, run, sectionOpener, subHeader
} from "./proposalBrand.js"

// The CL Coverage Comparison document. Content and order follow Patrick's coverage-comparison skill
// (At a Glance → Premium Summary → Key Points → line-by-line tables → forms appendix → disclaimer,
// with the skill's Same / Current only / Better / Reduced tags). Presented in Boxwood's house style
// (proposalBrand.ts; Patrick 2026-11-21: every output document shares it — Andrew, 2026-11-22):
// the house cover, logo + client-name page header, section openers, charcoal-header tables, and the
// mint contact band with the disclaimer at the foot of the last page. The skill's rust for gaps and
// reductions is kept on the tags — it carries meaning, and the house palette has no warning colour.

const RUST = "A0522D"

const DISCLAIMER = "This comparison is a summary prepared for discussion purposes only and does not amend, extend or alter coverage. Quotes and proposals are not binding until coverage is bound by the carrier. In the event of any difference, the actual policy forms, declarations and endorsements govern. Please review with your Boxwood account team before making coverage decisions."

const layout = createLayout(TEXT_WIDTH)
const page = { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: INTERIOR_MARGINS }
// Room above the closing band (contact band + disclaimer + page footer ≈ 3300 twips), with a margin
// for estimate error — an underestimate would print the band on two pages.
const CLOSING_PAGE_HEIGHT = Math.floor(0.88 * (PAGE_HEIGHT - INTERIOR_MARGINS.top - INTERIOR_MARGINS.bottom - 3300))

const money = (n: number) => (n < 0 ? "–$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US")
const amount = (v: number | string | null) => (typeof v === "number" ? money(v) : (v ?? "—"))

type Style = { color?: string; bold?: boolean } | undefined

function difference(a: unknown, b: unknown): { text: string; style: Style } {
  if(typeof a !== "number" || typeof b !== "number") return { text: "", style: undefined }
  const d = b - a
  return { text: d === 0 ? "$0" : (d > 0 ? "+" : "") + money(d), style: { bold: true, color: d < 0 ? GREEN : d > 0 ? RUST : CHAR } }
}

// The skill's comparison tag: same | a_only | b_only | different | better | worse | info (+ note).
function tag(r: ComparisonRow, AS: string, BS: string): { text: string; style: Style } {
  const label = { same: "Same", a_only: `${ AS } only`, b_only: `${ BS } only`, different: r.note ? "" : "Different", better: `Better in ${ BS }`, worse: `Reduced in ${ BS }`, info: "" }[r.status]
  const text = [label, r.note].filter(Boolean).join(label && r.note ? "; " : "")
  const color = r.status === "same" || r.status === "better" ? GREEN : (r.status === "a_only" || r.status === "worse" || r.flag) ? RUST : undefined
  const bold = (r.status !== "info" && r.status !== "different" && r.status !== "b_only") || r.flag
  return { text, style: color || bold ? { color, bold } : undefined }
}

// The house table cell prints one run, so a "\n" inside a value would just run the lines together.
const oneLine = (text: string) => text.split("\n").map((t) => t.trim()).filter(Boolean).join("; ")

// A comparison table as a layout piece: height estimated as the equivalent plain table, rendered
// with per-cell styles (which tablePiece can't carry). Everything left-aligned — the values are
// carrier wording ("$250,000 each claim"), and the house money-column detection would right-align
// some tables and not others.
function comparisonTable(headers: string[], rows: string[][], styles: Style[][], fractions: number[]): Piece {
  const cells = rows.map((r) => r.map(oneLine))
  const height = layout.pieceHeight(tablePiece(headers, cells, { fractions }))
  const rightAlign = headers.map(() => false)
  return blocksPiece(height, () => [dataTable(headers, cells, { fractions, rightAlign, cellStyle: (r, c) => styles[r]?.[c] })])
}

// A section opener (eyebrow, accent rule, headline). It forces its own page break when it opens a
// run (pageBreakBefore, so no empty line at the top), and drops its leading space at a page top.
const heading = (eyebrowText: string, text: string, first: boolean) => blocksPiece(first ? 900 : 1200, (startsPage, breakBefore) =>
  sectionOpener({ eyebrowText, title: text, compact: true, pageBreak: breakBefore, before: startsPage || breakBefore ? 0 : 320 }), { keepWithNext: true })
const sub = (text: string) => blocksPiece(420, () => [subHeader(text)], { keepWithNext: true })
const notes = (lines: string[]) => lines.map((n) => blocksPiece(300, () => [footnote(n)]))

function coverBlocks(D: Comparison): Block[] {
  return coverPage({
    eyebrow: "Coverage Comparison",
    title: D.client.name,
    titleAccent: "Your options, side by side.",
    subtitle: D.intro,
    preparedFor: {
      headline: ["Confidence in your coverage", "comes first."],
      facts: [["Named Insured", D.client.name], [D.set_a.short, D.set_a.label], [D.set_b.short, D.set_b.label]]
    },
    preparedBy: AGENCY_PREPARED_BY
  })
}

// At a Glance, Premium Summary, Key Points — the summary pages.
function summaryPieces(D: Comparison): Piece[] {
  const A = D.set_a.label, B = D.set_b.label, AS = D.set_a.short, BS = D.set_b.short
  const pieces: Piece[] = [
    // The intro sentence is on the cover; the interior opens with the skill's legend line.
    blocksPiece(600, () => [new Paragraph({
      spacing: { after: 200 },
      children: [run("Items marked ", { size: 19 }), run(`${ AS } only`, { bold: true, color: RUST, size: 19 }), run(` appear in the ${ AS } documents but not in the ${ BS } documents and are worth reviewing together.`, { size: 19 })]
    })]),
    heading("Summary", "At a Glance", true),
    comparisonTable(["Coverage", A, B], D.glance.map((g) => [g.item, g.a || "—", g.b || "—"]), D.glance.map(() => [{ bold: true }]), [2400, 4200, 4200]),
    ...notes(D.glance_notes)
  ]

  if(D.premium.rows.length > 0) {
    const plain = D.premium.rows.filter((r) => !r.total)
    const total = D.premium.rows.find((r) => r.total)
    const diffs = plain.map((r) => (r.diff_text ? { text: r.diff_text, style: undefined } : difference(r.a, r.b)))
    const totalDiff = total ? (total.diff_text ?? difference(total.a, total.b).text) : ""
    const headers = ["Line of coverage", A, B, "Difference"]
    const rows = plain.map((r, i) => [r.line, amount(r.a), amount(r.b), diffs[i].text])
    const totalRow = total ? [total.line, amount(total.a), amount(total.b), totalDiff] : undefined
    const fractions = [3600, 2400, 2400, 2400]
    const height = layout.pieceHeight(tablePiece(headers, totalRow ? [...rows, totalRow] : rows, { fractions }))
    pieces.push(
      heading("Summary", "Premium Summary", false),
      blocksPiece(height, () => [dataTable(headers, rows, { fractions, totalRow, rightAlign: [false, true, true, true], cellStyle: (r, c) => (c === 0 ? { bold: true } : c === 3 ? diffs[r]?.style : undefined) })]),
      ...notes(D.premium.notes)
    )
  }

  for(const pt of D.premium_tables) {
    pieces.push(sub(pt.title), tablePiece(pt.header, pt.rows.map((r) => pt.header.map((_, i) => r[i] ?? ""))), ...notes(pt.notes))
  }

  pieces.push(heading("Summary", "Key Points to Review", false))
  for(const k of D.key_points) {
    pieces.push(blocksPiece(200 + 230 * Math.ceil((k.lead.length + k.text.length) / 95), () => [new Paragraph({
      numbering: { reference: BULLETS, level: 0 },
      spacing: { after: 90 },
      children: [run(`${ k.lead } `, { bold: true, size: 19 }), run(k.text, { size: 19 })]
    })]))
  }
  return pieces
}

// One section per coverage line, the skill's side-by-side tables.
function linePieces(D: Comparison): Piece[] {
  const A = D.set_a.label, B = D.set_b.label, AS = D.set_a.short, BS = D.set_b.short
  return D.lines.flatMap((L, li) => {
    const pieces: Piece[] = [heading("Line by Line", L.title, li === 0)]
    for(const s of L.sections) {
      pieces.push(sub(s.title))
      if(L.single) {
        pieces.push(comparisonTable(["Item", L.single === "a" ? A : B], s.rows.map((r) => [r.item, (L.single === "a" ? r.a : r.b) ?? "—"]), [], [4400, 6400]))
      } else {
        const tags = s.rows.map((r) => tag(r, AS, BS))
        pieces.push(comparisonTable(
          ["Item", A, B, "Comparison"],
          s.rows.map((r, i) => [r.item, r.a ?? "—", r.b ?? "—", tags[i].text]),
          tags.map((t) => [undefined, undefined, undefined, t.style]),
          [3000, 2700, 2700, 2400]
        ))
      }
    }
    if(L.extensions && L.extensions.rows.length > 0) {
      const e = L.extensions.rows, h = Math.ceil(e.length / 2), rows: string[][] = []
      for(let i = 0; i < h; i++) rows.push([e[i].item, e[i].value, e[i + h]?.item ?? "", e[i + h]?.value ?? ""])
      pieces.push(sub(L.extensions.title))
      if(L.extensions.note) pieces.push(...notes([L.extensions.note]))
      pieces.push(comparisonTable(["Coverage", "Limit", "Coverage", "Limit"], rows, [], [3400, 2000, 3400, 2000]))
    }
    return pieces
  })
}

function formsPieces(D: Comparison): Piece[] {
  if(D.forms.length === 0) return []
  return [
    heading("Appendix", "Forms & Endorsements", true),
    ...D.forms.flatMap((f) => [sub(f.title), tablePiece(["Form", "Edition", "Description"], f.rows.map((r) => [r.form, r.edition || "—", r.description]), { fractions: [1800, 1200, 7800] })] as Piece[])
  ]
}

export async function buildCoverageComparisonDoc(D: Comparison, _preparedDate: string): Promise<Buffer> {
  // Three runs of content, each starting a page (the skill's page breaks): summary, line by line,
  // forms. The last run's end goes on the closing page with the band.
  const runs = [summaryPieces(D), linePieces(D), formsPieces(D)].filter((r) => r.length > 0)
  const last = runs.pop()!
  const { before, closing } = layout.splitForClosing(last, CLOSING_PAGE_HEIGHT, { breakBefore: runs.length > 0 })

  const flow: Block[] = [
    ...runs.flatMap((pieces, i) => layout.render(pieces, i === 0, i > 0)),
    ...before
  ]
  const header = { default: interiorHeader(D.client.name) }

  const doc = new Document({
    creator: "Boxwood Insurance Group",
    title: `Coverage Comparison — ${ D.client.name }`,
    styles: { default: { document: { run: { font: "Arial", size: 20, color: CHAR } } }, paragraphStyles: [FOOTER_STYLE] },
    numbering: { config: [BULLET_NUMBERING] },
    sections: [
      { properties: { page: { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: COVER_MARGINS } }, children: coverBlocks(D) },
      ...(flow.length > 0 ? [{ properties: { type: SectionType.NEXT_PAGE, page }, headers: header, footers: { default: interiorFooter() }, children: flow }] : []),
      { properties: { type: SectionType.NEXT_PAGE, page }, headers: header, footers: { default: closingFooter({ disclaimer: DISCLAIMER }) }, children: closing }
    ]
  })
  return Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array)
}
