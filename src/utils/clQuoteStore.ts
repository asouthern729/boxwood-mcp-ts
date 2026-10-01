import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CL_RENEWAL_SUMMARY_OUTPUT_DIR } from "./clRenewalSummaryArchive.js"
import type { QuoteExtraction } from "./quoteExtraction.js"

// Quote PDFs uploaded against an archived CL Renewal Summary, and what was extracted from each —
// scripts/output/cl-renewal-summary/quotes/<document>/<id>.pdf + <id>.json, where <document> is the
// archive filename minus ".docx". That archive filename is keyed on the policy terms the document
// covers (see clRenewalSummaryGenerate.ts), so every rebuild of the same terms — a rebuild after
// another upload, after a deletion, or once the renewal term lands — finds the same quotes again.

export type QuoteUploadStatus = "processing" | "done" | "error"

export type QuoteUpload = {
  id: string
  filename: string
  uploaded_at: string
  status: QuoteUploadStatus
  error?: string
  extraction?: QuoteExtraction
}

const QUOTES_DIR = path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, "quotes")

function documentDir(archiveFilename: string): string {
  return path.join(QUOTES_DIR, archiveFilename.replace(/\.docx$/i, ""))
}

function recordPath(archiveFilename: string, id: string): string {
  return path.join(documentDir(archiveFilename), `${ id }.json`)
}

export function quotePdfPath(archiveFilename: string, id: string): string {
  return path.join(documentDir(archiveFilename), `${ id }.pdf`)
}

function writeRecord(archiveFilename: string, record: QuoteUpload): void {
  writeFileSync(recordPath(archiveFilename, record.id), JSON.stringify(record, null, 2))
}

export function saveQuoteUpload(archiveFilename: string, pdf: Buffer, filename: string): QuoteUpload {
  mkdirSync(documentDir(archiveFilename), { recursive: true })

  const record: QuoteUpload = { id: randomUUID(), filename, uploaded_at: new Date().toISOString(), status: "processing" }
  writeFileSync(quotePdfPath(archiveFilename, record.id), pdf)
  writeRecord(archiveFilename, record)
  return record
}

export function completeQuoteUpload(archiveFilename: string, record: QuoteUpload, extraction: QuoteExtraction): QuoteUpload {
  const done: QuoteUpload = { ...record, status: "done", extraction }
  writeRecord(archiveFilename, done)
  return done
}

export function failQuoteUpload(archiveFilename: string, record: QuoteUpload, error: string): QuoteUpload {
  const failed: QuoteUpload = { ...record, status: "error", error }
  writeRecord(archiveFilename, failed)
  return failed
}

// Oldest first, so when two quotes cover the same line the later upload wins (clQuoteMerge.ts).
export function listQuoteUploads(archiveFilename: string): QuoteUpload[] {
  const dir = documentDir(archiveFilename)
  if(!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(path.join(dir, name), "utf8")) as QuoteUpload]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at))
}

export function completedQuoteExtractions(archiveFilename: string): { filename: string; extraction: QuoteExtraction }[] {
  return listQuoteUploads(archiveFilename)
    .filter((u): u is QuoteUpload & { extraction: QuoteExtraction } => u.status === "done" && u.extraction !== undefined)
    .map((u) => ({ filename: u.filename, extraction: u.extraction }))
}

export function deleteQuoteUpload(archiveFilename: string, id: string): boolean {
  const json = recordPath(archiveFilename, id)
  if(!existsSync(json)) return false

  unlinkSync(json)
  const pdf = quotePdfPath(archiveFilename, id)
  if(existsSync(pdf)) unlinkSync(pdf)
  return true
}

// When the document itself is deleted from the archive, its quotes go with it.
export function deleteAllQuoteUploads(archiveFilename: string): void {
  rmSync(documentDir(archiveFilename), { recursive: true, force: true })
}
