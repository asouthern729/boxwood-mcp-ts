import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { outputDir as outputPath } from "../config/config.js"

// The shared archive shape behind the CL document index pages (risk-profile, cl-renewal-summary):
// the generated .docx files under <OUTPUT_ROOT>/<subdir>/ (retention-cron-cleaned) plus
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
  // Every included policy term's polid — lets a scheduled job tell exactly which terms already have
  // a document (scripts/dailyClRenewalSummaries.ts). Optional: entries archived before 2026-10-01
  // don't carry it (alreadyArchivedPolids falls back to the filename/polno label for those).
  polids?: string[]
  // CL Renewal Summary only: whether every term's renewal was in AMS360 when the document was built
  // ("renewal") or some line still showed the expiring term ("current") — the daily job rebuilds a
  // "current" document once the renewal lands. Absent on documents built before 2026-10-08.
  built_from?: "current" | "renewal"
  // CL Renewal Summary only: the current-term polids whose renewal term the document printed.
  renewal_polids?: string[]
  // CL Renewal Summary only: when the document was last rebuilt in place (quote upload/removal or a
  // renewal landing) — generated_at keeps the original build time. Same name as the renewal premium
  // summary's field so the index pages share "Updated Today" logic.
  last_refreshed_at?: string
  // CL Renewal Summary only: why that last rebuild happened, in staff-facing words (e.g. "Quote added:
  // Travelers.pdf") — the index page shows it on hover. Absent on entries rebuilt before it existed.
  last_refresh_reason?: string
  // CL Renewal Summary only: every coverage section in the document, in order, with whether it shows
  // renewal values (AMS360 renewal term or an uploaded quote) or still the expiring term — the index
  // page lists these under the policy numbers. Absent means the entry predates this field.
  sections?: { title: string; polno: string; renewed: boolean }[]
}

// Entries only need a filename here; DocArchiveEntry is the CSR-grouped shape the CL index pages
// share, and the Proposal Builder (proposalBuilderArchive.ts) keys its own entries on the creator.
export function createDocArchive<Entry extends { filename: string } = DocArchiveEntry>(subdir: string) {
  const outputDir = outputPath(subdir)
  const manifestPath = path.join(outputDir, "manifest.json")

  function readManifest(): Entry[] {
    if(!existsSync(manifestPath)) return []

    try {
      return JSON.parse(readFileSync(manifestPath, "utf8")) as Entry[]
    } catch {
      return []
    }
  }

  // Regenerating the same document overwrites both the file and its manifest entry (matched on
  // filename) rather than accumulating duplicates.
  function archive(buffer: Buffer, entry: Entry): void {
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
    // A PDF rendition cached beside the .docx (docxToPdf.ts) goes with it.
    const pdfPath = filePath.replace(/\.docx$/i, ".pdf")
    if(pdfPath !== filePath && existsSync(pdfPath)) unlinkSync(pdfPath)

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

// Whether a policy term already has an archived document. Entries carrying polids are matched
// exactly. Older entries fall back to what they do carry: a single-policy archive filename ends in
// the term's polid (see riskProfileGenerate.ts's keying), and a combined one is matched on polno
// plus renewal date — the same polno renews under a new polid each term, so polno alone would
// count last year's document.
export function isTermArchived(entries: DocArchiveEntry[], term: { polid: string; polno: string; renewalDate: string }): boolean {
  return entries.some((entry) => {
    if(entry.polids) return entry.polids.includes(term.polid)
    if(entry.filename.endsWith(`_${ term.polid }.docx`)) return true
    return entry.polnos.split(", ").includes(term.polno) && entry.renewal_date_label.includes(term.renewalDate)
  })
}
