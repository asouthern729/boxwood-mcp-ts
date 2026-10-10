import { ErrorResponse } from '../../utils/errorResponse.js'
import { logger } from '../../utils/logger.js'

// Types
import type { Response, Request, NextFunction } from 'express'

interface ErrorWithStatus extends Error {
  statusCode: number
}

export default (err: ErrorWithStatus, req: Request, res: Response, _next: NextFunction) => {
  let error = { ...err }

  error = new ErrorResponse(err.message, err.statusCode || 500)

  // Error responses used to go out unlogged, which hid a failing Proposal Builder chat turn
  // (2026-10-10): server errors with their stack, client errors as a one-line warning.
  const status = error.statusCode || 500
  if(status >= 500) logger.error({ err, method: req.method, path: req.path, status }, 'request failed')
  else logger.warn({ method: req.method, path: req.path, status, message: err.message }, 'request rejected')
  
  res.status(status).json({
    success: false,
    error: error.message || 'Server Error'
  })
}