import express, { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
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
import { extractQuote, QuoteExtractionError } from "../utils/quoteExtraction.js"
import { groupByCsr } from "./riskProfile.js"

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

router.get(`${ BASE }/cl-renewal-summary/manifest`, auth0, (_req, res) => {
  const entriesWithSize = readClRenewalSummaryManifest()
    .filter((entry) => existsSync(path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({ ...entry, sizeBytes: statSync(path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)).size }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

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

// ---------- Uploaded quote PDFs (Patrick, 2026-09-29: "option to upload pdf for separate policies") ----------
// Upload → the PDF is read by Claude (quoteExtraction.ts) → the document is rebuilt in place with
// the quoted lines merged in, each flagged with a Word comment for review (clQuoteMerge.ts).
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

async function processQuoteUpload(filename: string, upload: QuoteUpload, pdf: Buffer): Promise<void> {
  try {
    const extraction = await extractQuote(pdf, upload.filename)

    if(extraction.lines.length === 0) {
      failQuoteUpload(filename, upload, "No coverage lines were found in this PDF — is it a quote or binder?")
      return
    }

    completeQuoteUpload(filename, upload, extraction)

    const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)
    if(entry) await rebuildClRenewalSummary(entry)
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

// Body is the raw PDF (Content-Type: application/pdf); the original filename comes in ?name= so the
// review comments can name the file the account manager actually uploaded.
router.post(
  `${ BASE }/cl-renewal-summary/files/:filename/quotes`,
  auth0,
  express.raw({ type: "application/pdf", limit: MAX_QUOTE_PDF_BYTES }),
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

    const pdf = req.body
    if(!Buffer.isBuffer(pdf) || pdf.length === 0 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      res.status(400).json({ error: "invalid_pdf", error_description: "Upload a PDF file." })
      return
    }

    const name = typeof req.query.name === "string" && req.query.name.trim() ? path.basename(req.query.name.trim()) : "quote.pdf"
    const upload = saveQuoteUpload(filename, pdf, name)
    void processQuoteUpload(filename, upload, pdf)

    res.status(202).json(quoteSummary(upload))
  }
)

router.delete(`${ BASE }/cl-renewal-summary/files/:filename/quotes/:quoteId`, auth0, asyncHandler(async(req: Request<{ filename: string; quoteId: string }>, res: Response) => {
  const { filename, quoteId } = req.params
  const entry = readClRenewalSummaryManifest().find((e) => e.filename === filename)

  if(!entry || !deleteQuoteUpload(filename, quoteId)) {
    res.status(404).json({ error: "not_found", error_description: "This quote doesn't exist." })
    return
  }

  // Take the quote's sections back out of the document.
  await rebuildClRenewalSummary(entry)
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
