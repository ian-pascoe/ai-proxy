/**
 * Devin credential helpers and per-session state.
 *
 * Go source: internal/runtime/executor/devin_executor.go (`devinAuthCredentials`, `resolveDevinSessionAndCascadeIDs`,
 * `newDevinStatusError`), internal/runtime/executor/helps/devin_wire.go (`NextDevinSessionTurnIndex`: process-scoped
 * LRU of 5000 session counters). The turn counter only decides whether thread metadata carries an ordinal; it lives
 * in the `SessionState` Durable Object (per-isolate fallback without the binding).
 */
import { Effect } from "effect";
import {
  type BackendResolver,
  bestEffort,
  isolateMemoryBackend,
  resolveBackend,
} from "../../session-state/client.ts";
import type { SessionAddress } from "../../session-state/protocol.ts";
import { ExecutionError } from "../errors.ts";
import type { Json } from "../../json/index.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { DEVIN_DEFAULT_BASE_URL } from "./wire.ts";
import { normalizeDevinUuid } from "./interactions.ts";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

export interface DevinCredentials {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly deviceSeed: string;
}

/** `devinAuthCredentials`: session token (`api_key`, `session_token`, `token`), base URL and device seed. */
export const devinCredentials = (credential: CredentialSnapshot): DevinCredentials => {
  const { attributes, metadata } = credential;

  const apiKey =
    text(attributes["api_key"]) ||
    text(attributes["session_token"]) ||
    text(attributes["token"]) ||
    text(metadata["api_key"]) ||
    text(metadata["session_token"]);

  let baseUrl = text(attributes["base_url"]) || DEVIN_DEFAULT_BASE_URL;

  if (baseUrl === DEVIN_DEFAULT_BASE_URL) baseUrl = text(metadata["base_url"]) || baseUrl;

  return {
    apiKey,
    baseUrl,
    deviceSeed: text(attributes["device_seed"]) || text(metadata["device_seed"]),
  };
};

const TURN_STORE = "devin-turns";

const TURN_KEY = "turn";

const TURN_TTL_MS = 24 * 3_600_000;

const turnAddress = (sessionId: string, callerScope: string): SessionAddress => ({
  store: TURN_STORE,
  scope: callerScope.trim(),
  session: sessionId.trim(),
});

/**
 * `NextDevinSessionTurnIndex`: the 0-based request ordinal of the session. Go keeps an LRU of 5000 counters per
 * process; here the counter is an atomic increment in the `SessionState` Durable Object (TTL 24 h, per caller scope
 * and session) with a per-isolate fallback. Backend failures answer 0 (no ordinal), like an unknown session.
 */
export const nextSessionTurnIndex = (
  sessionId: string,
  callerScope = "",
  backend: BackendResolver = resolveBackend(),
): Effect.Effect<number> => {
  if (sessionId.trim() === "") return Effect.succeed(0);

  return bestEffort(
    "devin turn counter",
    0,
    Effect.gen(function* () {
      const state = yield* backend;

      const [result] = yield* state.run(turnAddress(sessionId, callerScope), [
        { op: "incr", key: TURN_KEY, ttlMs: TURN_TTL_MS, maxEntries: 1 },
      ]);

      return result?.status === "ok"
        ? Math.max(0, Number.parseInt(result.value ?? "1", 10) - 1)
        : 0;
    }),
  );
};

/** `ResetDevinSessionTurnIndex` (per-isolate fallback store; tests). */
export const resetSessionTurnIndex = (sessionId: string, callerScope = ""): void => {
  Effect.runSync(
    isolateMemoryBackend.run(turnAddress(sessionId, callerScope), [
      { op: "delete", key: TURN_KEY },
    ]),
  );
};

export interface DevinSessionIds {
  readonly sessionId: string;
  readonly cascadeId: string;
}

/** `resolveDevinSessionAndCascadeIDs`: the protocol session id (or a random one) as UUIDs. */
export const resolveSessionIds = (
  sessionId: string,
  cascadeId: string,
  fallbackSessionId: string | undefined,
): DevinSessionIds => {
  const session = normalizeDevinUuid(sessionId !== "" ? sessionId : (fallbackSessionId ?? ""));

  return {
    sessionId: session,
    cascadeId: cascadeId === "" ? session : normalizeDevinUuid(cascadeId),
  };
};

/** `newDevinStatusError`: non-2xx answers keep the body; a 429 carries `Retry-After` (seconds or HTTP date). */
export const devinStatusError = (
  status: number,
  headers: Headers,
  body: string,
  nowMs: number,
): ExecutionError => {
  let retryAfterMs: number | undefined;

  if (status === 429) {
    const rawValue = (headers.get("retry-after") ?? "").trim();

    if (/^\d+$/.test(rawValue)) retryAfterMs = Number(rawValue) * 1000;
    else if (rawValue !== "") {
      const date = Date.parse(rawValue);

      if (!Number.isNaN(date) && date - nowMs > 0) retryAfterMs = date - nowMs;
    }
  }

  return new ExecutionError({
    status,
    message: body,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
};
