/**
 * Worker-side client of the `SessionState` Durable Object plus the in-process fallback.
 *
 * Stores (the replay modules under `executor/`) talk to a {@link SessionStateBackend}: the Durable Object one in production
 * (resolved per request from `WorkerEnv`, never captured in a layer), a per-isolate in-memory one when the binding is
 * absent (unit tests, local runs without the binding) and explicit in-memory ones in tests. Both run the same
 * {@link StateEngine}, so the semantics (TTL, compare-and-swap, bounds) are identical.
 */
import { createHash } from "node:crypto";
import { Clock, Effect, Option, Schema } from "effect";
import { WorkerEnv } from "../platform/env.ts";
import type { SessionState } from "./durable-object.ts";
import { MemoryStateTable, StateEngine } from "./engine.ts";
import type { SessionAddress, StateOp, StateResult } from "./protocol.ts";

/** The Durable Object could not be reached or answered unusably. Stores treat it as a cache miss. */
export class SessionStateError extends Schema.TaggedError<SessionStateError>()(
  "SessionStateError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface SessionStateBackend {
  /** Runs `ops` atomically on the instance of `address`; results are positional. */
  readonly run: (
    address: SessionAddress,
    ops: ReadonlyArray<StateOp>,
  ) => Effect.Effect<ReadonlyArray<StateResult>, SessionStateError>;
}

/** Durable Object name: the store plus a hash of scope and session (names stay short and never leak keys). */
export const addressName = (address: SessionAddress): string =>
  `${address.store}:${createHash("sha256").update(`${address.scope}\u0000${address.session}`).digest("hex").slice(0, 32)}`;

/** Backend over the `SESSION_STATE` namespace; the caller's Effect clock is the entry clock. */
export const durableObjectBackend = (
  namespace: DurableObjectNamespace<SessionState>,
): SessionStateBackend => ({
  run: (address, ops) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      return yield* Effect.tryPromise({
        try: async () => await namespace.getByName(addressName(address)).run([...ops], now),
        catch: (cause) => new SessionStateError({ message: "SessionState request failed", cause }),
      });
    }),
});

const MAX_MEMORY_INSTANCES = 10240;

/**
 * In-process backend: one {@link StateEngine} per address, bounded like the Go caches (10240 sessions, oldest use
 * evicted). `now` overrides the Effect clock for tests that use plain closures.
 */
export const makeMemoryBackend = (now?: () => number): SessionStateBackend => {
  const instances = new Map<string, StateEngine>();

  return {
    run: (address, ops) =>
      Effect.gen(function* () {
        const at = now === undefined ? yield* Clock.currentTimeMillis : now();
        const name = addressName(address);
        let engine = instances.get(name);

        if (engine === undefined) {
          engine = new StateEngine(new MemoryStateTable());

          while (instances.size >= MAX_MEMORY_INSTANCES) {
            const oldest = instances.keys().next();

            if (oldest.done === true) break;
            instances.delete(oldest.value);
          }
        } else {
          instances.delete(name);
        }

        instances.set(name, engine);
        const results = engine.run(ops, at);

        if (engine.size() === 0) instances.delete(name);

        return results;
      }),
  };
};

/** Per-isolate fallback shared by every store without a Durable Object binding. */
export const isolateMemoryBackend: SessionStateBackend = makeMemoryBackend();

/** The backend of the current request: the Durable Object when `WorkerEnv` binds it, else `fallback`. */
export const resolveBackend = (
  fallback: SessionStateBackend = isolateMemoryBackend,
): Effect.Effect<SessionStateBackend> =>
  Effect.serviceOption(WorkerEnv).pipe(
    Effect.map((env) =>
      Option.isSome(env) && env.value.SESSION_STATE !== undefined
        ? durableObjectBackend(env.value.SESSION_STATE)
        : fallback,
    ),
  );

/** How a store obtains its backend for one call. */
export type BackendResolver = Effect.Effect<SessionStateBackend>;

export const fixedBackend = (backend: SessionStateBackend): BackendResolver =>
  Effect.succeed(backend);

/** Failures degrade to a cache miss: replay and continuity are best effort, a request never fails because of them. */
export const bestEffort = <A>(
  label: string,
  fallback: A,
  effect: Effect.Effect<A, SessionStateError>,
): Effect.Effect<A> =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.logWarning(`session state ${label} failed: ${error.message}`).pipe(
        Effect.as(fallback),
      ),
    ),
  );

export interface EntryOptions {
  readonly ttlMs: number;
  readonly maxEntries?: number;
  /** Slide the expiry of the initial read (`get` with `extendTtlMs = ttlMs`). */
  readonly slideTtl?: boolean;
  /** State known from an earlier read; skips the initial `get` (one RPC for the usual uncontended write). */
  readonly known?: { readonly generation: number; readonly value: string | undefined };
}

export type Update =
  | { readonly _tag: "put"; readonly value: string }
  | { readonly _tag: "delete" }
  | { readonly _tag: "keep" };

export const putValue = (value: string): Update => ({ _tag: "put", value });

export const deleteValue: Update = { _tag: "delete" };

export const keepValue: Update = { _tag: "keep" };

export interface UpdateOutcome {
  /** True when the decided write or delete was applied (false for `keep`, after exhausting the attempts, rejections). */
  readonly applied: boolean;
  /** Generation of the entry after the update (0 when absent). */
  readonly generation: number;
}

const MAX_CAS_ATTEMPTS = 5;

/**
 * Read-modify-write of one key with compare-and-swap. `decide` sees the stored value (undefined when absent or
 * expired) and may run again when a concurrent writer won: the conflicting writer hands over its state, so a retry
 * costs one RPC and never a read.
 */
export const updateEntry = (
  backend: SessionStateBackend,
  address: SessionAddress,
  key: string,
  options: EntryOptions,
  decide: (current: string | undefined) => Update,
): Effect.Effect<UpdateOutcome, SessionStateError> =>
  Effect.gen(function* () {
    let generation: number;
    let current: string | undefined;

    if (options.known !== undefined) {
      generation = options.known.generation;
      current = options.known.value;
    } else {
      const first = (yield* backend.run(address, [
        { op: "get", key, ...(options.slideTtl === true ? { extendTtlMs: options.ttlMs } : {}) },
      ]))[0];

      generation = first?.status === "ok" ? first.generation : 0;
      current = first?.status === "ok" ? first.value : undefined;
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const update = decide(current);

      if (update._tag === "keep") return { applied: false, generation };

      const op: StateOp =
        update._tag === "put"
          ? {
              op: "put",
              key,
              value: update.value,
              ttlMs: options.ttlMs,
              ifGeneration: generation,
              ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
            }
          : { op: "delete", key, ifGeneration: generation };

      const result = (yield* backend.run(address, [op]))[0];

      if (result?.status === "ok") return { applied: true, generation: result.generation };

      if (result?.status !== "conflict") return { applied: false, generation };
      generation = result.generation;
      current = result.value;
    }

    return { applied: false, generation };
  });
