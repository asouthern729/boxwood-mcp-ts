import express, { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { z } from "zod"
import Anthropic from "@anthropic-ai/sdk"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import { logger } from "../utils/logger.js"
import { streamAssistantReply } from "../utils/assistantChat.js"
import { unknownToolPaths } from "../assistant/catalog.js"
import {
  MAX_FILES_PER_CHAT, MAX_PAGES_PER_CHAT, attachmentBlock, attachmentSummary, deleteAssistantAttachment,
  getOwnedAssistantAttachment, saveAssistantAttachment, type AssistantAttachment
} from "../utils/assistantAttachments.js"
import { UploadReadError } from "../utils/uploadNormalize.js"
import path from "node:path"

export const router: Router = express.Router()

const BASE = "/api/v1/boxwood-mcp"

// The global express.json() limit is 100kb, so the UI should send at most the last 20 messages;
// anything older is dropped here too.
const MAX_MESSAGES = 20
const MAX_MESSAGE_LENGTH = 4000

// The UI sends the whole conversation each turn (it keeps history in sessionStorage).
const ChatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(MAX_MESSAGE_LENGTH)
  })).min(1),
  context: z.unknown().optional(),
  // Files attached to this chat (POST /assistant/attachments); the UI sends all of them every turn.
  attachment_ids: z.array(z.string()).max(MAX_FILES_PER_CHAT).optional()
})

// path and tool go into the system prompt, so they're held to route-shaped, short strings. A
// context that doesn't fit is dropped rather than failing the whole message.
const ChatContext = z.object({
  path: z.string().max(100).regex(/^\/[A-Za-z0-9\-/]*$/),
  tool: z.string().max(60).regex(/^[A-Za-z0-9 \-]+$/).nullable()
})

// Per-user limit, kept in memory: 30 turns per 5 minutes.
const WINDOW_MS = 5 * 60 * 1000
const MAX_TURNS_PER_WINDOW = 30
const turnsByUser = new Map<string, number[]>()

function overLimit(sub: string): boolean {
  const now = Date.now()
  const recent = (turnsByUser.get(sub) ?? []).filter((at) => now - at < WINDOW_MS)

  if(recent.length >= MAX_TURNS_PER_WINDOW) {
    turnsByUser.set(sub, recent)
    return true
  }

  recent.push(now)
  turnsByUser.set(sub, recent)
  return false
}

function sendEvent(res: Response, event: "delta" | "done" | "error", data: object) {
  res.write(`event: ${ event }\ndata: ${ JSON.stringify(data) }\n\n`)
}

router.post(`${ BASE }/assistant/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const parsed = ChatBody.safeParse(req.body)

  if(!parsed.success) {
    return next(new ErrorResponse(`Invalid request: ${ parsed.error.issues[0]?.message ?? "bad body" }`, 400))
  }

  // Keep the most recent turns, starting on a user message as the API requires.
  let messages = parsed.data.messages.slice(-MAX_MESSAGES)
  while(messages.length && messages[0].role !== "user") messages = messages.slice(1)

  if(!messages.length || messages[messages.length - 1].role !== "user") {
    return next(new ErrorResponse("The conversation must end with a user message", 400))
  }

  const sub = req.auth0?.sub ?? "unknown"
  const contextResult = ChatContext.safeParse(parsed.data.context)
  const context = contextResult.success ? contextResult.data : undefined

  if(overLimit(sub)) {
    return next(new ErrorResponse("You've sent a lot of messages in a short time. Please wait a few minutes and try again.", 429))
  }

  // Checked before the stream opens, so a missing or oversized file is a plain JSON error.
  const ids = [...new Set(parsed.data.attachment_ids ?? [])]
  const attachments = ids.map((id) => getOwnedAssistantAttachment(id, sub))
  if(attachments.some((a) => !a)) {
    res.status(404).json({ error: "attachment_not_found", error_description: "A file on this chat has expired or was removed. Remove it and upload it again.", missing: ids.filter((_, i) => !attachments[i]) })
    return
  }
  const files = attachments as AssistantAttachment[]
  const pages = files.reduce((total, a) => total + a.pages, 0)
  if(pages > MAX_PAGES_PER_CHAT) {
    return next(new ErrorResponse(`These files total ${ pages } pages; the assistant can read ${ MAX_PAGES_PER_CHAT } at most in one chat. Remove a file, or upload just the pages you have questions about.`, 400))
  }
  let documents
  try {
    documents = await Promise.all(files.map(attachmentBlock))
  } catch(error) {
    if(error instanceof UploadReadError) return next(new ErrorResponse(error.message, 400))
    throw error
  }

  res.status(200)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  // nginx buffers proxied responses unless told not to.
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders()

  const abort = new AbortController()
  res.on("close", () => {
    if(!res.writableFinished) abort.abort()
  })

  try {
    const result = await streamAssistantReply(messages, context, (text) => sendEvent(res, "delta", { text }), abort.signal, documents)

    if(result.stopReason === "refusal") {
      sendEvent(res, "error", { message: "I can't help with that one. Try rephrasing, or ask about the Boxwood app or an insurance topic." })
    } else {
      sendEvent(res, "done", {})
    }

    const badPaths = unknownToolPaths(result.text)
    if(badPaths.length) logger.warn({ sub, badPaths }, "[ASSISTANT] reply linked to unknown pages")

    logger.info({ sub, path: context?.path, files: files.length, pages, stopReason: result.stopReason, ...result.usage }, "[ASSISTANT] turn")
  } catch(err) {
    if(abort.signal.aborted) {
      logger.info({ sub }, "[ASSISTANT] client disconnected mid-reply")
      return
    }

    logger.error({ err, sub }, "[ASSISTANT] turn failed")
    const message = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError ?
      "The assistant is busy right now. Please try again in a minute." :
      "Something went wrong getting a reply. Please try again."
    sendEvent(res, "error", { message })
  }

  res.end()
}))

// ---------- Attached files ----------
// Raw body (any Content-Type; the type is read from the bytes), original filename in ?name=. The file
// is converted before this returns, so it's ready to ask about at once.
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024
const ATTACHMENT_NOT_FOUND = { error: "not_found", error_description: "This file has expired or was removed." }

router.post(
  `${ BASE }/assistant/attachments`,
  auth0,
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  asyncHandler(async(req: Request<unknown, unknown, Buffer, { name?: string }>, res: Response) => {
    const sub = req.auth0?.sub
    if(!sub) {
      res.status(401).json({ error: "unauthorized", error_description: "Sign in again to attach files." })
      return
    }
    if(!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "invalid_file", error_description: "The file was empty." })
      return
    }
    const name = typeof req.query.name === "string" && req.query.name.trim() ? path.basename(req.query.name.trim()) : "document"

    try {
      const record = await saveAssistantAttachment(req.body, name, sub)
      logger.info({ sub, attachment: record.id, pages: record.pages, format: record.format }, "[ASSISTANT] file attached")
      res.status(201).json(attachmentSummary(record))
    } catch(error) {
      if(error instanceof UploadReadError) {
        res.status(400).json({ error: "invalid_file", error_description: error.message })
        return
      }
      throw error
    }
  })
)

router.get(`${ BASE }/assistant/attachments/:id`, auth0, (req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAssistantAttachment(req.params.id, req.auth0?.sub ?? "unknown")
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }
  res.json(attachmentSummary(record))
})

router.delete(`${ BASE }/assistant/attachments/:id`, auth0, asyncHandler(async(req: Request<{ id: string }>, res: Response) => {
  const record = getOwnedAssistantAttachment(req.params.id, req.auth0?.sub ?? "unknown")
  if(!record) {
    res.status(404).json(ATTACHMENT_NOT_FOUND)
    return
  }
  await deleteAssistantAttachment(record)
  res.status(200).json({ id: record.id })
}))
