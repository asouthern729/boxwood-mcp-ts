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
  context: z.unknown().optional()
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
    const result = await streamAssistantReply(messages, context, (text) => sendEvent(res, "delta", { text }), abort.signal)

    if(result.stopReason === "refusal") {
      sendEvent(res, "error", { message: "I can't help with that one. Try rephrasing, or ask about the Boxwood app or an insurance topic." })
    } else {
      sendEvent(res, "done", {})
    }

    const badPaths = unknownToolPaths(result.text)
    if(badPaths.length) logger.warn({ sub, badPaths }, "[ASSISTANT] reply linked to unknown pages")

    logger.info({ sub, path: context?.path, stopReason: result.stopReason, ...result.usage }, "[ASSISTANT] turn")
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
