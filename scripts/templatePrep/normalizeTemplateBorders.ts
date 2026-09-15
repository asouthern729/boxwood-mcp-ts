// One-time fix for commercial-renewal-template.xlsx (client feedback, 2026-09-15: "cell borders...
// looks uneven and fat in some spots"). Root cause confirmed by inspecting the template's own
// border styles: nearly every row from 12-22, columns B-H, has a "double" border style on its top
// and/or bottom edge (inconsistently — some rows double-top/thin-bottom, some double-top/none-
// bottom, B12/B13 double on both), stacking with the adjacent row's own border to render as an
// uneven, unusually thick line at some row boundaries but not others. This is a pre-existing
// artifact in the template Patrick supplied (or from however the original CL_Renewal_Premium_Summary
// spare rows were built), not something introduced by this project's own code.
//
// Fix: normalize every data row (12-22, columns B-H) to a plain thin box border on all four sides,
// then thicken column B (the "Coverage" column) specifically to a uniform medium border throughout
// that same range (client feedback, 2026-09-15: "i want the cells under Coverage to be thicker i
// just want it uniform throughout that section of the column") — columns C-H stay thin. Row 11
// (header) and row 23 (TOTAL PREMIUM, whose medium top border is an intentional divider between the
// data rows and the total) are deliberately left untouched.
//
// Also widens column B (client feedback, same date: "ensure the Coverage col is expanded far enough
// to show everything") — it now holds real Line-of-Business text plus a Policy #, considerably
// longer than the original static label it replaced.
import ExcelJS from "exceljs"
import path from "node:path"

const TEMPLATE_PATH = path.join(import.meta.dirname, "..", "..", "assets", "templates", "commercial-renewal-template.xlsx")

const FIRST_ROW = 12
const LAST_ROW = 22
const COLUMNS = ["B", "C", "D", "E", "F", "G", "H"]

async function main() {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)
  const sheet = workbook.getWorksheet(1)
  if(!sheet) throw new Error("commercial-renewal-template.xlsx has no first worksheet")

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }
  }
  const mediumBorder: Partial<ExcelJS.Borders> = {
    top: { style: "medium" }, bottom: { style: "medium" }, left: { style: "medium" }, right: { style: "medium" }
  }

  for(let row = FIRST_ROW; row <= LAST_ROW; row++) {
    for(const col of COLUMNS) {
      sheet.getCell(`${ col }${ row }`).border = col === "B" ? mediumBorder : thinBorder
    }
  }

  sheet.getColumn("B").width = 60

  await workbook.xlsx.writeFile(TEMPLATE_PATH)
  console.log(`Normalized borders on rows ${ FIRST_ROW }-${ LAST_ROW }, widened column B to 60, saved to ${ TEMPLATE_PATH }`)
}

main().catch((err) => { console.error(err); process.exit(1) })
