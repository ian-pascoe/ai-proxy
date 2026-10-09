/**
 * Bounded replay cache for Gemini text-signature carriers.
 *
 * Go source: internal/cache/antigravity_reasoning_replay_cache.go (`CacheAntigravityReasoningReplayItems`,
 * `GetAntigravityReasoningReplayItems`): entries are keyed by `(model, session key)`, expire after one hour and are
 * evicted oldest-first beyond 10240 entries.
 *
 * Translators are pure functions, so the cache is an interface with a per-isolate in-memory implementation.
 * TODO(SessionState Durable Object): back this by the SessionState DO so carriers survive isolate recycling and are
 * shared across isolates; until then a continuation that lands on another isolate loses the cached text signature
 * (the next turn degrades to the bypass signature, never to an error).
 */
import type { Json } from "../../../../json/index.ts"

export interface ReplayCache {
  /** Stores `items` for `(model, key)`; returns `false` when the entry is rejected. */
  readonly set: (model: string, key: string, items: readonly Json[]) => boolean
  readonly get: (model: string, key: string) => readonly Json[] | undefined
}

export const REPLAY_CACHE_TTL_MS = 60 * 60 * 1000
export const REPLAY_CACHE_MAX_ENTRIES = 10240
const REPLAY_CACHE_MAX_ITEMS = 4096

export const makeMemoryReplayCache = (now: () => number = Date.now): ReplayCache & { readonly size: () => number } => {
  const entries = new Map<string, { readonly items: readonly Json[]; readonly storedAt: number }>()
  const cacheKey = (model: string, key: string): string => {
    const trimmedModel = model.trim()
    const trimmedKey = key.trim()
    return trimmedModel === "" || trimmedKey === "" ? "" : `${trimmedModel}\u0000${trimmedKey}`
  }
  return {
    set: (model, key, items) => {
      const id = cacheKey(model, key)
      if (id === "" || items.length === 0 || items.length > REPLAY_CACHE_MAX_ITEMS) return false
      entries.delete(id)
      entries.set(id, { items: structuredClone([...items]), storedAt: now() })
      // Map iteration is insertion ordered: the first key is the oldest entry.
      while (entries.size > REPLAY_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      return true
    },
    get: (model, key) => {
      const id = cacheKey(model, key)
      const entry = id === "" ? undefined : entries.get(id)
      if (entry === undefined) return undefined
      if (now() - entry.storedAt > REPLAY_CACHE_TTL_MS) {
        entries.delete(id)
        return undefined
      }
      return structuredClone([...entry.items])
    },
    size: () => entries.size
  }
}

let current: ReplayCache = makeMemoryReplayCache()

/** The cache the Responses translators use (tests substitute their own with {@link setReplayCache}). */
export const replayCache = (): ReplayCache => current

export const setReplayCache = (next: ReplayCache): void => {
  current = next
}
