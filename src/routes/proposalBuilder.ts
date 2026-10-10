import express, { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { fetchUserInfo } from "../utils/auth0.js"
import { PdfConverterUnavailableError, pdfForDocx } from "../utils/docxToPdf.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import {
  UnsupportedAttachmentError, attachmentSummary, deleteAttachment, detectKind, getOwnedAttachment,
  processAttachment, saveAttachment, type ProposalAttachment
} from "../utils/proposalAttachments.js"
import {
  PROPOSAL_BUILDER_OUTPUT_DIR, deleteProposal, readProposalManifest, type ProposalCreator, type ProposalEntry
} from "../utils/proposalBuilderArchive.js"
import { logger } from "../utils/logger.js"
import { runProposalBuilderChatTurn } from "../utils/proposalBuilderChat.js"
import { PERSON_NAME } from "../tools/proposalBuilder.js"

// Proposal Builder (Andrew, 2026-10-10): files dropped on the page's chat are uploaded one per
// request and read in the background; the chat's proposal_builder tool builds a proposal from them.
// Proposals belong to whoever built them (req.auth0.sub), unlike the CSR-grouped CL index pages —
// the file routes otherwise mirror routes/clRenewalSummary.ts.
export const router = Router()

const BASE = "/api/v1/boxwood-mcp/proposal-builder" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_CHAT_MESSAGE_LENGTH = 2000
// Same cap as the Renewal Summary's quote uploads: the Messages API takes 32 MB including base64
// overhead.
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
const MAX_ATTACHMENTS_PER_TURN = 20
const NOT_FOUND = { error: "not_found", error_description: "This proposal doesn't exist." }
const ATTACHMENT_NOT_FOUND = { error: "not_found", error_description: "This attachment doesn't exist." }

function viewerSub(req: Pick<Request, "auth0">): string {
  const sub = req.auth0?.sub
  if(!sub) throw new ErrorResponse("Not authorized to access this route", 401)
  return sub
}

// Display name and email from Auth0 /userinfo (the access token doesn't carry them), cached per user
// for an hour — only needed when a proposal is built.
const userCache = new Map<string, { user: ProposalCreator; at: number }>()

async function currentUser(req: Pick<Request, "auth0" | "headers">): Promise<ProposalCreator> {
  const sub = viewerSub(req)
  const cached = userCache.get(sub)
  if(cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.user

  const token = req.headers.authorization?.slice("Bearer ".length) ?? ""
  const info = await fetchUserInfo(token)
  const user = { sub, name: info.label ?? info.email ?? "Unknown", email: info.email ?? "" }
  userCache.set(sub, { user, at: Date.now() })
  return user
}

function withSize(entry: ProposalEntry) {
  return { ...entry, sizeBytes: statSync(path.join(PROPOSAL_BUILDER_OUTPUT_DIR, entry.filename)).size }
}

// ---------- Manifest ----------

router.get(`${ BASE }/manifest`, auth0, (req: Request, res: Response) => {
  const sub = viewerSub(req)
  const entries = readProposalManifest()
    .filter((e) => existsSync(path.join(PROPOSAL_BUILDER_OUTPUT_DIR, e.filename)))
    .map(withSize)
    .sort((a, b) => (b.last_refreshed_at ?? b.generated_at).localeCompare(a.last_refreshed_at ?? a.generated_at))

  // "All" groups by the Prepared By name given in the chat, sorted by it (Andrew, 2026-10-10) — not
  // by the Auth0 identity, whose label can be an email. Proposals without one group last.
  if(req.query.scope === "all") {
    const groups = new Map<string, { prepared_by: string | null; proposals: typeof entries }>()
    for(const entry of entries) {
      const name = entry.prepared_by ?? null
      const key = name?.toLowerCase() ?? ""
      const group = groups.get(key) ?? { prepared_by: name, proposals: [] }
      group.proposals.push(entry)
      groups.set(key, group)
    }
    const sorted = [...groups.values()].sort((a, b) => (a.prepared_by === null ? 1 : b.prepared_by === null ? -1 : a.prepared_by.localeCompare(b.prepared_by)))
    res.json({ viewer_sub: sub, groups: sorted })
    return
  }

  const mine = entries.filter((e) => e.created_by.sub === sub)
  res.json({ viewer_sub: sub, groups: [{ prepared_by: null, proposals: mine }] })
})

// ---------- Files ----------

function archivedFile(filename: string): string | null {
  const entry = readProposalManifest().find((e) => e.filename === filename)
  const filePath = path.join(PROPOSAL_BUILDER_OUTPUT_DIR, filename)
  return entry && existsSync(filePath) ? filePath : null
}

router.get(`${ BASE }/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const filePath = archivedFile(req.params.filename)
  if(!filePath) {
    res.status(404).json(NOT_FOUND)
    return
  }

  res.setHeader("Content-Type", DOCX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ req.params.filename }"`)
  res.send(readFileSync(filePath))
})

router.get(`${ BASE }/files/:filename/pdf`, auth0, asyncHandler(async(req: Request<{ filename: string }>, res: Response) => {
  const filePath = archivedFile(req.params.filename)
  if(!filePath) {
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

// Only the creator can delete; the files it was built from go with it.
router.delete(`${ BASE }/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readProposalManifest().find((e) => e.filename === filename)

  if(!entry) {
    res.status(404).json(NOT_FOUND)
    return
  }

  if(entry.created_by.sub !== viewerSub(req)) {
    res.status(403).json({ error: "forbidden", error_description: "Only the person who built this proposal can delete it." })
    return
  }

  deleteProposal(filename)
  for(const source of entry.sources) deleteAttachment(source.id)
  res.status(200).json({ filename })
})

// ---------- Attachments ----------

// Raw body (any Content-Type — browsers often send none for a .docx); the kind comes from the bytes.
// The original filename comes in ?name=.
router.post(
  `${ BASE }/attachments`,
  auth0,
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
  asyncHandler(async(req: Request<unknown, unknown, Buffer, { name?: string }>, res: Response) => {
    const sub = viewerSub(req)
    const file = req.body

    if(!Buffer.isBuffer(file) || file.length === 0) {
      res.status(400).json({ error: "invalid_file", error_description: "Upload a PDF quote or an AMS360 proposal (.docx or PDF)." })
      return
    }

    let kind
    try {
      kind = await detectKind(file)
    } catch(err) {
      if(err instanceof UnsupportedAttachmentError) {
        res.status(400).json({ error: "invalid_file", error_description: err.message })
        return
      }
      throw err
    }

    const name = typeof req.query.name === "string" && req.query.name.trim() ? path.basename(req.query.name.trim()) : (kind === "ams_docx" ? "proposal.docx" : "upload.pdf")
    const record = saveAttachment(file, name, kind, sub)
    void processAttachment(record, file)

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

// Removes a chip before it's sent. Once a proposal is built from it, it goes when the proposal does.
router.delete(`${ BASE }/attachments/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAttachment(req.params.id, viewerSub(req))
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }

  if(record.proposal_filename) {
    res.status(409).json({ error: "in_use", error_description: "This file is part of a proposal; delete the proposal to remove it." })
    return
  }

  deleteAttachment(record.id)
  res.status(204).end()
})

// ---------- Chat ----------

router.post(`${ BASE }/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id, attachment_ids = [], prepared_by } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  if(!Array.isArray(attachment_ids) || attachment_ids.length > MAX_ATTACHMENTS_PER_TURN || !attachment_ids.every((id) => typeof id === "string")) {
    return next(new ErrorResponse(`attachment_ids must be an array of at most ${ MAX_ATTACHMENTS_PER_TURN } ids`, 400))
  }

  const user = await currentUser(req)
  const attachments = (attachment_ids as string[]).map((id) => getOwnedAttachment(id, user.sub))
  if(attachments.some((a) => a === null)) {
    logger.warn({ sub: user.sub, attachment_ids }, "[proposal_builder_chat] attachment not found for this user")
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }

  const started = Date.now()
  logger.info({ sub: user.sub, attachments: attachments.map((a) => ({ id: a!.id, kind: a!.kind, status: a!.status })), resumed: Boolean(session_id), saved_prepared_by: typeof prepared_by === "string" && prepared_by.trim() !== "" }, "[proposal_builder_chat] turn started")
  // A saved name that isn't a valid "Firstname Lastname" is ignored (Claude asks instead), not rejected.
  const savedPreparedBy = typeof prepared_by === "string" ? prepared_by.trim().replace(/\s+/g, " ") : ""
  const turn = await runProposalBuilderChatTurn(message.trim(), session_id, user, attachments as ProposalAttachment[], PERSON_NAME.test(savedPreparedBy) ? savedPreparedBy : undefined)
  logger.info({ sub: user.sub, session_id: turn.sessionId, tool_calls: turn.toolCalls.map((c) => c.name), reply_chars: turn.reply.length, ms: Date.now() - started }, "[proposal_builder_chat] turn finished")

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
}))

