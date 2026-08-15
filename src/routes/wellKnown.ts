import { Router } from "express"
import { publicBaseUrl } from "../config/config.js"

export const router = Router()

router.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${ publicBaseUrl }/mcp`,
    authorization_servers: [publicBaseUrl]
  })
})

router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: publicBaseUrl,
    authorization_endpoint: `${ publicBaseUrl }/authorize`,
    token_endpoint: `${ publicBaseUrl }/token`,
    registration_endpoint: `${ publicBaseUrl }/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  })
})
