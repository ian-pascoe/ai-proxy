/**
 * Wire protocol of the `SessionState` Durable Object (new in the Workers port; replaces the per-process maps of
 * internal/cache: codex/xai/claude/kimi/antigravity replay caches, the Claude continuity store and the Devin turn
 * counter, see docs/research/pipeline.md §7.1).
 *
 * One Durable Object instance holds the entries of one (store, scope, session) address; entries are `key -> string`
 * with an expiry and a generation. The generation is the compare-and-swap token (Go `…IfUnchanged` snapshots):
 * `0` always means "absent", every successful write allocates a fresh, never reused generation.
 */

/** Logical address of one Durable Object instance. Session keys are caller-isolated by their store. */
export interface SessionAddress {
  /** Store name, e.g. `codex-replay`; part of the Durable Object name. */
  readonly store: string;
  /** Caller scope (Access principal) for stores that shard by caller; empty when the session key embeds it. */
  readonly scope: string;
  /** Session key of the store. */
  readonly session: string;
}

export interface GetOp {
  readonly op: "get";
  readonly key: string;
  /** Sliding expiry: a hit moves the expiry to `now + extendTtlMs` (the generation does not change). */
  readonly extendTtlMs?: number;
}

export interface PutOp {
  readonly op: "put";
  readonly key: string;
  readonly value: string;
  readonly ttlMs: number;
  /** Compare-and-swap: only write when the current generation equals this (`0` = the key must be absent). */
  readonly ifGeneration?: number;
  /** Upper bound of entries in the instance; the oldest writes are evicted beyond it (default 256). */
  readonly maxEntries?: number;
}

export interface DeleteOp {
  readonly op: "delete";
  readonly key: string;
  readonly ifGeneration?: number;
}

/** Atomic counter: adds one to the integer stored at `key` (absent = 0) and answers the new count in `value`. */
export interface IncrOp {
  readonly op: "incr";
  readonly key: string;
  readonly ttlMs: number;
  readonly maxEntries?: number;
}

export type StateOp = GetOp | PutOp | DeleteOp | IncrOp;

export type StateResult =
  /** `get`: the current entry (`generation` 0 and no `value` when absent). `put`: the new generation. `delete`: 0. `incr`: the new count in `value`. */
  | { readonly status: "ok"; readonly generation: number; readonly value?: string }
  /** The compare-and-swap failed; carries the current state so the caller can retry without another read. */
  | { readonly status: "conflict"; readonly generation: number; readonly value?: string }
  | { readonly status: "rejected"; readonly reason: "too_large" | "invalid" };

export const DEFAULT_MAX_ENTRIES = 256;

export const MIN_TTL_MS = 1_000;

export const MAX_TTL_MS = 7 * 24 * 3_600_000;

/** Longest accepted value (UTF-16 units); the Go caches cap entries at 16 MiB. */
export const MAX_VALUE_CHARS = 20 * 1024 * 1024;
