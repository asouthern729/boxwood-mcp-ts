import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Request } from "express"
import { stateDir } from "../config/config.js"
import { fetchUserInfo } from "./auth0.js"
import { logger } from "./logger.js"

// One JSON line per document served, in <STATE_ROOT>/downloads/YYYY-MM.jsonl, so we can answer
// "how many times was this downloaded, and by whom". nginx's access log has the path but no user and
// only keeps 14 days. Names come from Auth0 /userinfo, which needs the downloader's own token, so
// they're resolved here at download time rather than when a report is run later.
export type DownloadRecord = {
  at: string
  tool: string
  filename: string
  format: string
  sub: string | null
  name: string | null
}

const DOWNLOADS_DIR = () => stateDir("downloads")

const nameCache = new Map<string, { name: string | null; at: number }>()
const NAME_TTL_MS = 60 * 60 * 1000

async function viewerName(req: Request, sub: string): Promise<string | null> {
  const cached = nameCache.get(sub)
  if(cached && Date.now() - cached.at < NAME_TTL_MS) return cached.name

  // A failed lookup still records the download, just without a name (and isn't cached, so the next
  // download retries).
  try {
    const token = req.headers.authorization?.slice("Bearer ".length) ?? ""
    const { label } = await fetchUserInfo(token)
    nameCache.set(sub, { name: label, at: Date.now() })
    return label
  } catch(error) {
    logger.warn({ err: error, sub }, "[download] couldn't resolve name")
    return null
  }
}

// Downloads whose record is still waiting on the Auth0 name lookup, counted in downloadCounts so the
// frontend's refetch right after a download already sees it.
const pending = new Map<string, number>()

// Call right after res.send on a successful download. Fire-and-forget: it never delays or fails the
// response it's recording. ?preview=1 marks the in-app Preview buttons, which fetch the same routes
// but aren't downloads.
export function recordDownload(req: Request, tool: string, filename: string): void {
  if(req.query.preview === "1") return

  pending.set(tool, (pending.get(tool) ?? 0) + 1)
  void (async() => {
    try {
      const sub = req.auth0?.sub ?? null
      const record: DownloadRecord = {
        at: new Date().toISOString(),
        tool,
        filename,
        format: path.extname(filename).slice(1).toLowerCase(),
        sub,
        name: sub ? await viewerName(req, sub) : null
      }

      mkdirSync(DOWNLOADS_DIR(), { recursive: true })
      appendFileSync(path.join(DOWNLOADS_DIR(), `${ record.at.slice(0, 7) }.jsonl`), `${ JSON.stringify(record) }\n`)
      logger.info(record, "[download]")
    } catch(error) {
      logger.warn({ err: error, tool, filename }, "[download] failed to record")
    } finally {
      pending.set(tool, pending.get(tool)! - 1)
    }
  })()
}

export function readDownloads(): DownloadRecord[] {
  if(!existsSync(DOWNLOADS_DIR())) return []

  return readdirSync(DOWNLOADS_DIR())
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => readFileSync(path.join(DOWNLOADS_DIR(), f), "utf8").split("\n"))
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as DownloadRecord]
      } catch {
        return []
      }
    })
}

// Every tool page with an odometer, so each one comes back even before its first download.
const TOOLS = [
  "cl-renewal-summary",
  "renewal-premium-summaries",
  "risk-profile",
  "pl-renewal-premium-change",
  "proposal-builder",
  "pl-renewal-summary",
  "download-report"
]

// All-time downloads per tool (docx/xlsx and PDF together, previews excluded), for the odometer on
// each tool page. Counting starts 2026-10-24; the nginx history was left out because it can't tell
// downloads from previews.
export function downloadCounts(): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(TOOLS.map((t) => [t, 0]))
  for(const r of readDownloads()) counts[r.tool] = (counts[r.tool] ?? 0) + 1
  for(const [tool, n] of pending) counts[tool] = (counts[tool] ?? 0) + n
  return counts
}
