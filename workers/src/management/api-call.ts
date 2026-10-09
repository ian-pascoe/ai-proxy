/**
 * `POST /v8/management/requests/api-call`: the panel's generic upstream probe (provider quota endpoints).
 *
 * Go source: internal/api/handlers/management/api_tools.go (`APICall`). `$TOKEN$` in header values and in `data` is
 * replaced with the credential's token (refreshed first when needed; JSON-escaped inside JSON bodies). The request is
 * bounded to 60 s like Go (explicit exception to "no timeouts after connect", see AGENTS.md). Differences: Workers
 * `fetch` cannot route through a proxy (`proxy_url` is validated but ignored) and cannot override the `Host` header
 * (ignored). The token never appears in logs.
 */
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { isJsonObject, type Json } from "../json/index.ts"
import { bodyJson, controlPlane, handled, jsonReply, replyError } from "./http.ts"

const TIMEOUT = "60 seconds"
const TOKEN_PLACEHOLDER = "$TOKEN$"

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "")

/** JSON-escapes a token for insertion between the quotes of a JSON string. */
const jsonEscape = (token: string): string => JSON.stringify(token).slice(1, -1)

const isValidJson = (value: string): boolean => {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

const validProxy = (value: string): boolean => {
  if (["direct", "none"].includes(value.toLowerCase())) return true
  try {
    return ["http:", "https:", "socks5:", "socks5h:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const apiCall = Effect.gen(function* () {
  const body = yield* bodyJson
  if (!isJsonObject(body)) return yield* replyError(400, "invalid body")
  const method = text(body.method).toUpperCase()
  if (method === "") return yield* replyError(400, "missing method")
  const urlText = text(body.url)
  if (urlText === "") return yield* replyError(400, "missing url")
  const url = yield* Effect.try({ try: () => new URL(urlText), catch: () => replyError(400, "invalid url") })
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
    return yield* replyError(400, "invalid url")
  }
  const proxy = text(body.proxy_url)
  if (proxy !== "" && !validProxy(proxy)) return yield* replyError(400, "invalid proxy_url")
  const authIndex = text(body.auth_index) || text(body.authIndex) || text(body.AuthIndex)

  const headers: Record<string, string> = {}
  if (isJsonObject(body.header)) {
    for (const [key, value] of Object.entries(body.header)) if (typeof value === "string") headers[key] = value
  }
  let data = typeof body.data === "string" ? body.data : ""

  let token: string | undefined
  const resolveToken = Effect.gen(function* () {
    if (token !== undefined) return token
    if (authIndex === "") return yield* replyError(400, "auth token not found")
    const result = yield* controlPlane("resolveApiCallToken", (stub) => stub.resolveApiCallToken(authIndex))
    if (result.ok) {
      token = result.token
      return token
    }
    if (result.error === "not_found") return yield* replyError(400, "auth credential not found for auth_index")
    return yield* replyError(
      400,
      result.error === "refresh_failed" ? "auth token refresh failed" : "auth token not found"
    )
  })

  for (const [key, value] of Object.entries(headers)) {
    if (value.includes(TOKEN_PLACEHOLDER)) headers[key] = value.replaceAll(TOKEN_PLACEHOLDER, yield* resolveToken)
  }
  if (data.includes(TOKEN_PLACEHOLDER)) {
    const resolved = yield* resolveToken
    data = data.replaceAll(TOKEN_PLACEHOLDER, isValidJson(data) ? jsonEscape(resolved) : resolved)
  }

  let request = HttpClientRequest.make(method as "GET")(url)
  for (const [key, value] of Object.entries(headers)) {
    // `Host` cannot be overridden from a Worker.
    if (key.toLowerCase() !== "host") request = HttpClientRequest.setHeader(request, key, value)
  }
  if (data !== "" && method !== "GET" && method !== "HEAD") request = HttpClientRequest.bodyText(request, data)

  const client = yield* HttpClient.HttpClient
  const outcome = yield* Effect.gen(function* () {
    const response = yield* client.execute(request).pipe(Effect.timeout(TIMEOUT))
    const responseBody = yield* response.text.pipe(Effect.timeout(TIMEOUT))
    return { response, responseBody }
  }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.result)
  if (outcome._tag === "Failure") {
    yield* Effect.logDebug("management api-call request failed")
    return yield* replyError(502, "request failed")
  }
  const { response, responseBody } = outcome.success
  const header: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(response.headers)) header[key] = [value]
  return jsonReply(200, { status_code: response.status, header, body: responseBody })
})

export const apiCallHandler = handled(apiCall)
