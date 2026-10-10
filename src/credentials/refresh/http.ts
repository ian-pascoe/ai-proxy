/**
 * HTTP plumbing shared by the refresh protocols: one `HttpClient` call returning status, headers and text, with
 * transport failures mapped to {@link RefreshError}. The client is a service, so tests swap the transport and
 * production uses `FetchHttpClient`.
 */
import { Effect } from "effect"
import { HttpClient, type HttpClientRequest } from "effect/http"
import { isJsonObject, type JsonObject } from "../../json/index.ts"
import { refreshError, type RefreshError } from "./error.ts"

export interface HttpReply {
  readonly status: number
  readonly text: string
  /** Header lookup (case-insensitive). */
  readonly header: (name: string) => string | undefined
}

/** Longest upstream body kept in an error message. */
const MAX_BODY = 2048

export const clipBody = (body: string): string => {
  const trimmed = body.trim()
  return trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY)}...` : trimmed
}

/** Per-request bound (Go: 30 s client timeout; allowed because refreshes are credential acquisition). */
export const REQUEST_TIMEOUT = "30 seconds"

/** Executes `request`; non-2xx statuses are NOT failures here, callers decide. Never includes URLs in errors. */
export const send = (
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpReply, RefreshError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request)
    const text = yield* response.text
    return {
      status: response.status,
      text,
      header: (name: string) => response.headers[name.toLowerCase()]
    } satisfies HttpReply
  }).pipe(
    Effect.mapError((error) =>
      refreshError({ message: `refresh request failed: ${"reason" in error ? error.reason._tag : "transport error"}` })
    ),
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(refreshError({ message: "refresh request timed out" }))
    })
  )

export const parseJsonObject = (text: string): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** Seconds field of a token response (number or numeric string); `0` when absent or invalid. */
export const seconds = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** Go `time.Format(time.RFC3339)` in UTC: no fractional seconds. */
export const rfc3339 = (epochMs: number): string => new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z")

/** Non-2xx reply as `token refresh failed with status N: <body>` (the text classifiers rely on this shape). */
export const statusFailure = (prefix: string, reply: HttpReply, retryable?: boolean): RefreshError =>
  refreshError({
    message: `${prefix} failed with status ${reply.status}: ${clipBody(reply.text)}`,
    status: reply.status,
    retryable
  })
