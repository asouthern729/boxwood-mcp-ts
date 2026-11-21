import { Document, Packer, Paragraph, SectionType } from "docx"
import type { LabeledValue, PlScheduleClass, PlSection } from "./plCoverageData.js"
import {
  CHAR, FOOTER_STYLE, PAGE_HEIGHT, PAGE_WIDTH, accentRule, body, closingFooter, eyebrow, factGrid, headline,
  interiorFooter, interiorHeader, run, sectionOpener, subHeader
} from "./proposalBrand.js"
import { blocksPiece, createLayout, lines, tablePiece, type Block, type BlockPiece, type Piece, type TablePiece } from "./docLayout.js"

// The "Personal Insurance Portfolio Summary" document for pl_renewal_summary. Unlike the CL documents
// (a cover page, then a page per section), this follows the client-supplied sample
// (Patrick_Baggett_Personal_Insurance_Summary, 2026-09-28): a compact, letter-style summary — title,
// notice, then short sections flowing on without page breaks. Section order and content are the
// sample's.
//
// Styled in Boxwood's house style (proposalBrand.ts, Patrick 2026-11-21): Arial, the palette, the
// logo + client-name page header and page-number footer, an eyebrow / accent-rule / headline title
// block in place of the sample's letterhead, compact section openers, fact cards for the
// label: value lines, charcoal-header data tables, and the mint contact band at the foot of the last
// page (the last coverage section's page footer — see buildPlRenewalSummaryDoc). Side margins stay
// the sample's 0.625"; top/bottom grow to hold the page header and footer.

const MARGIN_X = 900
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X // 10440 DXA
const MARGINS = { top: 1300, right: MARGIN_X, bottom: 900, left: MARGIN_X, header: 400, footer: 400 }
const AGENCY_PHONE = "615-245-5851"

const NOTICE = "This summary provides a high-level overview of your current personal insurance coverage. This is intended for informational purposes only and does not replace or supersede your official policy documents. Coverage details, exclusions, and conditions are governed solely by the terms outlined in your policies. Please refer to those documents for complete information."

type Fact = [string, string]

const pad = (n: number) => String(n).padStart(2, "0")

// The letter is built as height-estimated pieces (docLayout.ts) so the closing page can be cut to
// exactly one page — see buildPlRenewalSummaryDoc.
const layout = createLayout(TEXT_WIDTH)
const blocks = blocksPiece

const CARD_WIDTH = Math.floor((PAGE_WIDTH - 2 * 900 - 2 * 280) / 3)

function cardsHeight(facts: Fact[]): number {
  let height = 0
  for(let r = 0; r < facts.length; r += 3) {
    height += 460 + 230 * Math.max(...facts.slice(r, r + 3).map(([, v]) => lines(v, CARD_WIDTH, 110)))
  }
  return height
}

// A section's cards always stay on the page with what follows them (its first table), so a
// section never splits between its cards and its coverage.
function cards(facts: Fact[]): Piece[] {
  return facts.length > 0 ? [blocks(cardsHeight(facts), () => [factGrid(facts, { textWidth: TEXT_WIDTH, keepWithNext: true })], { keepWithNext: true })] : []
}

const SUBHEADER_HEIGHT = 580

function sub(text: string): BlockPiece {
  return blocks(SUBHEADER_HEIGHT, () => [subHeader(text)], { keepWithNext: true })
}

function note(text: string, opts: { italics?: boolean; size?: number; before?: number } = {}): BlockPiece {
  return blocks((opts.before ?? 0) + 140 + 230 * lines(text, TEXT_WIDTH, 95), () => [body(text, opts)])
}

// Column widths as fractions of the text width; blank cells stay blank (a coverage a vehicle
// doesn't carry), as in the sample.
function table(headers: string[], rows: string[][], fractions: number[]): TablePiece {
  return tablePiece(headers, rows, { fractions, keepBlank: true })
}

// ---------- SECTIONS ----------

function labeledValueTable(headers: [string, string], rows: LabeledValue[], split: [number, number]): TablePiece {
  return table(headers, rows.map((r) => [r.label, r.value]), split)
}

// Coverages that differ between vehicles go in their own table below the vehicle list: one row per
// coverage, one column per vehicle (Andrew, 2026-09-29 — it grows downward, not sideways). Past
// MAX_MATRIX_VEHICLES the vehicle columns get too narrow to read, so larger fleets are split across
// several tables of up to that many vehicles each.
const MAX_MATRIX_VEHICLES = 4

function coverageByVehicleTables(section: Extract<PlSection, { kind: "auto" }>): Piece[] {
  const pieces: Piece[] = []

  for(let start = 0; start < section.vehicles.length; start += MAX_MATRIX_VEHICLES) {
    const chunk = section.vehicles.slice(start, start + MAX_MATRIX_VEHICLES)
    if(start > 0) pieces.push(blocks(350, () => [new Paragraph({ spacing: { after: 120 }, children: [] })]))
    pieces.push(table(
      ["Coverage", ...chunk.map((v) => [v.year, v.makeModel].filter(Boolean).join(" "))],
      section.vehicleColumns.map((c) => [c.label, ...chunk.map((v) => v.values[c.key] ?? "")]),
      [0.28, ...Array(chunk.length).fill(0.72 / chunk.length)]
    ))
  }

  return pieces
}

// The policy's carrier, number and term — shown only when the reader needs them to tell policies
// apart: several carriers, or the same line of business on two policies.
function sourceFacts(section: PlSection): Fact[] {
  const { polno, carrier, term } = section.source
  return [...(carrier ? [["Carrier", carrier] as Fact] : []), ["Policy #", polno], ["Term", term]]
}

// The full scheduled property list, one table per class (Patrick, 2026-09-29).
function schedulePieces(schedule: PlScheduleClass[]): Piece[] {
  const pieces: Piece[] = [sub("Scheduled Items")]
  for(const cls of schedule) {
    const heading = [cls.className, cls.classLimit && `Scheduled Limit ${ cls.classLimit }`].filter(Boolean).join(" — ")
    pieces.push(blocks(420, () => [new Paragraph({ keepNext: true, spacing: { before: 120, after: 80 }, children: [run(heading, { bold: true, size: 19 })] })], { keepWithNext: true }))
    pieces.push(table(["Item #", "Description", "Value"], cls.items.map((i) => [i.number, i.description, i.value]), [0.1, 0.7, 0.2]))
    if(cls.moreCount > 0) {
      pieces.push(note(`…and ${ cls.moreCount } more ${ cls.className.toLowerCase() } item${ cls.moreCount === 1 ? "" : "s" }. The complete schedule is in your policy documents.`, { italics: true, size: 18, before: 80 }))
    }
  }
  return pieces
}

const OPENER_HEIGHT = 900
const SECTION_GAP = 400

function sectionPieces(section: PlSection, index: number, total: number, showSource: boolean): Piece[] {
  // The first section follows the title block and a section that starts the closing page sits at
  // the top of it; any other is spaced from the section above.
  const pieces: Piece[] = [blocks(OPENER_HEIGHT + (index === 0 ? 0 : SECTION_GAP), (startsPage) => sectionOpener({
    eyebrowText: `Coverage ${ pad(index + 1) } of ${ pad(total) }`,
    title: section.title,
    compact: true,
    before: index === 0 || startsPage ? 0 : SECTION_GAP,
    textWidth: TEXT_WIDTH
  }), { keepWithNext: true })]
  const source = showSource ? sourceFacts(section) : []

  switch(section.kind) {
    case "auto": {
      pieces.push(...cards([...source, ...section.highlights.map((h): Fact => [h.label, h.value])]))
      if(section.vehicles.length > 0) {
        pieces.push(sub("Scheduled Vehicles"))
        pieces.push(table(["Year", "Make & Model", "VIN"], section.vehicles.map((v) => [v.year, v.makeModel, v.vin]), [0.12, 0.48, 0.40]))
      }
      if(section.vehicleColumns.length > 0 && section.vehicles.length > 0) {
        pieces.push(sub("Coverage by Vehicle"))
        pieces.push(...coverageByVehicleTables(section))
      }
      break
    }
    case "property":
      pieces.push(...cards([...source, ...(section.address ? [["Property Address", section.address] as Fact] : [])]))
      pieces.push(labeledValueTable(["Coverage Category", "Amount"], section.rows, [0.55, 0.45]))
      if(section.schedule?.length) pieces.push(...schedulePieces(section.schedule))
      break
    case "personalArticles":
      pieces.push(...cards([...source, ["Total Scheduled Limit", section.totalScheduledLimit]]))
      if(section.schedule?.length) pieces.push(...schedulePieces(section.schedule))
      else pieces.push(note("A detailed item schedule is included in the attached policy document."))
      break
    case "umbrella":
      pieces.push(...cards(source))
      pieces.push(labeledValueTable(["Coverage Type", "Limit"], section.rows, [0.65, 0.35]))
      break
    case "other": {
      pieces.push(...cards(source))
      const showDeductible = section.rows.some((r) => r.deductible)
      pieces.push(showDeductible
        ? table(["Coverage", "Limit", "Deductible"], section.rows.map((r) => [r.coverage, r.limit, r.deductible]), [0.5, 0.25, 0.25])
        : table(["Coverage", "Limit"], section.rows.map((r) => [r.coverage, r.limit]), [0.65, 0.35]))
      break
    }
    case "noDetail":
      pieces.push(...cards(source))
      pieces.push(note("Coverage details for this policy are not available in this summary. Please refer to your policy documents.", { italics: true }))
      break
  }

  return pieces
}

// ---------- THE CLOSING PAGE ----------
// The mint band is the closing docx section's page footer, and a footer prints on every page of its
// section — so the closing section must never run past one page (Andrew, 2026-11-21: the band on
// the last page only). The usable height of a page that carries the band, with a safety margin: an
// overestimate only costs white space above the closing page; an underestimate would put the band
// on two pages.
const CLOSING_PAGE_HEIGHT = Math.floor(0.85 * (PAGE_HEIGHT - MARGINS.top - 2650))

// Replaces the sample's letterhead: the logo is in the page header, the agency's address and website
// in the closing band, "Trusted Insurance Advisors" is the band's tagline, and the phone + producer
// email become the "Your Contact" card.
function titleBlock(input: PlRenewalSummaryInput, singleCarrier: string | null): Block[] {
  const contact = [AGENCY_PHONE, input.producerEmail].filter(Boolean).join("\n")
  return [
    eyebrow("Personal Insurance Portfolio Summary"),
    accentRule({ textWidth: TEXT_WIDTH, after: 160 }),
    headline([[input.clientName, CHAR]], { size: 30, after: 200 }),
    factGrid([
      ["Insured", input.clientName],
      ...(singleCarrier ? [["Carrier", singleCarrier] as Fact] : []),
      ["Your Contact", contact]
    ], { textWidth: TEXT_WIDTH }),
    new Paragraph({
      spacing: { before: 80, after: 240 },
      children: [run("Important Notice: ", { bold: true, size: 17 }), run(NOTICE, { size: 17 })]
    })
  ]
}

export type PlRenewalSummaryInput = {
  clientName: string
  // One carrier across every included policy goes in the header, as in the sample. With several,
  // the header line is dropped and each section names its own carrier instead.
  carriers: string[]
  producerEmail: string | null
  sections: PlSection[]
}

// Title block: eyebrow, rule, headline, one row of cards (two lines with an email) and the notice.
const TITLE_HEIGHT = 3100

export async function buildPlRenewalSummaryDoc(input: PlRenewalSummaryInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const singleCarrier = input.carriers.length === 1 ? input.carriers[0] : null
  const titleCounts = new Map<string, number>()
  for(const s of input.sections) titleCounts.set(s.title, (titleCounts.get(s.title) ?? 0) + 1)

  const sections = input.sections.map((s, i) => sectionPieces(s, i, input.sections.length, !singleCarrier || (titleCounts.get(s.title) ?? 0) > 1))
  const title = blocks(TITLE_HEIGHT, () => titleBlock(input, singleCarrier))

  // The closing page — at the foot of which the mint band sits (Andrew, 2026-11-21, as on the CL
  // closing page) — starts with the last coverage section. With one section the whole letter is the
  // candidate, so a short one stays a single page. Whatever doesn't fit flows before it.
  const candidate = sections.length > 1 ? sections[sections.length - 1] : [title, ...(sections[0] ?? [])]
  const leading = sections.length > 1 ? layout.render([title, ...sections.slice(0, -1).flat()], false) : []
  const { before, closing } = layout.splitForClosing(candidate, CLOSING_PAGE_HEIGHT)
  const flow = [...leading, ...before]

  const page = { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: MARGINS }
  const header = { default: interiorHeader(input.clientName, { textWidth: TEXT_WIDTH }) }
  const closingSection = {
    properties: { ...(flow.length > 0 ? { type: SectionType.NEXT_PAGE } : {}), page },
    headers: header,
    footers: { default: closingFooter({ tagline: "Trusted Insurance Advisors", sideMargin: MARGIN_X, textWidth: TEXT_WIDTH, compact: true }) },
    children: closing
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20, color: CHAR } } }, paragraphStyles: [FOOTER_STYLE] },
    sections: [
      ...(flow.length > 0 ? [{ properties: { page }, headers: header, footers: { default: interiorFooter({ textWidth: TEXT_WIDTH }) }, children: flow }] : []),
      closingSection
    ]
  })

  const rawBuffer = await Packer.toBuffer(doc)
  const includedSections = [...new Set(input.sections.map((s) => s.title))]

  return { buffer: Buffer.from(rawBuffer as unknown as Uint8Array), includedSections }
}
