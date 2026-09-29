import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import {
  PL_RENEWAL_SUMMARY_OUTPUT_DIR, deletePlRenewalSummary, readPlRenewalSummaryManifest
} from "../utils/plRenewalSummaryArchive.js"
import { runPlRenewalSummaryChatTurn } from "../utils/plRenewalSummaryChat.js"
import { groupByCsr } from "./riskProfile.js"

// Mirrors routes/clRenewalSummary.ts route-for-route, under /pl-renewal-summary/ — the employee
// dashboard's /personal/renewal-summary page is a copy of its commercial Renewal Summary page and
// consumes the identical contract (manifest grouped by CSR, file download/delete validated against
// the manifest, embedded chat). See routes/riskProfile.ts for the reasoning behind each route.
export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_CHAT_MESSAGE_LENGTH = 2000

router.get(`${ BASE }/pl-renewal-summary/manifest`, auth0, (_req, res) => {
  const entriesWithSize = readPlRenewalSummaryManifest()
    .filter((entry) => existsSync(path.join(PL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({ ...entry, sizeBytes: statSync(path.join(PL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)).size }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

router.get(`${ BASE }/pl-renewal-summary/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readPlRenewalSummaryManifest().find((e) => e.filename === filename)

  if(!entry) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  const filePath = path.join(PL_RENEWAL_SUMMARY_OUTPUT_DIR, filename)

  if(!existsSync(filePath)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  res.setHeader("Content-Type", DOCX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
})

router.delete(`${ BASE }/pl-renewal-summary/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!deletePlRenewalSummary(filename)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  res.status(200).json({ filename })
})

router.post(`${ BASE }/pl-renewal-summary/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  const turn = await runPlRenewalSummaryChatTurn(message.trim(), session_id)

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
}))
