/**
 * Claude (Anthropic Messages) provider executor: OAuth tokens and API keys, Messages and count_tokens.
 *
 * Go source: internal/runtime/executor/claude_executor.go, claude_executor_execute.go, claude_executor_stream.go,
 * claude_executor_tokens.go, claude_executor_fast_error.go. The request is built by `pipeline.ts`; this module does
 * the HTTP exchange, error classification and response translation.
 *
 * Not ported (documented in docs/workers-port/ARCHITECTURE.md): the uTLS/header-order fingerprint (impossible with
 * Workers `fetch`, see workers/README.md), Thread continuation alias state, the device-profile stabiliser, the
 * Responses compaction bridge (`responses/compact` answers 501), proxies and OAuth refresh (OAuth slice).
 */
import { Clock, Effect, Stream } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { asInt, get, type Json, type JsonObject, tryParseJson } from "../../json/index.ts"
import { splitLines } from "../../http/sse.ts"
import { builtinTranslators } from "../../translator/builtin.ts"
import { Formats } from "../../translator/formats.ts"
import { makeTranslationState, type ResponseContext, type TranslatorRegistry } from "../../translator/registry.ts"
import { responseModelOf } from "../../usage/record.ts"
import { ExecutionError, headersRecord } from "../errors.ts"
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  type ExecutorResponse,
  type ProviderExecutor,
  responseFormatOf,
  type StreamResult
} from "../types.ts"
import { isObj, str } from "../../translator/common/gjson.ts"
import { claudeCreds, isAnthropicUpstreamBase } from "./credentials.ts"
import { type ContinuityStore, makeMemoryContinuityStore } from "./continuity.ts"
import { type ClaudeUpstreamProfile, restoreResponseModel } from "./profile.ts"
import { restoreToolNamesInResponse, AliasRestoreError, restoreToolNamesInStreamLine } from "./mcp-alias.ts"
import {
  type PipelineServices,
  prepareCountTokensRequest,
  prepareLocalCountBody,
  prepareMessagesRequest,
  type PreparedClaudeRequest
} from "./pipeline.ts"
import { classifyUpstreamError, headersIndicateUnifiedRejection, parseRateLimitResetMs } from "./ratelimit.ts"
import { ClaudeStreamReader, TOOL_INPUT_ERROR_MESSAGE, validateClaudeStreamingResponse } from "./stream.ts"
import {
  makeMemoryReplayStore,
  replayContentIsReplayable,
  replayScopeValid,
  type ThinkingReplayStore
} from "./thinking-replay.ts"
import { countInputTokens } from "./tokens.ts"
import { mergeUsage, parseClaudeStreamUsage, parseClaudeUsage } from "./usage.ts"
import type { UsageDetail } from "../../usage/record.ts"

const defaultContinuity = makeMemoryContinuityStore()
const defaultReplay = makeMemoryReplayStore()

export interface ClaudeExecutorOptions {
  readonly translators?: TranslatorRegistry
  readonly continuity?: ContinuityStore
  readonly replay?: ThinkingReplayStore
  /** Injected clock for date reminders (tests). */
  readonly now?: () => Date
  /** Delegating provider profile (Kimi embeds this executor with its own model naming). */
  readonly profile?: ClaudeUpstreamProfile
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({ status: 500, message: `upstream request failed: ${error.reason._tag}`, cause: error })

const readError = (error: unknown) =>
  new ExecutionError({ status: 502, message: `claude executor: failed to read upstream response: ${String(error)}` })

const gatewayError = (message: string) => new ExecutionError({ status: 502, message })

const responseContext = (
  request: ExecutorRequest,
  options: ExecutorOptions,
  prepared: { readonly translatedRequest: JsonObject }
): ResponseContext => ({
  model: request.model,
  originalRequest: options.originalRequest ?? request.payload,
  translatedRequest: prepared.translatedRequest,
  state: makeTranslationState()
})

/** Copies an error with changed flags (`ExecutionError` fields such as `message` are not enumerable). */
const copyError = (
  error: ExecutionError,
  patch: { credentialScoped?: boolean; requestScoped?: boolean }
): ExecutionError =>
  new ExecutionError({
    status: error.status,
    message: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.credentialScoped !== undefined ? { credentialScoped: error.credentialScoped } : {}),
    ...(error.requestScoped !== undefined ? { requestScoped: error.requestScoped } : {}),
    ...(error.terminalAuth !== undefined ? { terminalAuth: error.terminalAuth } : {}),
    ...(error.direct !== undefined ? { direct: error.direct } : {}),
    ...(error.headers !== undefined ? { headers: error.headers } : {}),
    ...(error.safeHeaders !== undefined ? { safeHeaders: error.safeHeaders } : {}),
    ...patch
  })

/** The upstream non-2xx answer as an `ExecutionError` (Fast mode answers pass through unchanged). */
const upstreamFailure = (
  context: ExecutionContext,
  fastRequest: boolean,
  status: number,
  headers: Headers,
  body: string,
  now: number
): ExecutionError => {
  const modelLevelCooling = context.config.upstream.claude["model-level-cooling"]
  const classified = classifyUpstreamError(status, headers, body, modelLevelCooling, now)
  if (fastRequest) {
    const direct = new Headers(headers)
    direct.delete("content-encoding")
    direct.delete("content-length")
    const credentialScoped = status === 429 && headersIndicateUnifiedRejection(headers)
    const retryAfterMs = status === 429 ? parseRateLimitResetMs(headers, now) : undefined
    return new ExecutionError({
      status,
      message: body,
      direct: true,
      headers: headersRecord(direct),
      requestScoped: !credentialScoped,
      ...(credentialScoped ? { credentialScoped: true } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
    })
  }
  // A rejected token (401) concerns the credential, not the request: the conductor refreshes or rotates it.
  if (status === 401 && classified.credentialScoped === undefined) {
    return copyError(classified, { credentialScoped: true })
  }
  return classified
}

export const makeClaudeExecutor = (executorOptions: ClaudeExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators
  const services: PipelineServices = {
    registry,
    continuity: executorOptions.continuity ?? defaultContinuity,
    replay: executorOptions.replay ?? defaultReplay,
    now: executorOptions.now ?? (() => new Date()),
    profile: executorOptions.profile
  }
  const profile = executorOptions.profile

  const unsupportedCompaction = (options: ExecutorOptions) =>
    options.alt === "responses/compact"
      ? Effect.fail(
          new ExecutionError({
            status: 501,
            message: "responses/compact is not supported by the claude executor yet",
            requestScoped: true
          })
        )
      : Effect.void

  /** Sends a prepared request; non-2xx answers become classified `ExecutionError`s. */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    prepared: { readonly url: string; readonly headers: Record<string, string>; readonly bodyText: string },
    fastRequest: boolean
  ) {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(prepared.url).pipe(
      HttpClientRequest.bodyText(prepared.bodyText, "application/json"),
      HttpClientRequest.setHeaders(prepared.headers)
    )
    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(httpRequest)
      .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.mapError(transportError))
    context.usage.markFirstByte(yield* Clock.currentTimeMillis)
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((value) => value)
      )
      const headers = new Headers(response.headers)
      context.usage.fail(response.status, text)
      return yield* upstreamFailure(
        context,
        fastRequest,
        response.status,
        headers,
        text,
        yield* Clock.currentTimeMillis
      )
    }
    return response
  })

  const finishReplay = (prepared: PreparedClaudeRequest, content: Json | undefined): void => {
    const scope = prepared.replay
    if (!replayScopeValid(scope) || !scope.cacheReady) return
    if (content !== undefined && replayContentIsReplayable(content)) {
      services.replay.replaceIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot, content)
    } else {
      services.replay.deleteIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot)
    }
  }

  const commitContinuity = (prepared: PreparedClaudeRequest, messageId: string, requestId: string): void => {
    if (prepared.continuityKey !== "" && messageId !== "") {
      services.continuity.commit(prepared.continuityKey, messageId, requestId, prepared.promptId)
    }
  }

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    yield* unsupportedCompaction(options)
    const responseFormat = responseFormatOf(options)
    const upstreamStream = responseFormat !== Formats.Claude
    const prepared = yield* prepareMessagesRequest({
      services,
      config: context.config,
      credential: context.credential,
      request,
      options,
      upstreamStream
    })
    const response = yield* send(context, prepared, prepared.fastRequest)
    let data = yield* response.text.pipe(Effect.mapError(readError))
    const requestId = response.headers["request-id"] ?? ""
    let usage: UsageDetail | undefined
    let replayContent: Json | undefined
    if (upstreamStream) {
      const invalid = validateClaudeStreamingResponse(data)
      if (invalid !== undefined) return yield* gatewayError(invalid)
      const reader = new ClaudeStreamReader({
        registry,
        responseFormat: Formats.Claude,
        context: responseContext(request, options, prepared),
        reverseMap: prepared.reverseMap,
        onUsage: (detail) => {
          usage = detail
        },
        onResponseModel: (model) => context.usage.observeResponseModel(model)
      })
      const lines = data.split("\n")
      const restored = yield* Effect.try({
        try: () =>
          lines.map((line) => {
            reader.accumulator.observe(line)
            const parsed = parseClaudeStreamUsage(line)
            if (parsed !== undefined) usage = mergeUsage(usage, parsed)
            context.usage.observeResponseModel(
              responseModelOf(tryParseJson(line.trim().startsWith("data:") ? line.trim().slice(5).trim() : ""))
            )
            return restoreResponseModel(profile, restoreToolNamesInStreamLine(line, prepared.reverseMap), request.model)
          }),
        catch: (error) =>
          error instanceof AliasRestoreError
            ? new ExecutionError({
                status: 500,
                message: `restore Claude OAuth tool name from streaming response: ${error.message}`,
                requestScoped: true
              })
            : readError(error)
      })
      data = restored.join("\n")
      const message = lines
        .map((line) => tryParseJson(line.trim().startsWith("data:") ? line.trim().slice(5).trim() : ""))
        .find((payload) => str(get(payload, "type")) === "message_start")
      commitContinuity(prepared, str(get(message, "message.id")).trim(), requestId)
      replayContent = reader.accumulator.content()
    } else {
      const parsed = tryParseJson(data)
      context.usage.observeResponseModel(responseModelOf(parsed))
      commitContinuity(prepared, str(get(parsed, "id")).trim(), requestId)
      if (prepared.reverseMap.size > 0 && isObj(parsed)) {
        yield* Effect.try({
          try: () => restoreToolNamesInResponse(parsed, prepared.reverseMap),
          catch: (error) =>
            new ExecutionError({
              status: 500,
              message: `restore Claude OAuth tool name from response: ${error instanceof Error ? error.message : String(error)}`,
              requestScoped: true
            })
        })
        data = JSON.stringify(parsed)
      }
      data = restoreResponseModel(profile, data, request.model)
      usage = parseClaudeUsage(data)
      replayContent = get(parsed, "content")
    }
    finishReplay(prepared, replayContent)
    const out = registry.translateNonStream(
      responseFormat,
      Formats.Claude,
      responseContext(request, options, prepared),
      data
    )
    if (out === undefined || out === "") return yield* gatewayError(TOOL_INPUT_ERROR_MESSAGE)
    if (usage !== undefined) context.usage.publish(usage)
    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    yield* unsupportedCompaction(options)
    const responseFormat = responseFormatOf(options)
    const prepared = yield* prepareMessagesRequest({
      services,
      config: context.config,
      credential: context.credential,
      request,
      options,
      upstreamStream: true
    })
    const response = yield* send(context, prepared, prepared.fastRequest)
    const requestId = response.headers["request-id"] ?? ""
    const reader = new ClaudeStreamReader({
      registry,
      responseFormat,
      context: responseContext(request, options, prepared),
      reverseMap: prepared.reverseMap,
      restoreLine: (line) => restoreResponseModel(profile, line, request.model),
      onUsage: (detail) => context.usage.publish(detail),
      onResponseModel: (model) => context.usage.observeResponseModel(model)
    })
    const wrap = (error: ExecutionError): ExecutionError =>
      prepared.fastRequest && !error.direct
        ? copyError(error, { requestScoped: error.credentialScoped !== true })
        : error
    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccum(
        () => reader,
        (state, line: string) => [state, [state.push(line)]] as const,
        { onHalt: (state) => [state.end()] }
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks)
        if (step.error === undefined) return emitted
        const error = wrap(step.error)
        context.usage.fail(error.status, error.message)
        return Stream.concat(emitted, Stream.fail(error))
      }),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message))),
      Stream.onExit((exit) =>
        Effect.sync(() => {
          if (exit._tag === "Success" && reader.completed) {
            commitContinuity(prepared, reader.messageId, requestId)
            finishReplay(prepared, reader.accumulator.content())
          } else {
            finishReplay(prepared, undefined)
          }
        })
      )
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const responseFormat = responseFormatOf(options)
    const { apiKey, baseURL } = claudeCreds(context.credential)
    const input = {
      services,
      config: context.config,
      credential: context.credential,
      request,
      options,
      upstreamStream: false
    }
    if (
      apiKey.trim() !== "" &&
      (profile?.upstreamCountTokens === true ||
        isAnthropicUpstreamBase(baseURL === "" ? "https://api.anthropic.com" : baseURL))
    ) {
      const prepared = yield* prepareCountTokensRequest(input)
      const response = yield* send(context, prepared, false)
      const data = yield* response.text.pipe(Effect.mapError(readError))
      const count = asInt(get(tryParseJson(data), "input_tokens"))
      const out = registry.translateTokenCount(responseFormat, Formats.Claude, count, data)
      return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
    }
    const body = yield* prepareLocalCountBody(input)
    const count = countInputTokens(body)
    const out = registry.translateTokenCount(
      responseFormat,
      Formats.Claude,
      count,
      JSON.stringify({ input_tokens: count })
    )
    return { payload: out, headers: new Headers() } satisfies ExecutorResponse
  })

  return { identifier: "claude", execute, executeStream, countTokens }
}
