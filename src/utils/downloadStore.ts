import { randomUUID } from "node:crypto"

// Single-process, in-memory store for generated files (e.g. download_report_workbook's .xlsx)
// handed out as a short-lived link instead of embedding the bytes in the MCP tool result — clients
// were trying to interpret/convert the embedded blob's MIME type rather than treat it as an opaque
// attachment. Fine to keep in memory only: this server runs as a single pm2 instance
// (ecosystem.config.cjs instances: 1), and losing unclaimed links on a restart is an acceptable
// trade for not needing disk cleanup.
type StoredDownload = { buffer: Buffer; filename: string; mimeType: string; expiresAt: number }

const TTL_MS = 24 * 60 * 60 * 1000
const store = new Map<string, StoredDownload>()

export function storeDownload(buffer: Buffer, filename: string, mimeType: string): string {
  const token = randomUUID()
  store.set(token, { buffer, filename, mimeType, expiresAt: Date.now() + TTL_MS })
  return token
}

// Reusable within the TTL window (not single-use-delete-on-first-fetch) — a rep re-opening or
// forwarding the link within the same day should still work.
export function getDownload(token: string): StoredDownload | undefined {
  const entry = store.get(token)
  if(!entry) return undefined

  if(Date.now() > entry.expiresAt) {
    store.delete(token)
    return undefined
  }

  return entry
}

// Sweeps links nobody ever opened so the store doesn't grow unbounded; unref'd so it never keeps
// the process alive on its own.
setInterval(() => {
  const now = Date.now()

  for(const [token, entry] of store) {
    if(now > entry.expiresAt) store.delete(token)
  }
}, 60 * 60 * 1000).unref()
