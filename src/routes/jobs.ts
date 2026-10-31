import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import auth0 from "../middleware/auth/auth0/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import { isJobId, readJobStatus } from "../utils/jobStatus.js"

export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const

// Last-run status of scheduled cron jobs, for each tool page's "last automatic run" line
// (src/utils/jobStatus.ts). ?names=cl-renewal-summaries[,monthly-risk-profiles...] — the Renewal
// Premium Summary page asks for two at once. Statuses come back in the order asked.
router.get(`${ BASE }/jobs`, auth0, (req: Request, res: Response, next: NextFunction) => {
  const names = typeof req.query.names === "string" ? req.query.names.split(",").map((n) => n.trim()).filter(Boolean) : []
  if(names.length === 0) return next(new ErrorResponse("names is required: one or more job ids, comma-separated", 400))

  const unknown = names.filter((n) => !isJobId(n))
  if(unknown.length > 0) return next(new ErrorResponse(`Unknown job(s): ${ unknown.join(", ") }`, 400))

  const now = new Date()
  res.json({ jobs: names.map((n) => readJobStatus(n as Parameters<typeof readJobStatus>[0], now)) })
})
