/**
 * Claude continuity store: per (credential, session) previous message/request ids, prompt id and the pinned
 * `currentDate` of the session.
 *
 * Go source: internal/runtime/executor/helps/claude_diagnostics.go (BeginClaudeContinuity, PinClaudeSessionDate,
 * CommitClaudeContinuity; TTL 1 h, at most 4096 entries). Go keeps it in process memory; here it sits behind a small
 * interface with a per-isolate in-memory implementation.
 * TODO(SessionState follow-up): back this with the SessionState Durable Object so the state survives isolate
 * eviction and is shared across isolates; until then each isolate starts a fresh generation (previous ids null).
 */
import { createHash, randomUUID } from "node:crypto"

const TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 4096
const EVICT_BATCH = 256

export interface ContinuityState {
  readonly key: string
  readonly previousMessageId: string
  readonly previousRequestId: string
  readonly promptId: string
}

export interface ContinuityStore {
  /** Starts a request of a session; returns the stored previous ids and the active prompt id. */
  readonly begin: (
    credentialIdentity: string,
    sessionId: string,
    isNewPromptTurn: boolean,
    explicitPromptId: string
  ) => ContinuityState | undefined
  /** Pins the session's date on first use and returns the pinned value. */
  readonly pinDate: (key: string, date: string) => string
  /** Records a completed response. */
  readonly commit: (key: string, messageId: string, requestId: string, promptId: string) => void
}

interface Entry {
  previousMessageId: string
  previousRequestId: string
  promptId: string
  pinnedDate: string
  lastAccess: number
  expiresAt: number
}

const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,36}$/

export const isValidPromptId = (id: string): boolean => PROMPT_ID.test(id.trim())

/** `ClaudeDeterministicPromptID`: a v4-shaped UUID derived from a seed. */
export const deterministicPromptId = (seed: string): string => {
  const digest = createHash("sha256").update(seed).digest()
  digest[6] = ((digest[6] as number) & 0x0f) | 0x40
  digest[8] = ((digest[8] as number) & 0x3f) | 0x80
  const hex = digest.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export const makeMemoryContinuityStore = (now: () => number = Date.now): ContinuityStore => {
  const entries = new Map<string, Entry>()
  let access = 0
  const evict = (): void => {
    if (entries.size < MAX_ENTRIES) return
    const oldest = [...entries.entries()].toSorted((a, b) => a[1].lastAccess - b[1].lastAccess).slice(0, EVICT_BATCH)
    for (const [key] of oldest) entries.delete(key)
  }
  return {
    begin: (credentialIdentity, sessionId, isNewPromptTurn, explicitPromptId) => {
      const identity = credentialIdentity.trim()
      const session = sessionId.trim()
      if (identity === "" || session === "") return undefined
      const key = createHash("sha256").update(`${identity}\u0000${session}`).digest("hex")
      const current = now()
      let entry = entries.get(key)
      if (entry === undefined || entry.expiresAt <= current) {
        if (entry === undefined) evict()
        entry = {
          previousMessageId: "",
          previousRequestId: "",
          promptId: "",
          pinnedDate: "",
          lastAccess: 0,
          expiresAt: 0
        }
      }
      const explicit = explicitPromptId.trim()
      if (explicit !== "" && isValidPromptId(explicit)) entry.promptId = explicit.toLowerCase()
      else if (isNewPromptTurn || entry.promptId === "") entry.promptId = randomUUID()
      entry.lastAccess = ++access
      entry.expiresAt = current + TTL_MS
      entries.set(key, entry)
      return {
        key,
        previousMessageId: entry.previousMessageId,
        previousRequestId: entry.previousRequestId,
        promptId: entry.promptId
      }
    },
    pinDate: (key, date) => {
      const entry = entries.get(key)
      if (key === "" || date === "" || entry === undefined) return date
      if (entry.pinnedDate === "") entry.pinnedDate = date
      return entry.pinnedDate
    },
    commit: (key, messageId, requestId, promptId) => {
      const entry = entries.get(key)
      if (entry === undefined || messageId.trim() === "" || entry.expiresAt <= now()) return
      entry.previousMessageId = messageId.trim()
      entry.previousRequestId = REQUEST_ID.test(requestId.trim()) ? requestId.trim() : ""
      if (isValidPromptId(promptId)) entry.promptId = promptId.toLowerCase()
      entry.lastAccess = ++access
      entry.expiresAt = now() + TTL_MS
    }
  }
}
