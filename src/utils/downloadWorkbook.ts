import ExcelJS from "exceljs"
import type { ReportItem } from "../tools/downloadReport.js"

export type AccuracyVerdict = {
  status: "matches" | "no_match" | "rejected" | "verify"
  note: string
}

export type WorkbookItem = ReportItem & { accuracy?: AccuracyVerdict }
export type WorkbookRep = { csr_code: string | null; rep_name: string | null; items: WorkbookItem[] }
export type WorkbookInput = { window: { since: string; until: string }; reps: WorkbookRep[] }

// ExcelJS's Column class supports totalsRowResult at runtime (it's the cached formula result shown
// in a Table's totals row), but the shipped type defs omit it from TableColumn — see
// node_modules/exceljs/lib/doc/table.js's Column class vs. TableColumnProperties in index.d.ts.
function setTotalsRowResult(table: ExcelJS.Table, colIndex: number, value: number) {
  (table.getColumn(colIndex) as unknown as { totalsRowResult: number }).totalsRowResult = value
}

// Exact hex values pulled from Morning_Download_Action_List_Example.xlsx's styles.xml.
const COLORS = {
  brandGreen: "FF459361",
  brandGreenDark: "FF2E7D32",
  greenTint: "FFE3F0E7",
  greenBg: "FFD9EAD3",
  gray: "FF6B6B6B",
  grayBg: "FFF2F2F2",
  cream: "FFFFF6E0",
  red: "FFB23B3B",
  redBg: "FFFBE1E1",
  amber: "FFB26A00",
  dark: "FF231F20",
  white: "FFFFFFFF",
  border: "FFD9D9D9"
} as const

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: COLORS.border } },
  bottom: { style: "thin", color: { argb: COLORS.border } },
  left: { style: "thin", color: { argb: COLORS.border } },
  right: { style: "thin", color: { argb: COLORS.border } }
}

function styleTitleCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 14, bold: true, color: { argb: COLORS.dark } }
}

function styleSubtitleCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 11, italic: true, color: { argb: COLORS.gray } }
}

function styleHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 11, bold: true, color: { argb: COLORS.white } }
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.brandGreen } }
  cell.alignment = { horizontal: "left", vertical: "middle", wrapText: false, indent: 1 }
  cell.border = THIN_BORDER
}

function styleBodyCell(cell: ExcelJS.Cell, opts: { bold?: boolean; color?: string; fill?: string } = {}) {
  cell.font = { name: "Arial", size: 10.5, bold: !!opts.bold, color: { argb: opts.color ?? COLORS.dark } }

  if(opts.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } }

  cell.alignment = { horizontal: "left", vertical: "top", wrapText: true }
  cell.border = THIN_BORDER
}

function addTitleBlock(sheet: ExcelJS.Worksheet, lastCol: string, title: string, subtitle: string) {
  sheet.getRow(1).height = 34
  sheet.mergeCells(`A1:${ lastCol }1`)
  sheet.mergeCells(`A2:${ lastCol }2`)

  const titleCell = sheet.getCell("A1")
  titleCell.value = title
  styleTitleCell(titleCell)

  const subtitleCell = sheet.getCell("A2")
  subtitleCell.value = subtitle
  styleSubtitleCell(subtitleCell)
}

// AMS360 timestamps here are already-formatted strings like "2026-08-28T17:00:00.000-05:00" (see
// formatTimestampColumn) — only the leading YYYY-MM-DD is needed, so slicing it out is more robust
// than parsing the full string's offset/format.
function formatDateLabel(isoLike: string): string {
  const [y, m, d] = isoLike.slice(0, 10).split("-").map(Number)

  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
}

const VERDICT_STYLE: Record<AccuracyVerdict["status"], { label: string; color: string; bg: string }> = {
  matches: { label: "✓ MATCHES", color: COLORS.brandGreenDark, bg: COLORS.greenBg },
  no_match: { label: "✗ NO MATCH FOUND", color: COLORS.red, bg: COLORS.redBg },
  rejected: { label: "✗ REJECTED", color: COLORS.red, bg: COLORS.redBg },
  verify: { label: "⚠ VERIFY", color: COLORS.amber, bg: COLORS.cream }
}

const ROUTINE_STYLE = { color: COLORS.gray, bg: COLORS.grayBg }
const NEEDS_REVIEW_STYLE = { label: "⚠ Needs review", color: COLORS.amber, bg: COLORS.cream }

// This tool renders verdicts, it doesn't invent them (see SKILL.md) — an omitted `accuracy` on a
// flagged item means the caller hasn't judged it yet, not that it's fine, so it gets a distinct
// "needs review" flag rather than silently reading as routine.
function accuracyCellFor(item: WorkbookItem): { text: string; color: string; bg: string } {
  if(item.accuracy) {
    const style = VERDICT_STYLE[item.accuracy.status]
    return { text: `${ style.label }\n${ item.accuracy.note }`, color: style.color, bg: style.bg }
  }

  if(item.flagged) {
    return { text: NEEDS_REVIEW_STYLE.label, color: NEEDS_REVIEW_STYLE.color, bg: NEEDS_REVIEW_STYLE.bg }
  }

  return { text: item.domain === "claim" ? "Informational" : "Routine", color: ROUTINE_STYLE.color, bg: ROUTINE_STYLE.bg }
}

// "Accuracy Issues" on the Summary tab counts only clear mismatches (rejected/no_match), not
// "verify" — verify means uncertain, not necessarily wrong, and counting it as an issue would
// overstate how sure this is.
function isAccuracyIssue(item: WorkbookItem): boolean {
  return item.accuracy?.status === "rejected" || item.accuracy?.status === "no_match"
}

function itemRowValues(item: WorkbookItem): string[] {
  const accuracy = accuracyCellFor(item)

  return [
    item.customer_name ?? "",
    item.policy_no,
    item.carrier_name ?? "",
    item.line_of_business ?? "",
    item.what_happened,
    item.detail ?? "",
    item.next_step,
    accuracy.text
  ]
}

// Table.addTable() already wrote the cell values (see itemRowValues) — this only layers the
// brand/flagged/accuracy styling on top, since a Table's own style theme covers banding, not
// per-item conditional colors.
function styleItemRow(sheet: ExcelJS.Worksheet, rowNumber: number, item: WorkbookItem) {
  const row = sheet.getRow(rowNumber)
  const rowFill = item.flagged ? COLORS.cream : undefined

  for(let col = 1; col <= 7; col++) {
    styleBodyCell(row.getCell(col), { bold: col === 1, fill: rowFill })
  }

  const accuracy = accuracyCellFor(item)
  styleBodyCell(row.getCell(8), { bold: true, color: accuracy.color, fill: accuracy.bg })
}

const REP_SHEET_COLUMN_WIDTHS = [24, 15, 26, 20, 20, 40, 36, 46]
const REP_SHEET_HEADERS = ["Customer", "Policy #", "Carrier", "Line of Business", "What Happened", "Detail", "Next Step", "Check for Accuracy"]

// No banding/theme colors from the table style — every cell here gets its own explicit brand
// fill/font from styleHeaderCell/styleBodyCell right after the table is created, and those direct
// formats are what Excel actually renders, so a visible theme would just be redundant.
const TABLE_STYLE = { theme: "TableStyleLight1", showRowStripes: false } as const

function buildRepSheet(workbook: ExcelJS.Workbook, sheetName: string, tableName: string, repName: string, dateLabel: string, items: WorkbookItem[]) {
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 4 }] })

  sheet.columns = REP_SHEET_COLUMN_WIDTHS.map((width) => ({ width }))

  const flaggedCount = items.filter((item) => item.flagged).length

  addTitleBlock(
    sheet,
    "H",
    "Boxwood Insurance Group — Morning Download Action List",
    `${ repName }  •  Overnight download for ${ dateLabel }  •  ${ items.length } item(s), ${ flaggedCount } flagged for review`
  )

  sheet.getRow(4).height = 20

  // A real Excel Table (not just an AutoFilter range) — gives reps sortable columns and per-column
  // filter dropdowns natively, plus a defined name (structured references) other tools can target.
  sheet.addTable({
    name: tableName,
    ref: "A4",
    headerRow: true,
    style: TABLE_STYLE,
    columns: REP_SHEET_HEADERS.map((name) => ({ name, filterButton: true })),
    rows: items.map(itemRowValues)
  })

  REP_SHEET_HEADERS.forEach((_header, i) => styleHeaderCell(sheet.getRow(4).getCell(i + 1)))
  items.forEach((item, i) => styleItemRow(sheet, 5 + i, item))
}

const SUMMARY_COLUMN_WIDTHS = [22, 10, 24, 10, 20]
const SUMMARY_HEADERS = ["Representative", "Items", "Flagged for Review", "Claims", "Accuracy Issues"]

type RepTotals = { name: string; items: number; flagged: number; claims: number; issues: number }

function buildSummarySheet(workbook: ExcelJS.Workbook, dateLabel: string, repTotals: RepTotals[]) {
  const sheet = workbook.addWorksheet("Summary")

  sheet.columns = SUMMARY_COLUMN_WIDTHS.map((width) => ({ width }))

  addTitleBlock(
    sheet,
    "E",
    `Morning Download Action List — ${ dateLabel }`,
    "One tab per representative. Duplicate download messages already merged; repeated transactions and accuracy issues are called out per item."
  )

  sheet.getRow(4).height = 20

  const totals = repTotals.reduce(
    (acc, rep) => ({
      items: acc.items + rep.items,
      flagged: acc.flagged + rep.flagged,
      claims: acc.claims + rep.claims,
      issues: acc.issues + rep.issues
    }),
    { items: 0, flagged: 0, claims: 0, issues: 0 }
  )

  // totalsRow is a native Table feature (SUBTOTAL formulas, excluded from sort/filter) rather than
  // just another data row — matches the old manually-written "TOTAL" row's meaning without letting
  // sort/filter on the rep rows accidentally move or hide it.
  const table = sheet.addTable({
    name: "SummaryTable",
    ref: "A4",
    headerRow: true,
    totalsRow: true,
    style: TABLE_STYLE,
    columns: [
      { name: SUMMARY_HEADERS[0], filterButton: true, totalsRowLabel: "TOTAL" },
      { name: SUMMARY_HEADERS[1], filterButton: true, totalsRowFunction: "sum" },
      { name: SUMMARY_HEADERS[2], filterButton: true, totalsRowFunction: "sum" },
      { name: SUMMARY_HEADERS[3], filterButton: true, totalsRowFunction: "sum" },
      { name: SUMMARY_HEADERS[4], filterButton: true, totalsRowFunction: "sum" }
    ],
    rows: repTotals.map((rep) => [rep.name, rep.items, rep.flagged, rep.claims, rep.issues])
  })

  // Seeds each totals cell's cached formula result (the TableColumnProperties type omits this
  // field, even though the underlying Column supports it) so the total reads correctly even in a
  // viewer that doesn't recalculate formulas on open, not just live Excel.
  setTotalsRowResult(table, 1, totals.items)
  setTotalsRowResult(table, 2, totals.flagged)
  setTotalsRowResult(table, 3, totals.claims)
  setTotalsRowResult(table, 4, totals.issues)
  table.commit()

  SUMMARY_HEADERS.forEach((_header, i) => styleHeaderCell(sheet.getRow(4).getCell(i + 1)))

  repTotals.forEach((rep, i) => {
    const row = sheet.getRow(5 + i)

    for(let col = 1; col <= 5; col++) {
      const isIssuesCol = col === 5 && rep.issues > 0
      styleBodyCell(row.getCell(col), isIssuesCol ? { bold: true, color: COLORS.red } : {})
    }
  })

  const totalRow = sheet.getRow(5 + repTotals.length)
  for(let col = 1; col <= 5; col++) {
    styleBodyCell(totalRow.getCell(col), { bold: true, fill: COLORS.greenTint })
  }
}

function sanitizeSheetName(rawName: string | null, index: number, used: Set<string>): string {
  const base = (rawName ?? `Rep ${ index + 1 }`).replace(/[:\\/?*[\]]/g, "").trim().slice(0, 31) || `Rep ${ index + 1 }`
  let candidate = base
  let suffix = 2

  while(used.has(candidate)) {
    const truncated = base.slice(0, 31 - String(suffix).length - 1)
    candidate = `${ truncated } ${ suffix }`
    suffix++
  }

  used.add(candidate)
  return candidate
}

// Excel table names share one namespace with defined names across the whole workbook (not just the
// sheet) — must start with a letter/underscore and contain only word characters, so this can't
// just reuse sanitizeSheetName's output (sheet names allow spaces and other punctuation).
function sanitizeTableName(rawName: string, used: Set<string>): string {
  let base = rawName.replace(/[^A-Za-z0-9_]/g, "_")
  if(!/^[A-Za-z_]/.test(base)) base = `Tbl_${ base }`
  base = base.slice(0, 60) || "Tbl"

  let candidate = base
  let suffix = 2

  while(used.has(candidate)) {
    candidate = `${ base }_${ suffix }`
    suffix++
  }

  used.add(candidate)
  return candidate
}

export async function buildDownloadReportWorkbook(input: WorkbookInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const dateLabel = formatDateLabel(input.window.until)
  const usedSheetNames = new Set<string>(["Summary"])
  const usedTableNames = new Set<string>(["SummaryTable"])

  const repTotals: RepTotals[] = input.reps.map((rep) => ({
    name: rep.rep_name ?? "Unassigned",
    items: rep.items.length,
    flagged: rep.items.filter((item) => item.flagged).length,
    claims: rep.items.filter((item) => item.domain === "claim").length,
    issues: rep.items.filter(isAccuracyIssue).length
  }))

  // Built first so it lands as the first tab (ExcelJS appends sheets in add order) — matches the
  // example, where Summary is the first tab a rep sees.
  buildSummarySheet(workbook, dateLabel, repTotals)

  input.reps.forEach((rep, index) => {
    const repName = rep.rep_name ?? "Unassigned"
    const sheetName = sanitizeSheetName(rep.rep_name, index, usedSheetNames)
    const tableName = sanitizeTableName(`Tbl_${ sheetName }`, usedTableNames)

    buildRepSheet(workbook, sheetName, tableName, repName, dateLabel, rep.items)
  })

  const rawBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(rawBuffer as unknown as Uint8Array)
}
