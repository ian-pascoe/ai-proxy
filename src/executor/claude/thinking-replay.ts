/**
 * Thinking replay for Anthropic-compatible API-key gateways (`is-compat` models): the signed thinking blocks of the
 * last assistant turn are cached and restored into the next request when the client dropped them.
 *
 * Go source: internal/runtime/executor/claude_thinking_replay.go, kimi_thinking_replay.go (restore /
 * replayable / stream accumulator), internal/cache/claude_thinking_replay_cache.go (store semantics).
 * The store sits behind {@link ThinkingReplayStore}; the default implementation keeps the content in the
 * `SessionState` Durable Object (compare-and-swap on the generation snapshot, shared across isolates) and falls
 * back to a per-isolate in-memory store when the binding is absent.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { get, type Json, type JsonObject, tryParseJson } from "../../json/index.ts";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
} from "../../session-state/client.ts";
import type { SessionAddress } from "../../session-state/protocol.ts";
import { isArr, isObj, str } from "../../translator/common/gjson.ts";
import { ssePayloadObject } from "../../usage/record.ts";

const TTL_MS = 3 * 3600_000;

const MAX_ENTRIES_PER_SESSION = 64;

export interface ReplaySnapshot {
  readonly generation: number;
}

export interface ThinkingReplayStore {
  readonly get: (
    family: string,
    session: string,
  ) => Effect.Effect<{ readonly contents: Json[]; readonly snapshot: ReplaySnapshot } | undefined>;
  /** Replaces the cached content when nobody changed it since `snapshot` (compare-and-swap). */
  readonly replaceIfUnchanged: (
    family: string,
    session: string,
    snapshot: ReplaySnapshot | undefined,
    content: Json,
  ) => Effect.Effect<boolean>;
  readonly deleteIfUnchanged: (
    family: string,
    session: string,
    snapshot: ReplaySnapshot | undefined,
  ) => Effect.Effect<boolean>;
}

export interface ThinkingReplayStoreOptions {
  /** `SessionState` store name (Claude and Kimi keep separate namespaces). */
  readonly store?: string;
  readonly ttlMs?: number;
  readonly backend?: BackendResolver;
}

/**
 * Store over the `SessionState` backend of the current request: one instance per session key, one entry per model
 * family. The generation of the Durable Object entry is the snapshot, so a concurrent turn of the session wins
 * (`claude_thinking_replay_cache.go` generation/tombstone semantics).
 */
export const makeSessionStateReplayStore = (
  options: ThinkingReplayStoreOptions = {},
): ThinkingReplayStore => {
  const storeName = options.store ?? "claude-thinking-replay";
  const ttlMs = options.ttlMs ?? TTL_MS;
  const backend = options.backend ?? resolveBackend();
  const address = (session: string): SessionAddress => ({ store: storeName, scope: "", session });
  const expected = (snapshot: ReplaySnapshot | undefined): number => snapshot?.generation ?? 0;

  return {
    get: (family, session) =>
      bestEffort(
        `${storeName} get`,
        undefined,
        Effect.gen(function* () {
          const state = yield* backend;
          const [result] = yield* state.run(address(session), [{ op: "get", key: family }]);

          if (result?.status !== "ok" || result.value === undefined) return undefined;
          const content = tryParseJson(result.value);

          return content === undefined
            ? undefined
            : { contents: [content], snapshot: { generation: result.generation } };
        }),
      ),
    replaceIfUnchanged: (family, session, snapshot, content) =>
      bestEffort(
        `${storeName} replace`,
        false,
        Effect.gen(function* () {
          const state = yield* backend;

          const [result] = yield* state.run(address(session), [
            {
              op: "put",
              key: family,
              value: JSON.stringify(content),
              ttlMs,
              ifGeneration: expected(snapshot),
              maxEntries: MAX_ENTRIES_PER_SESSION,
            },
          ]);

          return result?.status === "ok";
        }),
      ),
    deleteIfUnchanged: (family, session, snapshot) =>
      bestEffort(
        `${storeName} delete`,
        false,
        Effect.gen(function* () {
          const state = yield* backend;

          const [result] = yield* state.run(address(session), [
            { op: "delete", key: family, ifGeneration: expected(snapshot) },
          ]);

          return result?.status === "ok";
        }),
      ),
  };
};

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryReplayStore = (
  now?: () => number,
  ttlMs: number = TTL_MS,
  store?: string,
): ThinkingReplayStore =>
  makeSessionStateReplayStore({
    ttlMs,
    backend: fixedBackend(makeMemoryBackend(now)),
    ...(store === undefined ? {} : { store }),
  });

export interface ReplayScope {
  readonly modelFamily: string;
  readonly sessionKey: string;
  readonly snapshot: ReplaySnapshot | undefined;
  readonly cacheReady: boolean;
  readonly replayApplied: boolean;
}

export const replayScopeValid = (scope: ReplayScope | undefined): scope is ReplayScope =>
  scope !== undefined && scope.modelFamily.trim() !== "" && scope.sessionKey.trim() !== "";

/** `claudeThinkingReplayModelFamily`. */
export const replayModelFamily = (
  credentialId: string,
  baseURL: string,
  apiKey: string,
  baseModel: string,
): string => {
  if (baseModel === "") return "";
  const identity = credentialId.trim() || baseURL.trim() || apiKey.trim();

  if (identity === "") return `claude:${baseModel}`;

  return `claude:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}:${baseModel}`;
};

const canonical = (value: Json): string => JSON.stringify(sortKeys(value));

const sortKeys = (value: Json): Json => {
  if (isArr(value)) return value.map(sortKeys);

  if (isObj(value))
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeys(child)]),
    );

  return value;
};

const hasThinking = (content: Json | undefined): boolean =>
  isArr(content) &&
  content.some((part) => ["thinking", "redacted_thinking"].includes(str(get(part, "type")).trim()));

/** `kimiNonThinkingContentParts`: canonical non-thinking parts, `undefined` unless the content carries a tool_use. */
const nonThinkingParts = (content: Json | undefined): string[] | undefined => {
  if (!isArr(content)) return undefined;
  const parts: string[] = [];
  let hasToolUse = false;

  for (const part of content) {
    const type = str(get(part, "type")).trim();

    if (type === "thinking" || type === "redacted_thinking") continue;

    if (type === "tool_use") {
      if (str(get(part, "id")).trim() === "") return undefined;
      hasToolUse = true;
    }

    parts.push(canonical(part));
  }

  return hasToolUse ? parts : undefined;
};

/** `kimiThinkingReplayContentIsReplayable`: signed thinking plus a tool_use with an id. */
export const replayContentIsReplayable = (content: Json | undefined): boolean => {
  if (!isArr(content)) return false;
  let signedThinking = false;
  let toolUse = false;

  for (const part of content) {
    const type = str(get(part, "type")).trim();

    if (type === "thinking" && str(get(part, "signature")).trim() !== "") signedThinking = true;

    if (type === "tool_use" && str(get(part, "id")).trim() !== "") toolUse = true;
  }

  return signedThinking && toolUse;
};

/** `restoreKimiThinkingReplayContent`: puts the cached content into the latest matching assistant message. */
export const restoreReplayContent = (body: JsonObject, cached: Json): boolean => {
  const cachedParts = nonThinkingParts(cached);
  const messages = body.messages;

  if (cachedParts === undefined || !isArr(messages)) return false;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (str(get(message, "role")).trim().toLowerCase() !== "assistant" || !isObj(message)) continue;
    const current = message.content;

    if (current !== undefined && canonical(current) === canonical(cached)) return false;

    if (hasThinking(current)) continue;
    const currentParts = nonThinkingParts(current);

    if (
      currentParts === undefined ||
      currentParts.length !== cachedParts.length ||
      currentParts.some((part, i) => part !== cachedParts[i])
    ) {
      continue;
    }

    message.content = structuredClone(cached);

    return true;
  }

  return false;
};

interface AccumulatedBlock {
  raw: JsonObject;
  text: string;
  thinking: string;
  signature: string;
  input: string;
  hasText: boolean;
  hasThinking: boolean;
  hasSignature: boolean;
  hasInput: boolean;
}

/** Rebuilds the assistant content from Claude SSE lines (`kimiThinkingReplayStreamAccumulator`). */
export class ReplayStreamAccumulator {
  readonly #blocks = new Map<number, AccumulatedBlock>();
  #complete = false;
  #failed = false;

  observe(line: string): void {
    const payload = ssePayloadObject(line);

    if (payload === undefined || this.#failed) return;
    const index = Math.trunc(Number(get(payload, "index") ?? -1));

    switch (str(get(payload, "type"))) {
      case "content_block_start": {
        const block = get(payload, "content_block");

        if (!isObj(block)) return;

        const accumulated: AccumulatedBlock = {
          raw: structuredClone(block),
          text: str(block.text),
          thinking: str(block.thinking),
          signature: str(block.signature),
          input: "",
          hasText: typeof block.text === "string",
          hasThinking: typeof block.thinking === "string",
          hasSignature: typeof block.signature === "string",
          hasInput: false,
        };

        this.#blocks.set(index, accumulated);

        return;
      }

      case "content_block_delta": {
        const block = this.#blocks.get(index);
        const delta = get(payload, "delta");

        if (block === undefined || !isObj(delta)) return;

        switch (str(delta.type)) {
          case "text_delta":
            block.text += str(delta.text);
            block.hasText = true;

            return;
          case "thinking_delta":
            block.thinking += str(delta.thinking);
            block.hasThinking = true;

            return;
          case "signature_delta":
            block.signature += str(delta.signature);
            block.hasSignature = true;

            return;
          case "input_json_delta":
            block.input += str(delta.partial_json);
            block.hasInput = true;
        }

        return;
      }

      case "message_stop":
        this.#complete = true;

        return;
      case "error":
        this.#failed = true;
    }
  }

  /** The assistant content once the message completed; `undefined` otherwise. */
  content(): Json[] | undefined {
    if (!this.#complete || this.#failed) return undefined;
    const out: Json[] = [];

    for (const [, block] of [...this.#blocks.entries()].toSorted((a, b) => a[0] - b[0])) {
      const raw = block.raw;

      if (block.hasText) raw.text = block.text;

      if (block.hasThinking) raw.thinking = block.thinking;

      if (block.hasSignature) raw.signature = block.signature;

      if (block.hasInput) {
        const parsed = block.input === "" ? {} : tryParseJson(block.input);

        if (parsed === undefined) return undefined;
        raw.input = parsed;
      }

      out.push(raw);
    }

    return out;
  }
}
