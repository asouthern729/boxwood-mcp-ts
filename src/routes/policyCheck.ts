import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { readFileSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { fetchUserInfo } from "../utils/auth0.js"
import { recordDownload } from "../utils/downloadLog.js"
import { PdfConverterUnavailableError, pdfForDocx } from "../utils/docxToPdf.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import { logger } from "../utils/logger.js"
import { PolicyCheckError, ROLES, readDocumentProfile, type PolicyCheckRole } from "../utils/policyCheckAnalysis.js"
import { runPolicyCheckChatTurn } from "../utils/policyCheckChat.js"
import { CheckRefused, startCheck } from "../utils/policyCheckRun.js"
import {
  attachmentSummary, deleteAttachment, deleteCheck, getCheck, getOwnedAttachment, listChecks, reportPath, reportSize,
  saveAttachment, updateAttachment, type CheckEntry, type PolicyCheckAttachment, type PolicyCheckUser
} from "../utils/policyCheckStore.js"
import { normalizedPdf } from "../utils/quoteExtraction.js"

// Policy Check page (Andrew, 2026-11-22) — commercial lines account managers check an issued or
// renewal policy against the quote/binder/expiring policy. Contract agreed with the frontend
// (boxwood-tools-vite-ts /commercial/policy-check). Owner-scoped like routes/proposalBuilder.ts.
export const router = Router()

const BASE = "/api/v1/boxwood-mcp/policy-check" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_CHAT_MESSAGE_LENGTH = 2000
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
const MAX_ATTACHMENTS_PER_TURN = 20
const NOT_FOUND = { error: "not_found", error_description: "This check doesn't exist." }
const ATTACHMENT_NOT_FOUND = { error: "not_found", error_description: "This file doesn't exist." }

const isRole = (value: unknown): value is PolicyCheckRole => typeof value === "string" && (ROLES as readonly string[]).includes(value)

function viewerSub(req: Pick<Request, "auth0">): string {
  const sub = req.auth0?.sub
  if(!sub) throw new ErrorResponse("Not authorized to access this route", 401)
  return sub
}

// Name and email from Auth0 /userinfo (the access token doesn't carry them), cached for an hour.
const userCache = new Map<string, { user: PolicyCheckUser; at: number }>()

async function currentUser(req: Pick<Request, "auth0" | "headers">): Promise<PolicyCheckUser> {
  const sub = viewerSub(req)
  const cached = userCache.get(sub)
  if(cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.user
  const token = req.headers.authorization?.slice("Bearer ".length) ?? ""
  const info = await fetchUserInfo(token)
  const user = { sub, name: info.label ?? info.email ?? "Unknown", email: info.email ?? "" }
  userCache.set(sub, { user, at: Date.now() })
  return user
}

function publicEntry(entry: CheckEntry) {
  const { notes: _notes, ...rest } = entry
  return { ...rest, ...(entry.filename ? { sizeBytes: reportSize(entry.filename) } : {}) }
}

// ---------- Manifest ----------

router.get(`${ BASE }/manifest`, auth0, (req: Request, res: Response) => {
  const sub = viewerSub(req)
  const entries = listChecks()

  if(req.query.scope === "all") {
    const groups = new Map<string, { prepared_by: string | null; checks: ReturnType<typeof publicEntry>[] }>()
    for(const entry of entries) {
      const key = entry.prepared_by.toLowerCase()
      const group = groups.get(key) ?? { prepared_by: entry.prepared_by, checks: [] }
      group.checks.push(publicEntry(entry))
      groups.set(key, group)
    }
    res.json({ viewer_sub: sub, groups: [...groups.values()].sort((a, b) => (a.prepared_by ?? "").localeCompare(b.prepared_by ?? "")) })
    return
  }

  res.json({ viewer_sub: sub, groups: [{ prepared_by: null, checks: entries.filter((e) => e.created_by.sub === sub).map(publicEntry) }] })
})

// ---------- Checks ----------

router.post(`${ BASE }/checks`, auth0, asyncHandler(async(req: Request, res: Response) => {
  const { attachment_ids, client_name, notes } = req.body ?? {}
  if(!Array.isArray(attachment_ids) || attachment_ids.length > MAX_ATTACHMENTS_PER_TURN || !attachment_ids.every((id) => typeof id === "string")) {
    res.status(400).json({ error: "invalid_request", error_description: `attachment_ids must be an array of at most ${ MAX_ATTACHMENTS_PER_TURN } ids` })
    return
  }
  const user = await currentUser(req)
  try {
    const entry = startCheck(user, attachment_ids, {
      clientName: typeof client_name === "string" ? client_name : undefined,
      notes: typeof notes === "string" ? notes : undefined
    })
    res.status(202).json(publicEntry(entry))
  } catch(error) {
    if(error instanceof CheckRefused) {
      res.status(400).json({ error: "invalid_request", error_description: error.message })
      return
    }
    throw error
  }
}))

router.delete(`${ BASE }/checks/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const entry = getCheck(req.params.id)
  if(!entry) {
    res.status(404).json(NOT_FOUND)
    return
  }
  if(entry.created_by.sub !== viewerSub(req)) {
    res.status(403).json({ error: "forbidden", error_description: "Only the person who ran this check can delete it." })
    return
  }
  deleteCheck(entry)
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
  recordDownload(req, "policy-check", req.params.filename)
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
    recordDownload(req, "policy-check", pdf.filename)
  } catch(err) {
    if(err instanceof PdfConverterUnavailableError) {
      res.status(503).json({ error: "converter_unavailable", error_description: err.message })
      return
    }
    throw err
  }
}))

// ---------- Attachments ----------

async function readProfile(record: PolicyCheckAttachment, file: Buffer): Promise<void> {
  try {
    const profile = await readDocumentProfile(file, record.filename)
    updateAttachment({ ...record, status: "done", profile })
  } catch(error) {
    logger.error({ err: error, attachment: record.id }, "policy_check attachment read failed")
    const message = error instanceof PolicyCheckError ? error.message : "Something went wrong reading this file. Try uploading it again."
    updateAttachment({ ...record, status: "error", error: message })
  }
}

// Raw body (any Content-Type); the original filename comes in ?name= and the drop zone in ?role=.
router.post(
  `${ BASE }/attachments`,
  auth0,
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
  asyncHandler(async(req: Request<unknown, unknown, Buffer, { name?: string; role?: string }>, res: Response) => {
    const sub = viewerSub(req)
    const file = req.body
    if(!isRole(req.query.role)) {
      res.status(400).json({ error: "invalid_role", error_description: "role must be baseline, compared or reference." })
      return
    }
    if(!Buffer.isBuffer(file) || file.length === 0) {
      res.status(400).json({ error: "invalid_file", error_description: "Upload a PDF." })
      return
    }
    try {
      normalizedPdf(file)
    } catch {
      res.status(400).json({ error: "invalid_file", error_description: "This file isn't a PDF. Download it again as a PDF and upload that." })
      return
    }

    const name = typeof req.query.name === "string" && req.query.name.trim() ? path.basename(req.query.name.trim()) : "upload.pdf"
    const record = saveAttachment(file, name, req.query.role, sub)
    void readProfile(record, file)
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

router.patch(`${ BASE }/attachments/:id`, auth0, express.json(), (req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAttachment(req.params.id, viewerSub(req))
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }
  const role = req.body?.role
  if(!isRole(role)) {
    res.status(400).json({ error: "invalid_role", error_description: "role must be baseline, compared or reference." })
    return
  }
  if(record.check_id) {
    res.status(409).json({ error: "in_use", error_description: "This file is part of a check and can't be moved." })
    return
  }
  // Re-read so a finished first read written meanwhile isn't overwritten.
  const latest = getOwnedAttachment(record.id, record.owner_sub) ?? record
  res.json(attachmentSummary(updateAttachment({ ...latest, role })))
})

router.delete(`${ BASE }/attachments/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAttachment(req.params.id, viewerSub(req))
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }
  if(record.check_id) {
    res.status(409).json({ error: "in_use", error_description: "This file is part of a check; delete the check to remove it." })
    return
  }
  deleteAttachment(record.id)
  res.status(204).end()
})

// ---------- Chat ----------

router.post(`${ BASE }/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id, attachment_ids = [] } = req.body ?? {}
  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }
  if(session_id !== undefined && typeof session_id !== "string") return next(new ErrorResponse("session_id must be a string", 400))
  if(!Array.isArray(attachment_ids) || attachment_ids.length > MAX_ATTACHMENTS_PER_TURN || !attachment_ids.every((id) => typeof id === "string")) {
    return next(new ErrorResponse(`attachment_ids must be an array of at most ${ MAX_ATTACHMENTS_PER_TURN } ids`, 400))
  }

  const user = await currentUser(req)
  // Chips that went into a check meanwhile, or were deleted, are just left out.
  const attachments = (attachment_ids as string[]).map((id) => getOwnedAttachment(id, user.sub)).filter((a): a is PolicyCheckAttachment => a !== null && !a.check_id)

  const started = Date.now()
  const turn = await runPolicyCheckChatTurn(message.trim(), session_id, user, attachments)
  logger.info({ sub: user.sub, session_id: turn.sessionId, tool_calls: turn.toolCalls.map((c) => c.name), ms: Date.now() - started }, "[policy_check_chat] turn finished")
  res.status(200).json({ reply: turn.reply, session_id: turn.sessionId, tool_calls: turn.toolCalls })
}))
