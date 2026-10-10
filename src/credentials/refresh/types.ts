/**
 * Refresh protocol contract.
 *
 * A protocol is the Workers counterpart of one Go `ProviderExecutor.Refresh`: it receives a snapshot of the
 * credential and returns the complete updated auth-file metadata (a fresh object; the input is never mutated). The
 * `RefreshManager` owns everything around it (locking, three-way merge, persistence, scheduling, back-off).
 */
import type { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { JsonObject } from "../../json/index.ts";
import type { RefreshError } from "./error.ts";

export interface RefreshContext {
  /** Executor key of the credential (`kimi.com` -> `kimi`). */
  readonly provider: string;
  /** Auth-file metadata at the time the refresh started. */
  readonly metadata: Readonly<JsonObject>;
  /** Derived routing attributes (`domain`, `base_url`, ...). */
  readonly attributes: Readonly<Record<string, string>>;
  /** Refresh start time (epoch ms): the base of every computed `expired`. */
  readonly now: number;
  /** Delay before retry `attempt` (1-based) in ms. Go sleeps `attempt` seconds; tests inject `0`. */
  readonly retryDelayMs: (attempt: number) => number;
  /** `META_MINT_URL` override of the Meta key-mint endpoint (Go reads the process environment). */
  readonly metaMintUrl?: string | undefined;
}

/** An effect that talks to an upstream through the injected `HttpClient`. */
export type RefreshEffect<A> = Effect.Effect<A, RefreshError, HttpClient.HttpClient>;

export type RefreshProtocolEffect = RefreshEffect<JsonObject>;

export type RefreshProtocol = (context: RefreshContext) => RefreshProtocolEffect;
