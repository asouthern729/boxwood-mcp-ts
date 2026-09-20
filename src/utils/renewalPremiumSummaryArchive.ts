import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { RenewalPremiumSummaryCellMapEntry } from "./renewalPremiumSummaryWorkbook.js"

// Same on-disk convention as riskProfileArchive.ts's cl-risk-profile dir — written under
// scripts/output/ (gitignored, retention-cron-cleaned), its own subdirectory since this is a
// distinct tool/output (renewal_premium_summary's xlsx, not risk_profile's docx).
export const RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR = path.join(import.meta.dirname, "..", "..", "scripts", "output", "cl-renewal-premium-summaries")
const MANIFEST_PATH = path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, "manifest.json")

export type RenewalPremiumSummaryManifestEntry = {
  filename: string
  generated_at: string
  // Needed to re-query AMS360 for the Refresh path (renewalPremiumSummaryRefresh.ts) — the filename
  // above already embeds it, but parsing an ID back out of a sanitized filename is exactly the kind
  // of fragile string-matching Refresh is trying to avoid, so it's carried as its own field instead.
  // Optional: entries archived before Refresh shipped won't have it (or cell_map below) — those
  // reports simply aren't refreshable until regenerated once.
  custid?: string
  csr_code: string | null
  csr_name: string | null
  client_name: string
  // renewal_premium_summary is always account-scoped (custid, not polno) and can combine several
  // policies' lines of business into one workbook — a comma-joined label of every included policy's
  // polno, not a single value like riskProfile.ts's own polnos field.
  polnos: string
  // Sort key (YYYY-MM-DD, the soonest included renewal) — kept separate from renewal_date_label
  // since a multi-policy account can span a date range, which doesn't sort correctly as one string.
  renewal_date: string
  renewal_date_label: string
  // Which physical row each policy's Current/Renewal cells landed on at generation time — see
  // RenewalPremiumSummaryCellMapEntry's own comment. Lets Refresh update just those cells in the
  // already-archived file without re-deriving row order. Same "may be missing on older entries" as
  // custid above.
  cell_map?: RenewalPremiumSummaryCellMapEntry[]
  // Set only after a Refresh (never on the original generation) — distinguishes "built fresh" from
  // "values touched up since," both for the index page and so a second Refresh knows this file may
  // already differ from its own cell_map's original values.
  last_refreshed_at?: string
}

// Exported for the renewal-premium-summaries index route (src/routes/renewalPremiumSummaries.ts) —
// reads the same manifest this module writes, rather than duplicating the read-and-parse logic.
export function readManifest(): RenewalPremiumSummaryManifestEntry[] {
  if(!existsSync(MANIFEST_PATH)) return []

  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RenewalPremiumSummaryManifestEntry[]
  } catch {
    return []
  }
}

// Writes the finished .xlsx to scripts/output/cl-renewal-premium-summaries/ and upserts its
// manifest.json entry. Regenerating for the same account overwrites both the file and its manifest
// entry (matched on filename) rather than accumulating duplicates — the tool always rebuilds the
// account's full current picture, so there's never a reason to keep a stale prior version around.
export function archiveRenewalPremiumSummary(buffer: Buffer, entry: RenewalPremiumSummaryManifestEntry): void {
  mkdirSync(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, { recursive: true })
  writeFileSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, entry.filename), buffer)

  const manifest = readManifest().filter((existing) => existing.filename !== entry.filename)
  manifest.push(entry)
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

// Overwrites just the archived file's bytes and stamps last_refreshed_at on its manifest entry —
// used by the Refresh path (renewalPremiumSummaryRefresh.ts), which only ever touches a handful of
// value cells in the existing workbook rather than rebuilding it, so every other manifest field
// (cell_map, csr_code, polnos, etc.) stays exactly as it was at original generation.
export function recordRenewalPremiumSummaryRefresh(filename: string, buffer: Buffer, refreshedAt: string): void {
  writeFileSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename), buffer)

  const manifest = readManifest()
  const index = manifest.findIndex((existing) => existing.filename === filename)
  if(index === -1) throw new Error(`No manifest entry for ${ filename } — cannot record refresh`)

  manifest[index] = { ...manifest[index], last_refreshed_at: refreshedAt }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

// Removes both the archived .xlsx and its manifest entry. Returns false (no-op, nothing written)
// when there was no manifest entry for this filename to begin with, so the route can 404 instead of
// silently succeeding on a filename that was never archived. Tolerant of the file itself already
// being gone from disk (manifest entry present, file missing) — still removes the manifest entry
// rather than treating that mismatch as an error, since the end state the caller wants either way is
// "this filename is gone."
export function deleteRenewalPremiumSummary(filename: string): boolean {
  const manifest = readManifest()
  if(!manifest.some((existing) => existing.filename === filename)) return false

  const filePath = path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename)
  if(existsSync(filePath)) unlinkSync(filePath)

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest.filter((existing) => existing.filename !== filename), null, 2))
  return true
}
