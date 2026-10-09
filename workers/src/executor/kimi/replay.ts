/**
 * Kimi thinking replay for Claude-format callers.
 *
 * Go source: internal/runtime/executor/kimi_thinking_replay.go (`kimiThinkingReplayScopeFromRequest`,
 * `prepareKimiThinkingReplayRequest`, `cacheKimiThinkingReplayResponse`, `wrapKimiThinkingReplayStream`,
 * `shouldClearKimiThinkingReplayAfterError`), internal/cache/kimi_thinking_replay_cache.go (TTL 1 h). Kimi returns
 * signed `thinking` blocks next to `tool_use`; Claude Code drops them, so the last assistant content is cached per
 * (model family, caller-isolated session) and put back into the next request. The matching/accumulator logic is the
 * shared one of `executor/claude/thinking-replay.ts`; the store is in memory per isolate
 * (TODO(SessionState): back it with the SessionState Durable Object for cross-isolate continuity).
 */
import { createHash } from "node:crypto"
import { Effect, Stream } from "effect"
import { cloneJson, type Json, type JsonObject, isJsonObject } from "../../json/index.ts"
import { replayScopeFromRequest } from "../codex/replay.ts"
import {
  makeMemoryReplayStore,
  ReplayStreamAccumulator,
  replayContentIsReplayable,
  type ReplayScope,
  replayScopeValid,
  restoreReplayContent,
  type ThinkingReplayStore
} from "../claude/thinking-replay.ts"
import type { ExecutionError } from "../errors.ts"
import { parseSuffix } from "../suffix.ts"
import type { ExecutorOptions, ExecutorRequest } from "../types.ts"
import { normalizeKimiUpstreamModel } from "./model.ts"

const TTL_MS = 3600_000

export const makeKimiReplayStore = (now?: () => number): ThinkingReplayStore => makeMemoryReplayStore(now, TTL_MS)

/** `kimiThinkingReplayModelFamily`: `k3` and `k3-256k` share one family. */
export const kimiReplayFamily = (model: string): string => {
  const normalized = normalizeKimiUpstreamModel(parseSuffix(model.trim()).modelName)
  return normalized === "k3" || normalized === "k3-256k" ? "k3" : normalized
}

/** `xaiReasoningReplayIsolateSessionKey`: session keys are isolated per caller; no caller scope disables replay. */
const isolateSessionKey = (callerScope: string, sessionKey: string): string => {
  if (sessionKey === "") return ""
  if (sessionKey.startsWith("execution:")) return sessionKey
  if (callerScope.trim() === "") return ""
  return `caller:${createHash("sha256").update(callerScope).digest("hex").slice(0, 16)}:${sessionKey}`
}

export interface PreparedReplay {
  readonly request: ExecutorRequest
  readonly scope: ReplayScope
}

/** Restores cached thinking into (a copy of) the request payload and returns the scope for caching the answer. */
export const prepareKimiReplay = (
  store: ThinkingReplayStore,
  request: ExecutorRequest,
  options: ExecutorOptions
): PreparedReplay => {
  const sessionKey = isolateSessionKey(
    options.metadata.callerScope,
    replayScopeFromRequest({
      from: "claude",
      model: request.model,
      requestPayload: request.payload,
      headers: options.headers,
      callerScope: options.metadata.callerScope,
      body: request.payload
    }).sessionKey
  )
  const modelFamily = kimiReplayFamily(request.model)
  const empty: ReplayScope = { modelFamily, sessionKey, snapshot: undefined, cacheReady: false, replayApplied: false }
  if (!replayScopeValid(empty)) return { request, scope: empty }
  const stored = store.get(modelFamily, sessionKey)
  const base: ReplayScope = { ...empty, snapshot: stored?.snapshot, cacheReady: true }
  if (stored === undefined || !isJsonObject(request.payload)) return { request, scope: base }
  const restored = cloneJson(request.payload) as JsonObject
  let applied = false
  for (const content of stored.contents) if (restoreReplayContent(restored, content)) applied = true
  return applied
    ? { request: { ...request, payload: restored }, scope: { ...base, replayApplied: true } }
    : { request, scope: base }
}

/** `shouldClearKimiThinkingReplayAfterError`. */
export const shouldClearAfterError = (error: ExecutionError): boolean => error.status === 400 || error.status === 422

export const clearReplay = (store: ThinkingReplayStore, scope: ReplayScope): void => {
  if (replayScopeValid(scope) && scope.cacheReady)
    store.deleteIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot)
}

/** `cacheKimiThinkingReplayContent`: replayable content replaces the entry, anything else clears it. */
export const cacheReplay = (store: ThinkingReplayStore, scope: ReplayScope, content: Json | undefined): void => {
  if (!replayScopeValid(scope) || !scope.cacheReady) return
  if (content !== undefined && replayContentIsReplayable(content)) {
    store.replaceIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot, content)
  } else {
    clearReplay(store, scope)
  }
}

/** `wrapKimiThinkingReplayStream`: observes the client stream and caches the assistant content at its clean end. */
export const wrapReplayStream = <E extends ExecutionError>(
  chunks: Stream.Stream<string, E>,
  store: ThinkingReplayStore,
  scope: ReplayScope
): Stream.Stream<string, E> => {
  if (!replayScopeValid(scope)) return chunks
  const accumulator = new ReplayStreamAccumulator()
  return chunks.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        for (const line of chunk.split("\n")) accumulator.observe(line)
      })
    ),
    Stream.onExit((exit) =>
      Effect.sync(() => {
        if (exit._tag !== "Success") return
        const content = accumulator.content()
        if (content !== undefined) cacheReplay(store, scope, content)
      })
    )
  )
}
