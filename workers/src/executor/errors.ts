/**
 * The error contract between executors, the credential conductor and the handlers.
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (statusErr), sdk/cliproxy/executor/types.go
 * (StatusError, RequestScopedError), sdk/cliproxy/auth/errors.go (Error{Code,HTTPStatus}), internal/clienterror
 * (HTTPStatusFromError), sdk/api/handlers/handlers_execution.go (executionErrorMessage). The optional Go interfaces
 * (`StatusCode()`, `RetryAfter()`, `IsCredentialScoped()`, `IsRequestScoped()`, `DirectResponse()`, `Headers()`)
 * become plain fields.
 */
import { Schema } from "effect"

export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  /** HTTP status for the client (Go `StatusCode()`; 500 when unknown, 499 when the client went away). */
  status: Schema.Number,
  /**
   * Error text. For upstream HTTP errors this is the upstream body verbatim (JSON error bodies are passed through to
   * OpenAI-style clients); otherwise a human-readable message. Never contains credentials.
   */
  message: Schema.String,
  /** Conductor/selection code (`auth_not_found`, `auth_unavailable`, `provider_not_found`, `model_not_found`, ...). */
  code: Schema.optional(Schema.String),
  /** Upstream cooldown hint in milliseconds (Go `RetryAfter()`). */
  retryAfterMs: Schema.optional(Schema.Number),
  /** The failure is tied to the credential (e.g. quota exhausted): cool the credential down. */
  credentialScoped: Schema.optional(Schema.Boolean),
  /** The failure is caused by the request itself (4xx): do not penalise the credential, do not retry. */
  requestScoped: Schema.optional(Schema.Boolean),
  /** The upstream OAuth credential is permanently invalid (`coreauth.IsTerminalAuthError`). */
  terminalAuth: Schema.optional(Schema.Boolean),
  /** Forward `message` verbatim as the response body with `headers` (Go `DirectResponse()`). */
  direct: Schema.optional(Schema.Boolean),
  /** Upstream response headers (`Headers()`); exposed to clients only with `passthrough-headers`. */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Safe headers for the client regardless of passthrough (e.g. `Retry-After` of cooldown errors). */
  safeHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cause: Schema.optional(Schema.Defect())
}) {}

/** Convenience constructor for plain status errors (Go `statusErr{code, msg}`). */
export const statusError = (status: number, message: string): ExecutionError => new ExecutionError({ status, message })

/** Plain record of response headers (lower-case names). */
export const headersRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name] = value
  })
  return out
}
