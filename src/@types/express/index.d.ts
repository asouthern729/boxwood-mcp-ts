import type { Auth0User } from "../../utils/auth0.js"

declare global {
  namespace Express {
    interface Request {
      auth0?: Auth0User
    }
  }
}

export {}
