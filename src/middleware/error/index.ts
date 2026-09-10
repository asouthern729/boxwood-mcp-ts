import { ErrorResponse } from '../../utils/errorResponse.js'

// Types
import type { Response, Request, NextFunction } from 'express'

interface ErrorWithStatus extends Error {
  statusCode: number
}

export default (err: ErrorWithStatus, _req: Request, res: Response, _next: NextFunction) => {
  let error = { ...err }

  error = new ErrorResponse(err.message, err.statusCode || 500)
  
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'Server Error'
  })
}