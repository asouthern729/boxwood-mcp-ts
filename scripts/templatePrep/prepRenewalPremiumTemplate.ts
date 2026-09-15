// One-time (re-runnable) prep step for the renewal_premium_summary tool's real template.
//
// Patrick emailed the original (assets/templates/CL_Renewal_Premium_Summary.xlsx, permission given
// to reuse it directly rather than reproduce its styling by hand) built around a fixed 8-row
// line-of-business table (rows 12-19: General Liability/Property/Auto/Umbrella/Workers Comp/EPLI/
// Inland Marine/D&O), each with a live Percent Change formula and a pre-filled Trending range, and
// TOTAL PREMIUM hardcoded as =SUM(C12:C19).
//
// Per client feedback (2026-09-13): the sheet should always carry a few genuinely blank rows below
// the known 8, for a coverage that doesn't exist in the current term but gets added at renewal.
// This bakes those in ONCE, producing assets/templates/commercial-renewal-template.xlsx, which is
// what the app code actually loads.
//
// Written in ExcelJS (not openpyxl/Python) deliberately — an earlier openpyxl-based version of this
// script produced a file ExcelJS itself couldn't read back (TypeError: Cannot read properties of
// undefined (reading 'anchors')). Root cause: openpyxl re-serializes the drawing1.xml part (the
// embedded logo image) without the `xdr:` namespace prefix ExcelJS's parser expects, corrupting the
// only actually-load-bearing thing that library touches in this file. Doing the edit in ExcelJS
// instead guarantees a self-consistent round trip, since it's the same library that reads the
// result at runtime.
import ExcelJS from "exceljs"
import path from "node:path"

const SRC = path.join(import.meta.dirname, "..", "..", "assets", "templates", "CL_Renewal_Premium_Summary.xlsx")
const DST = path.join(import.meta.dirname, "..", "..", "assets", "templates", "commercial-renewal-template.xlsx")

const LAST_KNOWN_LOB_ROW = 19 // D&O
const NUM_BLANK_ROWS = 3

async function main() {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(SRC)
  const sheet = workbook.getWorksheet(1)
  if(!sheet) throw new Error("no first worksheet")

  // Duplicates row 19 (style + merges + formulas, all correctly shifted — ExcelJS's spliceRows
  // explicitly re-merges cells accounting for the insert offset, unlike openpyxl's insert_rows)
  // `count` times right after it, pushing TOTAL PREMIUM (originally row 20) down by NUM_BLANK_ROWS.
  sheet.duplicateRow(LAST_KNOWN_LOB_ROW, NUM_BLANK_ROWS, true)

  // The duplicated rows inherited D&O's own Coverage label, Trending text, and Percent Change
  // formula verbatim (a straight value copy, not row-number-aware) — clear/fix each for its own row.
  for(let i = 0; i < NUM_BLANK_ROWS; i++) {
    const row = LAST_KNOWN_LOB_ROW + 1 + i
    sheet.getCell(`B${ row }`).value = null
    sheet.getCell(`H${ row }`).value = null
    sheet.getCell(`G${ row }`).value = { formula: `IF(OR(C${ row }="",C${ row }=0,E${ row }=""),"",((E${ row }-C${ row })/C${ row }))` }
  }

  // TOTAL PREMIUM, now at LAST_KNOWN_LOB_ROW + 1 + NUM_BLANK_ROWS. Its SUM ranges still read
  // C12:C19 verbatim (spliceRows moves formula strings as plain text, it doesn't rewrite them) —
  // widened here to include the new blank rows.
  const totalRow = LAST_KNOWN_LOB_ROW + 1 + NUM_BLANK_ROWS
  const lastDataRow = totalRow - 1
  sheet.getCell(`C${ totalRow }`).value = { formula: `SUM(C12:C${ lastDataRow })` }
  sheet.getCell(`E${ totalRow }`).value = { formula: `SUM(E12:E${ lastDataRow })` }
  sheet.getCell(`G${ totalRow }`).value = { formula: `IF(OR(C${ totalRow }="",C${ totalRow }=0,E${ totalRow }=""),"",((E${ totalRow }-C${ totalRow })/C${ totalRow }))` }
  for(const col of ["I", "J", "K", "L", "M", "N"]) {
    sheet.getCell(`${ col }${ totalRow }`).value = { formula: `SUM(${ col }12:${ col }${ lastDataRow })` }
  }

  // "Coverage / Policy" data rows (A27:C27 through A32:C32 — the 6 "other current policies" rows)
  // were center-aligned, which reads as ragged/hard-to-follow once a long policy label wraps to 2+
  // lines of differing width. Left-aligned with a touch of indent instead — center's a no-op for
  // indent, this is why the header row (26, short single-line labels, no wrapping) is left as-is.
  const otherDataFirstRow = totalRow + 4
  const otherDataLastRow = otherDataFirstRow + 5
  for(let row = otherDataFirstRow; row <= otherDataLastRow; row++) {
    const cell = sheet.getCell(`A${ row }`)
    cell.alignment = { ...cell.alignment, horizontal: "left", indent: 1 }
  }

  // Client feedback (2026-09-13): wrapping is fine, but a wrapped 2-line "Coverage / Policy" entry
  // looked cramped at the original single-line row height (23.1 — clearly sized for exactly one
  // line). Roughly doubled so two wrapped lines get real breathing room, vertically centered (this
  // section's cells are already vertical:'middle') rather than pressed against the row's top/bottom
  // border. (Widening column A to force single-line was tried and reverted — it's not a spare
  // margin column, the embedded logo is anchored there, so growing it shoved the ENTIRE sheet,
  // including the unrelated Renewal Program Summary section above, to the right.)
  for(let row = otherDataFirstRow; row <= otherDataLastRow; row++) {
    sheet.getRow(row).height = 46
  }

  // Carrier (D) was only 18 wide — too narrow for a real carrier name ("Frankenmuth Insurance
  // Company", 30 chars) with wrapText off, so Excel spilled it into the empty Renewal (E) column
  // next door, visually hiding E's own cell boundary entirely (client feedback, 2026-09-13: "can't
  // see the cell for Renewal when empty"). Widened rather than wrapped, matching the same
  // single-line-carrier preference already established for the other renewal workbook.
  sheet.getColumn("D").width = 32

  // Client feedback (2026-09-13): Current/Renewal/Market-Options values should be center-aligned,
  // not right-aligned. Two separate pre-existing inconsistencies in the template, both normalized
  // here rather than trusted row-by-row: (1) Current/Renewal (C/E) were center-aligned on every one
  // of the 8 known-LOB rows EXCEPT row 15 (Umbrella in the template's original order), which was
  // missing `horizontal` entirely (defaults to Excel's right-aligned-numbers behavior) — invisible
  // in the template itself, but exposed once row reordering (populated lines first) started moving
  // a different line's data onto row 15's incomplete style; (2) Market Options (I-N) were
  // consistently right-aligned everywhere, never center, including on the spare rows (20-22).
  const firstLobRow = LAST_KNOWN_LOB_ROW - 7 // 12 — General Liability's row
  const lastSpareRow = LAST_KNOWN_LOB_ROW + NUM_BLANK_ROWS // 22
  for(let row = firstLobRow; row <= lastSpareRow; row++) {
    for(const col of ["C", "E", "I", "J", "K", "L", "M", "N"]) {
      const cell = sheet.getCell(`${ col }${ row }`)
      cell.alignment = { ...cell.alignment, horizontal: "center" }
    }
  }

  await workbook.xlsx.writeFile(DST)
  console.log("Saved", DST)
}

main()
