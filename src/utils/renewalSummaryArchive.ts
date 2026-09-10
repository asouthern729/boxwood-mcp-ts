import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Same on-disk convention as scripts/morningDownload.ts's download-report .xlsx: written under
// scripts/output/ (gitignored, cleaned up by a host crontab entry — see the retention cron this
// tool documents) rather than committed anywhere. Its own subdirectory, sibling to
// scripts/output/download-report/, keeps it independent of that report's file-naming pattern
// reports.ts already parses via regex.
export const RENEWAL_SUMMARY_OUTPUT_DIR = path.join(import.meta.dirname, "..", "..", "scripts", "output", "cl-renewal-summaries")
const MANIFEST_PATH = path.join(RENEWAL_SUMMARY_OUTPUT_DIR, "manifest.json")

export type RenewalSummaryManifestEntry = {
  filename: string
  generated_at: string
  csr_code: string | null
  csr_name: string | null
  client_name: string
  polno: string
  carrier_name: string | null
  // The policy term's own polexpdate (YYYY-MM-DD) — when the renewal is actually due, distinct
  // from generated_at (when this document happened to be built). The renewal-summaries index page
  // sorts by this, not generated_at, so a CSR sees their soonest-due renewals first.
  renewal_date: string
}

// Exported for the renewal-summaries index route (src/routes/renewalSummaries.ts) — reads the same
// manifest this module writes, rather than duplicating the read-and-parse logic.
export function readManifest(): RenewalSummaryManifestEntry[] {
  if(!existsSync(MANIFEST_PATH)) return []

  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RenewalSummaryManifestEntry[]
  } catch {
    return []
  }
}

// Client name/polno can carry characters that aren't safe in a filename (/, quotes, etc.) —
// collapsed to underscores the same way the tool's own emailed-attachment filename already is.
export function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unknown"
}

// Writes the finished .docx to scripts/output/cl-renewal-summaries/ and upserts its manifest.json
// entry. A JSON manifest (not a filename-derived listing like reports.ts's download-report page)
// because a future renewal-summaries index page needs to group by CSR, which isn't reliably
// recoverable by parsing a filename alone. Regenerating the same policy on the same day overwrites
// both the file and its manifest entry (matched on filename) rather than accumulating duplicates.
export function archiveRenewalSummary(buffer: Buffer, entry: RenewalSummaryManifestEntry): void {
  mkdirSync(RENEWAL_SUMMARY_OUTPUT_DIR, { recursive: true })
  writeFileSync(path.join(RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename), buffer)

  const manifest = readManifest().filter((existing) => existing.filename !== entry.filename)
  manifest.push(entry)
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}
