/**
 * Executor-facing request/response types and the provider executor interface.
 *
 * Go source: sdk/cliproxy/executor/types.go (Request, Options, Response, StreamResult, metadata keys),
 * sdk/cliproxy/auth/conductor.go (ProviderExecutor). Executors own the canonical per-attempt pipeline:
 * translate request (client -> provider format) -> upstream model -> thinking -> provider shaping -> payload rules
 * (always last) -> upstream fetch -> translate response (provider -> client format, one SSE line at a time).
 */
import type { Effect, Stream } from "effect"
import type { HttpClient } from "effect/http"
import type { Config } from "../config/schema.ts"
import type { Json } from "../json/index.ts"
import type { Format } from "../translator/formats.ts"
import type { UsageReporter } from "../usage/reporter.ts"
import type { ExecutionError } from "./errors.ts"
import type { CredentialSnapshot } from "./picker.ts"
import type { Thinking } from "./thinking.ts"

/** Go `executor.Request`. */
export interface ExecutorRequest {
  /** Model to execute for this credential (prefix stripped, alias resolved, `(suffix)` kept). */
  readonly model: string
  /** Client body (entry-protocol format); executors must not mutate it. */
  readonly payload: Json
}

/** Typed subset of Go `Options.Metadata` (sdk/api/handlers/handlers.go requestExecutionMetadata). */
export interface ExecutionMetadata {
  /** Inbound route path, e.g. `/v1/chat/completions` (payload rules, image endpoints). */
  readonly requestPath: string
  /** Model string exactly as the client sent it (suffix/prefix included). */
  readonly requestedModel: string
  readonly idempotencyKey?: string
  /** Client-requested reasoning effort (usage logs). */
  readonly reasoningEffort?: string
  /** Body `service_tier`, else `auto`. */
  readonly serviceTier: string
  /** `false` only when the client sent `generate: false`. */
  readonly generate: boolean
  /** Caller isolation scope (Access principal). */
  readonly callerScope: string
  /** Session identity for affinity/prompt caching, when known. */
  readonly sessionId?: string
}

/** Go `executor.Options`. */
export interface ExecutorOptions {
  readonly stream: boolean
  /** Gemini `alt` (`""` = SSE) or an internal route tag such as `responses/compact`. */
  readonly alt: string
  /** Inbound request headers (payload rule header conditions, `$Header` custom header expansion). */
  readonly headers: Headers
  readonly query: URLSearchParams
  /** Client body before any handler-level rewrite (baseline for `default` payload rules). */
  readonly originalRequest: Json | undefined
  /** Entry protocol of the request. */
  readonly sourceFormat: Format
  /** Protocol of the response the client expects (defaults to `sourceFormat`). */
  readonly responseFormat?: Format
  readonly metadata: ExecutionMetadata
}

/** Go `ResponseFormatOrSource`. */
export const responseFormatOf = (options: ExecutorOptions): Format => options.responseFormat ?? options.sourceFormat

/** Everything an attempt needs besides the request: credential, config snapshot and usage collector. */
export interface ExecutionContext {
  readonly credential: CredentialSnapshot
  readonly config: Config
  readonly usage: UsageReporter
}

export interface ExecutorResponse {
  /** Client-format body. */
  readonly payload: string
  /** Upstream response headers (forwarded only with `passthrough-headers`). */
  readonly headers: Headers
}

export interface StreamResult {
  readonly headers: Headers
  /**
   * Complete client-format chunks: bare JSON for OpenAI/Gemini, `event:`/`data:` framed text for Claude, Responses
   * and Interactions. Failures after the first chunk end the stream with an `ExecutionError`.
   */
  readonly chunks: Stream.Stream<string, ExecutionError>
}

/** Services available to executors. */
export type ExecutorServices = HttpClient.HttpClient | Thinking

/** Go `ProviderExecutor` (Refresh lives in the credential refresh slice). */
export interface ProviderExecutor {
  /** Provider key handled by this executor. */
  readonly identifier: string
  readonly execute: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) => Effect.Effect<ExecutorResponse, ExecutionError, ExecutorServices>
  readonly executeStream: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) => Effect.Effect<StreamResult, ExecutionError, ExecutorServices>
  readonly countTokens: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) => Effect.Effect<ExecutorResponse, ExecutionError, ExecutorServices>
}
