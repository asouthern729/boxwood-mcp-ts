import { Router } from "express"
import type { Request, Response } from "express"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import auth0 from "../middleware/auth/auth0/index.js"
import { readDownloadReportWatermark } from "../utils/downloadReportWatermark.js"

export const router = Router()

// Same directory scripts/morningDownload.ts writes to and scripts/sendReportEmail.ts reads
// from — this route only reads it, never writes.
const OUTPUT_DIR = path.join(import.meta.dirname, "..", "..", "scripts", "output", "download-report")
const BASE = "/api/v1/boxwood-mcp" as const
const REPORT_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}_download_report\.xlsx$/
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

// lastSync reflects only the most recently generated report (the watermark is overwritten each
// run, not kept per report date) — a status summary alongside the list, not per-row metadata.
router.get(`${ BASE }/reports/manifest`, auth0, (_req, res) => {
  const watermark = readDownloadReportWatermark()
  const lastSync = watermark && {
    syncedUntil: watermark.syncedUntil.toISOString(),
    tablesTouched: watermark.tablesTouched,
    rowsEntered: watermark.rowsEntered
  }

  if(!existsSync(OUTPUT_DIR)) {
    res.json({ reports: [], lastSync })
    return
  }

  const reports = readdirSync(OUTPUT_DIR)
    .filter((name) => REPORT_FILENAME_PATTERN.test(name))
    .map((filename) => ({
      date: filename.slice(0, 10),
      filename,
      sizeBytes: statSync(path.join(OUTPUT_DIR, filename)).size
    }))
    .sort((a, b) => b.date.localeCompare(a.date))

  res.json({ reports, lastSync })
})

// filename is user-supplied (URL param) — validated against the exact naming convention before
// any filesystem access, both to 404 on garbage and to rule out path traversal.
router.get(`${ BASE }/reports/files/:filename`, auth0, (req: Request<{ filename: string }>, res: Response) => {
  const { filename } = req.params

  if(!REPORT_FILENAME_PATTERN.test(filename)) {
    res.status(404).json({ error: "not_found", error_description: "This report doesn't exist." })
    return
  }

  const filePath = path.join(OUTPUT_DIR, filename)

  if(!existsSync(filePath)) {
    res.status(404).json({ error: "not_found", error_description: "This report doesn't exist." })
    return
  }

  res.setHeader("Content-Type", XLSX_MIME_TYPE)
  res.setHeader("Content-Disposition", `attachment; filename="${ filename }"`)
  res.send(readFileSync(filePath))
})
