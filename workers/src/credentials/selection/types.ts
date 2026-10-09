/**
 * Wire types of the selection RPC (`ControlPlane.pick` / `report`). Plain data only: they cross the Durable Object
 * RPC boundary. Requests are decoded with these schemas inside the DO; results are plain objects.
 */
import { Schema } from "effect"
import { AuthKind, Credential, CredentialError } from "../model.ts"

const optional = Schema.optionalKey

/** Session identity already extracted by the handler (header/body rules live in the pipeline slice). */
export const SessionRef = Schema.Struct({
  id: Schema.String,
  /** Parent/fork session; subagents may inherit the parent's credential. */
  parentId: optional(Schema.String),
  isFork: optional(Schema.Boolean),
  /** Hash of the caller (Access principal): bindings never cross scopes. */
  callerScope: optional(Schema.String)
})
export type SessionRef = typeof SessionRef.Type

export const PickRequest = Schema.Struct({
  /** Executor provider keys able to serve the model (from the model registry). */
  providers: Schema.Array(Schema.String),
  /** Model as requested by the client: may carry a `prefix/` and a `(thinking)` suffix. */
  model: Schema.String,
  /** Credential ids already tried in this round. */
  tried: optional(Schema.Array(Schema.String)),
  /** Restrict selection to one credential (`pinned_auth_id`). */
  pinnedAuthId: optional(Schema.String),
  requireAuthKind: optional(AuthKind),
  /** Skip Codex credentials on the free plan. */
  disallowFreeCodex: optional(Schema.Boolean),
  /** Downstream WebSocket request: prefer Codex credentials with `websockets=true`. */
  preferWebsockets: optional(Schema.Boolean),
  session: optional(SessionRef)
})
export type PickRequest = typeof PickRequest.Type

/** Routing outcome for the picked credential: requested model -> upstream model. */
export const ModelRouteSnapshot = Schema.Struct({
  requestedModel: Schema.String,
  routeModel: Schema.String,
  upstreamModel: Schema.String,
  upstreamModels: Schema.Array(Schema.String),
  originalAlias: Schema.String,
  forceMapping: Schema.Boolean,
  /** Key under which cooldown state for this request is tracked. */
  stateModel: Schema.String
})
export type ModelRouteSnapshot = typeof ModelRouteSnapshot.Type

/**
 * Everything an executor needs: the credential including token metadata (never log it), resolved base URL and
 * headers. Produced per pick; do not cache across requests (tokens rotate).
 */
export const CredentialSnapshot = Schema.Struct({
  ...Credential.fields,
  /** `attributes.base_url` (config) or `metadata.base_url` (auth file); absent when the provider default applies. */
  baseUrl: optional(Schema.String),
  /** Executor key used for the lookup (`kimi.com` -> `kimi`, compat -> `openai-compatible-<name>`). */
  executor: Schema.String
})
export type CredentialSnapshot = typeof CredentialSnapshot.Type

export const Lease = Schema.Struct({
  id: Schema.String,
  credentialId: Schema.String,
  credentialVersion: Schema.Int,
  provider: Schema.String,
  /** Model key for cooldown state (canonical, no thinking suffix). */
  model: Schema.String,
  issuedAt: Schema.Number,
  /** Opaque session-affinity cache keys bound by this pick. */
  affinityKeys: optional(Schema.Array(Schema.String))
})
export type Lease = typeof Lease.Type

export const PickFailureCode = Schema.Literals([
  "provider_not_found",
  "auth_not_found",
  "auth_unavailable",
  "model_cooldown"
])
export type PickFailureCode = typeof PickFailureCode.Type

/** Why nothing could be picked (mirrors the Go selector errors, credentials.md §6.5). */
export const PickFailure = Schema.Struct({
  code: PickFailureCode,
  message: Schema.String,
  /** 429 for `model_cooldown`, 503 for `auth_unavailable` with a known recovery; unset otherwise. */
  httpStatus: optional(Schema.Int),
  retryable: Schema.Boolean,
  /** Seconds until the earliest cooldown ends (also the `Retry-After` header value). */
  retryAfterSeconds: optional(Schema.Int),
  /** JSON error body for `model_cooldown` (`{"error":{"code":"model_cooldown",...}}`). */
  body: optional(Schema.String)
})
export type PickFailure = typeof PickFailure.Type

export type PickResult =
  | {
      readonly ok: true
      readonly credential: CredentialSnapshot
      readonly route: ModelRouteSnapshot
      readonly lease: Lease
    }
  | { readonly ok: false; readonly failure: PickFailure }

/** Outcome of one upstream attempt, reported back with the lease. */
export const ReportResult = Schema.Struct({
  success: Schema.Boolean,
  httpStatus: optional(Schema.Int),
  error: optional(CredentialError),
  /**
   * The failure is not the credential's fault (request-scoped, cancelled, transport): keeps session bindings.
   * Cooldown semantics for the other cases belong to the retry/cooldown slice.
   */
  requestScoped: optional(Schema.Boolean),
  /** Upstream `Retry-After` in milliseconds, if any. */
  retryAfterMs: optional(Schema.Number)
})
export type ReportResult = typeof ReportResult.Type

export type ReportOutcome =
  { readonly ok: true; readonly applied: boolean } | { readonly ok: false; readonly error: "unknown_credential" }
