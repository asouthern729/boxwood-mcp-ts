import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Persists the boundary between "already covered by a successfully-generated morning download
// report" and "not yet reported" — see the 2026-09-16/17 vendor-download-gap incident: a row's
// `entereddate` reflects AMS360's own write time, not when it actually reached our database, so a
// window bound purely off `entereddate` (fixed calendar cutoff, or even "max entereddate we've
// already reported") can permanently strand a row that syncs into Postgres a day or more late —
// its `entereddate` will always read as "before" whatever `entereddate`-based boundary we've
// already advanced past, even though we never actually saw it in time. `synced_at` doesn't have
// this problem: confirmed against real data it's set once at a row's first INSERT and never
// touched again by a later UPDATE (unlike `changeddate`), so it only ever moves forward relative
// to what we've already ingested — safe to use as the "have we already reported this" cursor.
//
// download_report itself still windows primarily on `entereddate` (see its own file for why) —
// this watermark instead drives an *additional* `synced_since` bound scripts/morningDownload.ts
// passes alongside a generous `entereddate` lookback, so nothing that syncs late gets silently
// skipped by the next day's run.
const WATERMARK_PATH = path.join(import.meta.dirname, "..", "..", "scripts", "state", "download-report-watermark.json")

export function readDownloadReportWatermark(): Date | null {
  if(!existsSync(WATERMARK_PATH)) return null

  try {
    const { syncedUntil } = JSON.parse(readFileSync(WATERMARK_PATH, "utf-8"))
    const parsed = new Date(syncedUntil)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  } catch {
    return null
  }
}

// Only call this after a report has actually been generated successfully — advancing the
// watermark on a failed/partial run would make the next run silently skip whatever that run was
// supposed to cover.
export function writeDownloadReportWatermark(syncedUntil: Date): void {
  mkdirSync(path.dirname(WATERMARK_PATH), { recursive: true })
  writeFileSync(WATERMARK_PATH, JSON.stringify({ syncedUntil: syncedUntil.toISOString() }, null, 2))
}
