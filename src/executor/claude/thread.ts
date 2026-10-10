/**
 * Claude Thread continuation: the MCP tool-name aliases of a conversation turn are remembered per upstream message so
 * that `thread.type = "continue"` requests without `tools` can restore the aliased names in the response.
 *
 * Go source: internal/runtime/executor/claude_executor_tool_state.go (`claudeOAuthToolAliasStore`,
 * `claudeOAuthToolAliasKeys`, `claudeThreadContinuationNeedsAliasState`, `prepareClaudeOAuthToolNamesForRequest`,
 * `rememberClaudeOAuthToolAliases`, `claudeThreadNotFoundError`). Go keeps the aliases in executor memory (1024
 * entries, oldest evicted); here they live in the `SessionState` Durable Object, one instance per caller scope with the
 * same 1024-entry bound, and expire after 7 days.
 */
import { Effect } from "effect";
import type { Json, JsonObject } from "../../json/index.ts";
import { isArr, isObj, str } from "../../translator/common/gjson.ts";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
} from "../../session-state/client.ts";
import type { SessionAddress, StateOp } from "../../session-state/protocol.ts";
import { ExecutionError } from "../errors.ts";

const STORE_NAME = "claude-tool-aliases";

const ENTRY_LIMIT = 1024;

const TTL_MS = 7 * 24 * 3_600_000;

export const THREAD_NOT_FOUND_MESSAGE =
  "No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread.";

/** `newClaudeThreadNotFoundError`: a request-scoped 404 with Anthropic's error body. */
export const threadNotFoundError = (): ExecutionError =>
  new ExecutionError({
    status: 404,
    message: JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: THREAD_NOT_FOUND_MESSAGE },
    }),
    requestScoped: true,
    direct: true,
  });

/** `claudeOAuthToolAliasKeys`: the previous message and (once known) the new message of the thread. */
export const threadAliasKeys = (body: JsonObject, messageId: string): string[] => {
  const keys: string[] = [];
  const previous = str(isObj(body.thread) ? body.thread.previous_message_id : undefined);

  if (previous !== "") keys.push(`message:${previous}`);

  if (messageId !== "") keys.push(`message:${messageId}`);

  return keys;
};

/** `claudeThreadContinuationNeedsAliasState`: a `continue` turn that sends no tool definitions itself. */
export const threadContinuationNeedsAliasState = (body: JsonObject): boolean => {
  const thread = body.thread;

  if (!isObj(thread) || str(thread.type) !== "continue") return false;
  const previous = thread.previous_message_id;

  if (previous === undefined || str(previous) === "") return false;

  return !isArr(body.tools) || body.tools.length === 0;
};

export interface ToolAliasStore {
  /** The aliases saved for the first of `keys` that exists (`alias -> client tool name`). */
  readonly load: (
    callerScope: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string> | undefined>;
  readonly save: (
    callerScope: string,
    keys: ReadonlyArray<string>,
    aliases: ReadonlyMap<string, string>,
  ) => Effect.Effect<void>;
}

const addressOf = (callerScope: string): SessionAddress => ({
  store: STORE_NAME,
  scope: callerScope,
  session: "state",
});

const parseAliases = (text: string | undefined): ReadonlyMap<string, string> | undefined => {
  if (text === undefined) return undefined;

  try {
    const parsed = JSON.parse(text) as Json;

    if (!isObj(parsed)) return undefined;

    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return undefined;
  }
};

export const makeSessionStateToolAliasStore = (
  backend: BackendResolver = resolveBackend(),
): ToolAliasStore => ({
  load: (callerScope, keys) =>
    keys.length === 0
      ? Effect.succeed(undefined)
      : bestEffort(
          "claude tool alias load",
          undefined,
          Effect.gen(function* () {
            const ops: StateOp[] = keys.map((key) => ({ op: "get", key }));
            const results = yield* (yield* backend).run(addressOf(callerScope), ops);

            for (const result of results) {
              if (result.status !== "ok" || result.value === undefined) continue;
              const aliases = parseAliases(result.value);

              if (aliases !== undefined) return aliases;
            }

            return undefined;
          }),
        ),
  save: (callerScope, keys, aliases) => {
    const targets = keys.filter((key) => key !== "");

    if (targets.length === 0) return Effect.void;
    const value = JSON.stringify(Object.fromEntries(aliases));

    return bestEffort(
      "claude tool alias save",
      undefined,
      Effect.gen(function* () {
        const ops: StateOp[] = targets.map((key) => ({
          op: "put",
          key,
          value,
          ttlMs: TTL_MS,
          maxEntries: ENTRY_LIMIT,
        }));

        yield* (yield* backend).run(addressOf(callerScope), ops);
      }),
    );
  },
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryToolAliasStore = (now?: () => number): ToolAliasStore =>
  makeSessionStateToolAliasStore(fixedBackend(makeMemoryBackend(now)));
