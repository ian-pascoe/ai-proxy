/**
 * Antigravity Interactions continuation sessions: a `requires_action` interaction is remembered together with its
 * pending call ids, so the client's next request (only tool results) continues the upstream interaction.
 *
 * Go source: internal/runtime/executor/helps/antigravity_interactions_state.go (`PrepareAntigravityInteractions`,
 * `Observe`) and internal/cache/antigravity_interactions_session.go (`InteractionsCallKey`, TTL 30 min from the
 * write, 1024 entries). The Go process-wide map is a `SessionState` Durable Object instance per conversation key
 * (caller, credential, endpoint, model and conversation hashed together); the entries of a conversation are keyed by
 * the hash of the pending call set. The 1024-entry bound applies per conversation.
 */
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { extractSessionInfo } from "../../handlers/session.ts"
import { asString, cloneJson, get, isJsonArray, isJsonObject, type Json, set, tryParseJson } from "../../json/index.ts"
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend
} from "../../session-state/client.ts"
import type { SessionAddress } from "../../session-state/protocol.ts"
import { goMarshal } from "../../translator/common/claude-util.ts"
import type { CredentialSnapshot } from "../picker.ts"
import type { ExecutorOptions, ExecutorRequest } from "../types.ts"

const TTL_MS = 30 * 60_000

const MAX_ENTRIES = 1024

const STORE_NAME = "antigravity-interactions"

/** Upstream continuation identifiers only. */
export interface InteractionsContinuation {
  readonly id: string
  readonly environment: string
}

export interface ContinuationStore {
  readonly get: (conversationKey: string, callKey: string) => Effect.Effect<InteractionsContinuation | undefined>
  readonly put: (conversationKey: string, callKey: string, state: InteractionsContinuation) => Effect.Effect<void>
}

/** `InteractionsCallKey`: the sorted call ids; empty (rejected) for no ids, empty ids, duplicates or NUL bytes. */
export const interactionsCallKey = (ids: ReadonlyArray<string>): string => {
  const sorted = [...ids].toSorted()

  for (let index = 0; index < sorted.length; index++) {
    const id = sorted[index] as string

    if (id === "" || id.includes("\u0000") || (index > 0 && sorted[index - 1] === id)) return ""
  }

  return sorted.join("\u0000")
}

const entryKey = (callKey: string): string => createHash("sha256").update(callKey).digest("hex")

const addressOf = (conversationKey: string): SessionAddress => ({
  store: STORE_NAME,
  scope: "",
  session: conversationKey
})

export const makeSessionStateContinuationStore = (backend: BackendResolver = resolveBackend()): ContinuationStore => ({
  get: (conversationKey, callKey) =>
    bestEffort(
      "antigravity interactions get",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend
        const [result] = yield* state.run(addressOf(conversationKey), [{ op: "get", key: entryKey(callKey) }])

        if (result?.status !== "ok" || result.value === undefined) return undefined
        const parsed = tryParseJson(result.value)
        const id = asString(get(parsed, "id"))

        return id === "" ? undefined : ({ id, environment: asString(get(parsed, "environment")) } as const)
      })
    ),
  put: (conversationKey, callKey, continuation) =>
    bestEffort(
      "antigravity interactions put",
      undefined,
      Effect.gen(function* () {
        const state = yield* backend
        yield* state.run(addressOf(conversationKey), [
          {
            op: "put",
            key: entryKey(callKey),
            value: JSON.stringify(continuation),
            ttlMs: TTL_MS,
            maxEntries: MAX_ENTRIES
          }
        ])
      })
    )
})

/** In-memory store for tests (`now` is injectable). */
export const makeInMemoryContinuationStore = (now?: () => number): ContinuationStore =>
  makeSessionStateContinuationStore(fixedBackend(makeMemoryBackend(now)))

/** Default store: the `SessionState` Durable Object when bound, else per isolate. */
export const defaultContinuationStore: ContinuationStore = makeSessionStateContinuationStore()

const digest = (value: Json): string => createHash("sha256").update(goMarshal(value)).digest("hex")

/** Tracks one request, including streamed steps (`AntigravityInteractionsState`). */
export class InteractionsState {
  readonly #key: string
  readonly #store: ContinuationStore
  #id = ""
  #environment = ""
  #calls: string[] = []

  constructor(key: string, store: ContinuationStore) {
    this.#key = key
    this.#store = store
  }

  /**
   * `Observe`: records only completed `requires_action` interactions, never failed or truncated streams. Stream
   * events may carry steps outside the final snapshot.
   */
  observe(payload: Json | undefined): Effect.Effect<void> {
    if (this.#key === "" || payload === undefined) return Effect.void
    const event = asString(get(payload, "event_type"))
    const interaction = event !== "" ? get(payload, "interaction") : payload
    const id = asString(get(interaction, "id"))

    if (id !== "") this.#id = id
    const environment = asString(get(interaction, "environment_id"))

    if (environment !== "") this.#environment = environment

    if (event === "step.start" && asString(get(payload, "step.type")) === "function_call") {
      this.#calls.push(asString(get(payload, "step.id")))
    }

    if (event !== "" && event !== "interaction.completed") return Effect.void

    if (asString(get(interaction, "status")) !== "requires_action" || this.#id === "") return Effect.void
    const steps = get(interaction, "steps")

    if (isJsonArray(steps)) {
      this.#calls = steps
        .filter((step) => asString(get(step, "type")) === "function_call")
        .map((step) => asString(get(step, "id")))
    }

    const callKey = interactionsCallKey(this.#calls)

    if (callKey === "") return Effect.void

    return this.#store.put(this.#key, callKey, { id: this.#id, environment: this.#environment })
  }
}

export interface PreparedInteractions {
  readonly state: InteractionsState
  readonly body: Json
}

/**
 * `PrepareAntigravityInteractions`: restores only a matching tool-result suffix. An explicit continuation always
 * wins, including an explicitly empty field. The conversation namespace is computed before the continuation rewrite
 * and the payload rules. `body` is mutated when a continuation is restored.
 */
export const prepareAntigravityInteractions = (
  store: ContinuationStore,
  credential: CredentialSnapshot,
  request: ExecutorRequest,
  options: ExecutorOptions,
  model: string,
  body: Json
): Effect.Effect<PreparedInteractions> =>
  Effect.gen(function* () {
    const inert = (): PreparedInteractions => ({ state: new InteractionsState("", store), body })

    if (!model.toLowerCase().startsWith("antigravity")) return inert()
    const caller = options.metadata.callerScope || (options.headers.get("Authorization") ?? "")
    const original = options.originalRequest ?? request.payload
    let identity = extractSessionInfo(options.headers, original)?.sessionId ?? ""
    const inputValue = get(body, "input")
    const input = isJsonArray(inputValue) ? inputValue : []

    if (identity === "") {
      let lastUser = -1
      input.forEach((step, index) => {
        if (asString(get(step, "type")) === "user_input") lastUser = index
      })

      if (lastUser < 0) return inert()
      // Canonical JSON, so whitespace and key order do not split a conversation; tool rounds after the last user
      // turn are excluded.
      identity = digest({
        input: input.slice(0, lastUser + 1),
        system_instruction: get(body, "system_instruction") ?? null
      })
    }

    const { attributes } = credential

    const key = digest([
      caller,
      credential.id,
      credential.provider,
      attributes["api_key"] ?? "",
      attributes["base_url"] ?? "",
      model,
      identity
    ])

    const state = new InteractionsState(key, store)

    if (get(body, "previous_interaction_id") !== undefined) return { state, body }
    let start = input.length
    const calls: string[] = []

    while (start > 0 && asString(get(input[start - 1], "type")) === "function_result") {
      start--
      calls.push(asString(get(input[start], "call_id")))
    }

    const callKey = interactionsCallKey(calls)

    if (callKey === "") return { state, body }
    const cached = yield* store.get(key, callKey)

    if (cached === undefined) return { state, body }
    set(body, "previous_interaction_id", cached.id)

    if (get(body, "environment_id") === undefined && cached.environment !== "") {
      set(body, "environment_id", cached.environment)
    }

    if (isJsonObject(body)) body["input"] = input.slice(start).map((step) => cloneJson(step))

    return { state, body }
  })
