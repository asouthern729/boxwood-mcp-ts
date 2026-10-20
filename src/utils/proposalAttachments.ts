import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import JSZip from "jszip"
import { extractAmsProposal, type AmsProposalExtraction } from "./amsProposalExtraction.js"
import { convertDocxToPdf } from "./docxToPdf.js"
import { logger } from "./logger.js"
import { PROPOSAL_BUILDER_OUTPUT_DIR } from "./proposalBuilderArchive.js"
import { QuoteExtractionError, extractQuote, type QuoteExtraction } from "./quoteExtraction.js"
import { deleteUpload, readUpload, saveUpload, uploadFilePath, writeUploadRecord, type UploadRecord } from "./uploadStore.js"

const execFileAsync = promisify(execFile)

// Files dropped on the Proposal Builder chat: carrier quote PDFs and AMS360-generated proposals
// (.docx or PDF). Each is read by Claude in the background as soon as it's uploaded — the chat polls
// its status — and owned by whoever uploaded it. A proposal records which attachments built it
// (proposalBuilderArchive.ts), so they stay on disk until that proposal is deleted.
//   <OUTPUT_ROOT>/proposal-builder/attachments/<id>.<pdf|docx> + <id>.json

export type ProposalAttachmentKind = "quote_pdf" | "ams_docx" | "ams_pdf"

export type ProposalAttachment = UploadRecord & {
  kind: ProposalAttachmentKind
  owner_sub: string
  // Set once a proposal is built from it; it can't be removed on its own after that.
  proposal_filename?: string
  quote?: QuoteExtraction
  ams?: AmsProposalExtraction
}

const ATTACHMENTS_DIR = path.join(PROPOSAL_BUILDER_OUTPUT_DIR, "attachments")

// A read that never finished (the server restarted mid-read) would otherwise poll forever.
const STALE_AFTER_MS = 20 * 60 * 1000

export class UnsupportedAttachmentError extends Error {}

// ---------- Kind detection (from the bytes — browsers send no reliable type for a .docx) ----------

// Headings only an AMS360 proposal prints; a carrier quote ("Business Insurance Proposal", "Premium
// Summary") can share one or two generic ones, so it takes three.
const AMS_MARKERS = [
  /your dedicated service team/i, /coverage provided by/i, /policy information/i, /expiring\s*premium/i,
  /included options and endorsements/i, /suggested coverages/i, /acknowledgment of coverage recommendations/i
]

async function pdfText(pdf: Buffer): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "proposal-kind-"))
  try {
    const file = path.join(dir, "upload.pdf")
    writeFileSync(file, pdf)
    const { stdout } = await execFileAsync("pdftotext", ["-q", file, "-"], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
    return stdout
  } catch {
    // Unreadable or scanned: treat it as a quote, which is read straight from the PDF anyway.
    return ""
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function docxText(docx: Buffer): Promise<string> {
  try {
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")?.async("string")
    return (xml ?? "").replace(/<w:tab\/>|<\/w:p>/g, " ").replace(/<[^>]+>/g, "")
  } catch {
    return ""
  }
}

function looksLikeAms(text: string): boolean {
  return AMS_MARKERS.filter((marker) => marker.test(text)).length >= 3
}

export async function detectKind(file: Buffer): Promise<ProposalAttachmentKind> {
  if(file.subarray(0, 2).toString() === "PK" && file.includes("word/document.xml")) {
    // The only Word file this reads is an AMS360 proposal; anything else (a branded proposal, a
    // letter) would come back as a garbled program, so it's turned away up front.
    if(looksLikeAms(await docxText(file))) return "ams_docx"
    throw new UnsupportedAttachmentError("This Word file doesn't look like an AMS360 proposal. Upload the AMS360 proposal, or a carrier quote as a PDF.")
  }

  const headerAt = file.indexOf("%PDF-")
  if(headerAt === -1 || headerAt > 1024) throw new UnsupportedAttachmentError("Upload a PDF quote or an AMS360 proposal (.docx or PDF).")

  const text = await pdfText(file)
  return looksLikeAms(text) ? "ams_pdf" : "quote_pdf"
}

// ---------- Store ----------

export function saveAttachment(file: Buffer, filename: string, kind: ProposalAttachmentKind, ownerSub: string): ProposalAttachment {
  return saveUpload<ProposalAttachment>(ATTACHMENTS_DIR, file, {
    filename, kind, owner_sub: ownerSub, ext: kind === "ams_docx" ? "docx" : "pdf"
  })
}

export function getAttachment(id: string): ProposalAttachment | null {
  const record = readUpload<ProposalAttachment>(ATTACHMENTS_DIR, id)
  if(record?.status === "processing" && Date.now() - Date.parse(record.uploaded_at) > STALE_AFTER_MS) {
    return writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "error", error: "Reading this file was interrupted. Upload it again." })
  }
  return record
}

// Only its owner sees an attachment; anyone else gets the same answer as for a missing one.
export function getOwnedAttachment(id: string, ownerSub: string): ProposalAttachment | null {
  const record = getAttachment(id)
  return record && record.owner_sub === ownerSub ? record : null
}

export function markAttachmentsUsed(ids: string[], proposalFilename: string): void {
  for(const id of ids) {
    const record = getAttachment(id)
    if(record && record.proposal_filename !== proposalFilename) writeUploadRecord(ATTACHMENTS_DIR, { ...record, proposal_filename: proposalFilename })
  }
}

export function deleteAttachment(id: string): boolean {
  return deleteUpload(ATTACHMENTS_DIR, id)
}

// What the API returns — never the extraction itself.
export function attachmentSummary(record: ProposalAttachment) {
  return {
    id: record.id,
    filename: record.filename,
    kind: record.kind,
    status: record.status,
    ...(record.error ? { error: record.error } : {})
  }
}

// ---------- Reading ----------

export async function processAttachment(record: ProposalAttachment, file: Buffer): Promise<void> {
  try {
    if(record.kind === "quote_pdf") {
      const quote = await extractQuote(file, record.filename)
      if(quote.lines.length === 0) throw new QuoteExtractionError("No coverage lines were found in this PDF — is it a quote or binder?")
      writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "done", quote })
      return
    }

    const pdf = record.kind === "ams_docx" ? await convertDocxToPdf(file) : file
    const ams = await extractAmsProposal(pdf, record.filename)
    if(ams.lines.length === 0) throw new QuoteExtractionError("No coverage sections were found in this proposal.")
    writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "done", ams })
  } catch(error) {
    logger.error({ err: error, attachment: record.id, kind: record.kind }, "proposal_builder attachment read failed")
    const message = error instanceof QuoteExtractionError ? error.message : "Something went wrong reading this file. Try uploading it again."
    writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "error", error: message })
  }
}

export function attachmentFilePath(record: ProposalAttachment): string {
  return uploadFilePath(ATTACHMENTS_DIR, record)
}
