/**
 * Request-scoped Gemini text-signature cache over the `SessionState` Durable Object.
 *
 * Go source: internal/cache/antigravity_reasoning_replay_cache.go (entries keyed by `(model, key)`, TTL 1 h). The
 * translators read and write the cache synchronously (`translator/gemini/openai/responses/replay-cache.ts`), so the
 * executor hydrates this cache with one batched read before translating the request (`prefetch`) and writes the
 * entries the response translation produced with one batched write (`flush`), once per translated chunk that stored
 * something. One Durable Object instance per caller scope holds the entries (message ids are unguessable, and a
 * caller's turns reuse one instance, so a request needs a single round trip each way). The Go 10240-entry bound
 * applies per caller.
 */
import { Effect } from "effect"
import { type Json } from "../../json/index.ts"
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend
} from "../../session-state/client.ts"
import type { SessionAddress, StateOp } from "../../session-state/protocol.ts"
import {
  REPLAY_CACHE_MAX_ENTRIES,
  REPLAY_CACHE_TTL_MS,
  type ReplayCache,
  replayCacheKey,
  replayItemsAcceptable
} from "../../translator/gemini/openai/responses/replay-cache.ts"

const STORE_NAME = "gemini-replay"

export interface RequestReplayCache extends ReplayCache {
  /** Loads the entries of `keys` for `model` (skipping the ones already loaded) in one round trip. */
  readonly prefetch: (model: string, keys: ReadonlyArray<string>) => Effect.Effect<void>
  /** Writes the entries stored since the last flush in one round trip (no-op when nothing is pending). */
  readonly flush: Effect.Effect<void>
}

const parseItems = (text: string | undefined): Json[] | undefined => {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as Json[]) : undefined
  } catch {
    return undefined
  }
}

export const makeRequestReplayCache = (
  callerScope: string,
  backend: BackendResolver = resolveBackend()
): RequestReplayCache => {
  const address: SessionAddress = { store: STORE_NAME, scope: callerScope.trim(), session: "" }
  /** `undefined` = loaded and absent. */
  const loaded = new Map<string, readonly Json[] | undefined>()
  const pending = new Map<string, readonly Json[]>()
  return {
    set: (model, key, items) => {
      const id = replayCacheKey(model, key)
      if (id === "" || !replayItemsAcceptable(items)) return false
      const copy = structuredClone([...items])
      loaded.set(id, copy)
      pending.set(id, copy)
      return true
    },
    get: (model, key) => {
      const id = replayCacheKey(model, key)
      const items = id === "" ? undefined : loaded.get(id)
      return items === undefined ? undefined : structuredClone([...items])
    },
    prefetch: (model, keys) => {
      const ids = [
        ...new Set(keys.map((key) => replayCacheKey(model, key)).filter((id) => id !== "" && !loaded.has(id)))
      ]
      if (ids.length === 0) return Effect.void
      return bestEffort(
        "gemini replay prefetch",
        undefined,
        Effect.gen(function* () {
          const state = yield* backend
          const ops: StateOp[] = ids.map((id) => ({ op: "get", key: id }))
          const results = yield* state.run(address, ops)
          ids.forEach((id, index) => {
            const result = results[index]
            if (result?.status === "ok") loaded.set(id, parseItems(result.value))
          })
        })
      )
    },
    flush: Effect.suspend(() => {
      if (pending.size === 0) return Effect.void
      const entries = [...pending.entries()]
      pending.clear()
      return bestEffort(
        "gemini replay flush",
        undefined,
        Effect.gen(function* () {
          const state = yield* backend
          const ops: StateOp[] = entries.map(([id, items]) => ({
            op: "put",
            key: id,
            value: JSON.stringify(items),
            ttlMs: REPLAY_CACHE_TTL_MS,
            maxEntries: REPLAY_CACHE_MAX_ENTRIES
          }))
          yield* state.run(address, ops)
        })
      )
    })
  }
}

/** Request cache over an in-memory backend (tests). */
export const makeMemoryRequestReplayCache = (callerScope = "", now?: () => number): RequestReplayCache =>
  makeRequestReplayCache(callerScope, fixedBackend(makeMemoryBackend(now)))
