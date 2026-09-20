import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import type { RenewalPremiumSummaryManifestEntry } from "../utils/renewalPremiumSummaryArchive.js"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, deleteRenewalPremiumSummary, readManifest } from "../utils/renewalPremiumSummaryArchive.js"
import { runRenewalPremiumSummaryChatTurn } from "../utils/renewalPremiumSummaryChat.js"
import { RenewalPremiumSummaryRefreshError, refreshRenewalPremiumSummary } from "../utils/renewalPremiumSummaryRefresh.js"

export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const MAX_CHAT_MESSAGE_LENGTH = 2000

export type ManifestEntryWithSize = RenewalPremiumSummaryManifestEntry & { sizeBytes: number }
export type CsrGroup = { csr_code: string | null; csr_name: string | null; summaries: ManifestEntryWithSize[] }

// Same grouping convention as riskProfile.ts's groupByCsr — "Unassigned" (no csrcode on the
// underlying policy) sorts last, real CSRs alphabetically by name; within a group, soonest-due
// renewal first. Exported (pure, no Express/filesystem dependency) so it's directly testable.
export function groupByCsr(entries: ManifestEntryWithSize[]): CsrGroup[] {
  const groupsByCsr = new Map<string, CsrGroup>()

  for(const entry of entries) {
    const key = entry.csr_code ?? "__unassigned__"
    let group = groupsByCsr.get(key)

    if(!group) {
      group = { csr_code: entry.csr_code, csr_name: entry.csr_name, summaries: [] }
      groupsByCsr.set(key, group)
    }

    group.summaries.push(entry)
  }

  for(const group of groupsByCsr.values()) {
    group.summaries.sort((a, b) => a.renewal_date.localeCompare(b.renewal_date))
  }

  return [...groupsByCsr.values()].sort((a, b) => {
    if(a.csr_code === null) return 1
    if(b.csr_code === null) return -1
    return (a.csr_name ?? "").localeCompare(b.csr_name ?? "")
  })
}

router.get(`${ BASE }/renewal-premium-summaries/manifest`, auth0, (_req, res) => {
  const entriesWithSize = readManifest()
    .filter((entry) => existsSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({ ...entry, sizeBytes: statSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, entry.filename)).size }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

// filename is user-supplied (URL param) — validated against the manifest (the actual source of
// truth for what's archived) rather than a regex pattern before any filesystem access, both to 404
// on garbage and to rule out path traversal; a filename that isn't in the manifest is never read
// regardless of what it looks like.
router.get(`${ BASE }/renewal-premium-summaries/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readManifest().find((e) => e.filename === filename)

  if(!entry) {
    res.status(404).json({ error: "not_found", error_description: "This renewal premium summary doesn't exist." })
    return
  }

  const filePath = path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename)

  if(!existsSync(filePath)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal premium summary doesn't exist." })
    return
  }

  res.setHeader("Content-Type", XLSX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
})

// Deletes the archived file and its manifest entry — the frontend's own two-click confirm is the
// only guard against an accidental call; nothing else here asks for confirmation. filename is
// validated against the manifest first, same pattern as the routes above (deleteRenewalPremiumSummary
// itself also checks, but checking here first keeps the 404 branch explicit rather than inferred from
// a boolean return).
router.delete(`${ BASE }/renewal-premium-summaries/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!deleteRenewalPremiumSummary(filename)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal premium summary doesn't exist." })
    return
  }

  res.status(200).json({ filename })
})

// Updates just the Current/Renewal value cells of an already-generated report in place (see
// renewalPremiumSummaryRefresh.ts) — never rebuilds the file, so anything a CSR has since edited by
// hand elsewhere in the sheet is left alone. filename is validated against the manifest (same
// pattern as the file-download route above) before doing anything else.
router.post(`${ BASE }/renewal-premium-summaries/files/:filename/refresh`, auth0, asyncHandler(async(req: Request<{ filename: string }>, res: Response, next: NextFunction) => {
  const { filename } = req.params
  const entry = readManifest().find((e) => e.filename === filename)

  if(!entry) {
    return next(new ErrorResponse("This renewal premium summary doesn't exist.", 404))
  }

  try {
    const result = await refreshRenewalPremiumSummary(filename)
    res.status(200).json(result)
  } catch(error) {
    if(error instanceof RenewalPremiumSummaryRefreshError) {
      return next(new ErrorResponse(error.message, 409))
    }
    throw error
  }
}))

router.post(`${ BASE }/renewal-premium-summaries/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  const turn = await runRenewalPremiumSummaryChatTurn(message.trim(), session_id)

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
}))
