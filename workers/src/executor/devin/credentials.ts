/**
 * Devin credential helpers and per-session state.
 *
 * Go source: internal/runtime/executor/devin_executor.go (`devinAuthCredentials`, `resolveDevinSessionAndCascadeIDs`,
 * `newDevinStatusError`), internal/runtime/executor/helps/devin_wire.go (`NextDevinSessionTurnIndex`: process-scoped
 * LRU of 5000 session counters). The turn counter only decides whether thread metadata carries an ordinal; it lives
 * per isolate (TODO(SessionState): move it to the SessionState Durable Object for cross-isolate continuity).
 */
import { ExecutionError } from "../errors.ts"
import type { CredentialSnapshot } from "../picker.ts"
import { DEVIN_DEFAULT_BASE_URL } from "./wire.ts"
import { normalizeDevinUuid } from "./interactions.ts"

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** `devinAuthCredentials`: session token (`api_key`, `session_token`, `token`), base URL and device seed. */
export const devinCredentials = (
  credential: CredentialSnapshot
): { readonly apiKey: string; readonly baseUrl: string; readonly deviceSeed: string } => {
  const { attributes, metadata } = credential
  const apiKey =
    text(attributes["api_key"]) ||
    text(attributes["session_token"]) ||
    text(attributes["token"]) ||
    text(metadata["api_key"]) ||
    text(metadata["session_token"])
  let baseUrl = text(attributes["base_url"]) || DEVIN_DEFAULT_BASE_URL
  if (baseUrl === DEVIN_DEFAULT_BASE_URL) baseUrl = text(metadata["base_url"]) || baseUrl
  return {
    apiKey,
    baseUrl,
    deviceSeed: text(attributes["device_seed"]) || text(metadata["device_seed"])
  }
}

const MAX_SESSION_COUNTERS = 5000
const turnCounters = new Map<string, number>()

/** `NextDevinSessionTurnIndex`: the 0-based request ordinal of the session. */
export const nextSessionTurnIndex = (sessionId: string): number => {
  const id = sessionId.trim()
  if (id === "") return 0
  const current = turnCounters.get(id)
  if (current === undefined && turnCounters.size >= MAX_SESSION_COUNTERS) {
    turnCounters.delete(turnCounters.keys().next().value as string)
  }
  turnCounters.set(id, (current ?? 0) + 1)
  return current ?? 0
}

/** `ResetDevinSessionTurnIndex`. */
export const resetSessionTurnIndex = (sessionId: string): void => {
  turnCounters.delete(sessionId.trim())
}

/** `resolveDevinSessionAndCascadeIDs`: the protocol session id (or a random one) as UUIDs. */
export const resolveSessionIds = (
  sessionId: string,
  cascadeId: string,
  fallbackSessionId: string | undefined
): { readonly sessionId: string; readonly cascadeId: string } => {
  const session = normalizeDevinUuid(sessionId !== "" ? sessionId : (fallbackSessionId ?? ""))
  return { sessionId: session, cascadeId: cascadeId === "" ? session : normalizeDevinUuid(cascadeId) }
}

/** `newDevinStatusError`: non-2xx answers keep the body; a 429 carries `Retry-After` (seconds or HTTP date). */
export const devinStatusError = (status: number, headers: Headers, body: string, nowMs: number): ExecutionError => {
  let retryAfterMs: number | undefined
  if (status === 429) {
    const rawValue = (headers.get("retry-after") ?? "").trim()
    if (/^\d+$/.test(rawValue)) retryAfterMs = Number(rawValue) * 1000
    else if (rawValue !== "") {
      const date = Date.parse(rawValue)
      if (!Number.isNaN(date) && date - nowMs > 0) retryAfterMs = date - nowMs
    }
  }
  return new ExecutionError({ status, message: body, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
}
