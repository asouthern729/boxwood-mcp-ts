import { Router } from "express"
import auth0 from "../middleware/auth/auth0/index.js"
import { getDownload } from "../utils/downloadStore.js"
import { downloadCounts, recordDownload } from "../utils/downloadLog.js"

export const router = Router()

router.get("/downloads/:token", (req, res) => {
  const entry = getDownload(req.params.token)

  if(!entry) {
    res.status(404).json({
      error: "not_found",
      error_description: "This download link has expired or doesn't exist."
    })
    return
  }

  res.setHeader("Content-Type", entry.mimeType)
  res.setHeader("Content-Disposition", `attachment; filename="${ entry.filename }"`)
  res.send(entry.buffer)
  recordDownload(req, "chat-link", entry.filename)
})

// All-time download count per tool page, keyed by the same tool ids the records use:
// { counts: { "risk-profile": 3, "cl-renewal-summary": 0, ... } }
router.get("/api/v1/boxwood-mcp/downloads/stats", auth0, (_req, res) => {
  res.json({ counts: downloadCounts() })
})
