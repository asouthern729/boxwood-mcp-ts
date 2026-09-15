import ExcelJS from "exceljs"
import path from "node:path"

// Loads and fills in Patrick's actual template (assets/templates/commercial-renewal-template.xlsx —
// see scripts/templatePrep/prepRenewalPremiumTemplate.py for how it was derived from his original
// CL_Renewal_Premium_Summary.xlsx, permission given to reuse it directly) rather than rebuilding the
// layout from scratch — real styling, real formulas (Percent Change, TOTAL PREMIUM), not an
// approximation of them.
const TEMPLATE_PATH = path.join(import.meta.dirname, "..", "..", "assets", "templates", "commercial-renewal-template.xlsx")

// Row order matches the template's fixed 8-line-of-business table (rows 12-19) exactly — also used
// as the priority order for picking a Package policy's "primary" line (client feedback, 2026-09-13:
// put the whole blended premium on the policy's primary line rather than attempting an unreliable
// per-line split — General Liability first, as the usual anchor coverage for a bundled program).
export const LOB_ROW_ORDER = ["CGL", "PROP", "AUTOB", "CUMBR", "WORK", "EPLI", "INMRC", "DO"] as const
export type KnownLobCode = typeof LOB_ROW_ORDER[number]

const FIRST_LOB_ROW = 12 // through 19 — always exactly 8 rows, one per LOB_ROW_ORDER entry

// The template's own label/Trending text per line, keyed by code rather than fixed row position —
// needed because rows are now reordered per generation (populated lines first; see
// buildRenewalPremiumSummaryWorkbook), so a line's label/Trending has to travel with it rather than
// stay pinned to whichever row it originally occupied in the template.
const LOB_LABEL: Record<KnownLobCode, string> = {
  CGL: "General Liability ", PROP: "Property", AUTOB: "Auto", CUMBR: "Umbrella",
  WORK: "Workers Comp", EPLI: "EPLI", INMRC: "Inland Marine", DO: "D&O"
}
const LOB_TRENDING: Record<KnownLobCode, string> = {
  CGL: "+1% to +9%", PROP: "flat to +10%", AUTOB: "+5% to +15%", CUMBR: "+10% to +20%",
  WORK: "-2% to +2%", EPLI: "0 to +5%", INMRC: "0 to +15%", DO: "0 to +5%"
}

const NUM_SPARE_ROWS = 3 // matches prepRenewalPremiumTemplate.py's NUM_BLANK_ROWS
const FIRST_SPARE_ROW = 20
// Row 23 (TOTAL PREMIUM) is never written to directly — its SUM/Percent-Change formulas are already
// baked into the template and just pick up whatever lands in C12:C22/E12:E22 above.
const OTHER_POLICIES_FIRST_ROW = 27
const OTHER_POLICIES_MAX_ROWS = 6 // matches the template's 6 pre-styled "other" data rows (27-32)

export type LobRowFill = { current: number | null; carrier: string; coverage: string; policyNos: string }
export type ExtraRow = { coverage: string; policyNos: string; current: number | null; carrier: string }
export type OtherPolicyRow = { coveragePolicy: string; expirationDate: string }

export type RenewalPremiumSummaryInput = {
  clientName: string
  renewalDateLabel: string
  lobRows: Partial<Record<KnownLobCode, LobRowFill>>
  extraRows: ExtraRow[]
  otherPolicies: OtherPolicyRow[]
}

// Client feedback (2026-09-15): show Policy # to the right of the coverage text, in a smaller
// italic font, rather than on its own line (which would need taller rows to avoid clipping).
// ExcelJS represents mixed-formatting-within-one-cell as `richText` runs, each with its own font —
// captures the cell's EXISTING font first (whatever the template already has for that row, e.g.
// bold green Calibri 11) and reuses it verbatim for the coverage run, so this doesn't hardcode a
// font that could drift from the template's own styling on a future revision.
function setCoverageCell(cell: ExcelJS.Cell, coverage: string, policyNos: string): void {
  const baseFont = cell.font
  cell.value = {
    richText: [
      { font: baseFont, text: coverage },
      { font: { ...baseFont, size: Math.max(7, (baseFont.size ?? 11) - 3), bold: false, italic: true }, text: `  ${ policyNos }` }
    ]
  }
}

export async function buildRenewalPremiumSummaryWorkbook(input: RenewalPremiumSummaryInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)
  const sheet = workbook.getWorksheet(1)
  if(!sheet) throw new Error("commercial-renewal-template.xlsx has no first worksheet")

  sheet.getCell("C6").value = input.clientName
  sheet.getCell("C7").value = input.renewalDateLabel

  // Client feedback (2026-09-15, final ordering): the 8 known coverage types always print first as
  // one block — populated ones among themselves first, then the remaining empty ones — matching the
  // template's own original fixed 8-line table. Extra/unmatched policies (a Package with no known
  // line at all, or a monoline policy in a line the template has no fixed row for — e.g. Surety)
  // print after that whole block, not interleaved with it. Whatever's left of the template's fixed
  // 11-row budget (rows 12-22) after both groups shows as blank rows — however many that happens to
  // be, not padded/forced to any particular count. This stays entirely within the template's
  // existing fixed layout (TOTAL PREMIUM's row/formula range, everything below it) rather than
  // inserting rows to grow the sheet.
  type RowEntry =
    | { kind: "known"; code: KnownLobCode; fill: LobRowFill }
    | { kind: "extra"; extra: ExtraRow }
    | { kind: "blank" }
    | { kind: "empty"; code: KnownLobCode }

  const populatedKnown: RowEntry[] = LOB_ROW_ORDER
    .filter((code) => input.lobRows[code])
    .map((code) => ({ kind: "known", code, fill: input.lobRows[code]! }))
  const emptyKnown: RowEntry[] = LOB_ROW_ORDER
    .filter((code) => !input.lobRows[code])
    .map((code) => ({ kind: "empty", code }))
  // Capped at NUM_SPARE_ROWS — more unmatched policies than that simply aren't placed, same overflow
  // behavior as before, since there's no more room in the fixed template without inserting rows.
  const populatedExtra: RowEntry[] = input.extraRows
    .slice(0, NUM_SPARE_ROWS)
    .map((extra) => ({ kind: "extra", extra }))

  const TOTAL_ROWS = (FIRST_SPARE_ROW + NUM_SPARE_ROWS) - FIRST_LOB_ROW
  const mainEntries: RowEntry[] = [...populatedKnown, ...emptyKnown, ...populatedExtra]
  const blanks: RowEntry[] = Array.from({ length: Math.max(0, TOTAL_ROWS - mainEntries.length) }, () => ({ kind: "blank" }))
  const entries = [...mainEntries, ...blanks].slice(0, TOTAL_ROWS)

  entries.forEach((entry, i) => {
    const row = FIRST_LOB_ROW + i
    const bCell = sheet.getCell(`B${ row }`)

    if(entry.kind === "known") {
      // Trending only applies to a known coverage line (it's an inherent property of the line
      // itself, e.g. "+1% to +9%" for General Liability) — shown whether or not it's populated, so
      // the reader still sees the benchmark range for a line this account doesn't currently carry.
      sheet.getCell(`H${ row }`).value = LOB_TRENDING[entry.code]
      setCoverageCell(bCell, entry.fill.coverage, entry.fill.policyNos)
      if(entry.fill.current !== null) sheet.getCell(`C${ row }`).value = entry.fill.current
      sheet.getCell(`D${ row }`).value = entry.fill.carrier
    } else if(entry.kind === "extra") {
      // No Trending — an extra/unmatched policy isn't one of the 8 tracked lines, so no benchmark
      // range applies. Explicitly cleared, not just left unwritten: this row may now land on a
      // template row position (12-19) that already has one of the 8 known lines' own Trending value
      // baked in from the template's default layout, which would otherwise leak through untouched.
      sheet.getCell(`H${ row }`).value = null
      setCoverageCell(bCell, entry.extra.coverage, entry.extra.policyNos)
      if(entry.extra.current !== null) sheet.getCell(`C${ row }`).value = entry.extra.current
      sheet.getCell(`D${ row }`).value = entry.extra.carrier
    } else if(entry.kind === "blank") {
      // Explicitly cleared (not just left unwritten) for the same reason as the "extra" case above —
      // this row may land on a template position that already has default label/Trending content.
      bCell.value = null
      sheet.getCell(`C${ row }`).value = null
      sheet.getCell(`D${ row }`).value = null
      sheet.getCell(`H${ row }`).value = null
    } else {
      sheet.getCell(`H${ row }`).value = LOB_TRENDING[entry.code]
      bCell.value = LOB_LABEL[entry.code]
    }
  })

  const otherPolicies = input.otherPolicies.slice(0, OTHER_POLICIES_MAX_ROWS)
  otherPolicies.forEach((other, i) => {
    const row = OTHER_POLICIES_FIRST_ROW + i
    sheet.getCell(`A${ row }`).value = other.coveragePolicy
    sheet.getCell(`D${ row }`).value = other.expirationDate
  })

  // Client feedback (2026-09-15): "unwanted empty rows" — the template pre-styles all
  // OTHER_POLICIES_MAX_ROWS rows with borders and light shading regardless of whether that many
  // "other" policies actually exist, so an account with fewer than the max (Defatta: 4 of 6) shows
  // trailing rows that look like intended-but-blank entries. Clears border/fill on every column of
  // any row beyond the real data (not just A/D, which is all that's ever written) so it renders as a
  // plain blank row instead. Only touches rows that are ENTIRELY unused — doesn't attempt to split a
  // "quote notes" box that spans two policy rows (F27:H28 etc.) when an odd otherPolicies count
  // leaves just one half of that pair unused, since only the box's own top-left cell actually
  // carries its visible border/fill.
  for(let i = otherPolicies.length; i < OTHER_POLICIES_MAX_ROWS; i++) {
    const row = OTHER_POLICIES_FIRST_ROW + i
    for(const col of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      const cell = sheet.getCell(`${ col }${ row }`)
      // Assigning the WHOLE style object (not mutating .border/.fill as separate sub-property
      // writes) matters here: this template has several rows sharing one underlying style record
      // (confirmed via the raw XML — rows 28-32's column A all point at the same style index), and
      // ExcelJS's per-property setters mutate that shared record in place rather than cloning it per
      // cell — a `cell.border = {}` on an unused row silently blanked the SAME style on the
      // populated rows sharing it too. Spreading `cell.style` into a fresh object first forces a
      // distinct style for this one cell.
      cell.style = { ...cell.style, border: {}, fill: { type: "pattern", pattern: "none" } }
    }
  }

  const rawBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(rawBuffer as unknown as ArrayBuffer)
}
