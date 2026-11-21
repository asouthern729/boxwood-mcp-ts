import { type Paragraph, type Table } from "docx"
import { dataTable } from "./proposalBrand.js"
import { columnWidths } from "./proposalStyle.js"

// Height-aware layout for documents in the house style (proposalBrand.ts) that flow rather than
// give each section its own page — the PL Renewal Summary and the Pre-Renewal Review.
//
// A document is built as "pieces" with estimated heights in twips. That lets it:
// - decide page fit (the Pre-Renewal Review's layoutSections: a section only starts where it can finish);
// - cut the closing page — the docx section whose page footer is the mint contact band — to exactly
//   one page (splitForClosing). A footer prints on every page of its section, so the closing section
//   must never run past one page (Andrew, 2026-11-21: the band on the last page only).
//
// A table piece keeps its rows, so it can be split between two pages with its header repeated.
// Heights are estimates calibrated against LibreOffice renders (a 9pt table row ≈ 370 twips); they
// only have to be good enough to err on the safe side.

export type Block = Paragraph | Table

// keepBlank: blank cells stay blank instead of "—" (write-in columns, coverages a vehicle doesn't carry).
export type TablePiece = { kind: "table"; headers: string[]; rows: string[][]; fractions?: number[]; keepBlank?: boolean }
// render(startsPage, breakBefore): startsPage when the piece opens a page (a new docx section), so
// leading space can be dropped; breakBefore when it must force one itself (pageBreakBefore — a
// break paragraph would leave an empty line at the top of the page).
// keepWithNext: a heading — never left at the end of a page without the piece after it.
export type BlockPiece = { kind: "blocks"; height: number; render: (startsPage: boolean, breakBefore: boolean) => Block[]; keepWithNext?: boolean }
export type Piece = TablePiece | BlockPiece

export function blocksPiece(height: number, render: (startsPage: boolean, breakBefore: boolean) => Block[], opts: { keepWithNext?: boolean } = {}): BlockPiece {
  return { kind: "blocks", height, render, ...opts }
}

const sticky = (p: Piece | undefined) => p?.kind === "blocks" && Boolean(p.keepWithNext)

export function tablePiece(headers: string[], rows: string[][], opts: { fractions?: number[]; keepBlank?: boolean } = {}): TablePiece {
  return { kind: "table", headers, rows, ...opts }
}

// Wrapped line count of `text` in a space `width` twips wide, at ~`charTwips` per character.
export function lines(text: string, width: number, charTwips: number): number {
  const perLine = Math.max(8, Math.floor(width / charTwips))
  return text.split("\n").reduce((total, para) => {
    let count = 1, used = 0
    for(const word of para.split(/\s+/)) {
      if(used > 0 && used + 1 + word.length > perLine) { count++; used = word.length } else used += (used > 0 ? 1 : 0) + word.length
    }
    return total + count
  }, 0)
}

// Money columns read right-aligned (Andrew, 2026-11-21). A column counts as money when most of its
// filled cells carry a dollar figure, so a few mixed values — "1% ($12,500)", "$40/day",
// "Included" — don't flip it left. (The shared detection in proposalStyle wants every cell to be a
// pure amount; the CL proposal keeps that.)
const DOLLAR = /\$\s?\d/

export function moneyColumns(rows: string[][], columnCount: number): boolean[] {
  return Array.from({ length: columnCount }, (_, i) => {
    const filled = rows.map((r) => (r[i] ?? "").trim()).filter((v) => v !== "" && v !== "—")
    return filled.length > 0 && filled.filter((v) => DOLLAR.test(v)).length / filled.length >= 0.6
  })
}

export function createLayout(textWidth: number) {
  // Widths as dataTable would size them, from the whole table — both halves of a split table use them.
  function tableWidths(t: TablePiece): number[] {
    const filled = t.rows.map((r) => t.headers.map((_, i) => (r[i] ?? "").trim() || (t.keepBlank ? "" : "—")))
    return columnWidths(t.headers, filled, t.fractions, textWidth)
  }

  function headerRowHeight(t: TablePiece, widths: number[]): number {
    return 190 + 175 * Math.max(...t.headers.map((h, i) => lines(h.toUpperCase(), widths[i] - 280, 100)))
  }

  function rowHeight(row: string[], widths: number[]): number {
    return 160 + 210 * Math.max(1, ...row.map((c, i) => lines(c, widths[i] - 280, 90)))
  }

  // The full table, or one part of it (rows [from, to)), with the full table's widths and alignment.
  function renderTable(t: TablePiece, from = 0, to = t.rows.length): Table {
    return dataTable(t.headers, t.rows.slice(from, to), {
      fractions: t.fractions, keepBlank: t.keepBlank, tableWidth: textWidth,
      rightAlign: moneyColumns(t.rows, t.headers.length), widths: tableWidths(t)
    })
  }

  function pieceHeight(p: Piece): number {
    if(p.kind === "blocks") return p.height
    const widths = tableWidths(p)
    return headerRowHeight(p, widths) + p.rows.reduce((sum, r) => sum + rowHeight(r, widths), 0)
  }

  function render(pieces: Piece[], startsPage: boolean, breakBefore = false): Block[] {
    return pieces.flatMap((p, i) => p.kind === "table" ? [renderTable(p)] : p.render(startsPage && i === 0, breakBefore && i === 0))
  }

  // Splits `pieces` (what would be on the last page) into what flows before the closing page and what
  // goes on it, given the height a page with the band can hold. Whole when it fits; otherwise the
  // closing page takes as much of the end as fits, cutting a table between rows. An overestimate
  // only costs white space above the closing page; an underestimate would put the band on two pages
  // — so `capacity` should carry a safety margin. breakBefore: the pieces followed a page break in
  // the flow, so whatever stays before the closing page must still start a new page.
  function splitForClosing(pieces: Piece[], capacity: number, { breakBefore = false }: { breakBefore?: boolean } = {}): { before: Block[]; closing: Block[] } {
    const total = pieces.reduce((sum, p) => sum + pieceHeight(p), 0)
    if(total <= capacity) return { before: [], closing: render(pieces, true) }

    // The closing page takes pieces[k..] whole…
    let room = capacity
    let k = pieces.length
    while(k > 0 && pieceHeight(pieces[k - 1]) <= room) room -= pieceHeight(pieces[--k])

    // …plus the end of the table before them, cut between rows, if any rows fit.
    const cut = pieces[k - 1]
    if(cut?.kind === "table") {
      const widths = tableWidths(cut)
      let left = room - headerRowHeight(cut, widths)
      let from = cut.rows.length
      while(from > 0 && rowHeight(cut.rows[from - 1], widths) <= left) left -= rowHeight(cut.rows[--from], widths)
      if(from > 0 && from < cut.rows.length) {
        return {
          before: [...render(pieces.slice(0, k - 1), false, breakBefore), renderTable(cut, 0, from)],
          closing: [renderTable(cut, from), ...render(pieces.slice(k), false)]
        }
      }
    }

    // A heading left at the end of the page before goes over with what it heads, when there's room;
    // otherwise what it heads stays back with it.
    while(k > 0 && k < pieces.length && sticky(pieces[k - 1])) {
      const h = pieceHeight(pieces[k - 1])
      if(h <= room) { room -= h; k-- } else k++
    }
    // Never an empty closing page: at worst it holds the last piece.
    k = Math.min(k, pieces.length - 1)

    return { before: render(pieces.slice(0, k), false, breakBefore), closing: render(pieces.slice(k), true) }
  }

  return { pieceHeight, render, renderTable, splitForClosing }
}
