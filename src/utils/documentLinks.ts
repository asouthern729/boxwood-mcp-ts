import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { CL_RENEWAL_SUMMARY_OUTPUT_DIR, readClRenewalSummaryManifest, type ClRenewalSummaryManifestEntry } from "./clRenewalSummaryArchive.js"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, readManifest as readPremiumManifest, type RenewalPremiumSummaryManifestEntry } from "./renewalPremiumSummaryArchive.js"

// Links between an account's renewal documents, so the dashboard can jump from one to the other
// (Andrew, 2026-11-21) — and, next, carry the Renewal Premium Spreadsheet's premiums into the CL
// Renewal Summary.
//
// Identity: each archived document gets an opaque, stable id — a name-based UUID (v5) of its tool and
// archive filename. Archive filenames are already unique and stable per document (a CL Renewal Summary
// per expiring policy term or combined set; a spreadsheet per account), so the id needs no stored state
// and survives a rebuild in place. It's what the dashboard puts in the URL instead of the filename,
// which carries the client's name.
//
// Link key: the expiring policy term (polid). Both documents are about renewing the same terms; a
// polno alone repeats from year to year, so it could pair this year's spreadsheet with last year's
// summary. A CL Renewal Summary records its terms (polids); a spreadsheet records each row's
// (cell_map polids — Refresh fills them in on older workbooks). Documents sharing a term are linked;
// one spreadsheet can link to several summaries when an account's terms were built separately.

export type DocumentTool = "cl-renewal-summary" | "renewal-premium-summary"
export type DocumentLink = { tool: DocumentTool; id: string; label: string }

// Fixed namespace for this app's document ids (RFC 4122 v5 hashes a namespace UUID with the name).
const NAMESPACE = Buffer.from("4f1c2b6e9d8a4e5b8c7d6e5f4a3b2c1d", "hex")

export function documentId(tool: DocumentTool, filename: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(`${ tool }:${ filename }`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50 // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex")
  return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-${ hex.slice(12, 16) }-${ hex.slice(16, 20) }-${ hex.slice(20, 32) }`
}

export function spreadsheetPolids(entry: RenewalPremiumSummaryManifestEntry): Set<string> {
  return new Set((entry.cell_map ?? []).flatMap((row) => row.polids ?? []))
}

const shares = (polids: Iterable<string>, other: Set<string>) => [...polids].some((polid) => other.has(polid))

// Only documents whose file is still on disk — the same filter each index page applies.
const onDisk = (dir: string) => <E extends { filename: string }>(entry: E) => existsSync(path.join(dir, entry.filename))

// The spreadsheet(s) for a CL Renewal Summary's terms. Entries without polids (archived before they
// were recorded) link to nothing.
//
// Several only when a summary's terms span two renewal months (spreadsheets are per account per
// renewal month) — then each is named by its month.
export function linksForClRenewalSummary(entry: ClRenewalSummaryManifestEntry, spreadsheets = readPremiumManifest().filter(onDisk(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR))): DocumentLink[] {
  if(!entry.polids?.length) return []
  const linked = spreadsheets.filter((sheet) => shares(entry.polids!, spreadsheetPolids(sheet)))
  return linked.map((sheet) => ({
    tool: "renewal-premium-summary",
    id: documentId("renewal-premium-summary", sheet.filename),
    label: linked.length > 1 ? `Renewal Premium Spreadsheet (${ monthLabel(sheet.renewal_date) })` : "Renewal Premium Spreadsheet"
  }))
}

// "Feb 2027" from a YYYY-MM-DD date.
function monthLabel(date: string): string {
  return new Date(`${ date.slice(0, 7) }-15T12:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

// Finds an archived document by its id, or undefined.
export function findSpreadsheet(id: string): RenewalPremiumSummaryManifestEntry | undefined {
  return readPremiumManifest().filter(onDisk(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR)).find((entry) => documentId("renewal-premium-summary", entry.filename) === id)
}

export function findClRenewalSummary(id: string): ClRenewalSummaryManifestEntry | undefined {
  return readClRenewalSummaryManifest().filter(onDisk(CL_RENEWAL_SUMMARY_OUTPUT_DIR)).find((entry) => documentId("cl-renewal-summary", entry.filename) === id)
}

// The CL Renewal Summaries for a spreadsheet's terms — named by policy number when there's more
// than one, so the buttons can be told apart.
export function linksForRenewalPremiumSummary(entry: RenewalPremiumSummaryManifestEntry, summaries = readClRenewalSummaryManifest().filter(onDisk(CL_RENEWAL_SUMMARY_OUTPUT_DIR))): DocumentLink[] {
  const polids = spreadsheetPolids(entry)
  if(polids.size === 0) return []
  const linked = summaries.filter((summary) => summary.polids && shares(summary.polids, polids))
  return linked.map((summary) => ({
    tool: "cl-renewal-summary",
    id: documentId("cl-renewal-summary", summary.filename),
    label: linked.length > 1 ? `CL Renewal Summary (${ summary.polnos })` : "CL Renewal Summary"
  }))
}
