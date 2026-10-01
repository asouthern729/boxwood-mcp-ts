import { readFileSync } from "node:fs"
import path from "node:path"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, readManifest, recordRenewalPremiumSummaryCellMap, recordRenewalPremiumSummaryRefresh } from "./renewalPremiumSummaryArchive.js"
import { fetchCurrentRenewalByPolno } from "./renewalPremiumSummaryPolicyValues.js"
import type { NumericCellEdit } from "./xlsxCellPatch.js"
import { patchNumericCells, readCells } from "./xlsxCellPatch.js"

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
  // false when nothing needed updating (or dry_run) — the archived file and manifest entry were left
  // exactly as they were.
  written: boolean
  dry_run: boolean
  changes: RenewalPremiumSummaryRefreshChange[]
  skipped_rows: RenewalPremiumSummaryRefreshSkip[]
}

export type RefreshRenewalPremiumSummaryOptions = {
  // Computes and returns the would-be changes without writing the file or the manifest.
  dryRun?: boolean
}

// YYYY-MM-DD in agency-local time, to compare against poleffdate (a plain local date).
function localDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso))
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
// or anything below the main table. Percent Change and TOTAL are never written either —
// they're live template formulas that recalculate once Current/Renewal change.
//
// Built to be safe on a workbook an employee has since opened and edited (the files are headed for
// OneDrive): cells are read and written straight from the package XML (xlsxCellPatch.ts) — no
// ExcelJS load/re-serialize — so only the changed cells differ, and notes, comments, and anything
// else in the package are carried over untouched. Nothing is written at all when there's nothing to change. Called by the index page's
// Refresh button and by scripts/weeklyRenewalPremiumSummaryRefresh.ts.
export async function refreshRenewalPremiumSummary(filename: string, options: RefreshRenewalPremiumSummaryOptions = {}): Promise<RenewalPremiumSummaryRefreshResult> {
  const dryRun = options.dryRun ?? false
  const manifest = readManifest()
  const entry = manifest.find((e) => e.filename === filename)

  if(!entry) {
    throw new RenewalPremiumSummaryRefreshError(`No archived renewal premium summary found for "${ filename }".`)
  }
  if(!entry.custid || !entry.cell_map) {
    throw new RenewalPremiumSummaryRefreshError(`"${ entry.client_name }" was generated before Refresh support existed — regenerate it once (renewal_premium_summary) to enable Refresh.`)
  }

  const freshByPolno = await fetchCurrentRenewalByPolno(entry.custid)
  const generatedOn = localDateOf(entry.generated_at)

  const filePath = path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename)
  const originalBuffer = readFileSync(filePath)
  const cells = await readCells(originalBuffer, 1, entry.cell_map.flatMap(({ row }) => [`B${ row }`, `C${ row }`, `E${ row }`]))

  const changes: RenewalPremiumSummaryRefreshChange[] = []
  const skippedRows: RenewalPremiumSummaryRefreshSkip[] = []
  const edits: NumericCellEdit[] = []
  const updatedCellMap = entry.cell_map.map((cellMapEntry) => ({ ...cellMapEntry }))

  for(const cellMapEntry of updatedCellMap) {
    const { row, polnos } = cellMapEntry

    // Row anchor: the coverage cell (B) carries the row's policy #s (setCoverageCell). If an employee
    // has inserted/deleted/moved rows, cell_map's row number now points at some other line — skipped
    // rather than written into the wrong row.
    const coverageCell = cells.get(`B${ row }`)!
    const coverageText = coverageCell.kind === "text" ? coverageCell.text : ""
    if(!polnos.every((polno) => coverageText.includes(polno))) {
      skippedRows.push({ row, polnos, reason: "Row no longer shows its policy number(s) — the sheet has been edited or rows moved, so it was left untouched." })
      continue
    }

    const freshEntries = polnos.map((polno) => freshByPolno.get(polno))

    // Conservative on purpose: if even one of this row's policies is no longer a current, in-force
    // commercial term (renewed into a new polid, cancelled, etc.), the row's combined figure can no
    // longer be reconstructed correctly from just what's still active — skipped rather than silently
    // understating a combined premium by dropping the missing policy's share.
    if(freshEntries.some((f) => f === undefined)) {
      skippedRows.push({ row, polnos, reason: "At least one policy on this row is no longer a current, in-force commercial term on the account — left untouched. Regenerate the report to pick up the account's current policy set." })
      continue
    }

    // Once a renewal takes effect, the same polno's in-force term IS the renewal — its premium is
    // not this report's Current (the expiring term's), so the row is frozen from then on.
    if(freshEntries.some((f) => f!.poleffdate > generatedOn)) {
      skippedRows.push({ row, polnos, reason: "A policy on this row has renewed into a new term since this report was built — left untouched." })
      continue
    }

    const freshCurrent = combineSum(freshEntries.map((f) => f!.current))
    const freshRenewal = combineSum(freshEntries.map((f) => f!.renewal))

    const cReading = cells.get(`C${ row }`)!
    const eReading = cells.get(`E${ row }`)!

    // Current is tool-owned, but only while the cell still holds exactly what the tool last wrote —
    // anything else (a different number, text, a formula) means a person has edited it, and it's
    // theirs from then on. Entries archived before cell_map carried written values have no record to
    // compare against: whatever is in the file is taken as tool-written (true for every pre-OneDrive
    // server copy, which nobody can edit), and the first Refresh that writes records it going forward.
    const lastWrittenCurrent = cellMapEntry.current !== undefined
      ? cellMapEntry.current
      : cReading.kind === "number" ? cReading.value : null
    const currentUntouched = lastWrittenCurrent === null
      ? cReading.kind === "blank"
      : cReading.kind === "number" && cReading.value === lastWrittenCurrent

    if(freshCurrent !== null && freshCurrent !== lastWrittenCurrent) {
      if(currentUntouched) {
        edits.push({ ref: `C${ row }`, value: freshCurrent })
        changes.push({ row, polnos, field: "current", old_value: lastWrittenCurrent, new_value: freshCurrent })
        cellMapEntry.current = freshCurrent
      } else {
        skippedRows.push({ row, polnos, reason: `Current has been edited by hand — left as is (AMS360 now shows ${ freshCurrent }).` })
      }
    } else if(cellMapEntry.current === undefined && currentUntouched) {
      cellMapEntry.current = lastWrittenCurrent
    }

    // Renewal is left blank for hand entry until a successor term's premium is actually known, and
    // only ever fills a cell that's still genuinely blank — never overwrites anything already there
    // (an employee's entry, or what the tool itself wrote earlier), even if AMS360's figure changes.
    if(eReading.kind === "blank" && freshRenewal !== null) {
      edits.push({ ref: `E${ row }`, value: freshRenewal })
      changes.push({ row, polnos, field: "renewal", old_value: null, new_value: freshRenewal })
      cellMapEntry.renewal = freshRenewal
    } else if(cellMapEntry.renewal === undefined) {
      cellMapEntry.renewal = eReading.kind === "number" ? eReading.value : null
    }
  }

  const refreshedAt = new Date().toISOString()

  if(dryRun) {
    return { filename, refreshed_at: refreshedAt, written: false, dry_run: true, changes, skipped_rows: skippedRows }
  }

  if(edits.length === 0) {
    const seededBaseline = updatedCellMap.some((e, i) => e.current !== entry.cell_map![i].current || e.renewal !== entry.cell_map![i].renewal)
    if(seededBaseline) recordRenewalPremiumSummaryCellMap(filename, updatedCellMap)
    return { filename, refreshed_at: refreshedAt, written: false, dry_run: false, changes, skipped_rows: skippedRows }
  }

  const { buffer, missing } = await patchNumericCells(originalBuffer, 1, edits)

  // A target cell with no <c> element at all means the sheet's shape changed under us — that one
  // change is dropped (and reported), never inserted.
  const appliedChanges = changes.filter((change) => !missing.includes(`${ change.field === "current" ? "C" : "E" }${ change.row }`))
  for(const ref of missing) {
    const row = Number(ref.slice(1))
    const cellMapEntry = updatedCellMap.find((e) => e.row === row)!
    const original = entry.cell_map.find((e) => e.row === row)!
    if(ref.startsWith("C")) cellMapEntry.current = original.current
    else cellMapEntry.renewal = original.renewal
    skippedRows.push({ row, polnos: cellMapEntry.polnos, reason: `Cell ${ ref } no longer exists in the sheet — left untouched.` })
  }

  if(appliedChanges.length === 0) {
    return { filename, refreshed_at: refreshedAt, written: false, dry_run: false, changes: [], skipped_rows: skippedRows }
  }

  recordRenewalPremiumSummaryRefresh(filename, buffer, refreshedAt, updatedCellMap)

  return { filename, refreshed_at: refreshedAt, written: true, dry_run: false, changes: appliedChanges, skipped_rows: skippedRows }
}
