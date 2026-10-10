/**
 * Retry-After extraction for OpenAI-compatible upstream errors.
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (openAICompatRetryAfter). Only 429 responses carry
 * a hint: integer seconds or an HTTP date in `Retry-After`, else a 60 s fallback for explicit tokens-per-minute
 * limit errors; otherwise none (the conductor backs off on its own).
 */
import { get, tryParseJson } from "../../json/index.ts"

const TPM_FALLBACK_MS = 60_000

export const openAICompatRetryAfterMs = (
  status: number,
  headers: Headers,
  body: string,
  now: number
): number | undefined => {
  if (status !== 429) return undefined
  const raw = (headers.get("retry-after") ?? "").trim()
  if (raw !== "") {
    if (/^\d+$/.test(raw)) return Number(raw) * 1000
    const date = Date.parse(raw)
    if (!Number.isNaN(date) && /[a-z]/i.test(raw)) return Math.max(0, date - now)
  }
  const parsed = tryParseJson(body)
  const code = get(parsed, "error.code")
  const message = get(parsed, "error.message")
  const codeLower = typeof code === "string" ? code.trim().toLowerCase() : ""
  const messageLower = typeof message === "string" ? message.trim().toLowerCase() : ""
  if (
    codeLower.includes("tpmratelimitexceeded") ||
    (messageLower.includes("tokens per minute") && messageLower.includes("limit") && messageLower.includes("exceeded"))
  ) {
    return TPM_FALLBACK_MS
  }
  return undefined
}
