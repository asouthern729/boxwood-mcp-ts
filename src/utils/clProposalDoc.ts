import { readFileSync } from "node:fs"
import { AlignmentType, BorderStyle, Document, Footer, ImageRun, LevelFormat, Packer, Paragraph, SectionType } from "docx"
import {
  AGENCY, GREEN, HEADER_FILL, MARGIN, MUTED, FAINT, PAGE_WIDTH, PROPOSAL_LOGO_PATH, TEXT,
  banner, centered, dataTable, divider, pageBreak, run, subHeader, type Block, type DocComment
} from "./proposalStyle.js"
import type { LocationRow } from "./riskProfileDoc.js"

// The CL Renewal Summary document, in the layout of Patrick's insurance-proposal skill (org-shared
// Claude skill, SKILL.md "Global brand spec") — the format he asked cl_renewal_summary to produce
// (email "FW: TN Equine", 2026-10-07, with TEH_Land_Tennessee_Equine_Hospital_Proposal.docx as the
// example), minus the Premium Summary page: "we will use the renewal premium tool for that". The
// skill's palette, banners and data tables live in proposalStyle.ts, shared with the Pre-Renewal
// Review (riskProfileDoc.ts).
//
// This file only renders. What goes in each section — AMS360 data, uploaded quotes, the template
// narratives — is assembled in clProposalLines.ts / clQuoteMerge.ts / clProposalText.ts.

const BULLETS = "proposal-bullets"

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

export type ServiceTeamMember = { role: string; name: string; phone: string; email: string }

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

function lineSection(line: ProposalLine, comments: DocComment[]): Block[] {
  return [
    pageBreak(),
    ...banner(line.title, { withLogo: true, comment: register(comments, line.comment) }),
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
