/**
 * Shared execution pipeline for all entry protocols: resolve model/providers -> pick credential -> resolve the
 * credential's upstream model -> run the provider executor -> report the attempt -> publish usage.
 *
 * Go source: sdk/api/handlers/handlers_execution.go (ExecuteWithAuthManager, executionErrorMessage),
 * sdk/api/handlers/handlers_stream.go (ExecuteStreamWithAuthManager), sdk/api/handlers/handlers.go
 * (requestExecutionMetadata), sdk/api/handlers/handlers_errors.go (enrichAuthSelectionError),
 * sdk/cliproxy/auth/conductor_execution.go (Execute/ExecuteStream), sdk/api/handlers/handlers_stream.go (bootstrap
 * retries). The retry rounds, cooldown waits and failover live in `conductor.ts`; this module supplies what is specific
 * to non-stream and stream execution (stream bootstrap, force-mapping rewrite, per-attempt reporting).
 */
import { Cause, Effect, Exit, Pull, Scope, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"
import { AccessPrincipal } from "../access/principal.ts"
import { ConfigReader } from "../config/reader.ts"
import type { Config } from "../config/schema.ts"
import { ExecutionError } from "../executor/errors.ts"
import type { ExecutionMetadata, ExecutorOptions } from "../executor/types.ts"
import { filterUpstreamHeaders } from "../http/headers.ts"
import { get, type Json } from "../json/index.ts"
import type { Format } from "../translator/formats.ts"
import type { WorkerEnv } from "../platform/env.ts"
import { type Attempt, conduct, lifecycleError, type Prepared } from "./conductor.ts"
import { rewriteResponseModel, rewriteStreamChunk } from "./model-rewrite.ts"
import { resolveModel } from "./resolve.ts"
import { extractSessionInfo } from "./session.ts"

export interface ExecutionInput {
  /** Entry protocol (handler type), passed to executors as `sourceFormat`. */
  readonly entryProtocol: Format
  /** Response protocol when it differs from the entry protocol. */
  readonly responseFormat?: Format
  /** Model string as sent by the client. */
  readonly model: string
  /** Body to execute (entry-protocol format). */
  readonly body: Json
  /** The client's body before handler rewrites (defaults to `body`). */
  readonly originalRequest?: Json
  readonly alt: string
  readonly request: HttpServerRequest.HttpServerRequest
  readonly allowImageModel?: boolean
  readonly allowSpeechModel?: boolean
}

export interface ExecutionOutput {
  readonly payload: string
  /** Filtered upstream headers when `passthrough-headers` is enabled. */
  readonly headers: Headers | undefined
}

export interface StreamOutput {
  readonly chunks: Stream.Stream<string, ExecutionError>
  readonly headers: Headers | undefined
}

const stringField = (body: Json, path: string): string | undefined => {
  const value = get(body, path)
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** `requestExecutionMetadata` (subset). `sessionId` is the explicit session identity, when the request carries one. */
export const executionMetadata = (
  input: ExecutionInput,
  callerScope: string,
  requestPath: string,
  headers: Headers,
  sessionId?: string
): ExecutionMetadata => {
  const idempotencyKey = headers.get("idempotency-key") ?? undefined
  const reasoningEffort = stringField(input.body, "reasoning_effort") ?? stringField(input.body, "reasoning.effort")
  return {
    requestPath,
    requestedModel: input.model,
    serviceTier: stringField(input.body, "service_tier") ?? "auto",
    generate: get(input.body, "generate") !== false,
    callerScope,
    ...(idempotencyKey !== undefined && idempotencyKey !== "" ? { idempotencyKey } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(sessionId !== undefined ? { sessionId } : {})
  }
}

/** `enrichAuthSelectionError`: adds providers/model to "no credential" errors. */
export const enrichSelectionError = (
  error: ExecutionError,
  providers: ReadonlyArray<string>,
  model: string
): ExecutionError => {
  if (error.code !== "auth_not_found" && error.code !== "auth_unavailable") return error
  const providerText = providers.length > 0 ? providers.join(",") : "unknown"
  const modelText = model.trim() !== "" ? model.trim() : "unknown"
  const base = error.message.trim() !== "" ? error.message.trim() : "no auth available"
  let message = `${base} (providers=${providerText}, model=${modelText})`
  if (`,${providerText},`.includes(",claude,")) {
    message += "; check Claude auth/key session and cooldown state via /v0/management/auth-files"
  }
  return new ExecutionError({ ...error, message, status: error.status > 0 ? error.status : 503 })
}

const toExecutionError = (cause: Cause.Cause<ExecutionError>): ExecutionError | undefined => {
  const failure = cause.reasons.find(Cause.isFailReason)
  return failure?.error
}

const prepare = Effect.fnUntraced(function* (input: ExecutionInput, stream: boolean) {
  const identity = yield* AccessPrincipal
  const { config } = yield* (yield* ConfigReader).get.pipe(
    Effect.mapError((cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }))
  )
  const resolved = yield* resolveModel(input.model, {
    entryProtocol: input.entryProtocol,
    ...(input.allowImageModel !== undefined ? { allowImageModel: input.allowImageModel } : {}),
    ...(input.allowSpeechModel !== undefined ? { allowSpeechModel: input.allowSpeechModel } : {})
  })
  const url = new URL(input.request.url, "http://localhost")
  const headers = new Headers(input.request.headers as Record<string, string>)
  const originalRequest = input.originalRequest ?? input.body
  const sessionInfo = extractSessionInfo(headers, originalRequest)
  const options: ExecutorOptions = {
    stream,
    alt: input.alt,
    headers,
    query: url.searchParams,
    originalRequest,
    sourceFormat: input.entryProtocol,
    ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
    metadata: executionMetadata(input, identity.callerScope, url.pathname, headers, sessionInfo?.sessionId)
  }
  return {
    config,
    providers: resolved.providers,
    routeModel: resolved.model,
    body: input.body,
    clientModel: input.model,
    options,
    stream,
    principalId: identity.principalId,
    callerScope: identity.callerScope,
    endpoint: `${input.request.method} ${url.pathname}`,
    session:
      sessionInfo === undefined
        ? undefined
        : {
            id: sessionInfo.sessionId,
            ...(sessionInfo.parentSessionId === undefined ? {} : { parentId: sessionInfo.parentSessionId }),
            ...(sessionInfo.isFork ? { isFork: true } : {})
          }
  } satisfies Prepared
})

const upstreamHeaders = (config: Config, headers: Headers): Headers | undefined =>
  config.requests["passthrough-headers"] ? filterUpstreamHeaders(headers) : undefined

/** Final error of a failed execution: selection errors name the providers and model (`enrichAuthSelectionError`). */
const finalError = (prepared: Prepared, error: ExecutionError): ExecutionError =>
  enrichSelectionError(error, prepared.providers, prepared.routeModel)

/** Non-streaming execution (Go `ExecuteWithAuthManager`). */
export const executeNonStream = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared = yield* prepare(input, false)
  const result = yield* conduct(prepared, (attempt) =>
    Effect.gen(function* () {
      const response = yield* attempt.executor.execute(attempt.context, attempt.request, prepared.options)
      yield* attempt.finish(undefined, response.headers)
      return {
        payload:
          attempt.rewriteTo === "" ? response.payload : rewriteResponseModel(response.payload, attempt.rewriteTo),
        headers: upstreamHeaders(prepared.config, response.headers)
      } satisfies ExecutionOutput
    })
  )
  if (!result.ok) return yield* finalError(prepared, result.error)
  return result.value
})

/** Reads until the first non-empty chunk (`readStreamBootstrap`). `closed` = the stream ended. */
const readBootstrap = (pull: Pull.Pull<ReadonlyArray<string>, ExecutionError>) =>
  Effect.gen(function* () {
    const buffered: string[] = []
    let received = false
    while (true) {
      const next = yield* pull.pipe(
        Effect.map((chunk) => ({ closed: false, chunk }) as const),
        Pull.catchDone(() => Effect.succeed({ closed: true, chunk: [] as ReadonlyArray<string> } as const))
      )
      if (next.closed) return { buffered, closed: true, received }
      received = true
      buffered.push(...next.chunk)
      if (next.chunk.some((text) => text !== "")) return { buffered, closed: false, received }
    }
  })

/**
 * One streaming attempt: opens the stream and waits for the first payload. Failures before it are failovers; after it
 * the stream is handed to the client and the attempt is reported when the stream ends (Go `wrapStreamResult`).
 */
const runStreamAttempt = (prepared: Prepared, attempt: Attempt) =>
  Effect.gen(function* () {
    const result = yield* attempt.executor.executeStream(attempt.context, attempt.request, prepared.options)
    // The pull lives in a child of the request scope: failed attempts close it, the winner stays open until the
    // response body is consumed.
    const parent = yield* Scope.Scope
    const child = Scope.forkUnsafe(parent)
    const pull = yield* Stream.toPull(result.chunks).pipe(Scope.provide(child))
    const abandon = Scope.close(child, Exit.void)
    const boot = yield* readBootstrap(pull).pipe(
      Effect.tapError(() => Effect.sync(() => (attempt.bootstrapFailed = true)).pipe(Effect.andThen(abandon)))
    )
    if (boot.closed && !boot.received) {
      attempt.bootstrapFailed = true
      yield* abandon
      return yield* new ExecutionError({
        status: 500,
        code: "empty_stream",
        message: "upstream stream closed before first payload"
      })
    }

    const services = yield* Effect.context<WorkerEnv>()
    const target = attempt.rewriteTo
    const rest = boot.closed ? Stream.empty : Stream.fromPull(Effect.succeed(pull))
    const chunks = Stream.concat(Stream.fromIterable(boot.buffered), rest).pipe(
      Stream.map((text) => (target === "" ? text : rewriteStreamChunk(text, target))),
      Stream.onExit((exit) => {
        const failure = Exit.isFailure(exit) ? toExecutionError(exit.cause) : undefined
        const interrupted = Exit.isFailure(exit) && failure === undefined
        return attempt
          .finish(interrupted ? lifecycleError() : failure, result.headers)
          .pipe(Effect.provideContext(services))
      })
    )
    return { chunks, headers: upstreamHeaders(prepared.config, result.headers) } satisfies StreamOutput
  })

/** `bootstrapEligible`: errors before the first byte that a fresh attempt may overcome. */
const bootstrapEligible = (status: number): boolean =>
  status === 0 || [401, 402, 403, 408, 429].includes(status) || status >= 500

/**
 * Streaming execution (Go `ExecuteStreamWithAuthManager`). Failover across credentials happens only before the first
 * payload chunk; `requests.streaming.bootstrap-retries` repeats the whole execution for bootstrap failures.
 */
export const executeStream = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared = yield* prepare(input, true)
  const maxBootstrapRetries = Math.max(0, prepared.config.requests.streaming["bootstrap-retries"])
  for (let retries = 0; ; retries += 1) {
    const result = yield* conduct(prepared, (attempt) => runStreamAttempt(prepared, attempt))
    if (result.ok) return result.value
    if (!result.bootstrap || retries >= maxBootstrapRetries || !bootstrapEligible(result.error.status)) {
      return yield* finalError(prepared, result.error)
    }
  }
})
