import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

// The shared archive shape behind the CL document index pages (risk-profile, cl-renewal-summary):
// the generated .docx files under scripts/output/<subdir>/ (gitignored, retention-cron-cleaned) plus
// a manifest.json of entries keyed by filename. A JSON manifest (not a filename-derived listing like
// reports.ts's download-report page) because the index pages group by CSR, which isn't reliably
// recoverable by parsing a filename alone. renewalPremiumSummaryArchive.ts predates this and keeps
// its own copy, since its entries carry Refresh-specific fields (cell_map etc.).
//
// This is the interim filing location. The client's hard requirement is that these documents land
// in SharePoint (Commercial Lines/Client Renewal Info/<client>/<year>/) rather than being emailed —
// once that Graph access exists, `archive` is the one place to add the upload.
export type DocArchiveEntry = {
  filename: string
  generated_at: string
  csr_code: string | null
  csr_name: string | null
  client_name: string
  // Comma-joined label of every included policy's polno (plural even for a single policy) — same
  // field name/shape as renewalPremiumSummaryArchive.ts's polnos, so the index pages (intended to
  // look/behave the same, per Andrew) can share rendering logic rather than branching on a
  // differently-named field.
  polnos: string
  // Sort key (YYYY-MM-DD, the soonest included renewal) — kept separate from renewal_date_label
  // since a multi-policy document can span a date range, which doesn't sort correctly as one string.
  renewal_date: string
  renewal_date_label: string
}

export function createDocArchive(subdir: string) {
  const outputDir = path.join(import.meta.dirname, "..", "..", "scripts", "output", subdir)
  const manifestPath = path.join(outputDir, "manifest.json")

  function readManifest(): DocArchiveEntry[] {
    if(!existsSync(manifestPath)) return []

    try {
      return JSON.parse(readFileSync(manifestPath, "utf8")) as DocArchiveEntry[]
    } catch {
      return []
    }
  }

  // Regenerating the same document overwrites both the file and its manifest entry (matched on
  // filename) rather than accumulating duplicates.
  function archive(buffer: Buffer, entry: DocArchiveEntry): void {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(path.join(outputDir, entry.filename), buffer)

    const manifest = readManifest().filter((existing) => existing.filename !== entry.filename)
    manifest.push(entry)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }

  // Removes both the archived .docx and its manifest entry. Returns false (no-op, nothing written)
  // when there was no manifest entry for this filename to begin with, so the route can 404 instead
  // of silently succeeding on a filename that was never archived. Tolerant of the file itself
  // already being gone from disk (manifest entry present, file missing) — still removes the
  // manifest entry rather than treating that mismatch as an error, since the end state the caller
  // wants either way is "this filename is gone."
  function remove(filename: string): boolean {
    const manifest = readManifest()
    if(!manifest.some((existing) => existing.filename === filename)) return false

    const filePath = path.join(outputDir, filename)
    if(existsSync(filePath)) unlinkSync(filePath)

    writeFileSync(manifestPath, JSON.stringify(manifest.filter((existing) => existing.filename !== filename), null, 2))
    return true
  }

  return { outputDir, readManifest, archive, remove }
}

// Client name/polno can carry characters that aren't safe in a filename (/, quotes, etc.) —
// collapsed to underscores.
export function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unknown"
}
