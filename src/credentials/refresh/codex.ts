/**
 * Codex (ChatGPT) OAuth refresh.
 *
 * Go source: internal/auth/codex/openai_auth.go (`RefreshTokens`, `refreshTokensSingleFlight`,
 * `RefreshTokensWithRetry`, `isNonRetryableRefreshErr`), internal/runtime/executor/codex_executor_auth.go (`Refresh`),
 * internal/auth/codex/jwt_parser.go. Docs: providers-claude-codex-openai.md B10.
 * Deviations: an empty `email` / missing `id_token` claims never blank the stored `email` / `plan_type`.
 */
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { isJsonObject, type JsonObject } from "../../json/index.ts"
import { decodeJwtClaims } from "../expiry.ts"
import { refreshError } from "./error.ts"
import { parseJsonObject, rfc3339, send, seconds, statusFailure, str } from "./http.ts"
import { withRetries } from "./retry.ts"
import type { RefreshContext, RefreshEffect, RefreshProtocolEffect } from "./types.ts"

export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

const MAX_ATTEMPTS = 3

const DEFAULT_PLAN = "free"

interface TokenData {
  readonly idToken: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expired: string
}

const requestTokens = (refreshToken: string, now: number): RefreshEffect<TokenData> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(CODEX_TOKEN_URL).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyUrlParams({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email"
      })
    )

    const reply = yield* send(request)

    if (reply.status !== 200) return yield* Effect.fail(statusFailure("token refresh", reply))
    const body = parseJsonObject(reply.text)

    if (body === undefined) return yield* Effect.fail(refreshError({ message: "failed to parse refresh response" }))

    return {
      idToken: str(body.id_token),
      accessToken: str(body.access_token),
      refreshToken: str(body.refresh_token),
      expired: rfc3339(now + seconds(body.expires_in) * 1000)
    }
  })

/** Claims of the id_token that matter to the credential (unverified, like Go). */
export const codexIdentity = (idToken: string): { email: string; accountId: string; planType: string } | undefined => {
  const claims = idToken === "" ? undefined : decodeJwtClaims(idToken)

  if (claims === undefined) return undefined
  const auth = claims["https://api.openai.com/auth"]
  const info = isJsonObject(auth) ? auth : {}

  return {
    email: str(claims.email),
    accountId: str(info.chatgpt_account_id),
    planType: str(info.chatgpt_plan_type) || DEFAULT_PLAN
  }
}

export const refreshCodex = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata }
    const refreshToken = str(metadata.refresh_token)

    if (refreshToken === "") return metadata

    const tokens = yield* withRetries(requestTokens(refreshToken, context.now), {
      attempts: MAX_ATTEMPTS,
      // Reuse of a rotated token cannot succeed on replay.
      retryable: (error) => !error.message.toLowerCase().includes("refresh_token_reused"),
      delayMs: context.retryDelayMs
    })

    const identity = codexIdentity(tokens.idToken)

    metadata.id_token = tokens.idToken
    metadata.access_token = tokens.accessToken

    if (tokens.refreshToken !== "") metadata.refresh_token = tokens.refreshToken

    if (identity !== undefined && identity.accountId !== "") metadata.account_id = identity.accountId

    if (identity !== undefined && identity.email !== "") metadata.email = identity.email
    metadata.expired = tokens.expired
    metadata.type = "codex"
    metadata.last_refresh = rfc3339(context.now)
    metadata.plan_type = identity?.planType ?? (str(metadata.plan_type) || DEFAULT_PLAN)

    return metadata
  })
