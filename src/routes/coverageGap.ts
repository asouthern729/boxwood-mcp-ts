import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { readFileSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { runCoverageGapChatTurn } from "../utils/coverageGapChat.js"
import { GapRefused, MAX_NOTES_LENGTH, startGapAnalysis } from "../utils/coverageGapRun.js"
import {
  attachmentSummary, deleteAttachment, deleteJob, getJob, getOwnedAttachment, listJobs, reportPath, reportSize,
  makeReadable, saveAttachment, updateAttachment, type GapAttachment, type GapEntry
} from "../utils/coverageGapStore.js"
import { DocToolError } from "../utils/docToolClaude.js"
import { currentUser, viewerSub } from "../utils/docToolUser.js"
import { recordDownload } from "../utils/downloadLog.js"
import { PdfConverterUnavailableError, pdfForDocx } from "../utils/docxToPdf.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import { logger } from "../utils/logger.js"
import { readDocumentProfile } from "../utils/policyCheckAnalysis.js"
import { ACCEPTED_FILES_MESSAGE, sniffUpload, uploadExt } from "../utils/uploadNormalize.js"

// Coverage Gap page (Andrew, 2026-11-25) — Commercial tools. Staff upload a commercial account's
// policy PDFs, optionally fill the account notes box, and get an internal Word gap analysis. Same
// contract shape as routes/coverageComparison.ts, with one drop zone (no roles) and runs called
// analyses.
export const router = Router()

const BASE = "/api/v1/boxwood-mcp/coverage-gap" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_CHAT_MESSAGE_LENGTH = 2000
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
const MAX_ATTACHMENTS_PER_TURN = 20
const NOT_FOUND = { error: "not_found", error_description: "This gap analysis doesn't exist." }
const ATTACHMENT_NOT_FOUND = { error: "not_found", error_description: "This file doesn't exist." }

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined)
const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= MAX_ATTACHMENTS_PER_TURN && ids.every((id) => typeof id === "string")

// The notes go back to the person who wrote them (the page shows them on the run); everyone else
// sees only that there were some.
function publicEntry(entry: GapEntry, viewer: string) {
  const { notes, ...rest } = entry
  return {
    ...rest,
    has_notes: Boolean(notes),
    ...(notes && entry.created_by.sub === viewer ? { notes } : {}),
    ...(entry.filename ? { sizeBytes: reportSize(entry.filename) } : {})
  }
}

// ---------- Manifest ----------

router.get(`${ BASE }/manifest`, auth0, (req: Request, res: Response) => {
  const sub = viewerSub(req)
  const entries = listJobs()

  if(req.query.scope === "all") {
    const groups = new Map<string, { prepared_by: string | null; analyses: ReturnType<typeof publicEntry>[] }>()
    for(const entry of entries) {
      const key = entry.prepared_by.toLowerCase()
      const group = groups.get(key) ?? { prepared_by: entry.prepared_by, analyses: [] }
      group.analyses.push(publicEntry(entry, sub))
      groups.set(key, group)
    }
    res.json({ viewer_sub: sub, groups: [...groups.values()].sort((a, b) => (a.prepared_by ?? "").localeCompare(b.prepared_by ?? "")) })
    return
  }

  res.json({ viewer_sub: sub, groups: [{ prepared_by: null, analyses: entries.filter((e) => e.created_by.sub === sub).map((e) => publicEntry(e, sub)) }] })
})

// ---------- Analyses ----------

router.post(`${ BASE }/analyses`, auth0, asyncHandler(async(req: Request, res: Response) => {
  const { attachment_ids, client_name, notes } = req.body ?? {}
  if(!validIds(attachment_ids)) {
    res.status(400).json({ error: "invalid_request", error_description: `attachment_ids must be an array of at most ${ MAX_ATTACHMENTS_PER_TURN } ids` })
    return
  }
  if(typeof notes === "string" && notes.length > MAX_NOTES_LENGTH) {
    res.status(400).json({ error: "invalid_request", error_description: `Account notes must be ${ MAX_NOTES_LENGTH } characters or fewer.` })
    return
  }
  const user = await currentUser(req)
  try {
    const entry = startGapAnalysis(user, attachment_ids, { clientName: optionalString(client_name), notes: optionalString(notes) })
    res.status(202).json(publicEntry(entry, user.sub))
  } catch(error) {
    if(error instanceof GapRefused) {
      res.status(400).json({ error: "invalid_request", error_description: error.message })
      return
    }
    throw error
  }
}))

router.delete(`${ BASE }/analyses/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const entry = getJob(req.params.id)
  if(!entry) {
    res.status(404).json(NOT_FOUND)
    return
  }
  if(entry.created_by.sub !== viewerSub(req)) {
    res.status(403).json({ error: "forbidden", error_description: "Only the person who ran this gap analysis can delete it." })
    return
  }
  deleteJob(entry)
  res.status(200).json({ id: entry.id })
})

// ---------- Files ----------

router.get(`${ BASE }/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const filePath = reportPath(req.params.filename)
  if(!filePath) {
    res.status(404).json(NOT_FOUND)
    return
  }
  res.setHeader("Content-Type", DOCX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ req.params.filename }"`)
  res.send(readFileSync(filePath))
  recordDownload(req, "coverage-gap", req.params.filename)
})

router.get(`${ BASE }/files/:filename/pdf`, auth0, asyncHandler(async(req: Request<{ filename: string }>, res: Response) => {
  const filePath = reportPath(req.params.filename)
  if(!filePath) {
    res.status(404).json(NOT_FOUND)
    return
  }
  try {
    const pdf = await pdfForDocx(filePath)
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `attachment; filename="${ pdf.filename }"`)
    res.send(pdf.buffer)
    recordDownload(req, "coverage-gap", pdf.filename)
  } catch(err) {
    if(err instanceof PdfConverterUnavailableError) {
      res.status(503).json({ error: "converter_unavailable", error_description: err.message })
      return
    }
    throw err
  }
}))

// ---------- Attachments ----------

// Converts the upload to what Claude reads (a PDF, or text for a workbook), then takes the first look.
async function readProfile(record: GapAttachment): Promise<void> {
  try {
    const { record: ready, doc } = await makeReadable(record)
    const profile = await readDocumentProfile(doc, ready.filename)
    // Re-read so a role change made while this read ran isn't overwritten.
    const latest = getOwnedAttachment(record.id, record.owner_sub) ?? ready
    updateAttachment({ ...latest, status: "done", profile })
  } catch(error) {
    logger.error({ err: error, attachment: record.id }, "coverage_gap attachment read failed")
    const message = error instanceof DocToolError ? error.message : "Something went wrong reading this file. Try uploading it again."
    const latest = getOwnedAttachment(record.id, record.owner_sub) ?? record
    updateAttachment({ ...latest, status: "error", error: message })
  }
}

// Raw body (any Content-Type); the original filename comes in ?name=. One drop zone, so no ?role=.
router.post(
  `${ BASE }/attachments`,
  auth0,
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
  asyncHandler(async(req: Request<unknown, unknown, Buffer, { name?: string }>, res: Response) => {
    const sub = viewerSub(req)
    const file = req.body
    const kind = Buffer.isBuffer(file) ? sniffUpload(file) : null
    if(!kind) {
      res.status(400).json({ error: "invalid_file", error_description: ACCEPTED_FILES_MESSAGE })
      return
    }

    const name = typeof req.query.name === "string" && req.query.name.trim() ? path.basename(req.query.name.trim()) : `upload.${ uploadExt(kind) }`
    const record = saveAttachment(file, name, "policy", sub, uploadExt(kind))
    void readProfile(record)
    res.status(202).json(attachmentSummary(record))
  })
)

router.get(`${ BASE }/attachments/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAttachment(req.params.id, viewerSub(req))
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }
  res.json(attachmentSummary(record))
})

router.delete(`${ BASE }/attachments/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAttachment(req.params.id, viewerSub(req))
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }
  if(record.job_id) {
    res.status(409).json({ error: "in_use", error_description: "This file is part of a gap analysis; delete the analysis to remove it." })
    return
  }
  deleteAttachment(record.id)
  res.status(204).end()
})

// ---------- Chat ----------

router.post(`${ BASE }/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id, attachment_ids = [], account_notes } = req.body ?? {}
  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }
  if(session_id !== undefined && typeof session_id !== "string") return next(new ErrorResponse("session_id must be a string", 400))
  if(!validIds(attachment_ids)) return next(new ErrorResponse(`attachment_ids must be an array of at most ${ MAX_ATTACHMENTS_PER_TURN } ids`, 400))
  if(account_notes !== undefined && (typeof account_notes !== "string" || account_notes.length > MAX_NOTES_LENGTH)) {
    return next(new ErrorResponse(`account_notes must be a string of ${ MAX_NOTES_LENGTH } characters or fewer`, 400))
  }

  const user = await currentUser(req)
  const attachments = attachment_ids.map((id) => getOwnedAttachment(id, user.sub)).filter((a): a is GapAttachment => a !== null && !a.job_id)
  const started = Date.now()
  const turn = await runCoverageGapChatTurn(message.trim(), session_id, user, attachments, account_notes)
  logger.info({ sub: user.sub, session_id: turn.sessionId, tool_calls: turn.toolCalls.map((c) => c.name), ms: Date.now() - started }, "[coverage_gap_chat] turn finished")
  res.status(200).json({ reply: turn.reply, session_id: turn.sessionId, tool_calls: turn.toolCalls })
}))
