import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import type { RiskProfileManifestEntry } from "../utils/riskProfileArchive.js"
import { RISK_PROFILE_OUTPUT_DIR, deleteRiskProfile, readManifest } from "../utils/riskProfileArchive.js"
import { runRiskProfileChatTurn } from "../utils/riskProfileChat.js"

export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MAX_CHAT_MESSAGE_LENGTH = 2000

export type ManifestEntryWithSize = RiskProfileManifestEntry & { sizeBytes: number }
export type CsrGroup = { csr_code: string | null; csr_name: string | null; summaries: ManifestEntryWithSize[] }

// Grouped by CSR server-side (unlike reports.ts's flat download-report listing) since that's the
// whole point of this index — a CSR should see only their own renewals-in-progress at a glance.
// "Unassigned" (no csrcode on the underlying policy) sorts last, real CSRs alphabetically by name.
// Within a group, sorted by renewal_date ascending — soonest-due renewal first — not generated_at,
// since that's what actually matters for a CSR deciding what to prep next. Exported (pure, no
// Express/filesystem dependency) so it's directly testable without standing up the OAuth flow.
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

router.get(`${ BASE }/risk-profile/manifest`, auth0, (_req, res) => {
  const entriesWithSize = readManifest()
    .filter((entry) => existsSync(path.join(RISK_PROFILE_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({ ...entry, sizeBytes: statSync(path.join(RISK_PROFILE_OUTPUT_DIR, entry.filename)).size }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

// filename is user-supplied (URL param) — validated against the manifest (the actual source of
// truth for what's archived) rather than a regex pattern before any filesystem access, both to 404
// on garbage and to rule out path traversal; a filename that isn't in the manifest is never read
// regardless of what it looks like.
router.get(`${ BASE }/risk-profile/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readManifest().find((e) => e.filename === filename)

  if(!entry) {
    res.status(404).json({ error: "not_found", error_description: "This risk profile doesn't exist." })
    return
  }

  const filePath = path.join(RISK_PROFILE_OUTPUT_DIR, filename)

  if(!existsSync(filePath)) {
    res.status(404).json({ error: "not_found", error_description: "This risk profile doesn't exist." })
    return
  }

  res.setHeader("Content-Type", DOCX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
})

// Deletes the archived file and its manifest entry — the frontend's own two-click confirm is the
// only guard against an accidental call; nothing else here asks for confirmation. filename is
// validated against the manifest first, same pattern as the routes above (deleteRiskProfile itself
// also checks, but checking here first keeps the 404 branch explicit rather than inferred from a
// boolean return). Mirrors renewal-premium-summaries' DELETE route exactly.
router.delete(`${ BASE }/risk-profile/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!deleteRiskProfile(filename)) {
    res.status(404).json({ error: "not_found", error_description: "This risk profile doesn't exist." })
    return
  }

  res.status(200).json({ filename })
})

router.post(`${ BASE }/risk-profile/chat`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  const turn = await runRiskProfileChatTurn(message.trim(), session_id)

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
}))
