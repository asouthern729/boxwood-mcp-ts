import { randomUUID } from "node:crypto"

const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000
const AUTH_CODE_TTL_MS = 60 * 1000

type PendingAuthorization = {
  clientId: string
  redirectUri: string
  state: string | undefined
  codeChallenge: string
}

type AuthCode = {
  auth0AccessToken: string
  expiresIn: number
  codeChallenge: string
  clientId: string
  redirectUri: string
}

type RegisteredClient = {
  redirectUris: string[]
}

const pendingAuthorizations = new Map<string, { value: PendingAuthorization, expiresAt: number }>()
const authCodes = new Map<string, { value: AuthCode, expiresAt: number }>()
const registeredClients = new Map<string, RegisteredClient>()

export function createPendingAuthorization(value: PendingAuthorization) {
  const transactionId = randomUUID()
  pendingAuthorizations.set(transactionId, { value, expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS })
  return transactionId
}

export function consumePendingAuthorization(transactionId: string) {
  const entry = pendingAuthorizations.get(transactionId)
  pendingAuthorizations.delete(transactionId)

  if(!entry || entry.expiresAt < Date.now()) return undefined

  return entry.value
}

export function createAuthCode(value: AuthCode) {
  const code = randomUUID()
  authCodes.set(code, { value, expiresAt: Date.now() + AUTH_CODE_TTL_MS })
  return code
}

export function consumeAuthCode(code: string) {
  const entry = authCodes.get(code)
  authCodes.delete(code)

  if(!entry || entry.expiresAt < Date.now()) return undefined

  return entry.value
}

export function registerClient(redirectUris: string[]) {
  const clientId = randomUUID()
  registeredClients.set(clientId, { redirectUris })
  return clientId
}

export function getClient(clientId: string) {
  return registeredClients.get(clientId)
}
