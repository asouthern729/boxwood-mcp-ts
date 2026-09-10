// Types
import { Request, Response, NextFunction } from 'express'

const sanitizeString = (s: string) =>
  s.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;")

export const sanitizeAny = (value: any): any => {
  if(typeof value === 'string') return sanitizeString(value)

  if(Array.isArray(value)) {
    // sanitize each element and write back
    return value.map(v => sanitizeAny(v))
  }

  if(value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      value[k] = sanitizeAny(value[k])
    }
    return value
  }

  return value
}

export default (req: Request, _res: Response, next: NextFunction) => {
  if(req.body !== null && req.body !== undefined) {
    req.body = sanitizeAny(req.body)
  }
  next()
}