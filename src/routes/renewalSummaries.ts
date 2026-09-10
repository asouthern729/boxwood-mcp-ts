import { Router } from "express"
import type { Request, Response } from "express"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import type { RenewalSummaryManifestEntry } from "../utils/renewalSummaryArchive.js"
import { RENEWAL_SUMMARY_OUTPUT_DIR, readManifest } from "../utils/renewalSummaryArchive.js"

export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export type ManifestEntryWithSize = RenewalSummaryManifestEntry & { sizeBytes: number }
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

router.get(`${ BASE }/renewal-summaries/manifest`, auth0, (_req, res) => {
  const entriesWithSize = readManifest()
    .filter((entry) => existsSync(path.join(RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)))
    .map((entry) => ({ ...entry, sizeBytes: statSync(path.join(RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)).size }))

  res.json({ groups: groupByCsr(entriesWithSize) })
})

// filename is user-supplied (URL param) — validated against the manifest (the actual source of
// truth for what's archived) rather than a regex pattern before any filesystem access, both to 404
// on garbage and to rule out path traversal; a filename that isn't in the manifest is never read
// regardless of what it looks like.
router.get(`${ BASE }/renewal-summaries/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params
  const entry = readManifest().find((e) => e.filename === filename)

  if(!entry) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  const filePath = path.join(RENEWAL_SUMMARY_OUTPUT_DIR, filename)

  if(!existsSync(filePath)) {
    res.status(404).json({ error: "not_found", error_description: "This renewal summary doesn't exist." })
    return
  }

  res.setHeader("Content-Type", DOCX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
})
