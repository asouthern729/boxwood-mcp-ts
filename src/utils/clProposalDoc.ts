import { BorderStyle, Document, LineRuleType, Packer, Paragraph, SectionType, Table, TableCell, TableLayoutType, TableRow, WidthType } from "docx"
import type { Block, DocComment } from "./proposalStyle.js"
import {
  AGENCY_PREPARED_BY, BULLET_NUMBERING, CHAR, COVER_MARGINS, FOOTER_STYLE, GREEN, INTERIOR_MARGINS, NO_BORDERS, ON_CHAR, PAGE_HEIGHT, PAGE_WIDTH,
  TABLE_NO_BORDERS, TEXT_WIDTH, WHITE, advisorPreparedBy, band, body, bullet, closingFooter, coverPage as brandCover, dataTable,
  eyebrow, factGrid, footnote, interiorFooter, interiorHeader, run, sectionOpener, subHeader
} from "./proposalBrand.js"
import type { LocationRow } from "./riskProfileDoc.js"

// The CL Renewal Summary and Proposal Builder document, in the layout of Patrick's insurance-proposal
// skill — the format he asked cl_renewal_summary to produce (email "FW: TN Equine", 2026-10-07, with
// TEH_Land_Tennessee_Equine_Hospital_Proposal.docx as the example), minus the Premium Summary page:
// "we will use the renewal premium tool for that". The Proposal Builder passes premiumSummary and
// gets that page back (Patrick, 2026-10-18).
//
// Styled to Patrick's "insurance-proposal-copy-reformatting" revision of the skill (2026-11-21):
// the High Net Worth one-pager look — palette, section openers, fact cards, bands and data tables
// in proposalBrand.ts. Only the look changed; sections, tables and columns are as before, except
// that the Proposal Builder's Why Boxwood moved to page 2 (Andrew, 2026-11-21).
//
// Two docx sections: the cover (zero margins so its bands bleed, no header/footer) and the
// interior (page header with logo + client name, page-number footer).
//
// This file only renders. What goes in each section — AMS360 data, uploaded quotes, the template
// narratives — is assembled in clProposalLines.ts / clQuoteMerge.ts / clProposalText.ts.

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

export type WhyBoxwoodPoint = { lead: string; text: string }

export type ServiceTeamMember = { role: string; name: string; phone: string; email: string }

// Skill Section 4. Rows are [line of business, carrier, annual premium]; notes print under the table.
export type ProposalPremiumSummary = { rows: [string, string, string][]; total: string; notes: string[]; comment?: string }

export type ClProposalInput = {
  clientName: string
  clientAddress: string
  policyPeriod: string
  // When the document's lines don't share one policy period (skill: "see individual coverage
  // sections for details").
  policyPeriodsDiffer: boolean
  // Every line shows the expiring term: the cover's period is labelled "Current Policy Period".
  allTermsCurrent: boolean
  // e.g. "Cincinnati quote prepared 08/20/2026 – valid for 60 days" — only from an uploaded quote.
  quoteNote?: string
  preparedBy: { name: string; email: string; phone: string } | null
  proposalDate: string
  // null leaves the Executive Summary page out (the Proposal Builder, Patrick 2026-10-18: straight from
  // the cover into the coverages); named insureds and locations then print only when there's more
  // than one of either.
  executiveSummary: string[] | null
  namedInsureds: string[]
  locations: LocationRow[]
  lines: ProposalLine[]
  bindConditions: { items: string[]; comment?: string }
  premiumSummary?: ProposalPremiumSummary
  specialtyAddOns: ProposalSpecialtyAddOn[]
  // Proposal Builder only, on page 2 straight after the cover (Andrew, 2026-11-21): each paragraph
  // with its 1–3 word lead-in. The Renewal Summary omits it (Patrick, 2026-11-18).
  whyBoxwood?: WhyBoxwoodPoint[]
  serviceTeam: ServiceTeamMember[]
}


// ---------- BUILDING BLOCKS ----------

function register(comments: DocComment[], text: string | undefined): DocComment | undefined {
  if(!text) return undefined
  const comment = { id: comments.length, text }
  comments.push(comment)
  return comment
}

function tableBlocks(table: ProposalTable): Block[] {
  if(table.rows.length === 0) return []
  return [
    subHeader(table.title),
    dataTable(table.headers, table.rows, { fractions: table.fractions }),
    ...(table.footnote ? [footnote(table.footnote)] : [])
  ]
}

function bulletGroupBlocks(group: ProposalBulletGroup): Block[] {
  if(group.items.length === 0) return []
  return [subHeader(group.title), ...group.items.map(bullet)]
}

const pad = (n: number) => String(n).padStart(2, "0")

// "Your 2026–2027 insurance program." from the cover's period; just "Your insurance program." when
// it names no year (e.g. "See individual coverage sections").
function programYears(policyPeriod: string): string {
  const years = [...new Set(policyPeriod.match(/\b(19|20)\d{2}\b/g) ?? [])]
  return years.length === 0 ? "" : `${ years[0] }${ years.length > 1 ? `–${ years[years.length - 1] }` : "" } `
}

// ---------- COVER ----------

function coverPage(input: ClProposalInput): Block[] {
  // Address arrives as "street | city, state zip" — one line each on the card.
  const period = input.policyPeriod + (input.policyPeriodsDiffer ? " (see individual coverage sections for details)" : "")
  return brandCover({
    eyebrow: "Commercial Insurance Proposal",
    title: input.clientName,
    titleAccent: `Your ${ programYears(input.policyPeriod) }insurance program.`,
    subtitle: "A disciplined, advisor-led approach to protecting your business, your people, and everything you have built.",
    preparedFor: {
      headline: ["Confidence in your coverage", "comes first."],
      facts: [
        ["Named Insured", input.clientName],
        [input.allTermsCurrent ? "Current Policy Period" : "Policy Period", period],
        ["Client Address", input.clientAddress.split(" | ").join("\n") || "—"]
      ],
      // Not in the skill's cover, but required: the uploaded quote's carrier, number and expiry
      // (clQuoteMerge.quoteNote), and the Proposal Builder drops quote-validity bullets from Bind
      // Conditions when this is present — so this line is the only place it prints (Andrew, 2026-11-21: keep it).
      note: input.quoteNote
    },
    preparedBy: input.preparedBy ? advisorPreparedBy(input.preparedBy) : AGENCY_PREPARED_BY
  })
}

// ---------- INTERIOR SECTIONS ----------
// Each builder takes breakBefore: true for every section but the first one in the interior docx
// section (which already starts a new page).

// Proposal Builder, page 2: section opener + charcoal "How we serve you" band, the paragraphs side
// by side under their lead-ins (2900|330|2900|330|2900 for three, 4515|330|4515 for two).
function whyBoxwoodSection(points: WhyBoxwoodPoint[], breakBefore: boolean): Block[] {
  const gap = 330
  const cw = Math.floor((TEXT_WIDTH - gap * (points.length - 1)) / points.length)
  const widths = points.flatMap((_, i) => (i === 0 ? [cw] : [gap, cw]))
  widths[widths.length - 1] += TEXT_WIDTH - widths.reduce((a, b) => a + b, 0)

  const cells = points.flatMap((p, i) => [
    ...(i > 0 ? [new TableCell({ width: { size: gap, type: WidthType.DXA }, borders: NO_BORDERS, children: [new Paragraph("")] })] : []),
    new TableCell({
      width: { size: widths[i * 2], type: WidthType.DXA },
      borders: { ...NO_BORDERS, top: { style: BorderStyle.SINGLE, size: 24, color: GREEN } },
      margins: { top: 200, bottom: 0, left: 0, right: 0 },
      children: [
        new Paragraph({ spacing: { after: 120, line: 252, lineRule: LineRuleType.AUTO }, children: [run(p.lead, { bold: true, size: 26, color: WHITE })] }),
        new Paragraph({ spacing: { after: 0, line: 276, lineRule: LineRuleType.AUTO }, children: [run(p.text, { size: 17, color: ON_CHAR })] })
      ]
    })
  ])

  return [
    ...sectionOpener({ eyebrowText: "Why Boxwood", title: "Commercial risk management,", accent: "professionally done.", pageBreak: breakBefore }),
    band(CHAR, [
      eyebrow("How we serve you", { color: WHITE, after: 260 }),
      new Table({ width: { size: TEXT_WIDTH, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, borders: TABLE_NO_BORDERS, rows: [new TableRow({ cantSplit: true, children: cells })] })
    ])
  ]
}

function insuredTables(namedInsureds: string[], locations: LocationRow[]): Block[] {
  return [
    ...tableBlocks({ title: "Named Insureds", headers: ["Named Insured"], rows: namedInsureds.map((n) => [n]) }),
    ...tableBlocks({
      title: "Location Schedule",
      headers: ["Loc.", "Address", "City", "State", "Zip"],
      rows: locations.map((l) => [l.locNo, l.address, l.city, l.state, l.zip]),
      fractions: [0.08, 0.44, 0.24, 0.1, 0.14]
    })
  ]
}

// The Renewal Summary's Executive Summary, or — without one (Proposal Builder) — a Named Insureds &
// Locations page when there's more than one of either. Empty when neither prints.
function executiveSummary(input: ClProposalInput, breakBefore: boolean): Block[] {
  if(input.executiveSummary) {
    return [
      ...sectionOpener({ eyebrowText: "Executive Summary", title: "Your program,", accent: "at a glance.", pageBreak: breakBefore }),
      ...input.executiveSummary.map((p) => body(p)),
      ...insuredTables(input.namedInsureds, input.locations)
    ]
  }
  const namedInsureds = input.namedInsureds.length > 1 ? input.namedInsureds : []
  const locations = input.locations.length > 1 ? input.locations : []
  if(namedInsureds.length === 0 && locations.length === 0) return []
  return [
    ...sectionOpener({ eyebrowText: "Insured Schedule", title: "Named Insureds & Locations", pageBreak: breakBefore }),
    ...insuredTables(namedInsureds, locations)
  ]
}

function lineSection(line: ProposalLine, index: number, total: number, comments: DocComment[], breakBefore: boolean): Block[] {
  return [
    ...sectionOpener({ eyebrowText: `Coverage ${ pad(index + 1) } of ${ pad(total) }`, title: line.title, pageBreak: breakBefore, comment: register(comments, line.comment) }),
    ...(line.overview ? [body(line.overview, { italics: true })] : []),
    ...(line.keyFacts.length > 0 ? [factGrid(line.keyFacts)] : []),
    ...line.tables.flatMap(tableBlocks),
    ...line.bulletGroups.flatMap(bulletGroupBlocks)
  ]
}

// Skill Section 4 puts "Bind Conditions & Notes" under the Premium Summary, on a page of its own.
// The CL Renewal Summary dropped the premium table (Patrick, 2026-10-07) and now prints it only once
// its linked Renewal Premium Spreadsheet has every renewal premium (Andrew, 2026-11-21 —
// renewalSummaryPremiums.ts); without it, its notes keep that page by themselves.
function bindConditions(input: ClProposalInput, comments: DocComment[], breakBefore: boolean): Block[] {
  const premium = input.premiumSummary
  if(input.bindConditions.items.length === 0 && !premium) return []
  const items = input.bindConditions.items.map(bullet)
  if(!premium) {
    return [
      ...sectionOpener({ eyebrowText: "Program Notes", title: "Bind Conditions & Notes", pageBreak: breakBefore, comment: register(comments, input.bindConditions.comment) }),
      ...items
    ]
  }

  // One page: the premium table, then the notes under a sub-heading; one comment covers both.
  const comment = [premium.comment, input.bindConditions.comment].filter(Boolean).join(" ")
  return [
    ...sectionOpener({ eyebrowText: "Premium Summary", title: "Your investment,", accent: "summarized.", pageBreak: breakBefore, comment: register(comments, comment || undefined) }),
    dataTable(["Line of Business", "Carrier", "Annual Premium"], premium.rows, { fractions: [0.36, 0.44, 0.2], totalRow: ["TOTAL PROGRAM PREMIUM", "", premium.total], keepBlank: true }),
    ...premium.notes.map(footnote),
    ...(items.length > 0 ? [subHeader("Bind Conditions & Notes"), ...items] : [])
  ]
}

function specialtyAddOn(addOn: ProposalSpecialtyAddOn, comments: DocComment[], breakBefore: boolean): Block[] {
  return [
    ...sectionOpener({ eyebrowText: "Specialty Coverage", title: addOn.title, pageBreak: breakBefore, comment: register(comments, addOn.comment) }),
    ...(addOn.paragraph ? [body(addOn.paragraph)] : []),
    ...tableBlocks({ title: "Coverage Terms", headers: ["Field", "Value"], rows: addOn.terms, fractions: [0.4, 0.6] }),
    ...(addOn.schedule ? tableBlocks(addOn.schedule) : [])
  ]
}

// Patrick (2026-10-08): the closing page sits on a page by itself — the service team, with the mint
// contact band and the disclaimer (skill Section 7) as its page footer (closingFooter). Both callers
// end this way; the Proposal Builder's Why Boxwood is on page 2 instead.
const SERVICE_TEAM_HEADERS = ["Role", "Name", "Phone", "Email"]
const SERVICE_TEAM_FRACTIONS = [0.24, 0.26, 0.18, 0.32]

function closingPage(input: ClProposalInput): Block[] {
  const teamRows = input.serviceTeam.map((m) => [m.role, m.name, m.phone, m.email])
  return [
    ...sectionOpener({ eyebrowText: "Boxwood Insurance Group", title: "Your Service Team" }),
    ...(teamRows.length > 0 ? [dataTable(SERVICE_TEAM_HEADERS, teamRows, { fractions: SERVICE_TEAM_FRACTIONS })] : [])
  ]
}

// ---------- DOCUMENT ----------

export async function buildClProposalDoc(input: ClProposalInput): Promise<{ buffer: Buffer; includedSections: string[] }> {
  const comments: DocComment[] = []
  const why = input.whyBoxwood && input.whyBoxwood.length > 0 ? input.whyBoxwood : null

  // Interior pages in order; every one but the first opens with a page break.
  const interior: Block[] = []
  const next = () => interior.length > 0
  const push = (blocks: Block[]) => interior.push(...blocks)

  if(why) push(whyBoxwoodSection(why, next()))
  push(executiveSummary(input, next()))
  input.lines.forEach((line, i) => push(lineSection(line, i, input.lines.length, comments, next())))
  const bindBlocks = bindConditions(input, comments, next())
  push(bindBlocks)
  // Add-ons flow on from whatever precedes them (skill: no forced break), except Bind Conditions keeps its page alone.
  input.specialtyAddOns.forEach((addOn, i) => push(specialtyAddOn(addOn, comments, i === 0 && bindBlocks.length > 0)))

  const interiorPage = { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: INTERIOR_MARGINS }

  const doc = new Document({
    comments: {
      children: comments.map((c) => ({ id: c.id, author: "Claude", initials: "CL", date: new Date(), children: [new Paragraph(c.text)] }))
    },
    styles: { default: { document: { run: { font: "Arial", size: 20, color: CHAR } } }, paragraphStyles: [FOOTER_STYLE] },
    numbering: { config: [BULLET_NUMBERING] },
    sections: [{
      properties: { page: { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT }, margin: COVER_MARGINS } },
      children: coverPage(input)
    }, ...(interior.length > 0
      ? [{
          properties: { type: SectionType.NEXT_PAGE, page: interiorPage },
          headers: { default: interiorHeader(input.clientName) },
          footers: { default: interiorFooter() },
          children: interior
        }]
      : []), {
      // Its own section so its footer can carry the closing band (see closingPage).
      properties: { type: SectionType.NEXT_PAGE, page: interiorPage },
      headers: { default: interiorHeader(input.clientName) },
      footers: { default: closingFooter({ disclaimer: DISCLAIMER }) },
      children: closingPage(input)
    }]
  })

  const includedSections = [
    ...(why ? ["Why Boxwood Insurance Group"] : []),
    ...(input.executiveSummary ? ["Executive Summary"] : []),
    ...input.lines.map((l) => l.title),
    ...(input.premiumSummary ? ["Premium Summary"] : []),
    ...(input.bindConditions.items.length > 0 ? ["Bind Conditions & Notes"] : []),
    ...input.specialtyAddOns.map((a) => a.title),
    "Your Service Team"
  ]

  return { buffer: Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array), includedSections }
}
