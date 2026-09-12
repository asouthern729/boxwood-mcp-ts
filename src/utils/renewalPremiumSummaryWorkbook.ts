import ExcelJS from "exceljs"

// Mirrors the layout of Commercial_Renewal_Template_Reformatted.xlsx (Patrick's template, emailed
// 2026-09-10 — see roadmap item #1's comment thread) as closely as a generated sheet reasonably can:
// same column set, same two-table structure, same section labels. Colors reused from
// renewalSummaryDoc.ts's Word-doc palette (GREEN/NEARBLACK) so this tool's output reads as the same
// brand as commercial_renewal_summary's .docx, not a one-off style.
const COLORS = {
  brandGreen: "FF459361",
  greenTint: "FFE3F0E7",
  gray: "FF6B6B6B",
  grayBg: "FFF2F2F2",
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

const MAIN_COLUMNS = [
  "Coverage", "Current", "Carrier", "Renewal", "Carrier", "Percent Change", "Trending Percent Increase",
  "Grange", "Frankenmuth", "Accident Fund", "Philadelphia", "Travelers", "CRC"
]
const LAST_COL = "M" // 13 columns, A-M

function styleTitleCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 14, bold: true, color: { argb: COLORS.dark } }
}

function styleFieldLabelCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 10.5, bold: true, color: { argb: COLORS.dark } }
}

function styleFieldValueCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 10.5, color: { argb: COLORS.dark } }
}

function styleSectionHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 11, bold: true, color: { argb: COLORS.dark } }
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.greenTint } }
}

function styleColumnHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { name: "Arial", size: 10, bold: true, color: { argb: COLORS.white } }
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.brandGreen } }
  cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true }
  cell.border = THIN_BORDER
}

function styleBodyCell(cell: ExcelJS.Cell, opts: { bold?: boolean; fill?: string } = {}) {
  cell.font = { name: "Arial", size: 10, bold: !!opts.bold, color: { argb: COLORS.dark } }
  if(opts.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } }
  cell.alignment = { horizontal: "left", vertical: "top", wrapText: true }
  cell.border = THIN_BORDER
}

// One row per policy included in the renewal window — NOT one row per line of business. See
// renewalPremiumSummary.ts's own header comment for why: AMS360 rates most multi-LOB commercial
// Package policies as a single blended premium (afw_policytranpremium.lineofbus = 'CPKGE'), so a
// per-LOB split would either be unavailable or actively wrong for exactly the policies where a
// split would matter most. `coverage` instead names what's bundled on the policy (e.g. "Package —
// General Liability, Property, Inland Marine"), and `current` is that whole policy's premium.
export type PremiumRow = { coverage: string; current: number | null; carrier: string; trendingRange: string }
export type OtherPolicyRow = { coveragePolicy: string; expirationDate: string }

export type RenewalPremiumSummaryInput = {
  clientName: string
  renewalDateLabel: string
  rows: PremiumRow[]
  otherPolicies: OtherPolicyRow[]
}

export async function buildRenewalPremiumSummaryWorkbook(input: RenewalPremiumSummaryInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet("Renewal Premium Summary", { views: [{ showGridLines: false }] })

  sheet.columns = [
    { width: 34 }, { width: 13 }, { width: 16 }, { width: 13 }, { width: 16 }, { width: 13 }, { width: 15 },
    { width: 11 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }
  ]

  let r = 1

  sheet.mergeCells(`A${ r }:${ LAST_COL }${ r }`)
  const titleCell = sheet.getCell(`A${ r }`)
  titleCell.value = "COMMERCIAL RENEWAL PREMIUM OVERVIEW"
  titleCell.alignment = { horizontal: "center" }
  styleTitleCell(titleCell)
  sheet.getRow(r).height = 26
  r += 2

  sheet.getCell(`A${ r }`).value = "Insured Name:"
  styleFieldLabelCell(sheet.getCell(`A${ r }`))
  sheet.getCell(`B${ r }`).value = input.clientName
  styleFieldValueCell(sheet.getCell(`B${ r }`))
  r += 1

  sheet.getCell(`A${ r }`).value = "Renewal Date:"
  styleFieldLabelCell(sheet.getCell(`A${ r }`))
  sheet.getCell(`B${ r }`).value = input.renewalDateLabel
  styleFieldValueCell(sheet.getCell(`B${ r }`))
  r += 2

  sheet.mergeCells(`A${ r }:G${ r }`)
  sheet.mergeCells(`H${ r }:${ LAST_COL }${ r }`)
  const summaryHeader = sheet.getCell(`A${ r }`)
  summaryHeader.value = "RENEWAL PROGRAM SUMMARY"
  styleSectionHeaderCell(summaryHeader)
  const marketHeader = sheet.getCell(`H${ r }`)
  marketHeader.value = "MARKET OPTIONS"
  styleSectionHeaderCell(marketHeader)
  r += 1

  const mainHeaderRow = sheet.getRow(r)
  MAIN_COLUMNS.forEach((label, i) => {
    const cell = mainHeaderRow.getCell(i + 1)
    cell.value = label
    styleColumnHeaderCell(cell)
  })
  mainHeaderRow.height = 30
  r += 1

  const firstDataRow = r
  for(const row of input.rows) {
    const rowIndex = r - firstDataRow
    const fill = rowIndex % 2 === 0 ? COLORS.greenTint : undefined

    styleBodyCell(sheet.getCell(`A${ r }`), { fill })
    sheet.getCell(`A${ r }`).value = row.coverage

    const currentCell = sheet.getCell(`B${ r }`)
    styleBodyCell(currentCell, { fill })
    if(row.current !== null) {
      currentCell.value = row.current
      currentCell.numFmt = "$#,##0"
    }

    styleBodyCell(sheet.getCell(`C${ r }`), { fill })
    sheet.getCell(`C${ r }`).value = row.carrier

    // Renewal / Carrier / Percent Change stay blank — not knowable until the renewal is actually
    // priced/bound, same as Patrick's own template.
    for(const col of ["D", "E", "F"]) styleBodyCell(sheet.getCell(`${ col }${ r }`), { fill })

    styleBodyCell(sheet.getCell(`G${ r }`), { fill })
    sheet.getCell(`G${ r }`).value = row.trendingRange

    // Market-option carrier columns (H-M) stay blank — filled in by hand as quotes come back.
    for(const col of ["H", "I", "J", "K", "L", "M"]) styleBodyCell(sheet.getCell(`${ col }${ r }`), { fill })

    r += 1
  }
  const lastDataRow = r - 1

  const totalRow = sheet.getRow(r)
  const totalLabelCell = totalRow.getCell(1)
  totalLabelCell.value = "TOTAL PREMIUM"
  styleBodyCell(totalLabelCell, { bold: true, fill: COLORS.grayBg })

  const totalCurrentCell = totalRow.getCell(2)
  styleBodyCell(totalCurrentCell, { bold: true, fill: COLORS.grayBg })
  if(lastDataRow >= firstDataRow) {
    totalCurrentCell.value = { formula: `SUM(B${ firstDataRow }:B${ lastDataRow })` }
    totalCurrentCell.numFmt = "$#,##0"
  } else {
    totalCurrentCell.value = 0
    totalCurrentCell.numFmt = "$#,##0"
  }

  for(const col of ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"]) {
    styleBodyCell(totalRow.getCell(col), { bold: true, fill: COLORS.grayBg })
  }
  r += 2

  sheet.mergeCells(`A${ r }:C${ r }`)
  sheet.mergeCells(`D${ r }:${ LAST_COL }${ r }`)
  const otherHeader = sheet.getCell(`A${ r }`)
  otherHeader.value = "OTHER EFFECTIVE DATES & QUOTE NOTES"
  styleSectionHeaderCell(otherHeader)
  const notesHeader = sheet.getCell(`D${ r }`)
  notesHeader.value = "ADDITIONAL QUOTE NOTES"
  styleSectionHeaderCell(notesHeader)
  r += 1

  sheet.mergeCells(`A${ r }:B${ r }`)
  const otherColHeaders: [string, string][] = [["A", "Coverage / Policy"], ["C", "Expiration Date"], ["D", "Quote Notes"]]
  for(const [col, label] of otherColHeaders) {
    const cell = sheet.getCell(`${ col }${ r }`)
    cell.value = label
    styleColumnHeaderCell(cell)
  }
  for(const col of ["E", "F", "G", "H", "I", "J", "K", "L", "M"]) styleColumnHeaderCell(sheet.getCell(`${ col }${ r }`))
  r += 1

  for(const other of input.otherPolicies) {
    sheet.mergeCells(`A${ r }:B${ r }`)
    styleBodyCell(sheet.getCell(`A${ r }`))
    sheet.getCell(`A${ r }`).value = other.coveragePolicy

    styleBodyCell(sheet.getCell(`C${ r }`))
    sheet.getCell(`C${ r }`).value = other.expirationDate

    sheet.mergeCells(`D${ r }:${ LAST_COL }${ r }`)
    styleBodyCell(sheet.getCell(`D${ r }`))

    r += 1
  }

  if(input.otherPolicies.length === 0) {
    sheet.mergeCells(`A${ r }:${ LAST_COL }${ r }`)
    const emptyCell = sheet.getCell(`A${ r }`)
    emptyCell.value = "No other current policies on this account."
    styleBodyCell(emptyCell)
    emptyCell.font = { name: "Arial", size: 10, italic: true, color: { argb: COLORS.gray } }
  }

  const rawBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(rawBuffer as unknown as ArrayBuffer)
}
