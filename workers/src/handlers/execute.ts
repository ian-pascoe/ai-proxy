/**
 * Shared execution pipeline for all entry protocols: resolve model/providers -> pick credential -> resolve the
 * credential's upstream model -> run the provider executor -> report the attempt -> publish usage.
 *
 * Go source: sdk/api/handlers/handlers_execution.go (ExecuteWithAuthManager, executionErrorMessage),
 * sdk/api/handlers/handlers_stream.go (ExecuteStreamWithAuthManager), sdk/api/handlers/handlers.go
 * (requestExecutionMetadata), sdk/api/handlers/handlers_errors.go (enrichAuthSelectionError),
 * sdk/cliproxy/auth/conductor_execution.go (Execute/ExecuteStream). One attempt per request for now: retries across
 * credentials, cooldown waits and bootstrap retries belong to the execution-retry slice and plug in around
 * {@link runAttempt}.
 */
import { Cause, Clock, Effect, Exit, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"
import { AccessPrincipal } from "../access/principal.ts"
import { ConfigReader } from "../config/reader.ts"
import type { Config } from "../config/schema.ts"
import { ExecutionError } from "../executor/errors.ts"
import { executionModelCandidates } from "../executor/models.ts"
import { CredentialPicker, failedAttempt, type PickResult } from "../executor/picker.ts"
import { ExecutorRegistry } from "../executor/registry.ts"
import { parseSuffix } from "../executor/suffix.ts"
import type { ExecutionMetadata, ExecutorOptions, ExecutorRequest, StreamResult } from "../executor/types.ts"
import { filterUpstreamHeaders } from "../http/headers.ts"
import { get, type Json } from "../json/index.ts"
import type { Format } from "../translator/formats.ts"
import { UsageReporter } from "../usage/reporter.ts"
import type { WorkerEnv } from "../platform/env.ts"
import { UsageSink } from "../usage/sink.ts"
import { resolveModel } from "./resolve.ts"

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

/** `requestExecutionMetadata` (subset; session identity extraction belongs to the conductor slice). */
export const executionMetadata = (
  input: ExecutionInput,
  callerScope: string,
  requestPath: string,
  headers: Headers
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
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
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

interface PreparedAttempt {
  readonly config: Config
  readonly providers: ReadonlyArray<string>
  readonly routeModel: string
  readonly options: ExecutorOptions
  readonly principalId: string
  readonly callerScope: string
  readonly endpoint: string
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
  const options: ExecutorOptions = {
    stream,
    alt: input.alt,
    headers,
    query: url.searchParams,
    originalRequest: input.originalRequest ?? input.body,
    sourceFormat: input.entryProtocol,
    ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
    metadata: executionMetadata(input, identity.callerScope, url.pathname, headers)
  }
  return {
    config,
    providers: resolved.providers,
    routeModel: resolved.model,
    options,
    principalId: identity.principalId,
    callerScope: identity.callerScope,
    endpoint: `${input.request.method} ${url.pathname}`
  } satisfies PreparedAttempt
})

/** Picks a credential and builds everything one upstream attempt needs. */
const runAttempt = Effect.fnUntraced(function* (prepared: PreparedAttempt, input: ExecutionInput, stream: boolean) {
  const picker = yield* CredentialPicker
  const executors = yield* ExecutorRegistry
  const picked: PickResult = yield* picker
    .pick({ providers: prepared.providers, model: prepared.routeModel, callerScope: prepared.callerScope })
    .pipe(Effect.mapError((error) => enrichSelectionError(error, prepared.providers, prepared.routeModel)))
  const { credential } = picked
  const executor = executors.get(credential.provider)
  if (executor === undefined) {
    const error = new ExecutionError({ status: 500, code: "executor_not_found", message: "executor not registered" })
    yield* picker.report(picked.leaseId, failedAttempt(prepared.routeModel, error))
    return yield* error
  }
  const model = executionModelCandidates(prepared.config, credential, prepared.routeModel)[0] ?? prepared.routeModel
  const usage = new UsageReporter({
    requestId: crypto.randomUUID(),
    provider: credential.provider,
    executorType: executor.identifier,
    model: parseSuffix(model).modelName,
    alias: input.model,
    endpoint: prepared.endpoint,
    principalId: prepared.principalId,
    authId: credential.id,
    authType: credential.kind,
    source: credential.label ?? credential.id,
    stream,
    serviceTier: prepared.options.metadata.serviceTier,
    ...(prepared.options.metadata.reasoningEffort !== undefined
      ? { reasoningEffort: prepared.options.metadata.reasoningEffort }
      : {}),
    requestedAt: yield* Clock.currentTimeMillis
  })
  const request: ExecutorRequest = { model, payload: input.body }
  const context = { credential, config: prepared.config, usage }
  return { picked, executor, request, context, usage }
})

const publishUsage = (usage: UsageReporter) =>
  Effect.gen(function* () {
    const record = usage.finish(yield* Clock.currentTimeMillis)
    if (record !== undefined) yield* (yield* UsageSink).publish(record)
  })

const upstreamHeaders = (config: Config, headers: Headers): Headers | undefined =>
  config.requests["passthrough-headers"] ? filterUpstreamHeaders(headers) : undefined

/** Non-streaming execution (Go `ExecuteWithAuthManager`). */
export const executeNonStream = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared = yield* prepare(input, false)
  const attempt = yield* runAttempt(prepared, input, false)
  const picker = yield* CredentialPicker
  const response = yield* attempt.executor.execute(attempt.context, attempt.request, prepared.options).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const error = Exit.isFailure(exit) ? toExecutionError(exit.cause) : undefined
        if (error !== undefined) attempt.usage.fail(error.status, error.message)
        yield* picker.report(
          attempt.picked.leaseId,
          error !== undefined ? failedAttempt(prepared.routeModel, error) : { ok: true, model: prepared.routeModel }
        )
        yield* publishUsage(attempt.usage)
      })
    )
  )
  return {
    payload: response.payload,
    headers: upstreamHeaders(prepared.config, response.headers)
  } satisfies ExecutionOutput
})

/**
 * Streaming execution (Go `ExecuteStreamWithAuthManager`). The attempt is reported and its usage published when the
 * returned chunk stream ends (completion, failure or client abort).
 */
export const executeStream = Effect.fnUntraced(function* (input: ExecutionInput) {
  const prepared = yield* prepare(input, true)
  const attempt = yield* runAttempt(prepared, input, true)
  const picker = yield* CredentialPicker
  const finish = (error: ExecutionError | undefined) =>
    Effect.gen(function* () {
      if (error !== undefined) attempt.usage.fail(error.status, error.message)
      yield* picker.report(
        attempt.picked.leaseId,
        error !== undefined ? failedAttempt(prepared.routeModel, error) : { ok: true, model: prepared.routeModel }
      )
      yield* publishUsage(attempt.usage)
    })
  const result: StreamResult = yield* attempt.executor
    .executeStream(attempt.context, attempt.request, prepared.options)
    .pipe(Effect.tapError((error) => finish(error)))
  const services = yield* Effect.context<UsageSink | CredentialPicker | WorkerEnv>()
  const chunks = result.chunks.pipe(
    Stream.onExit((exit) =>
      finish(Exit.isFailure(exit) ? toExecutionError(exit.cause) : undefined).pipe(Effect.provideContext(services))
    )
  )
  return { chunks, headers: upstreamHeaders(prepared.config, result.headers) } satisfies StreamOutput
})
