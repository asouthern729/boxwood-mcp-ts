import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, Footer, Header, HeightRule, ImageRun, LevelFormat,
  LineRuleType, PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TabStopType,
  TextRun, VerticalAlign, WidthType
} from "docx"
import type { ITableCellBorders } from "docx"
import { AGENCY, columnWidths, numericColumns, type Block } from "./proposalStyle.js"

// The visual language of Patrick's "insurance-proposal-copy-reformatting" skill (the restyled
// insurance-proposal skill, matching Boxwood's High Net Worth one-pager): mint and charcoal
// full-bleed bands, green letter-spaced eyebrows over a short accent rule, two-tone headlines,
// green-top-rule fact cards and charcoal-header / mint-banded data tables. Every size, colour,
// margin and spacing below is the skill's own figure unless a comment says otherwise.
//
// Boxwood's house style for generated client documents (Patrick, 2026-11-21: every output document
// should share it). Helpers are document-neutral; each document supplies its own wording (cover
// eyebrow, headlines, header name, tagline). Used by the CL proposal document (clProposalDoc.ts —
// Proposal Builder and CL Renewal Summary), the PL Renewal Summary (plRenewalSummaryDoc.ts), the
// Pre-Renewal Review (riskProfileDoc.ts) and the CL Coverage Comparison (coverageComparisonDoc.ts).
//
// Layout: a cover docx section with zero margins (coverPage, no header/footer) and an interior
// section with INTERIOR_MARGINS, interiorHeader/interiorFooter, sections opened with sectionOpener,
// and a closing section — starting a new page — whose page footer is closingFooter, which puts the
// mint band at the foot of the last page. A compact flowing document (the PL Renewal Summary
// letter, plRenewalSummaryDoc.ts) skips the cover and passes its own margins/text width.

export const GREEN = "459361"
export const CHAR = "231F20"
export const MINT = "E3F0E7"
export const ARC = "A1C8AF"
export const WHITE = "FFFFFF"
export const ON_CHAR = "D9D9D9"
export const DISCLAIMER_GRAY = "7A7A7A"
const PALE_MINT = "F3F8F5"
const HAIRLINE = "C9DDD0"

export const PAGE_WIDTH = 12240
export const PAGE_HEIGHT = 15840
export const SIDE_MARGIN = 1440
export const TEXT_WIDTH = PAGE_WIDTH - 2 * SIDE_MARGIN // 9360
export const COVER_MARGINS = { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 }
export const INTERIOR_MARGINS = { top: 1440, right: SIDE_MARGIN, bottom: 1080, left: SIDE_MARGIN, header: 500, footer: 500 }
const COVER_TEXT_WIDTH = PAGE_WIDTH - 2 * 900 // 10440
const WEBSITE = AGENCY.website.replace(/^www\./, "")
export const DEFAULT_TAGLINE = "Let's begin the conversation."

// Generated once from the skill's Python (white knocked out of boxwood-proposal-logo.png; the cover
// arc art) and committed — never processed at runtime.
const ASSETS = path.join(import.meta.dirname, "..", "..", "assets")
const LOGO_PATH = path.join(ASSETS, "boxwood-proposal-logo-clear.png")
const ARCS_PATH = path.join(ASSETS, "proposal-cover-arcs.png")
const LOGO_RATIO = 1918 / 558

const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
export const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE }
export const TABLE_NO_BORDERS = { ...NO_BORDERS, insideHorizontal: NONE, insideVertical: NONE }

type RunOpts = { bold?: boolean; italics?: boolean; size?: number; color?: string; characterSpacing?: number; break?: number }

export function run(text: string, o: RunOpts = {}): TextRun {
  return new TextRun({ text, font: "Arial", bold: o.bold, italics: o.italics, size: o.size, color: o.color ?? CHAR, characterSpacing: o.characterSpacing, break: o.break })
}

// docx ImageRun sizes are in pixels at 96 dpi.
export function logoRun(widthInches: number): ImageRun {
  const width = widthInches * 96
  return new ImageRun({ type: "png", data: readFileSync(LOGO_PATH), transformation: { width, height: width / LOGO_RATIO } })
}

export function pageBreak(): Paragraph {
  return new Paragraph({ children: [new PageBreak()] })
}


// ---------- TYPE ----------

type ParaOpts = { before?: number; after?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; size?: number; color?: string; keepNext?: boolean; pageBreakBefore?: boolean }

// Small, bold, ALL CAPS, letter-spaced label.
export function eyebrow(text: string, o: ParaOpts = {}): Paragraph {
  return new Paragraph({
    keepNext: o.keepNext ?? true,
    pageBreakBefore: o.pageBreakBefore,
    alignment: o.align,
    spacing: { before: o.before ?? 0, after: o.after ?? 80 },
    children: [run(text.toUpperCase(), { bold: true, size: o.size ?? 16, color: o.color ?? GREEN, characterSpacing: 40 })]
  })
}

// Short (~0.53") thick green bar under an eyebrow.
export function accentRule({ textWidth = TEXT_WIDTH, after = 200 }: { textWidth?: number; after?: number } = {}): Paragraph {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 0, after },
    indent: { right: textWidth - 760 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: GREEN, space: 1 } },
    children: [run("", { size: 4 })]
  })
}

// Two-tone headline: [["Your investment, ", CHAR], ["summarized.", GREEN]]. breakBetween puts each
// part on its own line; sizes may differ per part.
export function headline(parts: [string, string, number?][], o: { size?: number; after?: number; breakBetween?: boolean } = {}): Paragraph {
  const children = parts.map(([text, color, size], i) => run(text, { bold: true, size: size ?? o.size ?? 36, color, break: o.breakBetween && i > 0 ? 1 : undefined }))
  return new Paragraph({
    keepNext: true,
    spacing: { before: 0, after: o.after ?? 160, line: 252, lineRule: LineRuleType.AUTO },
    children
  })
}

export function body(text: string, o: ParaOpts & { italics?: boolean } = {}): Paragraph {
  return new Paragraph({
    alignment: o.align,
    spacing: { before: o.before ?? 0, after: o.after ?? 140, line: 276, lineRule: LineRuleType.AUTO },
    children: [run(text, { size: o.size ?? 20, color: o.color ?? CHAR, italics: o.italics })]
  })
}

// Replaces the old logo + green banner. pageBreak sets
// pageBreakBefore on the eyebrow rather than adding a break paragraph, which would leave an empty
// line at the top of the new page.
// compact (the PL letter, no page breaks between sections): 14pt headline, tighter spacing, and
// `before` to separate it from the section above. textWidth sizes the accent rule on other margins.
export function sectionOpener({ eyebrowText, title, accent, pageBreak: breakBefore, compact = false, before, textWidth }: { eyebrowText: string; title: string; accent?: string; pageBreak?: boolean; compact?: boolean; before?: number; textWidth?: number }): Paragraph[] {
  return [
    eyebrow(eyebrowText, { before, after: compact ? 40 : 60, pageBreakBefore: breakBefore }),
    accentRule({ after: compact ? 100 : 160, textWidth }),
    headline([[title + (accent ? " " : ""), CHAR], ...(accent ? [[accent, GREEN] as [string, string]] : [])], { size: compact ? 28 : 36, after: compact ? 140 : 200 })
  ]
}

// "Coverage Limits", "Bind Conditions & Notes", "Your Service Team", ...
export function subHeader(text: string): Paragraph {
  return eyebrow(text, { before: 280, after: 100, size: 17 })
}

export function footnote(text: string): Paragraph {
  return new Paragraph({ spacing: { before: 80, after: 80 }, children: [run(text, { italics: true, size: 17 })] })
}

// ---------- BULLETS ----------

export const BULLETS = "proposal-bullets"

export const BULLET_NUMBERING = {
  reference: BULLETS,
  levels: [{
    level: 0,
    format: LevelFormat.BULLET,
    text: "•",
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 560, hanging: 280 } }, run: { color: GREEN } }
  }]
}

export function bullet(text: string): Paragraph {
  return new Paragraph({ numbering: { reference: BULLETS, level: 0 }, spacing: { before: 30, after: 30 }, children: [run(text, { size: 19 })] })
}

// ---------- CARDS & BANDS ----------

// Fact cards: green top rule, tiny eyebrow label, bold value; `cols` per row. A value's "\n" breaks
// the line (the cover's street | city lines). keepWithNext holds every row on the page with what
// follows (a flowing document, so a section's cards don't split from its table).
export function factGrid(facts: [string, string][], { textWidth = TEXT_WIDTH, cols = 3, labelColor = GREEN, valueColor = CHAR, keepWithNext }: { textWidth?: number; cols?: number; labelColor?: string; valueColor?: string; keepWithNext?: boolean } = {}): Table {
  const keep = keepWithNext || undefined
  const gap = 280
  const cw = Math.floor((textWidth - gap * (cols - 1)) / cols)
  const widths: number[] = []
  for(let i = 0; i < cols; i++) {
    widths.push(cw)
    if(i < cols - 1) widths.push(gap)
  }
  widths[widths.length - 1] += textWidth - widths.reduce((a, b) => a + b, 0)

  const value = (text: string) => new Paragraph({
    keepNext: keep,
    children: text.split("\n").map((line, i) => run(line, { size: 20, bold: true, color: valueColor, break: i > 0 ? 1 : undefined }))
  })

  const rows: TableRow[] = []
  for(let r = 0; r < facts.length; r += cols) {
    const cells: TableCell[] = []
    for(let i = 0; i < cols; i++) {
      const f = facts[r + i]
      const w = widths[i * 2]
      cells.push(new TableCell({
        width: { size: w, type: WidthType.DXA },
        borders: { ...NO_BORDERS, top: f ? { style: BorderStyle.SINGLE, size: 18, color: GREEN } : NONE },
        margins: { top: 100, bottom: 160, left: 0, right: 0 },
        children: f ? [eyebrow(f[0], { size: 14, after: 40, color: labelColor, keepNext: keepWithNext ?? false }), value(f[1])] : [(keep ? new Paragraph({ keepNext: true }) : new Paragraph(""))]
      }))
      if(i < cols - 1) cells.push(new TableCell({ width: { size: gap, type: WidthType.DXA }, borders: NO_BORDERS, children: [(keep ? new Paragraph({ keepNext: true }) : new Paragraph(""))] }))
    }
    rows.push(new TableRow({ cantSplit: true, children: cells }))
  }
  return new Table({ width: { size: textWidth, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, borders: TABLE_NO_BORDERS, rows })
}

// Full-bleed band: one shaded cell pulled out to the page edges. Interior pages: offset = minus the
// side margin (-1440 on the CL documents, -900 on the PL letter), and the cell pads back in by the
// same amount so its content lines up with the text; the cover (zero margins): offset 0.
export function band(fill: string, children: Block[], { top = 440, bottom = 440, offset = -SIDE_MARGIN }: { top?: number; bottom?: number; offset?: number } = {}): Table {
  const side = offset ? -offset : 900
  return new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: [PAGE_WIDTH],
    layout: TableLayoutType.FIXED,
    borders: TABLE_NO_BORDERS,
    indent: offset ? { size: offset, type: WidthType.DXA } : undefined,
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        width: { size: PAGE_WIDTH, type: WidthType.DXA },
        borders: NO_BORDERS,
        shading: { fill, type: ShadingType.CLEAR },
        margins: { top, bottom, left: side, right: side },
        children
      })]
    })]
  })
}

// Logo + tagline | agency name, address, phone | website — on the cover (offset 0, 5220/5220) and
// closing the document (offset -1440, 4680/4680). keepNext holds it on the same page as whatever
// follows (the PL letter's inline closing).
export function contactBand({ offset, top, bottom, tagline = DEFAULT_TAGLINE, keepNext, logoWidth = 1.6 }: { offset: number; top: number; bottom: number; tagline?: string; keepNext?: boolean; logoWidth?: number }): Table {
  const half = offset ? (PAGE_WIDTH + 2 * offset) / 2 : 5220
  const keep = keepNext || undefined
  const left = new TableCell({
    width: { size: half, type: WidthType.DXA },
    borders: NO_BORDERS,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({ keepNext: keep, spacing: { after: 120 }, children: [logoRun(logoWidth)] }),
      new Paragraph({ keepNext: keep, children: [run(tagline, { bold: true, size: 22 })] })
    ]
  })
  const right = new TableCell({
    width: { size: half, type: WidthType.DXA },
    borders: NO_BORDERS,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      eyebrow("Boxwood Insurance Group", { size: 14, after: 60, align: AlignmentType.RIGHT, keepNext: keepNext ?? false }),
      new Paragraph({ keepNext: keep, alignment: AlignmentType.RIGHT, spacing: { after: 40 }, children: [run(AGENCY.address, { size: 16 })] }),
      new Paragraph({ keepNext: keep, alignment: AlignmentType.RIGHT, children: [run(`${ AGENCY.phone } | ${ WEBSITE }`, { size: 16 })] })
    ]
  })
  return band(MINT, [new Table({
    width: { size: half * 2, type: WidthType.DXA },
    columnWidths: [half, half],
    layout: TableLayoutType.FIXED,
    borders: TABLE_NO_BORDERS,
    rows: [new TableRow({ children: [left, right] })]
  })], { offset, top, bottom })
}

// ---------- PAGE HEADER & FOOTER (interior section only) ----------

// textWidth: the page's text width, for the right tab (CL 9360; the PL letter 10440).
//
// A name too long for one line beside the logo (~128 twips per 7pt letter-spaced capital) would wrap
// under the logo and into the page; it goes in a two-column table instead, wrapping right-aligned
// in its own column.
const HEADER_LOGO_COLUMN = 2300
const HEADER_CHAR = 128

export function interiorHeader(clientName: string, { textWidth = TEXT_WIDTH }: { textWidth?: number } = {}): Header {
  const name = run(clientName.toUpperCase(), { bold: true, size: 14, color: GREEN, characterSpacing: 30 })
  if(clientName.length * HEADER_CHAR > textWidth - HEADER_LOGO_COLUMN) {
    const rule = { style: BorderStyle.SINGLE, size: 4, color: ARC }
    return new Header({
      children: [new Table({
        width: { size: textWidth, type: WidthType.DXA },
        columnWidths: [HEADER_LOGO_COLUMN, textWidth - HEADER_LOGO_COLUMN],
        layout: TableLayoutType.FIXED,
        borders: { ...TABLE_NO_BORDERS, bottom: rule },
        rows: [new TableRow({
          children: [
            new TableCell({ width: { size: HEADER_LOGO_COLUMN, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.BOTTOM, margins: { top: 0, bottom: 120, left: 0, right: 0 }, children: [new Paragraph({ children: [logoRun(1.35)] })] }),
            new TableCell({ width: { size: textWidth - HEADER_LOGO_COLUMN, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.BOTTOM, margins: { top: 0, bottom: 120, left: 0, right: 0 }, children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [name] })] })
          ]
        })]
      }), new Paragraph({ spacing: { after: 0 }, children: [run("", { size: 4 })] })]
    })
  }
  return new Header({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: textWidth }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ARC, space: 6 } },
      children: [logoRun(1.35), run("\t"), name]
    })]
  })
}

// The footer paragraph's own style is the page number's look: LibreOffice ignores the run
// formatting of a PAGE field and falls back to the paragraph style. Add to Document styles.paragraphStyles.
export const FOOTER_STYLE = { id: "BrandFooter", name: "Brand Footer", basedOn: "Normal", run: { font: "Arial", size: 14, bold: true, color: GREEN } }

function footerLine(textWidth = TEXT_WIDTH): Paragraph {
  return new Paragraph({
    style: FOOTER_STYLE.id,
    tabStops: [{ type: TabStopType.RIGHT, position: textWidth }],
    children: [
      run(`Boxwood Insurance Group | ${ AGENCY.phone } | ${ WEBSITE }`, { size: 14, bold: false }),
      run("\t"),
      run("PAGE ", { bold: true, size: 14, color: GREEN, characterSpacing: 30 }),
      new TextRun({ children: [PageNumber.CURRENT], font: "Arial", bold: true, size: 14, color: GREEN })
    ]
  })
}

export function interiorFooter({ textWidth = TEXT_WIDTH }: { textWidth?: number } = {}): Footer {
  return new Footer({ children: [footerLine(textWidth)] })
}

// ---------- DATA TABLES ----------
// Fixed DXA widths summing to TEXT_WIDTH, sized to content by proposalStyle.ts's columnWidths (a
// column never narrower than its longest word or figure); money columns right-aligned. Charcoal
// header (repeats on each page), white / pale-mint bands with hairline rules, optional green total row.

const RULE = { style: BorderStyle.SINGLE, size: 4, color: HAIRLINE }
const BODY_BORDERS = { top: RULE, bottom: RULE, left: NONE, right: NONE }
const HEAD_BORDERS = { top: NONE, bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN }, left: NONE, right: NONE }
const HEAD_MARGINS = { top: 90, bottom: 90, left: 140, right: 140 }
const BODY_MARGINS = { top: 75, bottom: 75, left: 140, right: 140 }

function cell(text: string, width: number, o: { borders: ITableCellBorders; fill: string; margins: typeof BODY_MARGINS; right: boolean; run: RunOpts; keepNext?: true }): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: o.borders,
    verticalAlign: VerticalAlign.CENTER,
    shading: { fill: o.fill, type: ShadingType.CLEAR },
    margins: o.margins,
    children: [new Paragraph({ keepNext: o.keepNext, alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [run(text, o.run)] })]
  })
}

// Empty cells print "—" unless keepBlank.
// rightAlign overrides the money-column detection per column (a matrix whose columns should all
// align alike). keepWithNext holds the whole table on the page with what follows. widths fixes the
// column widths (the two halves of a table split across pages must match). cellStyle colours or
// bolds individual body cells (the CL Coverage Comparison's Same / Reduced tags), by row and column.
export function dataTable(headers: string[], rows: string[][], { fractions, totalRow, keepBlank = false, tableWidth = TEXT_WIDTH, rightAlign, keepWithNext, widths: fixedWidths, cellStyle }: { fractions?: number[]; totalRow?: string[]; keepBlank?: boolean; tableWidth?: number; rightAlign?: boolean[]; keepWithNext?: boolean; widths?: number[]; cellStyle?: (row: number, col: number) => { color?: string; bold?: boolean } | undefined } = {}): Table {
  const filled = rows.map((r) => headers.map((_, i) => (r[i] ?? "").trim() || (keepBlank ? "" : "—")))
  const sizing = totalRow ? [...filled, totalRow] : filled
  const widths = fixedWidths ?? columnWidths(headers, sizing, fractions, tableWidth)
  const right = rightAlign ?? numericColumns(sizing, headers.length)
  const keep = keepWithNext || undefined

  return new Table({
    width: { size: tableWidth, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: TABLE_NO_BORDERS,
    rows: [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: headers.map((h, i) => cell(h.toUpperCase(), widths[i], { borders: HEAD_BORDERS, fill: CHAR, margins: HEAD_MARGINS, right: right[i], keepNext: keep, run: { bold: true, color: WHITE, size: 15, characterSpacing: 20 } }))
      }),
      ...filled.map((r, ri) => new TableRow({
        cantSplit: true,
        children: r.map((text, i) => cell(text, widths[i], { borders: BODY_BORDERS, fill: ri % 2 ? PALE_MINT : WHITE, margins: BODY_MARGINS, right: right[i], keepNext: keep, run: { size: 18, ...cellStyle?.(ri, i) } }))
      })),
      ...(totalRow
        ? [new TableRow({
            cantSplit: true,
            children: totalRow.map((text, i) => cell(text, widths[i], { borders: NO_BORDERS, fill: GREEN, margins: HEAD_MARGINS, right: right[i], keepNext: keep, run: { bold: true, color: WHITE, size: 19 } }))
          })]
        : [])
    ]
  })
}

// ---------- COVER ART ----------

// heightInches scales the art down (same aspect) on a crowded cover; default is the skill's 2.9" × 4.53".
export function coverArcs(heightInches?: number): Paragraph {
  const transformation = heightInches === undefined
    ? { width: 2.9 * 96, height: 4.53 * 96 }
    : { width: heightInches * (2.9 / 4.53) * 96, height: heightInches * 96 }
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before: 0, after: 0 },
    children: [new ImageRun({ type: "png", data: readFileSync(ARCS_PATH), transformation })]
  })
}

// ---------- COVER (its own zero-margin docx section) ----------

export type CoverOptions = {
  eyebrow: string                      // "Commercial Insurance Proposal"
  title: string                        // the client's name — charcoal 22pt
  titleAccent: string                  // "Your 2027–2028 insurance program." — green 18pt; keep to one line
  subtitle?: string                    // one sentence, 10pt; omitted on the Pre-Renewal Review
  preparedFor: {
    headline: [string, string]         // [charcoal, green]: ["Confidence in your coverage", "comes first."]
    facts: [string, string][]          // exactly three cards
    note?: string                      // small italic line under the cards
  }
  preparedBy: [string, string][]       // cards on the charcoal band, three per row; none omits the band
  preparedByEyebrow?: string           // the band's label — default "Prepared By"
  tagline?: string
}

// Rough line count of a fact-card value: ~30 characters of 10pt bold per line in a cover card.
function cardLines(value: string): number {
  return value.split("\n").reduce((total, para) => {
    let lines = 1, width = 0
    for(const word of para.split(/\s+/)) {
      if(width > 0 && width + 1 + word.length > 30) { lines++; width = word.length } else width += (width > 0 ? 1 : 0) + word.length
    }
    return total + lines
  }, 0)
}

// The hero's minimum height: the arcs' 4.53" plus room, less what the Prepared For block needs
// beyond its usual two-line cards and no note, so the cover stays one page with long names.
const HERO_HEIGHT = 7200
const CARD_LINE = 250
// Each charcoal-band card row past the first (the Pre-Renewal Review's one card per policy) takes
// ~750 twips. The hero gives that up first, down to the arc art's own height; then the contact
// band's bottom padding, down to its normal 420; then — a crowded cover — the hero tightens its
// logo spacing and scales the arc art down (to no less than 3.4").
const BAND_CARD_ROW = 750
const HERO_FLOOR = 6600
const CONTACT_BOTTOM = 1400
const ARCS_MIN_INCHES = 3.4

// Mint hero (logo, eyebrow, two-tone title, arc art), "Prepared For" cards, charcoal "Prepared By"
// band, mint contact band. Must fit one page (skill: trim hero padding first): the hero shrinks by
// the Prepared For block's extra lines, and the contact band's bottom padding carries the mint to
// the foot of the page.
//
// LibreOffice applies the largest top/bottom cell margin in a row to every cell in it, so the
// hero's left cell pads with paragraph spacing instead of the skill's cell margins (720 / 600) —
// otherwise the arc art, which should bleed off the top edge, drops ~0.5".
export function coverPage(o: CoverOptions): Block[] {
  const extraLines = Math.max(0, Math.max(...o.preparedFor.facts.map(([, v]) => cardLines(v))) - 2) + (o.preparedFor.note ? 1 : 0)
  const extraBandRows = Math.max(0, Math.ceil(o.preparedBy.length / 3) - 1)
  let heroHeight = HERO_HEIGHT - CARD_LINE * extraLines
  let contactBottom = CONTACT_BOTTOM
  let arcsInches: number | undefined
  let crowded = false
  if(extraBandRows > 0) {
    const wanted = heroHeight - BAND_CARD_ROW * extraBandRows
    heroHeight = Math.max(HERO_FLOOR, wanted)
    const short = heroHeight - wanted
    contactBottom = Math.max(420, CONTACT_BOTTOM - short)
    const stillShort = short - (CONTACT_BOTTOM - contactBottom)
    if(stillShort > 0) {
      crowded = true
      heroHeight = Math.max(4900, HERO_FLOOR - stillShort - 600)
      arcsInches = Math.max(ARCS_MIN_INCHES, heroHeight / 1440)
    }
  }
  const hero = new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: [7740, 4500],
    layout: TableLayoutType.FIXED,
    borders: TABLE_NO_BORDERS,
    rows: [new TableRow({
      cantSplit: true,
      height: { value: heroHeight, rule: HeightRule.ATLEAST },
      children: [
        new TableCell({
          width: { size: 7740, type: WidthType.DXA },
          borders: NO_BORDERS,
          shading: { fill: MINT, type: ShadingType.CLEAR },
          margins: { top: 0, bottom: 0, left: 900, right: 0 },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({ spacing: { before: crowded ? 240 : 480, after: crowded ? 360 : 700 }, children: [logoRun(2.3)] }),
            eyebrow(o.eyebrow),
            accentRule({ textWidth: 6840, after: 240 }),
            headline([[o.title, CHAR, 44], [o.titleAccent, GREEN, 36]], { breakBetween: true, after: o.subtitle ? 240 : 360 }),
            ...(o.subtitle ? [body(o.subtitle, { after: 360 })] : [])
          ]
        }),
        new TableCell({
          width: { size: 4500, type: WidthType.DXA },
          borders: NO_BORDERS,
          shading: { fill: MINT, type: ShadingType.CLEAR },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          verticalAlign: VerticalAlign.TOP,
          children: [coverArcs(arcsInches)]
        })
      ]
    })]
  })

  const preparedFor = band(WHITE, [
    eyebrow("Prepared For"),
    headline([[`${ o.preparedFor.headline[0] } `, CHAR], [o.preparedFor.headline[1], GREEN]], { size: 30, after: 280 }),
    factGrid(o.preparedFor.facts, { textWidth: COVER_TEXT_WIDTH }),
    ...(o.preparedFor.note ? [body(o.preparedFor.note, { italics: true, size: 17, before: 80, after: 0 })] : [])
  ], { offset: 0, top: 640, bottom: 760 })

  const preparedBy = o.preparedBy.length > 0
    ? [band(CHAR, [
        eyebrow(o.preparedByEyebrow ?? "Prepared By", { color: WHITE }),
        factGrid(o.preparedBy, { labelColor: ARC, valueColor: WHITE, textWidth: COVER_TEXT_WIDTH })
      ], { offset: 0, top: 440, bottom: 400 })]
    : []

  return [hero, preparedFor, ...preparedBy, contactBand({ offset: 0, top: 420, bottom: contactBottom, tagline: o.tagline })]
}

// "Prepared By" cards when no advisor is known: the agency itself.
export const AGENCY_PREPARED_BY: [string, string][] = [["Agency", "Boxwood Insurance Group"], ["Main Line", AGENCY.phone], ["Website", WEBSITE]]

export function advisorPreparedBy(advisor: { name: string; phone: string; email: string }): [string, string][] {
  return [
    ["Your Advisor", advisor.name],
    ["Direct", advisor.phone || AGENCY.phone],
    advisor.email ? ["Email", advisor.email] : ["Website", WEBSITE]
  ]
}

// ---------- CLOSING ----------
// The skill (Section 7) puts the mint contact band and disclaimer straight after the last content.
// Andrew (2026-11-21) wants them at the foot of the last page, as the pre-restyle closing page had
// them: the closing page is its own docx section and this is that section's page footer, so it sits
// at the bottom and can't split across pages. The usual footer line (page number) stays under it.

// sideMargin / textWidth for other page margins (the PL letter: 900 / 10440); disclaimer optional
// (the PL letter's notice is at the top). compact: smaller logo and padding.
export function closingFooter({ disclaimer, tagline, sideMargin = SIDE_MARGIN, textWidth = TEXT_WIDTH, compact = false }: { disclaimer?: string; tagline?: string; sideMargin?: number; textWidth?: number; compact?: boolean }): Footer {
  const pad = compact ? 280 : 420
  return new Footer({
    children: [
      compact
        ? contactBand({ offset: -sideMargin, top: pad, bottom: pad, tagline, logoWidth: 1.25 })
        : contactBand({ offset: -sideMargin, top: pad, bottom: pad, tagline }),
      disclaimer
        ? new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 160, after: 200 }, children: [run(disclaimer, { italics: true, size: 14, color: DISCLAIMER_GRAY })] })
        : new Paragraph({ spacing: { before: 0, after: 160 }, children: [] }),
      footerLine(textWidth)
    ]
  })
}
