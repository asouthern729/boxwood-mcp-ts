import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import {
  PL_RENEWAL_CHANGE_OUTPUT_DIR, deletePlRenewalChange, readPlRenewalChangeManifest
} from "../utils/plRenewalPremiumChangeArchive.js"
import { runPlRenewalPremiumChangeChatTurn } from "../utils/plRenewalPremiumChangeChat.js"
import { groupByCsr } from "./riskProfile.js"

// Mirrors routes/plRenewalSummary.ts route-for-route, under /pl-renewal-premium-change/ — the
// employee dashboard's /personal/premium-change-tool page (manifest grouped by CSR, xlsx
// download/delete validated against the manifest, embedded chat for on-demand builds). Entries carry
// extra totals and the paste-ready note so index rows don't have to open the workbook.
export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const MAX_CHAT_MESSAGE_LENGTH = 2000
const NOT_FOUND = { error: "not_found", error_description: "This renewal premium change workbook doesn't exist." }

router.get(`${ BASE }/pl-renewal-premium-change/manifest`, auth0, (_req, res) => {
  const entriesWithSize = readPlRenewalChangeManifest()
    .filter((entry) => existsSync(path.join(PL_RENEWAL_CHANGE_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({ ...entry, sizeBytes: statSync(path.join(PL_RENEWAL_CHANGE_OUTPUT_DIR, entry.filename)).size }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

router.get(`${ BASE }/pl-renewal-premium-change/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readPlRenewalChangeManifest().find((e) => e.filename === filename)
  const filePath = path.join(PL_RENEWAL_CHANGE_OUTPUT_DIR, filename)

  if(!entry || !existsSync(filePath)) {
    res.status(404).json(NOT_FOUND)
    return
  }

  res.setHeader("Content-Type", XLSX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
})

router.delete(`${ BASE }/pl-renewal-premium-change/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!deletePlRenewalChange(filename)) {
    res.status(404).json(NOT_FOUND)
    return
  }

  res.status(200).json({ filename })
})

router.post(`${ BASE }/pl-renewal-premium-change/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  const turn = await runPlRenewalPremiumChangeChatTurn(message.trim(), session_id)

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
}))
