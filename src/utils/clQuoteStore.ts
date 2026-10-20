import path from "node:path"
import { CL_RENEWAL_SUMMARY_OUTPUT_DIR } from "./clRenewalSummaryArchive.js"
import type { QuoteExtraction } from "./quoteExtraction.js"
import {
  deleteUpload, deleteUploadDir, listUploads, saveUpload, uploadFilePath, writeUploadRecord, type UploadRecord, type UploadStatus
} from "./uploadStore.js"

// Quote PDFs uploaded against an archived CL Renewal Summary, and what was extracted from each —
// <OUTPUT_ROOT>/cl-renewal-summary/quotes/<document>/<id>.pdf + <id>.json, where <document> is the
// archive filename minus ".docx". That archive filename is keyed on the policy terms the document
// covers (see clRenewalSummaryGenerate.ts), so every rebuild of the same terms — a rebuild after
// another upload, after a deletion, or once the renewal term lands — finds the same quotes again.
// Storage itself is uploadStore.ts, shared with the Proposal Builder.

export type QuoteUploadStatus = UploadStatus

export type QuoteUpload = UploadRecord & { extraction?: QuoteExtraction }

const QUOTES_DIR = path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, "quotes")

function documentDir(archiveFilename: string): string {
  return path.join(QUOTES_DIR, archiveFilename.replace(/\.docx$/i, ""))
}

export function quotePdfPath(archiveFilename: string, id: string): string {
  return uploadFilePath(documentDir(archiveFilename), { id })
}

export function saveQuoteUpload(archiveFilename: string, pdf: Buffer, filename: string): QuoteUpload {
  return saveUpload<QuoteUpload>(documentDir(archiveFilename), pdf, { filename, ext: "pdf" })
}

export function completeQuoteUpload(archiveFilename: string, record: QuoteUpload, extraction: QuoteExtraction): QuoteUpload {
  return writeUploadRecord(documentDir(archiveFilename), { ...record, status: "done", extraction })
}

export function failQuoteUpload(archiveFilename: string, record: QuoteUpload, error: string): QuoteUpload {
  return writeUploadRecord(documentDir(archiveFilename), { ...record, status: "error", error })
}

// Oldest first, so when two quotes cover the same line the later upload wins (clQuoteMerge.ts).
export function listQuoteUploads(archiveFilename: string): QuoteUpload[] {
  return listUploads<QuoteUpload>(documentDir(archiveFilename))
}

export function completedQuoteExtractions(archiveFilename: string): { filename: string; extraction: QuoteExtraction }[] {
  return listQuoteUploads(archiveFilename)
    .filter((u): u is QuoteUpload & { extraction: QuoteExtraction } => u.status === "done" && u.extraction !== undefined)
    .map((u) => ({ filename: u.filename, extraction: u.extraction }))
}

export function deleteQuoteUpload(archiveFilename: string, id: string): boolean {
  return deleteUpload(documentDir(archiveFilename), id)
}

// When the document itself is deleted from the archive, its quotes go with it.
export function deleteAllQuoteUploads(archiveFilename: string): void {
  deleteUploadDir(documentDir(archiveFilename))
}
