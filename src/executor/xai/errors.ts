/**
 * xAI upstream error classification.
 *
 * Go source: internal/runtime/executor/xai_executor_response.go (xaiStatusErr, isXAIBadCredentialsBody,
 * xaiFreeUsageExhaustedCooldown), xai_executor_speech.go (xaiSpeechStatusErr, xaiSpeechModelUnavailable).
 *
 *  - 403 with a "bad credentials" body is an invalidated OAuth access token: remapped to 401 so the conductor's
 *    refresh-once-and-retry path runs instead of a payment cooldown (the upstream body is kept).
 *  - 429 with `free-usage-exhausted` / "included free usage" carries a 24 h cooldown hint.
 *  - Speech 404s that do not say the model is unavailable (e.g. an unknown voice id) are request-scoped.
 */
import { asString, get, type Json, tryParseJson } from "../../json/index.ts"
import { ExecutionError, withErrorFields } from "../errors.ts"

/** `xaiFreeUsageExhaustedCooldown`: the rolling free-tier window advertised by the chat proxy. */
export const XAI_FREE_USAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** `isXAIBadCredentialsBody`. */
export const isBadCredentialsBody = (body: string): boolean => {
  const parsed = tryParseJson(body)

  for (const path of ["code", "error.code", "body.error.code"]) {
    if (asString(get(parsed, path)).toLowerCase().includes("bad-credentials")) return true
  }

  for (const path of ["error", "error.message", "message", "body.error", "body.error.message"]) {
    if (asString(get(parsed, path)).toLowerCase().includes("access token could not be validated")) return true
  }

  const raw = body.toLowerCase()

  return raw.includes("bad-credentials") || raw.includes("access token could not be validated")
}

/** `xaiStatusErr`. `headers` are the upstream response headers (exposed with `passthrough-headers`). */
export const xaiStatusError = (
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>
): ExecutionError => {
  const extra = headers === undefined ? {} : { headers: { ...headers } }

  if (body === "") return new ExecutionError({ status, message: body, ...extra })

  if (status === 403 && isBadCredentialsBody(body)) return new ExecutionError({ status: 401, message: body, ...extra })

  if (status !== 429) return new ExecutionError({ status, message: body, ...extra })
  const parsed = tryParseJson(body)
  const code = asString(get(parsed, "code")).toLowerCase()
  let message = asString(get(parsed, "error")).toLowerCase()

  if (message === "") message = body.toLowerCase()

  const exhausted =
    code.includes("free-usage-exhausted") ||
    message.includes("free-usage-exhausted") ||
    message.includes("included free usage")

  return new ExecutionError({
    status,
    message: body,
    ...(exhausted ? { retryAfterMs: XAI_FREE_USAGE_COOLDOWN_MS } : {}),
    ...extra
  })
}

const SPEECH_MODEL_UNAVAILABLE = [
  "model_not_found",
  "model_not_supported",
  "model is not supported",
  "model is unsupported",
  "model not supported",
  "unsupported model",
  "model is not available",
  "model not available",
  "model is unavailable",
  "model unavailable",
  "not available for your plan",
  "not available for your account"
]

const mentionsUnavailableModel = (text: string): boolean => {
  const lower = text.toLowerCase()

  return SPEECH_MODEL_UNAVAILABLE.some((pattern) => lower.includes(pattern))
}

/** `xaiSpeechModelUnavailable`: the body says the speech model itself is missing or unsupported. */
export const speechModelUnavailable = (body: string): boolean => {
  const parsed: Json | undefined = tryParseJson(body)

  if (parsed === undefined) return mentionsUnavailableModel(body)

  return ["code", "error.code", "type", "error.type", "error", "error.message", "message", "detail"].some((path) =>
    mentionsUnavailableModel(asString(get(parsed, path)))
  )
}

/** `xaiSpeechStatusErr`. */
export const xaiSpeechStatusError = (
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>
): ExecutionError => {
  const error = xaiStatusError(status, body, headers)

  if (error.status === 404 && !speechModelUnavailable(body)) return withErrorFields(error, { requestScoped: true })

  return error
}
