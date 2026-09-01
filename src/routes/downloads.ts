import { Router } from "express"
import { getDownload } from "../utils/downloadStore.js"

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
})
