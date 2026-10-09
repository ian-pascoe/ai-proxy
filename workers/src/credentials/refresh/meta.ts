/**
 * Meta "refresh": mint an LLM API key from the device (DCA) token. Not a token refresh and never scheduled.
 *
 * Go source: internal/auth/meta/meta.go (`MintAPIKey`), internal/runtime/executor/meta_executor.go (`Refresh`,
 * `extractDCAToken`, `metaCreds`, `ShouldPrepareRequestAuth`). Docs: credentials.md §9.4.
 * The `META_MINT_URL` override of Go (unit tests) is not ported; tests mock the transport instead.
 */
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import type { JsonObject } from "../../json/index.ts"
import { refreshError } from "./error.ts"
import { clipBody, parseJsonObject, rfc3339, send, str } from "./http.ts"
import type { RefreshContext, RefreshProtocolEffect } from "./types.ts"

export const META_MINT_URL = "https://api.meta.ai/muse-code/key"
export const META_DEFAULT_BASE_URL = "https://api.meta.ai/v1"
const META_USER_AGENT = "muse-code/1.0.2"

/** `extractDCAToken`: `dca_token`, else an `access_token` that carries the `dca:` prefix. */
export const metaDcaToken = (metadata: Readonly<JsonObject>): string => {
  const dca = str(metadata.dca_token)
  if (dca !== "") return dca
  const access = str(metadata.access_token)
  return access.startsWith("dca:") ? access : ""
}

/** `metaCreds` token: the minted API key (never a `dca:` token). */
export const metaApiKey = (metadata: Readonly<JsonObject>): string => {
  for (const key of ["api_key", "access_token"]) {
    const value = str(metadata[key])
    if (value !== "" && !value.startsWith("dca:")) return value
  }
  return ""
}

/** `ShouldPrepareRequestAuth`: a DCA token without a minted key. */
export const metaNeedsMint = (metadata: Readonly<JsonObject>): boolean =>
  metaApiKey(metadata) === "" && metaDcaToken(metadata) !== ""

const setOrDelete = (target: JsonObject, key: string, value: string): void => {
  if (value !== "") target[key] = value
  else delete target[key]
}

export const refreshMeta = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata }
    const dcaToken = metaDcaToken(metadata)
    if (dcaToken === "") {
      if (metaApiKey(metadata) !== "") return metadata
      return yield* Effect.fail(refreshError({ message: "meta executor: missing API key or DCA token", status: 401 }))
    }

    const request = HttpClientRequest.post(META_MINT_URL).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${dcaToken}`,
        "user-agent": META_USER_AGENT,
        accept: "application/json"
      }),
      HttpClientRequest.bodyJsonUnsafe({ dca_token: dcaToken })
    )
    const reply = yield* send(request)
    if (reply.status < 200 || reply.status >= 300) {
      return yield* Effect.fail(
        refreshError({
          message: `meta executor: mint API key failed: meta auth: mint key failed (HTTP ${reply.status}): ${clipBody(reply.text)}`,
          status: reply.status
        })
      )
    }
    const minted = parseJsonObject(reply.text)
    const apiKey = str(minted?.api_key)
    if (minted === undefined || apiKey === "") {
      return yield* Effect.fail(refreshError({ message: "meta executor: mint API key returned empty key" }))
    }

    metadata.base_url =
      str(minted.base_url) || str(metadata.base_url) || str(metadata.api_base_url) || META_DEFAULT_BASE_URL
    metadata.api_key = apiKey
    metadata.access_token = apiKey
    metadata.dca_token = dcaToken
    delete metadata.expired
    if (str(minted.user_email) !== "") metadata.email = str(minted.user_email)
    if (str(minted.user_full_name) !== "") metadata.name = str(minted.user_full_name)
    setOrDelete(metadata, "subs_tier_name", str(minted.subs_tier_name))
    setOrDelete(metadata, "subs_tier_id", str(minted.subs_tier_id))
    metadata.is_subs_active = minted.is_subs_active === true
    metadata.has_payment_method = minted.has_payment_method === true
    metadata.type = "meta"
    metadata.last_refresh = rfc3339(context.now)
    return metadata
  })
