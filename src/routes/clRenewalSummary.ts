import express, { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import { recordDownload } from "../utils/downloadLog.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import { PdfConverterUnavailableError, pdfForDocx } from "../utils/docxToPdf.js"
import {
  CL_RENEWAL_SUMMARY_OUTPUT_DIR, deleteClRenewalSummary, readClRenewalSummaryManifest
} from "../utils/clRenewalSummaryArchive.js"
import { runClRenewalSummaryChatTurn } from "../utils/clRenewalSummaryChat.js"
import { ClRenewalSummaryRebuildError, archivedPolids, rebuildClRenewalSummary } from "../utils/clRenewalSummaryGenerate.js"
import {
  completeQuoteUpload, deleteAllQuoteUploads, deleteQuoteUpload, failQuoteUpload, listQuoteUploads, saveQuoteUpload
} from "../utils/clQuoteStore.js"
import type { QuoteUpload } from "../utils/clQuoteStore.js"
import { logger } from "../utils/logger.js"
import { extractQuote, quoteFileKind, QuoteExtractionError } from "../utils/quoteExtraction.js"
import { groupByCsr } from "./riskProfile.js"
import { documentId, linksForClRenewalSummary } from "../utils/documentLinks.js"
import { LinkedBuildError, buildClRenewalSummaryForSpreadsheet } from "../utils/linkedDocumentBuild.js"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, readManifest as readPremiumManifest } from "../utils/renewalPremiumSummaryArchive.js"

// Mirrors routes/riskProfile.ts route-for-route (manifest grouped by CSR, file download/delete
// validated against the manifest, embedded chat) so the future employee-dashboard frontend can treat
// the two index pages identically — see that file's comments for the reasoning behind each route.
export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_CHAT_MESSAGE_LENGTH = 2000
// The Messages API's own request cap is 32 MB including the base64 overhead (~4/3), so the PDF
// itself has to stay under ~24 MB.
const MAX_QUOTE_PDF_BYTES = 24 * 1024 * 1024
const NOT_FOUND = { error: "not_found", error_description: "This renewal summary doesn't exist." }

// Each entry also carries its document id (the dashboard's URL key) and links to the Renewal Premium
// Spreadsheet for the same policy terms (documentLinks.ts).
router.get(`${ BASE }/cl-renewal-summary/manifest`, auth0, (_req, res) => {
  const spreadsheets = readPremiumManifest().filter((sheet) => existsSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, sheet.filename)))
  const entriesWithSize = readClRenewalSummaryManifest()
    .filter((entry) => existsSync(path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({
      ...entry,
      sizeBytes: statSync(path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)).size,
      id: documentId("cl-renewal-summary", entry.filename),
      links: linksForClRenewalSummary(entry, spreadsheets)
    }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

// Builds the CL Renewal Summary for a Renewal Premium Spreadsheet's policy terms, from the spreadsheet's
// preview (linkedDocumentBuild.ts) — 200 { id, created }, id being the summary to open (created: false
// when one already exists). Takes a few seconds: a full document build.
router.post(`${ BASE }/cl-renewal-summary/linked`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const spreadsheetId = typeof req.body?.spreadsheet_id === "string" ? req.body.spreadsheet_id : ""
  if(!spreadsheetId) {
    return next(new ErrorResponse("spreadsheet_id is required.", 400))
  }

  try {
    res.status(200).json(await buildClRenewalSummaryForSpreadsheet(spreadsheetId))
  } catch(error) {
    if(error instanceof LinkedBuildError) return next(new ErrorResponse(error.message, error.status))
    throw error
  }
}))

router.get(`${ BASE }/cl-renewal-summary/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)

  if(!entry) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  const filePath = path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, filename)

  if(!existsSync(filePath)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  res.setHeader("Content-Type", DOCX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
  recordDownload(req, "cl-renewal-summary", filename)
})

// PDF of the same archived .docx, same as routes/plRenewalSummary.ts. Cached beside the .docx; a quote
// upload rebuilds the .docx in place (newer mtime), so the next PDF request reconverts.
router.get(`${ BASE }/cl-renewal-summary/files/:filename/pdf`, auth0, asyncHandler(async(req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)
  const filePath = path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, filename)

  if(!entry || !existsSync(filePath)) {
    res.status(404).json(NOT_FOUND)
    return
  }

  try {
    const pdf = await pdfForDocx(filePath)
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `attachment; filename="${ pdf.filename }"`)
    res.send(pdf.buffer)
    recordDownload(req, "cl-renewal-summary", pdf.filename)
  } catch(err) {
    if(err instanceof PdfConverterUnavailableError) {
      res.status(503).json({ error: "converter_unavailable", error_description: err.message })
      return
    }
    throw err
  }
}))

router.delete(`${ BASE }/cl-renewal-summary/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!deleteClRenewalSummary(filename)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  deleteAllQuoteUploads(filename)
  res.status(200).json({ filename })
})

// ---------- Uploaded quotes: PDF, .docx, .xlsx or image (Patrick, 2026-09-29: "option to upload pdf for separate policies") ----------
// Upload → the PDF is read by Claude (quoteExtraction.ts) → the document is rebuilt in place with
// the quoted lines merged in (clQuoteMerge.ts).
// Reading a quote takes a minute or more, longer than a request should hang, so the upload returns
// 202 at once and the work finishes in the background; the page polls the quotes list for status.

function quoteSummary(upload: QuoteUpload) {
  return {
    id: upload.id,
    filename: upload.filename,
    uploaded_at: upload.uploaded_at,
    status: upload.status,
    ...(upload.error ? { error: upload.error } : {}),
    lines: (upload.extraction?.lines ?? []).map((l) => ({ title: l.title, carrier: l.carrier, annual_premium: l.annual_premium }))
  }
}

async function processQuoteUpload(filename: string, upload: QuoteUpload, file: Buffer): Promise<void> {
  try {
    const extraction = await extractQuote(file, upload.filename)

    if(extraction.lines.length === 0) {
      failQuoteUpload(filename, upload, "No coverage lines were found in this file — is it a quote or binder?")
      return
    }

    completeQuoteUpload(filename, upload, extraction)

    const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)
    if(entry) await rebuildClRenewalSummary(entry, `Quote added: ${ upload.filename }`)
  } catch(error) {
    logger.error({ err: error, filename, quote: upload.id }, "cl_renewal_summary quote upload failed")
    const message = error instanceof QuoteExtractionError || error instanceof ClRenewalSummaryRebuildError
      ? error.message
      : "Something went wrong reading this quote. Try uploading it again."
    failQuoteUpload(filename, upload, message)
  }
}

router.get(`${ BASE }/cl-renewal-summary/files/:filename/quotes`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!readClRenewalSummaryManifest().some((e) => e.filename === filename)) {
    res.status(404).json(NOT_FOUND)
    return
  }

  res.json({ quotes: listQuoteUploads(filename).map(quoteSummary) })
})

const QUOTE_TYPES_MESSAGE = "Upload the quote as a PDF, Word document (.docx), Excel workbook (.xlsx), or a PNG/JPEG image."

// Body is the raw file: a PDF, or (since 2026-11-25) a .docx, .xlsx, or PNG/JPEG image. The type is read from
// the bytes, so any Content-Type (or none) is accepted; browsers label spreadsheets inconsistently. The original
// filename comes in ?name= so the quote's recorded source names the file the account manager uploaded.
router.post(
  `${ BASE }/cl-renewal-summary/files/:filename/quotes`,
  auth0,
  express.raw({ type: () => true, limit: MAX_QUOTE_PDF_BYTES }),
  (req: Request<{ filename: string }, unknown, Buffer, { name?: string }>, res: Response) => {
    const { filename } = req.params
    const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)

    if(!entry) {
      res.status(404).json(NOT_FOUND)
      return
    }

    if(!archivedPolids(entry)) {
      res.status(409).json({ error: "rebuild_required", error_description: "This document predates quote uploads — build it again from the chat, then upload the quote." })
      return
    }

    const file = req.body
    // A PDF header can sit a little way in: American Modern's portal download starts with a 22-byte
    // wrapper before "%PDF-" (quoteExtraction.ts allows for it).
    const kind = Buffer.isBuffer(file) ? quoteFileKind(file) : null
    if(kind === "xls") {
      res.status(400).json({ error: "invalid_file", error_description: "This is an older Excel file (.xls). Open it in Excel, save it as .xlsx, and upload that." })
      return
    }
    if(kind === null) {
      res.status(400).json({ error: "invalid_file", error_description: QUOTE_TYPES_MESSAGE })
      return
    }

    const ext = kind === "jpeg" ? "jpg" : kind
    const name = typeof req.query.name === "string" && req.query.name.trim() ? path.basename(req.query.name.trim()) : `quote.${ ext }`
    const upload = saveQuoteUpload(filename, file, name, ext)
    void processQuoteUpload(filename, upload, file)

    res.status(202).json(quoteSummary(upload))
  }
)

router.delete(`${ BASE }/cl-renewal-summary/files/:filename/quotes/:quoteId`, auth0, asyncHandler(async(req: Request<{ filename: string; quoteId: string }>, res: Response) => {
  const { filename, quoteId } = req.params
  const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)
  // Read before deleting — the upload record goes with it.
  const quoteName = entry ? listQuoteUploads(filename).find((q) => q.id === quoteId)?.filename : undefined

  if(!entry || !deleteQuoteUpload(filename, quoteId)) {
    res.status(404).json({ error: "not_found", error_description: "This quote doesn't exist." })
    return
  }

  // Take the quote's sections back out of the document.
  await rebuildClRenewalSummary(entry, `Quote removed: ${ quoteName ?? "quote" }`)
  res.status(200).json({ id: quoteId })
}))

router.post(`${ BASE }/cl-renewal-summary/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  const turn = await runClRenewalSummaryChatTurn(message.trim(), session_id)

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
}))
