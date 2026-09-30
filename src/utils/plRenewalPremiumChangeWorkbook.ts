import { readFileSync } from "node:fs"
import path from "node:path"
import { editSheet } from "./xlsxCellPatch.js"
import type { CellEdit, SheetEditor } from "./xlsxCellPatch.js"

// Fills in the PL team's own "Renewal Calculator.xlsx" (Patrick, 2026-09-29 — reused as-is, see
// assets/templates/pl-renewal-calculator.xlsx) for one client's renewal. Patched at the XML level
// (xlsxCellPatch.editSheet), not through ExcelJS, so the template's two Excel tables, styles and
// SharePoint customXml survive untouched.
//
// The sheet has two parallel calculators: Table1 (A2:F16, monthly = ÷12) for annual accounts and
// Table14 (J3:O17, monthly = ÷6) for accounts with a 6-month auto term (Andrew, 2026-09-30: the whole
// account goes on the 6-month side when it has one). Each has a note block beneath it — the text the
// PL team pastes into the AMS activity note — which is re-rendered here with only the lines the
// client actually has, followed by the account total, since the template's own block uses shared
// formulas that can't be trimmed cell by cell.
const TEMPLATE_PATH = path.join(import.meta.dirname, "..", "..", "assets", "templates", "pl-renewal-calculator.xlsx")

export type PlCalculatorLob = "HOME" | "AUTO" | "PA" | "WATERCRAFT" | "UMBRELLA" | "FLOOD"
export type PlCalculatorTerm = "annual" | "six_month"

export type PlCalculatorLine = {
  // A fixed template row, or null for a line that goes on a spare row under its own label.
  lob: PlCalculatorLob | null
  label: string
  current: number
  renewal: number
}

export type PlCalculatorInput = {
  carriersLabel: string
  renewalDateLabel: string // M/D/YYYY
  term: PlCalculatorTerm
  lines: PlCalculatorLine[]
}

export type PlCalculatorResult = {
  buffer: Buffer
  note: string
  currentTotal: number
  renewalTotal: number
  changeAmount: number
  changePercent: number | null
  // Lines that didn't fit the template's spare rows (never expected in practice — 7 spares).
  overflow: string[]
}

type Layout = {
  labelCol: string; currentCol: string; renewalCol: string; incrCol: string; monthlyCol: string; percentCol: string
  divisor: number
  fixedRows: Record<PlCalculatorLob, number>
  spareRows: number[]
  totalsRow: number
  noteCols: string[] // 9 columns: label, current, "RNWL", renewal, incr label, incr, "Monthly Increase", monthly, %
  headerRef: string
  firstNoteRow: number
  lastNoteRow: number
  noteLabel: Record<PlCalculatorLob, number> // sharedStrings index
  spareSuffix: string
  totalLabel: number
  incrLabel: (lob: PlCalculatorLob | null) => number
  totalIncrLabel: number
  styles: { label: string; current: string; text: string; value: string; monthlyText: string; percent: string; totalPercent: string }
}

// sharedStrings.xml indexes in the template (see its sst) — reused rather than writing new strings.
const SST = {
  monthlyIncrease: 5, rnwl: 8, annualIncrease: 9, homeowners: 10, automobile: 1, personalArticles: 21, watercraft: 2,
  umbrellaExp: 7, flood: 4, accountTotal: 29, homeExp: 22, autoExp: 11, personalArticlesExp: 12, watercraftExp: 13,
  floodExp: 14, accountExp: 15, sixMonthIncrease: 24, increase: 25
} as const

const ANNUAL: Layout = {
  labelCol: "A", currentCol: "B", renewalCol: "C", incrCol: "D", monthlyCol: "E", percentCol: "F",
  divisor: 12,
  fixedRows: { HOME: 3, AUTO: 4, PA: 5, WATERCRAFT: 6, UMBRELLA: 7, FLOOD: 8 },
  spareRows: [9, 10, 11, 12, 13, 14, 15],
  totalsRow: 16,
  noteCols: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
  headerRef: "A18",
  firstNoteRow: 19,
  lastNoteRow: 32,
  noteLabel: { HOME: SST.homeowners, AUTO: SST.automobile, PA: SST.personalArticles, WATERCRAFT: SST.watercraft, UMBRELLA: SST.umbrellaExp, FLOOD: SST.flood },
  spareSuffix: "",
  totalLabel: SST.accountTotal,
  incrLabel: () => SST.annualIncrease,
  totalIncrLabel: SST.annualIncrease,
  styles: { label: "17", current: "19", text: "19", value: "19", monthlyText: "27", percent: "21", totalPercent: "21" }
}

const SIX_MONTH: Layout = {
  labelCol: "J", currentCol: "K", renewalCol: "L", incrCol: "M", monthlyCol: "N", percentCol: "O",
  divisor: 6,
  fixedRows: { HOME: 4, AUTO: 5, PA: 6, WATERCRAFT: 7, UMBRELLA: 8, FLOOD: 9 },
  spareRows: [10, 11, 12, 13, 14, 15, 16],
  totalsRow: 17,
  noteCols: ["K", "L", "M", "N", "O", "P", "Q", "R", "S"],
  headerRef: "K19",
  firstNoteRow: 20,
  lastNoteRow: 33,
  noteLabel: { HOME: SST.homeExp, AUTO: SST.autoExp, PA: SST.personalArticlesExp, WATERCRAFT: SST.watercraftExp, UMBRELLA: SST.umbrellaExp, FLOOD: SST.floodExp },
  spareSuffix: " Exp",
  totalLabel: SST.accountExp,
  incrLabel: (lob) => (lob === "AUTO" ? SST.sixMonthIncrease : SST.annualIncrease),
  totalIncrLabel: SST.increase,
  styles: { label: "17", current: "18", text: "19", value: "19", monthlyText: "20", percent: "21", totalPercent: "29" }
}

// Plain-text labels for the note string, matching the sharedStrings entries above.
const SST_TEXT: Record<number, string> = {
  [SST.monthlyIncrease]: "Monthly Increase", [SST.rnwl]: "RNWL", [SST.annualIncrease]: "Annual Increase",
  [SST.homeowners]: "Homeowners", [SST.automobile]: "Automobile", [SST.personalArticles]: "Personal Articles",
  [SST.watercraft]: "Watercraft", [SST.umbrellaExp]: "Umbrella Exp", [SST.flood]: "Flood", [SST.accountTotal]: "Account Total",
  [SST.homeExp]: "Home Exp", [SST.autoExp]: "Auto Exp", [SST.personalArticlesExp]: "Personal Articles Exp",
  [SST.watercraftExp]: "Watercraft Exp", [SST.floodExp]: "Flood Exp", [SST.accountExp]: "Account Exp",
  [SST.sixMonthIncrease]: "6 Month Increase", [SST.increase]: "Increase"
}

const round2 = (v: number) => Math.round(v * 100) / 100

// Excel's display of the template's formats: "$"#,##0.00 and 0.00%.
function money(v: number): string {
  return `${ v < 0 ? "-" : "" }$${ Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`
}

function percent(v: number | null): string {
  return v === null ? "" : `${ (v * 100).toFixed(2) }%`
}

// Money and % columns in a note row; the rest are labels.
const NOTE_NUMERIC_COLUMNS = new Set([1, 3, 5, 7, 8])
const NOTE_COLUMN_GAP = "    "

// Space-padded columns for the "Copy For AMS" text: labels left-aligned, amounts right-aligned, each
// column as wide as its widest value. Tabs were tried first (2026-09-30), but AMS renders a tab as a
// fixed four spaces, so the columns drifted with every label length.
function alignNoteRows(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((r) => r[col].length))) ?? []
  return rows.map((row) => row
    .map((cell, col) => (NOTE_NUMERIC_COLUMNS.has(col) ? cell.padStart(widths[col]) : cell.padEnd(widths[col])))
    .join(NOTE_COLUMN_GAP)
    .trimEnd())
}

type PlacedRow = { row: number; line: PlCalculatorLine }

function placeLines(layout: Layout, lines: PlCalculatorLine[]): { placed: PlacedRow[]; overflow: string[] } {
  const placed: PlacedRow[] = []
  const overflow: string[] = []
  const usedFixed = new Set<PlCalculatorLob>()
  const spares = [...layout.spareRows]

  for(const line of lines) {
    if(line.lob && !usedFixed.has(line.lob)) {
      usedFixed.add(line.lob)
      placed.push({ row: layout.fixedRows[line.lob], line })
      continue
    }
    const spare = spares.shift()
    if(spare === undefined) overflow.push(line.label)
    // A second policy of a fixed line (a second home) goes on a spare row as a plain labeled line.
    else placed.push({ row: spare, line: { ...line, lob: null } })
  }

  return { placed: placed.sort((a, b) => a.row - b.row), overflow }
}

function clearNoteBlock(sheet: SheetEditor, layout: Layout): void {
  const headerRow = Number(layout.headerRef.slice(1))
  sheet.clear(headerRow, layout.lastNoteRow, layout.noteCols[0], layout.noteCols[layout.noteCols.length - 1])
}

export async function buildPlRenewalCalculatorWorkbook(input: PlCalculatorInput): Promise<PlCalculatorResult> {
  const layout = input.term === "six_month" ? SIX_MONTH : ANNUAL
  const other = input.term === "six_month" ? ANNUAL : SIX_MONTH
  const { placed, overflow } = placeLines(layout, input.lines)

  const currentTotal = round2(placed.reduce((sum, p) => sum + p.line.current, 0))
  const renewalTotal = round2(placed.reduce((sum, p) => sum + p.line.renewal, 0))
  const changeAmount = round2(renewalTotal - currentTotal)
  const changePercent = currentTotal !== 0 ? changeAmount / currentTotal : null

  const header = `${ input.carriersLabel } ${ input.renewalDateLabel } Renewal:`
  const noteRows: string[][] = []

  const buffer = await editSheet(readFileSync(TEMPLATE_PATH), 1, (sheet) => {
    const { labelCol, currentCol, renewalCol, incrCol, monthlyCol, percentCol } = layout
    const tableRows = [...Object.values(layout.fixedRows), ...layout.spareRows]
    const byRow = new Map(placed.map((p) => [p.row, p.line]))

    // Upper table: every template row keeps its formulas; only inputs, spare labels and the cached
    // results change. Unused rows stay at $0 exactly as the template has them.
    for(const row of tableRows) {
      const line = byRow.get(row)
      const current = line?.current ?? 0
      const renewal = line?.renewal ?? 0
      const incr = round2(renewal - current)
      sheet.set(`${ currentCol }${ row }`, { kind: "number", value: current })
      sheet.set(`${ renewalCol }${ row }`, { kind: "number", value: renewal })
      if(line && line.lob === null) sheet.set(`${ labelCol }${ row }`, { kind: "text", text: line.label })
      setCached(sheet, `${ incrCol }${ row }`, incr)
      setCached(sheet, `${ monthlyCol }${ row }`, incr / layout.divisor)
      setCached(sheet, `${ percentCol }${ row }`, current !== 0 ? incr / current : Number.NaN)
    }

    const t = layout.totalsRow
    setCached(sheet, `${ currentCol }${ t }`, currentTotal)
    setCached(sheet, `${ renewalCol }${ t }`, renewalTotal)
    setCached(sheet, `${ incrCol }${ t }`, changeAmount)
    setCached(sheet, `${ monthlyCol }${ t }`, changeAmount / layout.divisor)
    setCached(sheet, `${ percentCol }${ t }`, changePercent ?? Number.NaN)

    // Note blocks: the inactive one is emptied entirely; the active one is rebuilt compactly.
    clearNoteBlock(sheet, other)
    clearNoteBlock(sheet, layout)
    sheet.set(layout.headerRef, { kind: "text", text: header })

    const [cLabel, cCur, cRnwl, cRen, cIncrLabel, cIncr, cMoLabel, cMo, cPct] = layout.noteCols
    const s = layout.styles

    const writeNoteRow = (noteRow: number, sourceRow: number, label: CellEdit, labelText: string, incrLabel: number, current: number, renewal: number, isTotal: boolean) => {
      const incr = round2(renewal - current)
      const monthly = incr / layout.divisor
      const pct = current !== 0 ? incr / current : null
      sheet.set(`${ cLabel }${ noteRow }`, { ...label, style: s.label })
      sheet.set(`${ cCur }${ noteRow }`, { kind: "formula", formula: `${ currentCol }${ sourceRow }`, cached: current, style: s.current })
      sheet.set(`${ cRnwl }${ noteRow }`, { kind: "shared", index: SST.rnwl, style: s.text })
      sheet.set(`${ cRen }${ noteRow }`, { kind: "formula", formula: `${ renewalCol }${ sourceRow }`, cached: renewal, style: s.value })
      sheet.set(`${ cIncrLabel }${ noteRow }`, { kind: "shared", index: incrLabel, style: s.text })
      sheet.set(`${ cIncr }${ noteRow }`, { kind: "formula", formula: `${ incrCol }${ sourceRow }`, cached: incr, style: s.value })
      sheet.set(`${ cMoLabel }${ noteRow }`, { kind: "shared", index: SST.monthlyIncrease, style: s.monthlyText })
      sheet.set(`${ cMo }${ noteRow }`, { kind: "formula", formula: `${ monthlyCol }${ sourceRow }`, cached: monthly, style: s.value })
      sheet.set(`${ cPct }${ noteRow }`, {
        kind: "formula", formula: `${ percentCol }${ sourceRow }`, cached: pct ?? { error: "#DIV/0!" }, style: isTotal ? s.totalPercent : s.percent
      })
      noteRows.push([labelText, money(current), "RNWL", money(renewal), SST_TEXT[incrLabel], money(incr), "Monthly Increase", money(monthly), percent(pct)])
    }

    let noteRow = layout.firstNoteRow
    for(const { row, line } of placed) {
      const label: CellEdit = line.lob ? { kind: "shared", index: layout.noteLabel[line.lob] } : { kind: "text", text: `${ line.label }${ layout.spareSuffix }` }
      const labelText = line.lob ? SST_TEXT[layout.noteLabel[line.lob]] : `${ line.label }${ layout.spareSuffix }`
      writeNoteRow(noteRow++, row, label, labelText, layout.incrLabel(line.lob), line.current, line.renewal, false)
    }
    writeNoteRow(noteRow, layout.totalsRow, { kind: "shared", index: layout.totalLabel }, SST_TEXT[layout.totalLabel], layout.totalIncrLabel, currentTotal, renewalTotal, true)
  })

  return { buffer, note: [header, ...alignNoteRows(noteRows)].join("\n"), currentTotal, renewalTotal, changeAmount, changePercent: changePercent === null ? null : round2(changePercent * 100), overflow }
}

// The template's own formula stays (structured Table1/Table14 references); only its cached result is
// replaced, so a non-recalculating viewer still shows the right number.
function setCached(sheet: SheetEditor, ref: string, value: number): void {
  sheet.setCachedValue(ref, Number.isFinite(value) ? round2Precise(value) : value)
}

// Cached values keep more precision than cents (Excel would), e.g. a monthly increase of -37.5833.
function round2Precise(v: number): number {
  return Math.round(v * 1e10) / 1e10
}
