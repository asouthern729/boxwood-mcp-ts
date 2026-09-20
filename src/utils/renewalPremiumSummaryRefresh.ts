import ExcelJS from "exceljs"
import path from "node:path"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, readManifest, recordRenewalPremiumSummaryRefresh } from "./renewalPremiumSummaryArchive.js"
import { fetchCurrentRenewalByPolno } from "./renewalPremiumSummaryPolicyValues.js"

export class RenewalPremiumSummaryRefreshError extends Error {}

export type RenewalPremiumSummaryRefreshChange = {
  row: number
  polnos: string[]
  field: "current" | "renewal"
  old_value: number | null
  new_value: number
}

export type RenewalPremiumSummaryRefreshSkip = {
  row: number
  polnos: string[]
  reason: string
}

export type RenewalPremiumSummaryRefreshResult = {
  filename: string
  refreshed_at: string
  changes: RenewalPremiumSummaryRefreshChange[]
  skipped_rows: RenewalPremiumSummaryRefreshSkip[]
}

// Same null-means-"not itself priced", null-as-zero-once-anything-is-known combination rule
// buildRenewalPremiumSummaryWorkbook's caller uses when two policies land on the same row (see
// renewalPremiumSummary.ts's lobRows combine step) — kept identical here so a refreshed row's summed
// value can never disagree with what a fresh full regeneration would compute for the same policies.
function combineSum(values: (number | null)[]): number | null {
  if(values.every((v) => v === null)) return null
  return values.reduce((sum: number, v) => sum + (v ?? 0), 0)
}

// Updates just the Current (and, when newly known, Renewal) cells of an already-generated renewal
// premium summary in place, using the row map recorded at generation time (RenewalPremiumSummaryCellMapEntry,
// stored on the manifest entry) — deliberately does NOT rebuild row order, coverage text, Carrier,
// Trending, or anything below the main table, so nothing a CSR may have since edited by hand is ever
// touched. Percent Change is never written here either — it's a live formula on the template that
// recalculates on its own once Current/Renewal change.
export async function refreshRenewalPremiumSummary(filename: string): Promise<RenewalPremiumSummaryRefreshResult> {
  const manifest = readManifest()
  const entry = manifest.find((e) => e.filename === filename)

  if(!entry) {
    throw new RenewalPremiumSummaryRefreshError(`No archived renewal premium summary found for "${ filename }".`)
  }
  if(!entry.custid || !entry.cell_map) {
    throw new RenewalPremiumSummaryRefreshError(`"${ entry.client_name }" was generated before Refresh support existed — regenerate it once (renewal_premium_summary) to enable Refresh.`)
  }

  const freshByPolno = await fetchCurrentRenewalByPolno(entry.custid)

  const filePath = path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.getWorksheet(1)
  if(!sheet) throw new RenewalPremiumSummaryRefreshError(`${ filename } has no first worksheet.`)

  const changes: RenewalPremiumSummaryRefreshChange[] = []
  const skippedRows: RenewalPremiumSummaryRefreshSkip[] = []

  for(const cellMapEntry of entry.cell_map) {
    const { row, polnos } = cellMapEntry
    const freshEntries = polnos.map((polno) => freshByPolno.get(polno))

    // Conservative on purpose: if even one of this row's policies is no longer a current, in-force
    // commercial term (renewed into a new polid, cancelled, etc.), the row's combined figure can no
    // longer be reconstructed correctly from just what's still active — skipped rather than silently
    // understating a combined premium by dropping the missing policy's share.
    if(freshEntries.some((f) => f === undefined)) {
      skippedRows.push({ row, polnos, reason: "At least one policy on this row is no longer a current, in-force commercial term on the account — left untouched. Regenerate the report to pick up the account's current policy set." })
      continue
    }

    const freshCurrent = combineSum(freshEntries.map((f) => f!.current))
    const freshRenewal = combineSum(freshEntries.map((f) => f!.renewal))

    const cCell = sheet.getCell(`C${ row }`)
    const eCell = sheet.getCell(`E${ row }`)

    // Current is always tool-owned, synced data — never hand-entered by a CSR — so it's safe to
    // overwrite whenever it's actually changed.
    const oldCurrent = typeof cCell.value === "number" ? cCell.value : null
    if(freshCurrent !== null && freshCurrent !== oldCurrent) {
      cCell.value = freshCurrent
      changes.push({ row, polnos, field: "current", old_value: oldCurrent, new_value: freshCurrent })
    }

    // Renewal is left blank for hand entry until a successor term's premium is actually known.
    // Once anything real is sitting in that cell — a CSR's own entry, or a value an earlier Refresh
    // or the original generation already wrote — it's off-limits: only ever fills a cell that's
    // still genuinely blank, never overwrites one that already has a value, even if AMS360's own
    // successor premium has since changed.
    const eIsBlank = eCell.value === null || eCell.value === undefined || eCell.value === ""
    if(eIsBlank && freshRenewal !== null) {
      eCell.value = freshRenewal
      changes.push({ row, polnos, field: "renewal", old_value: null, new_value: freshRenewal })
    }
  }

  const refreshedAt = new Date().toISOString()
  const rawBuffer = await workbook.xlsx.writeBuffer()
  recordRenewalPremiumSummaryRefresh(filename, Buffer.from(rawBuffer as unknown as ArrayBuffer), refreshedAt)

  return { filename, refreshed_at: refreshedAt, changes, skipped_rows: skippedRows }
}
