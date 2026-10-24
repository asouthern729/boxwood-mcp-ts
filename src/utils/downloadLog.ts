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

  const token = req.headers.authorization?.slice("Bearer ".length) ?? ""
  const { label } = await fetchUserInfo(token)
  nameCache.set(sub, { name: label, at: Date.now() })
  return label
}

// Call right after res.send on a successful download. Fire-and-forget: it never delays or fails the
// response it's recording.
export function recordDownload(req: Request, tool: string, filename: string): void {
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
