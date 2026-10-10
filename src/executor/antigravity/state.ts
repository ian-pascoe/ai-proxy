/**
 * Best-effort Antigravity runtime state: short quota cooldowns and Google One AI credits.
 *
 * Go source: internal/runtime/executor/antigravity_executor_credits.go (`markAntigravityShortCooldownRequired`,
 * `antigravityIsInShortCooldownRequired`, credits balance/hint/failure maps and their home-KV keys).
 * State lives in the `CACHE` KV namespace with the Go TTLs (KV needs at least 60 s of `expirationTtl`; deadlines are
 * checked on read) and falls back to per-isolate maps without a binding. KV failures never fail a request: unknown
 * state is optimistic (credits assumed available, no cooldown). The balance-probe slot is a lock and needs an atomic
 * claim, which KV cannot give: it is a create-if-absent write in the `SessionState` Durable Object (per credential,
 * TTL 10 min), with the per-isolate map as fallback.
 */
import { createHash } from "node:crypto";
import type { SessionState } from "../../session-state/durable-object.ts";
import { addressName } from "../../session-state/client.ts";

export const CREDITS_TTL_MS = 30 * 60_000;

export const CREDITS_REFRESH_INTERVAL_MS = 10 * 60_000;

const KV_MIN_TTL_SECONDS = 60;

/** `antigravityCreditsBalance` + hint. */
export interface CreditsRecord {
  readonly creditAmount: number;
  readonly minCreditAmount: number;
  readonly paidTierId: string;
  readonly updatedAt: number;
}

export const creditsAvailable = (record: CreditsRecord | undefined): boolean =>
  record === undefined || record.creditAmount >= record.minCreditAmount;

const hashModel = (model: string): string =>
  createHash("sha256").update(model, "utf8").digest("hex").slice(0, 16);

const ttlSeconds = (ms: number): number => Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ms / 1000));

export interface AntigravityState {
  /** Remaining short-cooldown time (ms) of a credential/model pair, `0` when none. */
  shortCooldownRemaining(authId: string, model: string, now: number): Promise<number>;
  markShortCooldown(authId: string, model: string, durationMs: number, now: number): Promise<void>;
  credits(authId: string): Promise<CreditsRecord | undefined>;
  setCredits(authId: string, record: CreditsRecord): Promise<void>;
  /** `markAntigravityCreditsPermanentlyDisabled`: balance `0 / min 1`. */
  markCreditsExhausted(authId: string, now: number): Promise<void>;
  /** Claims the per-credential balance probe slot (10 min); `false` when another probe ran recently. */
  readonly claimCreditsRefresh: CreditsRefreshClaim;
}

const memoryCooldowns = new Map<string, number>();

const memoryCredits = new Map<
  string,
  { readonly record: CreditsRecord; readonly expires: number }
>();

const memoryRefresh = new Map<string, number>();

/** Per-isolate implementation (tests and deployments without KV). */
export const makeMemoryAntigravityState = (): AntigravityState => ({
  shortCooldownRemaining: async (authId, model, now) => {
    const deadline = memoryCooldowns.get(`${authId}|${model}`) ?? 0;

    return Math.max(0, deadline - now);
  },
  markShortCooldown: async (authId, model, durationMs, now) => {
    memoryCooldowns.set(`${authId}|${model}`, now + durationMs);
  },
  credits: async (authId) => {
    const entry = memoryCredits.get(authId);

    return entry === undefined || entry.expires <= Date.now() ? undefined : entry.record;
  },
  setCredits: async (authId, record) => {
    memoryCredits.set(authId, { record, expires: Date.now() + CREDITS_TTL_MS });
  },
  markCreditsExhausted: async (authId, now) => {
    memoryCredits.set(authId, {
      record: { creditAmount: 0, minCreditAmount: 1, paidTierId: "", updatedAt: now },
      expires: now + CREDITS_TTL_MS,
    });
  },
  claimCreditsRefresh: async (authId, now) => {
    const last = memoryRefresh.get(authId);

    if (last !== undefined && now - last < CREDITS_REFRESH_INTERVAL_MS) return false;
    memoryRefresh.set(authId, now);

    return true;
  },
});

/** Test hook: clears the per-isolate maps. */
export const resetMemoryAntigravityState = (): void => {
  memoryCooldowns.clear();
  memoryCredits.clear();
  memoryRefresh.clear();
};

/** Claims the probe slot of a credential atomically; `false` when it is taken (or the claim failed). */
export type CreditsRefreshClaim = (authId: string, now: number) => Promise<boolean>;

const CREDITS_LOCK_STORE = "antigravity-credits-probe";

/** {@link CreditsRefreshClaim} over the `SessionState` Durable Object (`put` with `ifGeneration: 0`). */
export const sessionStateCreditsClaim =
  (namespace: DurableObjectNamespace<SessionState>): CreditsRefreshClaim =>
  async (authId, now) => {
    try {
      const stub = namespace.getByName(
        addressName({ store: CREDITS_LOCK_STORE, scope: "", session: authId }),
      );

      const [result] = await stub.run(
        [
          {
            op: "put",
            key: "probe",
            value: String(now),
            ttlMs: CREDITS_REFRESH_INTERVAL_MS,
            ifGeneration: 0,
          },
        ],
        now,
      );

      return result?.status === "ok";
    } catch {
      return false;
    }
  };

/** KV-backed implementation; every KV failure degrades to "no state". */
export const makeKvAntigravityState = (
  kv: KVNamespace,
  claimRefresh: CreditsRefreshClaim = makeMemoryAntigravityState().claimCreditsRefresh,
): AntigravityState => {
  const swallow = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch {
      return fallback;
    }
  };

  const cooldownKey = (authId: string, model: string): string =>
    `ag:sc:${authId}:${hashModel(model)}`;

  const creditsKey = (authId: string): string => `ag:credits:${authId}`;

  const putCredits = (authId: string, record: CreditsRecord): Promise<void> =>
    swallow(
      () =>
        kv.put(creditsKey(authId), JSON.stringify(record), {
          expirationTtl: ttlSeconds(CREDITS_TTL_MS),
        }),
      undefined,
    );

  return {
    shortCooldownRemaining: (authId, model, now) =>
      swallow(async () => {
        const raw = await kv.get(cooldownKey(authId, model));
        const deadline = raw === null ? 0 : Number(raw);

        return Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
      }, 0),
    markShortCooldown: (authId, model, durationMs, now) =>
      swallow(
        () =>
          kv.put(cooldownKey(authId, model), String(now + durationMs), {
            expirationTtl: ttlSeconds(durationMs + 5000),
          }),
        undefined,
      ),
    credits: (authId) =>
      swallow(async () => {
        const raw = await kv.get(creditsKey(authId));

        // SAFETY: only `putCredits` writes this key, always a serialised `CreditsRecord`.
        return raw === null ? undefined : (JSON.parse(raw) as CreditsRecord);
      }, undefined),
    setCredits: putCredits,
    markCreditsExhausted: (authId, now) =>
      putCredits(authId, { creditAmount: 0, minCreditAmount: 1, paidTierId: "", updatedAt: now }),
    claimCreditsRefresh: claimRefresh,
  };
};

/**
 * The state store for an invocation: KV when the binding exists, the probe slot in the `SessionState` Durable Object
 * when that binding exists.
 */
export const antigravityStateFor = (
  env:
    | {
        readonly CACHE?: KVNamespace;
        readonly SESSION_STATE?: DurableObjectNamespace<SessionState>;
      }
    | undefined,
): AntigravityState => {
  if (env?.CACHE === undefined) return makeMemoryAntigravityState();

  return env.SESSION_STATE === undefined
    ? makeKvAntigravityState(env.CACHE)
    : makeKvAntigravityState(env.CACHE, sessionStateCreditsClaim(env.SESSION_STATE));
};
