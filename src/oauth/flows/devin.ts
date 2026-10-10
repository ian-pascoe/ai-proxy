/**
 * Devin (Cognition / Windsurf) login: authorization code + PKCE; the redirect target is `http://127.0.0.1:<port>/callback`
 * (Devin validates that shape), so on Workers the redirected URL is pasted back like for the other providers.
 *
 * Go source: auth_files_devin_oauth.go (`RequestDevinToken`, `completeDevinOAuth`), internal/auth/devin/
 * {devin_auth,record,pkce,user_status}.go (`BuildAuthorizationURL`, `ExchangeCodeForToken`, `FetchSelfProfile`,
 * `FormatSessionToken`, `CreateAuthRecord`). Docs: config-management-oauth.md §3.2.7.
 */
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import type { JsonObject } from "../../json/index.ts"
import { generatePkce, queryEscape, sha256Hex } from "../encoding.ts"
import { buildUserStatusRequest, parseUserStatus } from "./devin-status.ts"
import { call, parseJsonObject, str, tryCall, tryCallBytes } from "./http.ts"
import { type CallbackFlow, type CredentialRecord, flowFailure } from "./types.ts"

export const DEVIN_APP_URL = "https://app.devin.ai"
export const DEVIN_API_URL = "https://api.devin.ai"
export const DEVIN_SERVER_URL = "https://server.codeium.com"
export const DEVIN_GET_USER_STATUS_URL = `${DEVIN_SERVER_URL}/exa.seat_management_pb.SeatManagementService/GetUserStatus`
/** The port of the Go server's default listener; Devin only checks scheme, host and path of the redirect URI. */
export const DEVIN_REDIRECT_URI = "http://127.0.0.1:8317/callback"

const TOKEN_PREFIX = "devin-session-token$"
const EXCHANGE_FAILED = "Failed to exchange authorization code for tokens"

/** `FormatSessionToken`: tokens carry the mandatory `devin-session-token$` prefix. */
export const formatSessionToken = (raw: string): string => {
  const token = raw.trim()
  if (token.startsWith(TOKEN_PREFIX)) return token
  return token.startsWith("eyJ") ? `${TOKEN_PREFIX}${token}` : token
}

/** `CreateAuthRecord` file naming: path-unsafe or long identifiers are replaced by a hash. */
export const devinFileName = async (userName: string, userId: string, sessionToken: string): Promise<string> => {
  const identifier = userName || userId || `user-${await sha256Hex(sessionToken, 8)}`
  const sanitized = identifier.replace(/[^A-Za-z0-9\-_.@]/g, "_")
  const fileIdentifier =
    sanitized !== identifier || sanitized.length > 160 ? `user-${await sha256Hex(identifier, 8)}` : sanitized
  return `devin-${fileIdentifier}.json`
}

export const devinFlow = (): CallbackFlow => ({
  kind: "callback",
  provider: "devin",
  timeoutMessage: "Timeout waiting for OAuth callback",
  deniedMessage: "Devin authorization denied",
  saveMessage: "Failed to save authentication tokens",
  start: ({ state }) =>
    Effect.promise(async () => {
      const pkce = await generatePkce(64)
      // Devin expects its own query order (matches the official CLI).
      const query = [
        `redirect_uri=${queryEscape(DEVIN_REDIRECT_URI)}`,
        `state=${queryEscape(state)}`,
        "prompt=select_account",
        `code_challenge=${queryEscape(pkce.codeChallenge)}`,
        "code_challenge_method=S256"
      ].join("&")
      return {
        url: `${DEVIN_APP_URL}/auth/cli/continue?${query}`,
        data: { code_verifier: pkce.codeVerifier } satisfies JsonObject
      }
    }),
  complete: ({ code, data }) =>
    Effect.gen(function* () {
      if (code.trim() === "") return yield* flowFailure("Missing authorization code")

      // Upstream errors can contain tokens or authorization codes; never expose them.
      const exchange = HttpClientRequest.post(`${DEVIN_API_URL}/auth/cli/token`).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({ code: code.trim(), code_verifier: str(data.code_verifier) })
      )
      const reply = yield* call(exchange, EXCHANGE_FAILED)
      const token = reply.status >= 200 && reply.status < 300 ? str(parseJsonObject(reply.text)?.token) : ""
      if (token === "") return yield* flowFailure(EXCHANGE_FAILED)
      const sessionToken = formatSessionToken(token)

      // Profile and quota enrichment are best-effort; the session token is permanent.
      const self = yield* tryCall(
        HttpClientRequest.get(`${DEVIN_API_URL}/v3/self`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${sessionToken}`, accept: "application/json" })
        )
      )
      const profile = self !== undefined && self.status === 200 ? (parseJsonObject(self.text) ?? {}) : {}
      const statusReply = yield* tryCallBytes(
        HttpClientRequest.post(DEVIN_GET_USER_STATUS_URL).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Basic ${sessionToken}-${sessionToken}`,
            "connect-protocol-version": "1",
            "content-type": "application/proto",
            accept: "*/*",
            "user-agent": ""
          }),
          HttpClientRequest.bodyUint8Array(buildUserStatusRequest(sessionToken), "application/proto")
        )
      )
      const status =
        statusReply !== undefined && statusReply.status === 200 ? parseUserStatus(statusReply.bytes) : undefined

      const userName = str(profile.user_name) || (status?.userName ?? "")
      const userId = str(profile.user_id) || (status?.userId ?? "")
      const orgId = str(profile.org_id) || (status?.orgId ?? "")
      const metadata: JsonObject = {
        type: "devin",
        api_key: sessionToken,
        session_token: sessionToken,
        user_name: userName,
        user_id: userId,
        org_id: orgId,
        auth_kind: "oauth"
      }
      if ((status?.email ?? "") !== "") metadata.email = status?.email ?? ""
      if ((status?.plan ?? "") !== "") metadata.plan = status?.plan ?? ""
      const fileName = yield* Effect.promise(() => devinFileName(userName, userId, sessionToken))
      return { fileName, metadata } satisfies CredentialRecord
    })
})
