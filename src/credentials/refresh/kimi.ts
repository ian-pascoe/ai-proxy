/**
 * Kimi OAuth refresh (RFC 8628 device-flow tokens).
 *
 * Go source: internal/auth/kimi/kimi.go (`RefreshToken`, `refreshTokenSingleFlight`, `commonHeaders`, domain/OAuth
 * host resolution), internal/runtime/executor/kimi_executor.go (`Refresh`). Docs: providers-other.md §3.3.
 * The device headers use constants (no hostname/filesystem on Workers); the login-time `device_id` is reused.
 */
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import type { JsonObject } from "../../json/index.ts"
import { refreshError } from "./error.ts"
import { parseJsonObject, rfc3339, send, seconds, statusFailure, str } from "./http.ts"
import type { RefreshContext, RefreshProtocolEffect } from "./types.ts"

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"

const KIMI_COM_OAUTH_HOST = "https://auth.kimi.com"

const KIMI_AI_OAUTH_HOST = "https://auth.kimi.ai"

const KIMI_COM_BASE = "https://api.kimi.com/coding"

const KIMI_AI_BASE = "https://api.kimi.ai/coding"

const FALLBACK_DEVICE_ID = "cli-proxy-api-device"

export const kimiTokenUrl = (domain: string): string =>
  `${domain === "kimi.ai" ? KIMI_AI_OAUTH_HOST : KIMI_COM_OAUTH_HOST}/api/oauth/token`

export const refreshKimi = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata }
    const refreshToken = str(metadata.refresh_token)

    if (refreshToken === "") return metadata

    // `attributes.domain` is derived from `domain`, `base_url` and the provider type (credentials/derive.ts).
    const domain = context.attributes.domain === "kimi.ai" ? "kimi.ai" : "kimi.com"

    const request = HttpClientRequest.post(kimiTokenUrl(domain)).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        "x-msh-platform": "CLIProxyAPI",
        "x-msh-version": "cliproxy-workers",
        "x-msh-device-name": "cliproxy-workers",
        "x-msh-device-model": "Cloudflare Workers",
        "x-msh-device-id": str(metadata.device_id) || FALLBACK_DEVICE_ID
      }),
      HttpClientRequest.bodyUrlParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    )

    const reply = yield* send(request)

    if (reply.status === 401 || reply.status === 403) {
      return yield* Effect.fail(
        refreshError({ message: `kimi: refresh token rejected (status ${reply.status})`, status: reply.status })
      )
    }

    if (reply.status !== 200) return yield* Effect.fail(statusFailure("kimi: refresh", reply))
    const body = parseJsonObject(reply.text)

    if (body === undefined)
      return yield* Effect.fail(refreshError({ message: "kimi: failed to parse refresh response" }))
    const accessToken = str(body.access_token)

    if (accessToken === "")
      return yield* Effect.fail(refreshError({ message: "kimi: empty access token in refresh response" }))

    metadata.access_token = accessToken
    const rotated = str(body.refresh_token)

    if (rotated !== "") metadata.refresh_token = rotated
    const expiresIn = seconds(body.expires_in)

    if (expiresIn > 0) metadata.expired = rfc3339(Math.floor(context.now / 1000) * 1000 + Math.trunc(expiresIn) * 1000)

    if (str(metadata.type) === "") metadata.type = domain === "kimi.ai" ? "kimi-ai" : "kimi"

    if (!Object.hasOwn(metadata, "domain")) metadata.domain = domain

    if (!Object.hasOwn(metadata, "base_url")) {
      metadata.base_url = context.attributes.base_url || (domain === "kimi.ai" ? KIMI_AI_BASE : KIMI_COM_BASE)
    }

    metadata.last_refresh = rfc3339(context.now)

    return metadata
  })
