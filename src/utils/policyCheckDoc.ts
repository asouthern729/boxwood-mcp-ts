import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AlignmentType, BorderStyle, Document, Footer, ImageRun, Packer, PageBreak, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType
} from "docx"
import type { CheckDocument, CheckRowFindings, PolicyCheckFindings } from "./policyCheckAnalysis.js"
import type { NumberedItem, Priority, ProcessedCheck } from "./policyCheckRun.js"

// The Policy Check report, laid out per section 4 of Patrick's policy-check skill: letter portrait,
// 0.5" margins, Arial 9pt body / 8.5pt tables, brand green headers, a page-one "Check These First"
// summary, whole rows filled by priority (red Correction, amber Confirm, blue-grey Housekeeping).

const GREEN = "459361"
const TEXT = "231F20"
const GREY = "777777"
const WHITE = "FFFFFF"
const BORDER = "BFBFBF"
const MINT = "E3F0E7"
const MATCH_TEXT = "2E6B43"

const PRIORITY_STYLE: Record<Priority, { fill: string; text: string; label: string }> = {
  1: { fill: "F8D7D3", text: "9B1C1C", label: "Correction" },
  2: { fill: "FCEBC7", text: "8A5300", label: "Confirm" },
  3: { fill: "DCE6F0", text: "1F4E79", label: "Housekeeping" }
}

const PAGE_WIDTH = 12240
const MARGIN = 720
const WIDTH = PAGE_WIDTH - 2 * MARGIN // 10800 twips
const BODY = 18 // 9pt
const TABLE = 17 // 8.5pt

// Page one must not spill (skill section 4). Its height is budgeted in 8.5pt text lines: rows are
// estimated from how many lines their longest cell wraps to at its column width. Priority 1 items
// always stay on page one; the rest continue at the top of page two.
const PAGE_ONE_LINES = 60
const ITEM_FRACTIONS = [0.35, 1.45, 1.15, 1.8, 1.75, 1.75, 2.05]
// Average Arial character width at 8.5pt, in twips, plus cell padding.
const CHAR_TWIPS = 95
const CELL_PADDING_TWIPS = 160

function wrappedLines(text: string, widthTwips: number): number {
  const perLine = Math.max(1, Math.floor((widthTwips - CELL_PADDING_TWIPS) / CHAR_TWIPS))
  return (text || "—").split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0)
}

function itemRowLines(item: NumberedItem, widths: number[]): number {
  const cells = [String(item.number), PRIORITY_STYLE[item.pri].label, item.line, item.item, item.baseline, item.compared, item.action]
  return Math.max(...cells.map((c, i) => wrappedLines(c, widths[i]))) + 0.5
}

function headerLines(processed: ProcessedCheck, o: BuildOptions): number {
  const valueWidth = widthsFrom([1.3, 6])[1]
  const f = processed.findings
  const values = [
    o.clientName, "mode",
    f.policies_checked.map((p) => `${ p.line } · ${ p.carrier } · ${ p.policy_number } · ${ p.term }`).join("\n"),
    o.documents.map((d) => `${ d.label }: ${ d.filename }`).join("\n") + (o.amsPulledAt ? "\nReference: AMS360 via Boxwood MCP — customer, terms, transactions and activity notes" : ""),
    f.not_reviewed.join("; ") || "None", "date", o.preparedFor
  ]
  // Logo + title, then each header row (+ padding), banner, scorecard, heading, table header, legend, overflow note.
  return 6 + values.reduce((total, v) => total + wrappedLines(v, valueWidth) + 0.4, 0) + 4 + 4 + 2 + 1.5 + 1 + 1.5
}

const LOGO_PATH = path.join(import.meta.dirname, "..", "..", "assets", "boxwood-logo.png")
const LOGO_RATIO = 1600 / 435

const MODE_LABEL: Record<PolicyCheckFindings["mode"], string> = {
  quote_to_issued: "Quote → Issued",
  expiring_to_renewal: "Expiring → Renewal",
  both: "Quote → Issued, with Expiring → Renewal changes"
}

type Block = Paragraph | Table

// ---------- Primitives ----------

function run(text: string, o: { bold?: boolean; size?: number; color?: string; italics?: boolean; font?: string } = {}): TextRun {
  return new TextRun({ text, font: o.font ?? "Arial", bold: o.bold, italics: o.italics, size: o.size ?? BODY, color: o.color ?? TEXT })
}

function para(children: TextRun[], o: { after?: number; before?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}): Paragraph {
  return new Paragraph({ children, spacing: { after: o.after ?? 60, before: o.before ?? 0 }, alignment: o.align })
}

function heading(text: string, before = 200): Paragraph {
  return para([run(text, { bold: true, size: 24, color: GREEN })], { before, after: 80 })
}

function subheading(text: string): Paragraph {
  return para([run(text, { bold: true, size: 19, color: GREEN })], { before: 140, after: 60 })
}

const border = { style: BorderStyle.SINGLE, size: 4, color: BORDER }
const borders = { top: border, bottom: border, left: border, right: border }

type CellOpts = { fill?: string; color?: string; bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] }

function cell(text: string, width: number, o: CellOpts = {}): TableCell {
  const lines = (text || "—").split("\n")
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
    borders,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: lines.map((line) => new Paragraph({ alignment: o.align, children: [run(line, { size: o.size ?? TABLE, bold: o.bold, color: o.color })] }))
  })
}

function widthsFrom(fractions: number[], total = WIDTH): number[] {
  const sum = fractions.reduce((a, b) => a + b, 0)
  const widths = fractions.map((f) => Math.floor((f / sum) * total))
  widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0)
  return widths
}

type RowSpec = { cells: string[]; fill?: string; color?: string; bold?: boolean; cellStyles?: (CellOpts | undefined)[] }

function table(headers: string[], rows: RowSpec[], fractions: number[], o: { align?: ("left" | "right")[] } = {}): Table {
  const widths = widthsFrom(fractions)
  const align = (i: number) => (o.align?.[i] === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT)
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h, i) => cell(h, widths[i], { fill: GREEN, color: WHITE, bold: true, align: align(i) })) }),
      ...rows.map((r) => new TableRow({
        cantSplit: true,
        children: r.cells.map((text, i) => cell(text, widths[i], { fill: r.fill, color: r.color, bold: r.bold, align: align(i), ...r.cellStyles?.[i] }))
      }))
    ]
  })
}

function oneCell(children: Paragraph[], fill: string, borderColor = fill): Table {
  const b = { style: BorderStyle.SINGLE, size: 6, color: borderColor }
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: [WIDTH],
    layout: TableLayoutType.FIXED,
    rows: [new TableRow({ children: [new TableCell({ width: { size: WIDTH, type: WidthType.DXA }, shading: { fill, type: ShadingType.CLEAR, color: "auto" }, borders: { top: b, bottom: b, left: b, right: b }, margins: { top: 100, bottom: 100, left: 140, right: 140 }, children })] })]
  })
}

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${ n < 0 ? "-" : "" }$${ Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`)
const signedMoney = (n: number | null) => (n === null ? "—" : n === 0 ? "—" : `${ n > 0 ? "+" : "-" }$${ Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`)
const pct = (n: number | null) => (n === null ? "—" : `${ n > 0 ? "+" : "" }${ n.toFixed(1) }%`)

function rowPriority(row: CheckRowFindings, numberByRef: Map<string, number>, items: NumberedItem[]): Priority | null {
  const n = numberByRef.get(row.ref)
  return n ? items[n - 1].pri : null
}

function statusCellStyle(status: string, pri: Priority | null): CellOpts | undefined {
  if(status === "MATCH") return { fill: MINT, color: MATCH_TEXT, bold: true }
  if(status === "N/A") return { color: GREY }
  if(pri) return { color: PRIORITY_STYLE[pri].text, bold: true }
  return undefined
}

// ---------- Page one ----------

function headerBlock(processed: ProcessedCheck, o: BuildOptions): Block[] {
  const f = processed.findings
  const documents = o.documents.map((d) => `${ d.label}: ${ d.filename }${ d.pages ? ` (${ d.pages } pp.)` : "" }`)
  if(o.amsPulledAt) documents.push(`Reference: AMS360 via Boxwood MCP — customer, terms, transactions and activity notes (pulled ${ usDate(o.amsPulledAt) })`)
  const rows: [string, string][] = [
    ["Client", o.clientName],
    ["Mode", MODE_LABEL[f.mode]],
    ["Policies checked", f.policies_checked.map((p) => `${ p.line } · ${ p.carrier } · ${ p.policy_number }${ p.term ? ` · ${ p.term }` : "" }`).join("\n") || "—"],
    ["Documents reviewed", documents.join("\n")],
    ["Not reviewed", f.not_reviewed.length > 0 ? f.not_reviewed.join("; ") : "None"],
    ["Review date", usDate(new Date().toISOString().slice(0, 10))],
    ["Prepared for", o.preparedFor]
  ]
  const widths = widthsFrom([1.3, 6])
  return [
    new Paragraph({ spacing: { after: 60 }, children: [new ImageRun({ type: "png", data: readFileSync(LOGO_PATH), transformation: { width: 0.45 * LOGO_RATIO * 96, height: 0.45 * 96 } })] }),
    para([run("Policy Check", { bold: true, size: 32, color: GREEN })], { after: 80 }),
    new Table({
      width: { size: WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      rows: rows.map(([label, value]) => new TableRow({ cantSplit: true, children: [cell(label, widths[0], { bold: true, fill: MINT }), cell(value, widths[1])] }))
    })
  ]
}

function resultBanner(processed: ProcessedCheck): Table {
  const fill = { red: PRIORITY_STYLE[1].fill, amber: PRIORITY_STYLE[2].fill, green: MINT }[processed.banner.level]
  const color = { red: PRIORITY_STYLE[1].text, amber: PRIORITY_STYLE[2].text, green: MATCH_TEXT }[processed.banner.level]
  return oneCell([para([run(processed.banner.text, { bold: true, size: 24, color })], { after: 0, align: AlignmentType.CENTER })], fill, color)
}

function scorecard(processed: ProcessedCheck): Table {
  const { counts, premium } = processed
  const change = premium.change
  const premiumFill = change === null || change === 0 ? "EEEEEE" : change > 0 ? PRIORITY_STYLE[1].fill : MINT
  const premiumColor = change === null || change === 0 ? GREY : change > 0 ? PRIORITY_STYLE[1].text : MATCH_TEXT
  const priorityBox = (label: string, value: number, p: Priority) => ({ label, value: String(value), fill: PRIORITY_STYLE[p].fill, color: PRIORITY_STYLE[p].text })
  const premiumValue = change === null ? "—" : change === 0 ? "$0" : `${ signedMoney(change) }${ premium.percent !== null ? ` (${ pct(premium.percent) })` : "" }`
  const boxes: { label: string; value: string; fill: string; color: string }[] = [
    priorityBox("Correction needed", counts.correction, 1),
    priorityBox("Confirm", counts.confirm, 2),
    priorityBox("Housekeeping", counts.housekeeping, 3),
    { label: "Premium change", value: premiumValue, fill: premiumFill, color: premiumColor },
    { label: "MATCH (checks)", value: String(counts.match), fill: MINT, color: MATCH_TEXT }
  ]
  const widths = widthsFrom([1, 1, 1, 1.4, 1])
  const white = { style: BorderStyle.SINGLE, size: 12, color: WHITE }
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [new TableRow({
      cantSplit: true,
      children: boxes.map((b, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: { fill: b.fill, type: ShadingType.CLEAR, color: "auto" },
        borders: { top: white, bottom: white, left: white, right: white },
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run(b.value, { bold: true, size: 26, color: b.color })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run(b.label, { size: 15, color: b.color })] })
        ]
      }))
    })]
  })
}

function itemsTable(items: NumberedItem[]): Table {
  return table(
    ["#", "Priority", "Line", "Item", "Should be (baseline)", "Issued shows", "Action"],
    items.map((i) => ({
      cells: [String(i.number), PRIORITY_STYLE[i.pri].label, i.line, i.item, i.baseline, i.compared, i.action],
      fill: PRIORITY_STYLE[i.pri].fill,
      cellStyles: [{ bold: true, color: PRIORITY_STYLE[i.pri].text }, { bold: true, color: PRIORITY_STYLE[i.pri].text }]
    })),
    ITEM_FRACTIONS
  )
}

function legend(): Paragraph {
  return para([
    run("Legend: ", { size: 15, bold: true, color: GREY }),
    run("■ ", { size: 15, color: PRIORITY_STYLE[1].text }), run("red = Correction needed   ", { size: 15, color: GREY }),
    run("■ ", { size: 15, color: PRIORITY_STYLE[2].text }), run("amber = Confirm   ", { size: 15, color: GREY }),
    run("■ ", { size: 15, color: PRIORITY_STYLE[3].text }), run("blue-grey = Housekeeping", { size: 15, color: GREY })
  ], { before: 40 })
}

// ---------- Later sections ----------

function premiumSchedule(processed: ProcessedCheck): Block[] {
  const { premium, numberByRef } = processed
  if(premium.change === null || Math.abs(premium.change) < 0.01) {
    return [heading("Premium Change Schedule"), para([run(`Premium: no change — ${ money(premium.baseline) } baseline and compared.`)])]
  }

  const lineRows: RowSpec[] = premium.lines.map((l) => {
    const change = l.baseline !== null && l.compared !== null ? l.compared - l.baseline : null
    const moved = change !== null && Math.abs(change) >= 0.01
    const percent = moved && l.baseline ? (change! / l.baseline) * 100 : null
    return {
      cells: [l.line, money(l.baseline), money(l.compared), moved ? signedMoney(change) : "—", moved ? pct(percent) : "—", l.driver || "—"],
      fill: moved ? PRIORITY_STYLE[l.explained_by_correction ? 1 : 2].fill : undefined
    }
  })
  lineRows.push({ cells: ["Total", money(premium.baseline), money(premium.compared), signedMoney(premium.change), pct(premium.percent), ""], fill: MINT, bold: true })

  const driverRows: RowSpec[] = premium.drivers.map((d) => ({
    cells: [d.kind, d.line, d.detail, signedMoney(d.impact), d.ref && numberByRef.get(d.ref) ? `#${ numberByRef.get(d.ref) }` : "—"],
    fill: d.kind === "Unexplained" ? PRIORITY_STYLE[2].fill : undefined
  }))
  const driverTotal = premium.drivers.reduce((t, d) => t + d.impact, 0)
  driverRows.push({ cells: ["Total change", "", "", signedMoney(Math.round(driverTotal * 100) / 100), ""], fill: MINT, bold: true })

  return [
    heading("Premium Change Schedule"),
    subheading("Premium by line"),
    table(["Line of coverage", "Baseline", "Compared", "$ Change", "% Change", "What drove it"], lineRows, [2, 1.1, 1.1, 1.1, 0.8, 2.9], { align: ["left", "right", "right", "right", "right", "left"] }),
    subheading("What drove the change"),
    table(["Driver", "Line", "Detail (baseline → compared)", "$ Impact", "Ref #"], driverRows, [1.8, 1.4, 4, 1.1, 0.6], { align: ["left", "left", "left", "right", "left"] })
  ]
}

function amsSection(processed: ProcessedCheck, amsPulledAt: string | null): Block[] {
  const rows = processed.findings.ams_cross_reference
  if(!amsPulledAt || rows.length === 0) return []
  return [
    heading("AMS360 Cross-Reference"),
    para([run(`Boxwood MCP, pulled ${ usDate(amsPulledAt) }`, { size: 16, color: GREY, italics: true })]),
    table(["Topic", "AMS360 shows", "Effect on this check"],
      rows.map((r) => ({ cells: [r.topic, r.ams_shows, `${ r.ref && processed.numberByRef.get(r.ref) ? `#${ processed.numberByRef.get(r.ref) } — ` : "" }${ r.effect }`] })),
      [1.6, 4.2, 3])
  ]
}

const SECTION_TITLES: Record<CheckRowFindings["section"], string> = {
  A: "A. Basic Information",
  B: "B. Coverage Limits, Deductibles & Exposures",
  C: "C. Endorsements, Exclusions & Special Provisions",
  D: "D. Loss & Financial Safeguards"
}

function detailSections(processed: ProcessedCheck): Block[] {
  const { findings, numberByRef, items } = processed
  const blocks: Block[] = [heading("Detail Checklist")]

  for(const section of ["A", "B", "C", "D"] as const) {
    const rows = findings.rows.filter((r) => r.section === section)
    const tables = findings.exposure_tables.filter((t) => t.section === section)
    if(rows.length === 0 && tables.length === 0) continue
    blocks.push(subheading(SECTION_TITLES[section]))

    // Section B groups by line, with each line's exposure tables after its rows.
    const lines = section === "B" ? [...new Set([...rows.map((r) => r.line), ...tables.map((t) => t.line)])] : [null]
    for(const line of lines) {
      const lineRows = line === null ? rows : rows.filter((r) => r.line === line)
      if(line !== null) blocks.push(para([run(line, { bold: true, size: 18 })], { before: 100, after: 40 }))
      if(lineRows.length > 0) {
        blocks.push(table(
          ["#", "Item", "Baseline", "Compared", "Status", "Note / Action", "Citation"],
          lineRows.map((r) => {
            const pri = rowPriority(r, numberByRef, items)
            const n = numberByRef.get(r.ref)
            return {
              cells: [n ? String(n) : "", line === null && r.line !== "Program" ? `${ r.item } (${ r.line })` : r.item, r.baseline, r.compared, r.status, r.action, r.citation],
              fill: pri ? PRIORITY_STYLE[pri].fill : undefined,
              color: r.status === "N/A" ? GREY : undefined,
              cellStyles: [undefined, undefined, undefined, undefined, statusCellStyle(r.status, pri)]
            }
          }),
          [0.35, 1.8, 1.8, 1.8, 0.8, 2, 1.25]
        ))
      }
      for(const t of tables.filter((x) => line === null || x.line === line)) {
        const headers = t.headers.split(" | ")
        blocks.push(para([run(t.title, { bold: true, size: 17, color: GREEN })], { before: 80, after: 40 }))
        blocks.push(table(headers, t.rows.map((r) => {
          const pri = r.priority === "none" ? null : (Number(r.priority) as Priority)
          const cells = r.cells.split(" | ")
          return { cells: headers.map((_, i) => cells[i] ?? ""), fill: pri ? PRIORITY_STYLE[pri].fill : undefined }
        }), headers.map(() => 1)))
      }
    }
  }
  return blocks
}

function formsSection(findings: PolicyCheckFindings): Block[] {
  if(findings.forms.length === 0) return []
  const order = { Added: 0, Removed: 1, Edition: 2, Same: 3 }
  const forms = [...findings.forms].sort((a, b) => order[a.change] - order[b.change])
  return [
    heading("Forms Comparison"),
    table(["Form #", "Edition (baseline)", "Edition (compared)", "Title", "Change", "Coverage effect"],
      forms.map((f) => ({
        cells: [f.form_number, f.baseline_edition ?? "—", f.compared_edition ?? "—", f.title, f.change, f.coverage_effect],
        fill: f.change === "Added" || f.change === "Removed" ? PRIORITY_STYLE[2].fill : undefined
      })),
      [1.2, 1, 1, 2.6, 0.8, 3.2])
  ]
}

function correctionRequest(processed: ProcessedCheck, clientName: string): Block[] {
  const corrections = processed.items.filter((i) => i.pri === 1)
  const policies = processed.findings.policies_checked.map((p) => `${ p.policy_number } (${ p.line })`).join(", ")
  if(corrections.length === 0) {
    const confirms = processed.items.filter((i) => i.pri === 2).map((i) => `#${ i.number }`)
    return [
      heading("Correction Request Draft"),
      para([run(`Not needed — no correction items.${ confirms.length > 0 ? ` Confirm ${ confirms.join(", ") } with the underwriter by email or phone.` : "" }`)])
    ]
  }
  const lines = [
    `Policy: ${ policies || "—" }`,
    `Insured: ${ clientName }`,
    "",
    "Please correct the following:",
    ...corrections.map((c, i) => `${ i + 1 }. ${ c.correction_text ?? `${ c.item }: currently shows ${ c.compared }; should be ${ c.baseline } (${ c.citation }).` }`)
  ]
  return [
    heading("Correction Request Draft"),
    para([run("Paste into an email to the carrier/underwriter.", { size: 16, color: GREY, italics: true })]),
    oneCell(lines.map((l) => para([run(l || " ", { font: "Consolas", size: 17 })], { after: 20 })), "F7F7F7", BORDER)
  ]
}

function signOff(): Block[] {
  return [
    heading("Sign-off"),
    table(["Reviewed by", "Date", "Endorsement request sent", "Carrier confirmation received", "Delivered to client"],
      [{ cells: ["\n\n", "", "", "", ""] }], [1.6, 1, 1.6, 1.8, 1.4]),
    para([run("Internal accuracy review prepared by Boxwood Insurance Group. Based solely on the documents listed above; confirm against the full policy and with the carrier. Not a coverage opinion.", { size: 16, color: GREY })], { before: 160 })
  ]
}

function footer(): Footer {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        run("Boxwood Insurance Group · Internal accuracy review · Page ", { size: 15, color: GREY }),
        new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 15, color: GREY }),
        run(" of ", { size: 15, color: GREY }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], font: "Arial", size: 15, color: GREY })
      ]
    })]
  })
}

function usDate(ymd: string): string {
  const [y, m, d] = ymd.split("-")
  return y && m && d ? `${ m }/${ d }/${ y }` : ymd
}

// ---------- Build ----------

export type BuildOptions = { clientName: string; preparedFor: string; documents: CheckDocument[]; amsPulledAt: string | null }

export async function buildPolicyCheckDoc(processed: ProcessedCheck, o: BuildOptions): Promise<Buffer> {
  const widths = widthsFrom(ITEM_FRACTIONS)
  let budget = PAGE_ONE_LINES - headerLines(processed, o)
  let pageOneCount = 0
  for(const item of processed.items) {
    const lines = itemRowLines(item, widths)
    if(item.pri !== 1 && lines > budget) break
    budget -= lines
    pageOneCount++
  }
  const pageOne = processed.items.slice(0, pageOneCount)
  const overflow = processed.items.slice(pageOneCount)

  const children: Block[] = [
    ...headerBlock(processed, o),
    para([], { after: 80 }),
    resultBanner(processed),
    para([], { after: 60 }),
    scorecard(processed),
    heading("Items to Check First", 140)
  ]

  if(processed.items.length === 0) {
    children.push(para([run("Nothing to check — every item matched.")]))
  } else {
    children.push(itemsTable(pageOne), legend())
    if(overflow.length > 0) {
      const confirm = overflow.filter((i) => i.pri === 2).length
      const house = overflow.filter((i) => i.pri === 3).length
      const parts = [confirm ? `${ confirm } Confirm` : "", house ? `${ house } Housekeeping` : ""].filter(Boolean).join(", ")
      children.push(para([run(`+ ${ overflow.length } more item${ overflow.length === 1 ? "" : "s" } (${ parts }) — see page 2`, { bold: true, size: 17 })]))
    }
  }

  children.push(new Paragraph({ children: [new PageBreak()] }))
  if(overflow.length > 0) children.push(heading("Items to Check (continued)", 0), itemsTable(overflow), legend())
  children.push(
    ...premiumSchedule(processed),
    ...amsSection(processed, o.amsPulledAt),
    ...detailSections(processed),
    ...formsSection(processed.findings),
    ...correctionRequest(processed, o.clientName),
    ...signOff()
  )

  const doc = new Document({
    creator: "Boxwood Insurance Group",
    title: `${ o.clientName } — Policy Check`,
    styles: { default: { document: { run: { font: "Arial", size: BODY, color: TEXT } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_WIDTH, height: 15840 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 360, footer: 360 } } },
      footers: { default: footer() },
      children
    }]
  })
  return Buffer.from(await Packer.toBuffer(doc) as unknown as Uint8Array)
}
