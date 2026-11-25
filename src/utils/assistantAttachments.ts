import Anthropic, { toFile } from "@anthropic-ai/sdk"
import { existsSync, readFileSync } from "node:fs"
import { PDFDocument } from "pdf-lib"
import { outputDir } from "../config/config.js"
import { logger } from "./logger.js"
import {
  ACCEPTED_FILES_MESSAGE, UploadReadError, sniffUpload, textPages, toReadable, type ReadableDoc
} from "./uploadNormalize.js"
import { deleteUpload, listUploads, readUpload, saveUpload, uploadFilePath, writeUploadRecord, type UploadRecord } from "./uploadStore.js"

// Files a staff member drops into the Boxwood Assistant to ask questions about (Patrick, 2026-11-24:
// "being able to upload a document in the boxwood assistant and being able to ask questions about
// the document"). Any type uploadNormalize.ts accepts; each is converted once, on upload, and kept
// in its readable form:
//   <OUTPUT_ROOT>/assistant/attachments/<id>.<pdf|txt> + <id>.json
// Only the uploader can use or see a file. These are client documents, so they're kept briefly: a
// file is deleted (here and from Anthropic's Files API) when the chat is cleared or the chip removed,
// and in any case 24 hours after upload.

export const MAX_FILES_PER_CHAT = 3
export const MAX_PAGES_PER_CHAT = 150
const MAX_LIVE_FILES_PER_USER = 10
const TTL_MS = 24 * 60 * 60 * 1000

const ATTACHMENTS_DIR = outputDir("assistant", "attachments")

export type AssistantAttachment = UploadRecord & {
  owner_sub: string
  pages: number
  format: ReadableDoc["format"]
  // Set the first time the file is sent to Claude (PDFs only; text goes inline).
  anthropic_file_id?: string
}

let client: Anthropic | null = null
const anthropic = () => (client ??= new Anthropic())

async function pdfPages(pdf: Buffer): Promise<number> {
  try {
    return (await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false })).getPageCount()
  } catch {
    throw new UploadReadError("This PDF couldn't be opened. It may be damaged or password-protected; download it again and re-upload.")
  }
}

export function attachmentSummary(record: AssistantAttachment) {
  return { id: record.id, filename: record.filename, pages: record.pages, uploaded_at: record.uploaded_at }
}

// Converts and stores an upload. Throws UploadReadError (shown to staff as-is) when it can't be used.
export async function saveAssistantAttachment(file: Buffer, filename: string, ownerSub: string): Promise<AssistantAttachment> {
  await sweepExpired()

  const live = listUploads<AssistantAttachment>(ATTACHMENTS_DIR).filter((r) => r.owner_sub === ownerSub)
  if(live.length >= MAX_LIVE_FILES_PER_USER) {
    throw new UploadReadError("You have a lot of files open in the assistant. Clear the chat (or remove some files) and try again.")
  }

  const kind = sniffUpload(file)
  if(!kind) throw new UploadReadError(ACCEPTED_FILES_MESSAGE)
  const doc = await toReadable(file, kind)
  const pages = doc.format === "pdf" ? await pdfPages(doc.data) : textPages(doc.data)
  if(pages > MAX_PAGES_PER_CHAT) {
    throw new UploadReadError(`This file is ${ pages } pages; the assistant can read ${ MAX_PAGES_PER_CHAT } at most. Upload just the pages you have questions about.`)
  }

  const record = saveUpload<AssistantAttachment>(ATTACHMENTS_DIR, doc.format === "pdf" ? doc.data : Buffer.from(doc.data, "utf8"), {
    filename, owner_sub: ownerSub, pages, format: doc.format, ext: doc.format === "pdf" ? "pdf" : "txt"
  } as Omit<AssistantAttachment, "id" | "uploaded_at" | "status">)
  // Converted before it was saved, so it's ready at once.
  return writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "done" })
}

function expired(record: AssistantAttachment): boolean {
  return Date.now() - Date.parse(record.uploaded_at) > TTL_MS
}

// Only its owner sees an attachment; anyone else (or an expired one) gets the same answer as a missing one.
export function getOwnedAssistantAttachment(id: string, ownerSub: string): AssistantAttachment | null {
  const record = readUpload<AssistantAttachment>(ATTACHMENTS_DIR, id)
  return record && record.owner_sub === ownerSub && !expired(record) ? record : null
}

export async function deleteAssistantAttachment(record: AssistantAttachment): Promise<void> {
  if(record.anthropic_file_id) {
    await anthropic().files.delete(record.anthropic_file_id).catch((err: unknown) => logger.warn({ err, id: record.id }, "[ASSISTANT] couldn't delete uploaded file from Anthropic"))
  }
  deleteUpload(ATTACHMENTS_DIR, record.id)
}

// Runs at most every 10 minutes, from uploads and chat turns.
let lastSweep = 0
export async function sweepExpired(): Promise<void> {
  if(Date.now() - lastSweep < 10 * 60 * 1000) return
  lastSweep = Date.now()
  for(const record of listUploads<AssistantAttachment>(ATTACHMENTS_DIR).filter(expired)) {
    await deleteAssistantAttachment(record)
  }
}

// The content block Claude reads for a file. PDFs go up to the Files API once and are referenced by
// id after that, so each turn's request stays small; workbooks (text) go inline.
export async function attachmentBlock(record: AssistantAttachment): Promise<Anthropic.Beta.BetaRequestDocumentBlock> {
  const filePath = uploadFilePath(ATTACHMENTS_DIR, record)
  if(!existsSync(filePath)) throw new UploadReadError(`"${ record.filename }" is no longer available. Remove it and upload it again.`)
  const title = record.filename

  if(record.format === "text") {
    return { type: "document", source: { type: "text", media_type: "text/plain", data: readFileSync(filePath, "utf8") }, title }
  }

  let fileId = record.anthropic_file_id
  if(!fileId) {
    const meta = await anthropic().files.upload({ file: await toFile(readFileSync(filePath), record.filename, { type: "application/pdf" }) })
    fileId = meta.id
    writeUploadRecord(ATTACHMENTS_DIR, { ...record, anthropic_file_id: fileId })
  }
  return { type: "document", source: { type: "file", file_id: fileId }, title }
}
