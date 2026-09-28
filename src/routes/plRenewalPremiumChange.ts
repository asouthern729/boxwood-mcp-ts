import { Router } from "express"
import type { Request, Response, NextFunction } from "express"
import auth0 from "../middleware/auth/auth0/index.js"
import asyncHandler from "../middleware/async/index.js"
import { ErrorResponse } from "../utils/errorResponse.js"
import { activityLineHeader, downloadWindow, fetchPlRenewalPremiumChanges, formatActivityLine } from "../utils/plRenewalPremiumChange.js"

export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

// Standalone dashboard view of the PL Renewal Premium Change tool (Patrick, 2026-09-15: "identify
// client name/number and ... timeframe"). Computed on request, nothing archived — same as the daily
// email, these aren't meant to be saved anywhere.
router.get(`${ BASE }/pl-renewal-premium-change`, auth0, asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const customerName = optionalString(req.query.customer_name)
  const policyNo = optionalString(req.query.policy_no)
  const startDate = optionalString(req.query.start_date)
  const endDate = optionalString(req.query.end_date)

  if(customerName !== undefined && customerName.length < 2) {
    return next(new ErrorResponse("customer_name must be at least 2 characters", 400))
  }

  if([startDate, endDate].some((d) => d !== undefined && !DATE_ONLY_PATTERN.test(d))) {
    return next(new ErrorResponse("start_date and end_date must be YYYY-MM-DD", 400))
  }

  const { renewals, truncated } = await fetchPlRenewalPremiumChanges({
    ...downloadWindow(startDate, endDate),
    customerName,
    polno: policyNo
  })

  res.status(200).json({
    count: renewals.length,
    truncated,
    renewals,
    activity_header: activityLineHeader(),
    activity_lines: renewals.map(formatActivityLine)
  })
}))
