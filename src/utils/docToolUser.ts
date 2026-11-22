import type { Request } from "express"
import { fetchUserInfo } from "./auth0.js"
import type { DocToolUser } from "./docToolStore.js"
import { ErrorResponse } from "./errorResponse.js"

// The signed-in staff member for the upload-and-run document tool routes (Policy Check, CL
// Coverage Comparison). Name and email come from Auth0 /userinfo — the access token doesn't carry
// them — cached per user for an hour.

export function viewerSub(req: Pick<Request, "auth0">): string {
  const sub = req.auth0?.sub
  if(!sub) throw new ErrorResponse("Not authorized to access this route", 401)
  return sub
}

const userCache = new Map<string, { user: DocToolUser; at: number }>()

export async function currentUser(req: Pick<Request, "auth0" | "headers">): Promise<DocToolUser> {
  const sub = viewerSub(req)
  const cached = userCache.get(sub)
  if(cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.user
  const token = req.headers.authorization?.slice("Bearer ".length) ?? ""
  const info = await fetchUserInfo(token)
  const user = { sub, name: info.label ?? info.email ?? "Unknown", email: info.email ?? "" }
  userCache.set(sub, { user, at: Date.now() })
  return user
}
