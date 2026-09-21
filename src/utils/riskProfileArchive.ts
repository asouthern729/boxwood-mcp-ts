import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

// Same on-disk convention as scripts/morningDownload.ts's download-report .xlsx: written under
// scripts/output/ (gitignored, cleaned up by a host crontab entry — see the retention cron this
// tool documents) rather than committed anywhere. Its own subdirectory, sibling to
// scripts/output/download-report/, keeps it independent of that report's file-naming pattern
// reports.ts already parses via regex.
export const RISK_PROFILE_OUTPUT_DIR = path.join(import.meta.dirname, "..", "..", "scripts", "output", "cl-risk-profile")
const MANIFEST_PATH = path.join(RISK_PROFILE_OUTPUT_DIR, "manifest.json")

export type RiskProfileManifestEntry = {
  filename: string
  generated_at: string
  csr_code: string | null
  csr_name: string | null
  client_name: string
  // Comma-joined label of every included policy's polno (plural even for a single policy) — same
  // field name/shape as renewalPremiumSummaryArchive.ts's polnos, so the risk-profile and
  // renewal-premium-summaries index pages (intended to look/behave the same, per Andrew) can share
  // rendering logic rather than branching on a differently-named field.
  polnos: string
  // Sort key (YYYY-MM-DD, the soonest included renewal) — kept separate from renewal_date_label
  // since a multi-policy document can span a date range, which doesn't sort correctly as one string.
  renewal_date: string
  renewal_date_label: string
}

// Exported for the risk-profile index route (src/routes/riskProfile.ts) — reads the same
// manifest this module writes, rather than duplicating the read-and-parse logic.
export function readManifest(): RiskProfileManifestEntry[] {
  if(!existsSync(MANIFEST_PATH)) return []

  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RiskProfileManifestEntry[]
  } catch {
    return []
  }
}

// Client name/polno can carry characters that aren't safe in a filename (/, quotes, etc.) —
// collapsed to underscores the same way the tool's own emailed-attachment filename already is.
export function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unknown"
}

// Writes the finished .docx to scripts/output/cl-risk-profile/ and upserts its manifest.json
// entry. A JSON manifest (not a filename-derived listing like reports.ts's download-report page)
// because the risk-profile index page needs to group by CSR, which isn't reliably recoverable by
// parsing a filename alone. Regenerating the same policy on the same day overwrites both the file
// and its manifest entry (matched on filename) rather than accumulating duplicates.
export function archiveRiskProfile(buffer: Buffer, entry: RiskProfileManifestEntry): void {
  mkdirSync(RISK_PROFILE_OUTPUT_DIR, { recursive: true })
  writeFileSync(path.join(RISK_PROFILE_OUTPUT_DIR, entry.filename), buffer)

  const manifest = readManifest().filter((existing) => existing.filename !== entry.filename)
  manifest.push(entry)
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

// Removes both the archived .docx and its manifest entry. Returns false (no-op, nothing written)
// when there was no manifest entry for this filename to begin with, so the route can 404 instead of
// silently succeeding on a filename that was never archived. Tolerant of the file itself already
// being gone from disk (manifest entry present, file missing) — still removes the manifest entry
// rather than treating that mismatch as an error, since the end state the caller wants either way is
// "this filename is gone." Same pattern as renewalPremiumSummaryArchive.ts's deleteRenewalPremiumSummary.
export function deleteRiskProfile(filename: string): boolean {
  const manifest = readManifest()
  if(!manifest.some((existing) => existing.filename === filename)) return false

  const filePath = path.join(RISK_PROFILE_OUTPUT_DIR, filename)
  if(existsSync(filePath)) unlinkSync(filePath)

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest.filter((existing) => existing.filename !== filename), null, 2))
  return true
}
