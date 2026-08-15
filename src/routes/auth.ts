import express, { Router } from "express"
import {
  buildAuth0AuthorizeUrl,
  exchangeCodeForToken,
  verifyCodeChallenge
} from "../utils/auth0.js"
import {
  consumeAuthCode,
  consumePendingAuthorization,
  createAuthCode,
  createPendingAuthorization,
  getClient,
  registerClient
} from "../utils/authStore.js"
import { logger } from "../utils/logger.js"

export const router = Router()

router.post("/register", (req, res) => {
  const redirectUris = req.body?.redirect_uris

  if(!Array.isArray(redirectUris) || redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" })
    return
  }

  const clientId = registerClient(redirectUris)

  res.status(201).json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"]
  })
})

router.get("/authorize", (req, res) => {
  const clientId = String(req.query.client_id ?? "")
  const redirectUri = String(req.query.redirect_uri ?? "")
  const state = req.query.state === undefined ? undefined : String(req.query.state)
  const codeChallenge = String(req.query.code_challenge ?? "")
  const codeChallengeMethod = req.query.code_challenge_method

  const client = getClient(clientId)

  if(!client || !client.redirectUris.includes(redirectUri)) {
    res.status(400).json({ error: "invalid_request", error_description: "Unknown client_id or redirect_uri" })
    return
  }

  if(codeChallengeMethod !== "S256" || !codeChallenge) {
    res.status(400).json({ error: "invalid_request", error_description: "PKCE (S256) is required" })
    return
  }

  const transactionId = createPendingAuthorization({ clientId, redirectUri, state, codeChallenge })

  logger.info({ transactionId, clientId, redirectUri }, "Created pending authorization")

  res.redirect(buildAuth0AuthorizeUrl(transactionId))
})

router.get("/callback", async (req, res) => {
  const auth0Code = String(req.query.code ?? "")
  const transactionId = String(req.query.state ?? "")

  if(req.query.error) {
    logger.warn({ transactionId, auth0Error: req.query.error, auth0ErrorDescription: req.query.error_description }, "Auth0 returned an error to /callback")
    res.status(400).json({ error: req.query.error, error_description: req.query.error_description ?? "Auth0 returned an error" })
    return
  }

  const pending = consumePendingAuthorization(transactionId)

  if(!auth0Code || !pending) {
    logger.warn({ transactionId, hadCode: Boolean(auth0Code) }, "No matching pending authorization for /callback state")
    res.status(400).json({ error: "invalid_request", error_description: "Missing or expired authorization state" })
    return
  }

  logger.info({ transactionId, clientId: pending.clientId }, "Resolved pending authorization, exchanging code with Auth0")

  try {
    const { accessToken, expiresIn } = await exchangeCodeForToken(auth0Code)

    const ourCode = createAuthCode({
      auth0AccessToken: accessToken,
      expiresIn,
      codeChallenge: pending.codeChallenge,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri
    })

    const redirectUrl = new URL(pending.redirectUri)
    redirectUrl.searchParams.set("code", ourCode)
    if(pending.state !== undefined) redirectUrl.searchParams.set("state", pending.state)

    res.redirect(redirectUrl.toString())
  } catch(error) {
    logger.error({ err: error }, "Auth0 code exchange failed")
    res.status(502).json({ error: "server_error", error_description: "Failed to exchange code with Auth0" })
  }
})

router.post("/token", express.urlencoded({ extended: false }), (req, res) => {
  const code = req.body?.code
  const codeVerifier = req.body?.code_verifier
  const redirectUri = req.body?.redirect_uri
  const clientId = req.body?.client_id

  const entry = consumeAuthCode(String(code ?? ""))

  if(!entry) {
    logger.warn({ clientId }, "POST /token: unknown or expired code")
    res.status(400).json({ error: "invalid_grant", error_description: "Unknown or expired code" })
    return
  }

  if(entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
    logger.warn({ clientId, expectedClientId: entry.clientId }, "POST /token: client_id or redirect_uri mismatch")
    res.status(400).json({ error: "invalid_grant", error_description: "client_id or redirect_uri mismatch" })
    return
  }

  if(!codeVerifier || !verifyCodeChallenge(String(codeVerifier), entry.codeChallenge)) {
    logger.warn({ clientId }, "POST /token: PKCE verification failed")
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" })
    return
  }

  logger.info({ clientId }, "Issued access token")

  res.json({
    access_token: entry.auth0AccessToken,
    token_type: "Bearer",
    expires_in: entry.expiresIn
  })
})
