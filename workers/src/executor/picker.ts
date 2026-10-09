/**
 * Credential selection contract between the request pipeline and the credential store.
 *
 * Go source: sdk/cliproxy/auth/conductor_execution.go (pickNextMixed, MarkResult), sdk/cliproxy/auth/types.go (Auth).
 * The production implementation lives in the ControlPlane Durable Object (single writer for cursors, cooldowns,
 * quota state and session affinity) and is reached over JS RPC; `static-picker.ts` is a config-only stand-in.
 *
 * Contract:
 *  - `pick` chooses one credential able to serve `model` for one of `providers` (in preference order), honouring
 *    `excludedIds` (credentials already tried in this request), `pinnedId`, session affinity (`sessionKey` within
 *    `callerScope`), priorities/weights and cooldowns. It returns an immutable snapshot plus a lease id. It fails
 *    with an `ExecutionError` whose `code` is `provider_not_found` (empty providers), `auth_not_found` (no credential
 *    serves the model) or `auth_unavailable` (all cooling down; `retryAfterMs` set when known), status 503 unless
 *    the code says otherwise.
 *  - `report` must be called exactly once per lease with the attempt outcome so cooldown/quota bookkeeping and
 *    round-robin state stay consistent. It never fails (bookkeeping errors are logged by the implementation).
 *  - Snapshots must be treated as read-only; secrets in `attributes`/`metadata` must never be logged.
 */
import { Context, type Effect } from "effect"
import type { WorkerEnv } from "../platform/env.ts"
import type { ExecutionError } from "./errors.ts"

/** Read-only view of one credential (Go `cliproxyauth.Auth`). */
export interface CredentialSnapshot {
  /** Stable credential id (never derived from a secret in clear text). */
  readonly id: string
  /** Provider / executor key, e.g. `claude`, `codex`, `gemini`, `openai-compatible-openrouter`. */
  readonly provider: string
  /** `apikey` for configured keys, `oauth` for login credentials. */
  readonly kind: "apikey" | "oauth"
  /** Account label for logs and usage (e.g. compat entry name, email). */
  readonly label?: string
  /** Model namespace prefix (`team-a` in `team-a/gpt-5`); stripped before execution. */
  readonly prefix?: string
  /**
   * String attributes as in Go: `base_url`, `api_key`, `compat_name`, `provider_key`, `config_index`, `priority`,
   * `weight`, `header:<Name>` (custom upstream headers), ...
   */
  readonly attributes: Readonly<Record<string, string>>
  /** Provider metadata (OAuth tokens, account ids, `disable_cooling`, `request_retry`, ...). */
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface PickRequest {
  /** Candidate providers in preference order (from model resolution). */
  readonly providers: ReadonlyArray<string>
  /** Route model as resolved by the handler: may carry a credential prefix and a `(thinking)` suffix. */
  readonly model: string
  /** Caller isolation scope (`AccessPrincipal.callerScope`). */
  readonly callerScope: string
  /** Session key for affinity/stickiness, when the request carries one. */
  readonly sessionKey?: string
  /** Credentials already tried for this request. */
  readonly excludedIds?: ReadonlyArray<string>
  /** Require this credential (e.g. video retrieval bound to the creating credential). */
  readonly pinnedId?: string
  /** Select as if for this model while executing `model` (Interactions agents, Go `auth_selection_model`). */
  readonly selectionModel?: string
  /** Exclude free-plan credentials (Codex image tools). */
  readonly disallowFreeAuth?: boolean
}

export interface PickResult {
  readonly credential: CredentialSnapshot
  /** Opaque lease to pass back to `report`. */
  readonly leaseId: string
}

/** Outcome of one upstream attempt. `model` is the route model the lease was picked for. */
export type AttemptResult =
  | { readonly ok: true; readonly model: string }
  | {
      readonly ok: false
      readonly model: string
      readonly status: number
      readonly retryAfterMs?: number
      readonly credentialScoped?: boolean
      readonly requestScoped?: boolean
      /** Short, secret-free error summary for diagnostics. */
      readonly message?: string
    }

export class CredentialPicker extends Context.Service<
  CredentialPicker,
  {
    readonly pick: (request: PickRequest) => Effect.Effect<PickResult, ExecutionError, WorkerEnv>
    readonly report: (leaseId: string, result: AttemptResult) => Effect.Effect<void, never, WorkerEnv>
  }
>()("cliproxy/executor/CredentialPicker") {}

/** Builds the `AttemptResult` for a failed attempt from an executor error. */
export const failedAttempt = (model: string, error: ExecutionError): AttemptResult => ({
  ok: false,
  model,
  status: error.status,
  ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  ...(error.credentialScoped !== undefined ? { credentialScoped: error.credentialScoped } : {}),
  ...(error.requestScoped !== undefined ? { requestScoped: error.requestScoped } : {}),
  message: error.message.slice(0, 256)
})
