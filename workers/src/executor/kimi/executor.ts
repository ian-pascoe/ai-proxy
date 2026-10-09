/**
 * Kimi (Moonshot "Kimi Code") executor: OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.
 *
 * Go source: internal/runtime/executor/kimi_executor.go (Execute, ExecuteStream, executeResponses,
 * executeResponsesStream, CountTokens), kimi_thinking_replay.go, helps/kimi_responses.go. Routing by the client's
 * protocol: Claude -> the embedded Claude executor (`executor/claude`, profile with Kimi model naming, Messages base
 * URL, no Claude Code attribution, thinking replay), OpenAI Responses -> `{base}/v1/responses` (body kept as is),
 * everything else -> `{base}/v1/chat/completions`. Order inside the Chat/Responses paths: translate -> upstream
 * model -> thinking -> shaping -> payload rules (final barrier) -> fetch.
 *
 * Not ported: the apply_patch bridge, multi-agent-v2 rewriting, outbound proxies. The token refresh runs in the
 * ControlPlane (credentials/refresh/kimi.ts); 401 recovery is done by the conductor.
 */
import { Clock, Effect, Stream } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { splitLines } from "../../http/sse.ts"
import { asString, cloneJson, get, type Json, set, tryParseJson } from "../../json/index.ts"
import { builtinTranslators } from "../../translator/builtin.ts"
import { Formats } from "../../translator/formats.ts"
import { makeTranslationState, type ResponseContext, type TranslatorRegistry } from "../../translator/registry.ts"
import {
  parseOpenAIStreamUsage,
  parseOpenAIUsage,
  responseModelOf,
  ssePayloadObject,
  type UsageDetail
} from "../../usage/record.ts"
import { makeClaudeExecutor } from "../claude/executor.ts"
import type { ThinkingReplayStore } from "../claude/thinking-replay.ts"
import { ensureResponsesUsageDetails, parseCodexUsage } from "../codex/output.ts"
import { setIfDifferent } from "../codex/request.ts"
import { ExecutionError } from "../errors.ts"
import { finalizePayload } from "../helps/payload.ts"
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts"
import { parseSuffix } from "../suffix.ts"
import { Thinking } from "../thinking.ts"
import {
  type ExecutionContext,
  type ExecutorOptions,
  type ExecutorRequest,
  type ExecutorResponse,
  type ProviderExecutor,
  responseFormatOf,
  type StreamResult
} from "../types.ts"
import { kimiHeaders } from "./headers.ts"
import { kimiChatUrl, kimiClaudeBaseUrl, kimiResponsesUrl, kimiToken, normalizeKimiUpstreamModel } from "./model.ts"
import {
  cacheReplay,
  clearReplay,
  makeKimiReplayStore,
  prepareKimiReplay,
  shouldClearAfterError,
  wrapReplayStream
} from "./replay.ts"
import {
  normalizeKimiResponsesInput,
  normalizeKimiTemperature,
  normalizeKimiTools,
  normalizeKimiToolMessageLinks
} from "./request.ts"

export const KIMI_PROVIDER = "kimi"

export interface KimiExecutorOptions {
  readonly translators?: TranslatorRegistry
  /** Thinking replay store for Claude-format callers (defaults to a per-isolate in-memory store, TTL 1 h). */
  readonly replay?: ThinkingReplayStore
}

const defaultReplay = makeKimiReplayStore()

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error
  })

const badGateway = () => new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })

const usageOf = (text: string): UsageDetail | undefined => {
  const parsed = tryParseJson(text)
  const codex = parseCodexUsage(parsed)
  if (codex !== undefined && (codex.totalTokens > 0 || codex.inputTokens > 0)) return codex
  const openai = parseOpenAIUsage(text)
  return openai.totalTokens > 0 || openai.inputTokens > 0 ? openai : undefined
}

export const makeKimiExecutor = (executorOptions: KimiExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators
  const replayStore = executorOptions.replay ?? defaultReplay
  const claude = makeClaudeExecutor({
    translators: registry,
    profile: { normalizeModel: normalizeKimiUpstreamModel, stripDefaultAttribution: true, upstreamCountTokens: true }
  })

  /** The credential the embedded Claude executor sees: the Messages base (`ResolveKimiClaudeBaseURL`). */
  const claudeContext = (context: ExecutionContext): ExecutionContext => ({
    ...context,
    credential: {
      ...context.credential,
      attributes: { ...context.credential.attributes, base_url: kimiClaudeBaseUrl(context.credential) }
    }
  })

  const responseContext = (request: ExecutorRequest, options: ExecutorOptions, translated: Json): ResponseContext => ({
    model: request.model,
    originalRequest: options.originalRequest ?? request.payload,
    translatedRequest: translated,
    state: makeTranslationState()
  })

  const requestedModel = (request: ExecutorRequest, options: ExecutorOptions): string =>
    options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model

  // -------------------------------------------------------------------------------------------------------------
  // Chat Completions
  // -------------------------------------------------------------------------------------------------------------

  const prepareChat = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean
  ) {
    const thinking = yield* Thinking
    const baseModel = parseSuffix(request.model).modelName
    const from = options.sourceFormat
    const to = Formats.OpenAI
    const translate = (payload: Json) =>
      registry.translateRequest(from, to, { format: from, model: baseModel, stream, body: payload }, thinking.summary)
    const translated = translate(request.payload)
    if (translated.error !== undefined) {
      return yield* new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true
      })
    }
    const original =
      options.originalRequest === undefined || options.originalRequest === request.payload
        ? cloneJson(translated.body)
        : translate(options.originalRequest).body

    let body = set(translated.body, "model", normalizeKimiUpstreamModel(baseModel))
    body = yield* thinking.apply({
      body,
      model: request.model,
      from,
      to: KIMI_PROVIDER,
      provider: KIMI_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup
    })
    if (stream) body = set(body, "stream_options.include_usage", true)
    body = normalizeKimiToolMessageLinks(body)
    body = normalizeKimiTools(body)
    body = normalizeKimiTemperature(body)
    const effort = asString(get(body, "reasoning_effort")) || asString(get(body, "thinking.effort"))
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined)
    const translatedForResponse = cloneJson(body)
    body = finalizePayload(
      context.config,
      KIMI_PROVIDER,
      {
        model: baseModel,
        requestedModel: requestedModel(request, options),
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original
      },
      body
    )
    return { url: kimiChatUrl(context.credential), body, translated: translatedForResponse, to }
  })

  /** POSTs `body`; non-2xx answers carry the upstream body (Go `statusErr`). */
  const post = Effect.fnUntraced(function* (
    context: ExecutionContext,
    url: string,
    body: Json,
    options: ExecutorOptions,
    stream: boolean
  ) {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
      HttpClientRequest.setHeaders(
        kimiHeaders(
          context.credential,
          kimiToken(context.credential),
          stream,
          options.headers,
          options.metadata.sessionId
        )
      )
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.mapError(transportError))
    context.usage.markFirstByte(yield* Clock.currentTimeMillis)
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      context.usage.fail(response.status, text)
      return yield* new ExecutionError({ status: response.status, message: text })
    }
    return response
  })

  const executeChat = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepareChat(context, request, options, false)
    const response = yield* post(context, prepared.url, prepared.body, options, false)
    const data = yield* response.text.pipe(Effect.mapError(transportError))
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)))
    const responseFormat = responseFormatOf(options)
    let out = registry.translateNonStream(
      responseFormat,
      prepared.to,
      responseContext(request, options, prepared.translated),
      data
    )
    if (out === undefined || out === "") return yield* badGateway()
    context.usage.publish(parseOpenAIUsage(data))
    if (responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out)
    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  const executeChatStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepareChat(context, request, options, true)
    const response = yield* post(context, prepared.url, prepared.body, options, true)
    const responseFormat = responseFormatOf(options)
    const state = responseContext(request, options, prepared.translated)
    const translate = (line: string): Stream.Stream<string, ExecutionError> => {
      const chunks = registry.translateStream(responseFormat, prepared.to, state, line)
      const emitted = Stream.fromIterable(chunks)
      return state.state.toolInputError === undefined ? emitted : Stream.concat(emitted, Stream.fail(badGateway()))
    }
    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.tap((line) =>
        Effect.sync(() => {
          const usage = parseOpenAIStreamUsage(line)
          if (usage !== undefined) context.usage.publish(usage)
          context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)))
        })
      ),
      Stream.flatMap(translate),
      Stream.concat(Stream.suspend(() => translate("data: [DONE]"))),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  // -------------------------------------------------------------------------------------------------------------
  // Responses (client protocol openai-response)
  // -------------------------------------------------------------------------------------------------------------

  const prepareResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean
  ) {
    const thinking = yield* Thinking
    const baseModel = parseSuffix(request.model).modelName
    let body = cloneJson(request.payload)
    body = set(body, "model", normalizeKimiUpstreamModel(baseModel))
    body = setIfDifferent(body, "stream", stream)
    body = yield* thinking.apply({
      body,
      model: request.model,
      from: options.sourceFormat,
      to: Formats.Codex,
      provider: KIMI_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup
    })
    body = normalizeKimiResponsesInput(body)
    body = normalizeKimiTools(body)
    body = normalizeKimiTemperature(body)
    const effort = asString(get(body, "reasoning.effort")) || asString(get(body, "thinking.effort"))
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined)
    const translated = cloneJson(body)
    body = finalizePayload(
      context.config,
      KIMI_PROVIDER,
      {
        model: baseModel,
        requestedModel: requestedModel(request, options),
        protocol: Formats.OpenAIResponse,
        fromProtocol: options.sourceFormat,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: request.payload
      },
      body
    )
    return { url: kimiResponsesUrl(context.credential), body, translated }
  })

  const compactUnsupported = (options: ExecutorOptions, stream: boolean) =>
    options.alt === "responses/compact"
      ? Effect.fail(
          new ExecutionError({
            status: stream ? 400 : 501,
            message: stream ? "streaming not supported for /responses/compact" : "/responses/compact not supported",
            requestScoped: true
          })
        )
      : Effect.void

  const executeResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    yield* compactUnsupported(options, false)
    const prepared = yield* prepareResponses(context, request, options, false)
    const response = yield* post(context, prepared.url, prepared.body, options, false)
    const data = yield* response.text.pipe(Effect.mapError(transportError))
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)))
    const responseFormat = responseFormatOf(options)
    let out = data
    if (responseFormat !== Formats.OpenAIResponse) {
      const translated = registry.translateNonStream(
        responseFormat,
        Formats.OpenAIResponse,
        responseContext(request, options, prepared.translated),
        data
      )
      if (translated === undefined || translated === "") return yield* badGateway()
      out = translated
    }
    const usage = usageOf(data)
    if (usage !== undefined) context.usage.publish(usage)
    if (responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out)
    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  const executeResponsesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    yield* compactUnsupported(options, true)
    const prepared = yield* prepareResponses(context, request, options, true)
    const response = yield* post(context, prepared.url, prepared.body, options, true)
    const responseFormat = responseFormatOf(options)
    const state = responseContext(request, options, prepared.translated)
    const emit = (line: string): Stream.Stream<string, ExecutionError> => {
      if (responseFormat === Formats.OpenAIResponse) return Stream.make(`${line}\n`)
      const emitted = Stream.fromIterable(registry.translateStream(responseFormat, Formats.OpenAIResponse, state, line))
      return state.state.toolInputError === undefined ? emitted : Stream.concat(emitted, Stream.fail(badGateway()))
    }
    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.tap((line) =>
        Effect.sync(() => {
          context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)))
          if (!line.startsWith("data:")) return
          const payload = line.slice(5).trim()
          const type = asString(get(tryParseJson(payload), "type"))
          if (type === "response.completed" || type === "response.incomplete" || type === "response.done") {
            const usage = usageOf(payload)
            if (usage !== undefined) context.usage.publish(usage)
          }
        })
      ),
      Stream.flatMap(emit),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  // -------------------------------------------------------------------------------------------------------------
  // Claude Messages (embedded Claude executor)
  // -------------------------------------------------------------------------------------------------------------

  const executeClaude = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const replay = prepareKimiReplay(replayStore, request, options)
    const result = yield* Effect.result(claude.execute(claudeContext(context), replay.request, options))
    if (result._tag === "Failure") {
      if (replay.scope.replayApplied && shouldClearAfterError(result.failure)) clearReplay(replayStore, replay.scope)
      return yield* result.failure
    }
    const content = get(tryParseJson(result.success.payload), "content")
    if (Array.isArray(content)) cacheReplay(replayStore, replay.scope, content)
    return result.success
  })

  const executeClaudeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const replay = prepareKimiReplay(replayStore, request, options)
    const result = yield* Effect.result(claude.executeStream(claudeContext(context), replay.request, options))
    if (result._tag === "Failure") {
      if (replay.scope.replayApplied && shouldClearAfterError(result.failure)) clearReplay(replayStore, replay.scope)
      return yield* result.failure
    }
    return {
      headers: result.success.headers,
      chunks: wrapReplayStream(result.success.chunks, replayStore, replay.scope)
    } satisfies StreamResult
  })

  // -------------------------------------------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------------------------------------------

  const execute: ProviderExecutor["execute"] = (context, request, options) => {
    if (options.sourceFormat === Formats.Claude) return executeClaude(context, request, options)
    if (options.sourceFormat === Formats.OpenAIResponse) return executeResponses(context, request, options)
    return executeChat(context, request, options)
  }

  const executeStream: ProviderExecutor["executeStream"] = (context, request, options) => {
    if (options.sourceFormat === Formats.Claude) return executeClaudeStream(context, request, options)
    if (options.sourceFormat === Formats.OpenAIResponse) return executeResponsesStream(context, request, options)
    return executeChatStream(context, request, options)
  }

  /** Anthropic `count_tokens` through the embedded Claude executor with the Messages base URL. */
  const countTokens: ProviderExecutor["countTokens"] = (context, request, options) =>
    claude.countTokens(claudeContext(context), request, options)

  return { identifier: KIMI_PROVIDER, execute, executeStream, countTokens }
}
