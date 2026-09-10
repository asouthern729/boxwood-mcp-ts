import { logger } from "../../../utils/logger.js"
import { ErrorResponse } from "../../../utils/errorResponse.js"
import { verifyAccessToken } from "../../../utils/auth0.js"

// Types
import type { Request, Response, NextFunction } from "express"

export default async (req: Request, _res: Response, next: NextFunction) => {
  if(!req.headers.authorization?.startsWith("Bearer ")) {
    return next(new ErrorResponse("Authorization header required", 401))
  }

  const token = req.headers.authorization.slice("Bearer ".length)

  try {
    req.auth0 = await verifyAccessToken(token)
    next()
  } catch(err) {
    logger.error(`[AUTH] token verification error: ${ err instanceof Error ? err.message : err }`)
    next(new ErrorResponse("Not authorized to access this route", 401))
  }
}
