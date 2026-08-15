import { createHash } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { publicBaseUrl } from "../config/config.js"

const AUTH0_TENANT_DOMAIN = process.env.AUTH0_TENANT_DOMAIN!
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID!
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET!
const AUTH0_API_URI = process.env.AUTH0_API_URI!

const AUTH0_ISSUER = `https://${ AUTH0_TENANT_DOMAIN }/`
export const OUR_CALLBACK_URL = `${ publicBaseUrl }/callback`

export function buildAuth0AuthorizeUrl(state: string) {
  const url = new URL(`https://${ AUTH0_TENANT_DOMAIN }/authorize`)

  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", AUTH0_CLIENT_ID)
  url.searchParams.set("redirect_uri", OUR_CALLBACK_URL)
  url.searchParams.set("scope", "openid profile email")
  url.searchParams.set("audience", AUTH0_API_URI)
  url.searchParams.set("state", state)

  return url.toString()
}

export async function exchangeCodeForToken(code: string) {
  const response = await fetch(`https://${ AUTH0_TENANT_DOMAIN }/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      code,
      redirect_uri: OUR_CALLBACK_URL
    })
  })

  if(!response.ok) {
    throw new Error(`Auth0 token exchange failed: ${ response.status } ${ await response.text() }`)
  }

  const body = await response.json() as { access_token: string, expires_in: number }
  return { accessToken: body.access_token, expiresIn: body.expires_in }
}

const jwks = createRemoteJWKSet(new URL(`https://${ AUTH0_TENANT_DOMAIN }/.well-known/jwks.json`))

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: AUTH0_ISSUER,
    audience: AUTH0_API_URI
  })

  return payload
}

export function verifyCodeChallenge(codeVerifier: string, codeChallenge: string) {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url")
  return computed === codeChallenge
}
