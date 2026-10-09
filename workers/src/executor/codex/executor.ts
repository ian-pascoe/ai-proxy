/**
 * Codex (ChatGPT backend Responses API) executor, HTTP/SSE transport.
 *
 * Go source: internal/runtime/executor/codex_executor.go, codex_executor_execute.go (Execute, executeCompact),
 * codex_executor_stream.go (ExecuteStream), codex_executor_request.go (cacheHelper), codex_openai_images.go.
 * Pipeline per attempt (ARCHITECTURE.md): translate -> model rewrite -> thinking -> provider shaping -> input id
 * sanitising -> user payload rules (final barrier) -> upstream fetch -> response translation.
 *
 * Not ported (documented follow-ups): websocket transport (#18), bootstrap buffering and retries (retry slice),
 * multi-agent-v2 rewriting and `is-compat` model handling. `CountTokens` counts locally (`helps/token-count.ts`).
 */
import { Clock, Effect, Stream } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { splitLines } from "../../http/sse.ts"
import { asString, cloneJson, del, get, isJsonObject, type Json, set, tryParseJson } from "../../json/index.ts"
import { builtinTranslators } from "../../translator/builtin.ts"
import { Formats } from "../../translator/formats.ts"
import { makeTranslationState, type ResponseContext, type TranslatorRegistry } from "../../translator/registry.ts"
import { encodingForCodexModel, getCodec } from "../../tokenizer/index.ts"
import { parseOpenAIUsage, responseModelOf } from "../../usage/record.ts"
import { isResponsesTokenEvent } from "../../usage/ttft.ts"
import { ExecutionError, headersRecord } from "../errors.ts"
import { normalizeCodexToolSchemas } from "../helps/codex-tool-schema.ts"
import { sanitizeCodexInputItemIds } from "../helps/codex-input-ids.ts"
import { finalizePayload } from "../helps/payload.ts"
import { buildResponsesUsageJson, countCodexInputTokens } from "../helps/token-count.ts"
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
import {
  codexEmptyIncompleteStreamError,
  codexIncompleteStreamError,
  codexTerminalFailure,
  isThinkingSignatureInvalid,
  newCodexStatusError
} from "./errors.ts"
import { buildCodexHeaders, codexBaseUrl, isNativeCodexRequest } from "./headers.ts"
import {
  buildImagesApiResponse,
  CODEX_IMAGE_SOURCE_FORMAT,
  CODEX_IMAGES_MAIN_MODEL,
  directImageEndpoint,
  directImageModel,
  extractImageResults,
  finishImageResponsesBody,
  imageCompletedFrame,
  imagePartialFrame,
  isCodexImageRequest,
  prepareDirectImageBody,
  prepareImageRequest
} from "./images.ts"
import {
  ensureResponsesUsageDetails,
  hasMeaningfulOutputDelta,
  isTerminalEmptyIncomplete,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput
} from "./output.ts"
import {
  ensureImageGenerationTool,
  normalizeCodexInstructions,
  normalizeParallelToolCalls,
  promptCacheId,
  sanitizeReasoningEncryptedContent,
  setIfDifferent
} from "./request.ts"
import {
  applyReplayCache,
  cacheReplayFromCompleted,
  type CodexReplayScope,
  type CodexReplayStore,
  defaultReplayStore,
  replayScopeFromRequest
} from "./replay.ts"
import { CodexStreamReader } from "./stream.ts"

export const CODEX_PROVIDER = "codex"

export interface CodexExecutorOptions {
  readonly translators?: TranslatorRegistry
  /** Reasoning replay store (defaults to the per-isolate in-memory store, see replay.ts). */
  readonly replayStore?: CodexReplayStore
  /** models.json `config.override_header` lookup (model registry), applied after every other header. */
  readonly modelHeaderOverrides?: (model: string) => Readonly<Record<string, string>> | undefined
}

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error
  })

interface PreparedRequest {
  readonly url: string
  readonly headers: Record<string, string>
  /** Final business payload (after payload rules). */
  readonly body: Json
  readonly baseModel: string
  /** Translated request before provider shaping that depends on the cache id (translator response context). */
  readonly translated: Json
  readonly original: Json | undefined
  readonly replayScope: CodexReplayScope
  readonly responseFormat: string
  readonly providerFormat: string
}

export const makeCodexExecutor = (executorOptions: CodexExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators
  const replayStore = executorOptions.replayStore ?? defaultReplayStore

  const translatePair = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    to: string,
    baseModel: string,
    stream: boolean,
    summary: import("../../translator/registry.ts").SummaryHooks
  ) => {
    const from = options.sourceFormat
    const translated = registry.translateRequest(
      from,
      to,
      { format: from, model: baseModel, stream, body: request.payload },
      summary
    )
    if (translated.error !== undefined) {
      return new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true
      })
    }
    // The payload-rule baseline: the client payload translated without any later mutation.
    const sameSource = options.originalRequest === undefined || options.originalRequest === request.payload
    const original = sameSource
      ? { ...translated, body: cloneJson(translated.body) }
      : registry.translateRequest(
          from,
          to,
          { format: from, model: baseModel, stream, body: options.originalRequest },
          summary
        )
    return { translated, original }
  }

  const finalize = (
    context: ExecutionContext,
    options: ExecutorOptions,
    baseModel: string,
    requestModel: string,
    protocol: string,
    original: Json | undefined,
    body: Json
  ): Json =>
    finalizePayload(
      context.config,
      CODEX_PROVIDER,
      {
        model: baseModel,
        requestedModel: options.metadata.requestedModel !== "" ? options.metadata.requestedModel : requestModel,
        protocol,
        fromProtocol: options.sourceFormat,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        ...(original !== undefined ? { original } : {})
      },
      body
    )

  /** Responses requests (`/responses`) and compaction (`/responses/compact`, target `openai-response`). */
  const prepare = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    mode: { readonly stream: boolean; readonly compact: boolean }
  ) {
    const thinking = yield* Thinking
    const baseModel = parseSuffix(request.model).modelName
    const from = options.sourceFormat
    const to = mode.compact ? Formats.OpenAIResponse : Formats.Codex
    const responseFormat = responseFormatOf(options)
    const pair = translatePair(context, request, options, to, baseModel, mode.stream, thinking.summary)
    if (pair instanceof ExecutionError) return yield* pair
    const { translated, original } = pair
    const nativeOutput = isNativeCodexRequest(request.payload, options.headers, from, responseFormat)

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider: CODEX_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup
    })

    body = setIfDifferent(body, "model", baseModel)
    if (mode.compact) {
      body = del(body, "stream")
    } else {
      body = setIfDifferent(body, "stream", true)
      const summaryDelivery = get(body, "stream_options.reasoning_summary_delivery")
      for (const field of [
        "previous_response_id",
        "generate",
        "prompt_cache_retention",
        "safety_identifier",
        "stream_options"
      ]) {
        body = del(body, field)
      }
      if (mode.stream && summaryDelivery !== undefined)
        body = set(body, "stream_options.reasoning_summary_delivery", summaryDelivery)
    }
    body = normalizeCodexInstructions(body, nativeOutput)
    if (!mode.compact && context.config.multimedia["disable-image-generation"] === false) {
      body = ensureImageGenerationTool(body, baseModel, context.credential, options.headers)
    }
    body = sanitizeReasoningEncryptedContent(body)
    body = normalizeParallelToolCalls(body, options.headers)
    body = normalizeCodexToolSchemas(body)

    const replayScope = mode.compact
      ? { modelName: "", sessionKey: "", requestFingerprint: "" }
      : replayScopeFromRequest({
          from,
          model: request.model,
          requestPayload: request.payload,
          headers: options.headers,
          callerScope: options.metadata.callerScope,
          body
        })
    if (!mode.compact) yield* applyReplayCache(replayStore, replayScope, body)

    const translatedForResponse = cloneJson(body)
    // cacheHelper: prompt cache key, input id sanitising, then the payload rules as the last mutation.
    const cacheId = promptCacheId({
      from,
      model: request.model,
      payload: request.payload,
      body,
      headers: options.headers,
      callerScope: options.metadata.callerScope,
      sessionId: options.metadata.sessionId
    })
    if (cacheId !== "") body = setIfDifferent(body, "prompt_cache_key", cacheId)
    body = sanitizeCodexInputItemIds(body)
    body = finalize(context, options, baseModel, request.model, to, original.body, body)

    const effort = asString(get(body, "reasoning.effort"))
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined)
    const headers = buildCodexHeaders({
      credential: context.credential,
      config: context.config,
      clientHeaders: options.headers,
      stream: !mode.compact,
      ...(cacheId !== "" ? { sessionHeader: cacheId } : {}),
      body,
      baseModel,
      ...(options.metadata.sessionId !== undefined ? { sessionId: options.metadata.sessionId } : {}),
      routingHint: true,
      ...(executorOptions.modelHeaderOverrides?.(baseModel) !== undefined
        ? { modelHeaderOverrides: executorOptions.modelHeaderOverrides(baseModel) as Record<string, string> }
        : {})
    })
    const url = `${codexBaseUrl(context.credential)}${mode.compact ? "/responses/compact" : "/responses"}`
    return {
      url,
      headers,
      body,
      baseModel,
      translated: translatedForResponse,
      original: options.originalRequest ?? request.payload,
      replayScope,
      responseFormat,
      providerFormat: to
    } satisfies PreparedRequest
  })

  /** POSTs `body`; non-2xx answers become classified `ExecutionError`s (the replay cache is cleared when needed). */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    url: string,
    headers: Record<string, string>,
    body: Json,
    replayScope?: CodexReplayScope,
    // Streams mark the effective TTFT on the first token event (usage `observeTokenEvent`), not on the headers.
    ttft: "first-byte" | "token-event" = "first-byte"
  ) {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
      HttpClientRequest.setHeaders(headers)
    )
    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(httpRequest)
      .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.mapError(transportError))
    if (ttft === "token-event") context.usage.recordFirstPacket(yield* Clock.currentTimeMillis)
    else context.usage.markFirstByte(yield* Clock.currentTimeMillis)
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      if (replayScope !== undefined && isThinkingSignatureInvalid(response.status, text)) {
        yield* replayStore.clear(replayScope.modelName, replayScope.sessionKey)
      }
      const error = newCodexStatusError(response.status, text, {
        modelLevelCooling: context.config.upstream.codex["model-level-cooling"],
        nowMs: yield* Clock.currentTimeMillis,
        headers: headersRecord(new Headers(response.headers))
      })
      context.usage.fail(error.status, error.message)
      return yield* error
    }
    return response
  })

  const responseContext = (prepared: PreparedRequest, request: ExecutorRequest): ResponseContext => ({
    model: request.model,
    originalRequest: prepared.original,
    translatedRequest: prepared.translated,
    state: makeTranslationState()
  })

  const failedTranslation = () => new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })

  // -------------------------------------------------------------------------------------------------------------
  // Responses: non-stream (aggregates the upstream SSE until the terminal event)
  // -------------------------------------------------------------------------------------------------------------

  const executeResponses = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepare(context, request, options, { stream: false, compact: false })
    const response = yield* send(context, prepared.url, prepared.headers, prepared.body, prepared.replayScope)
    const text = yield* response.text.pipe(Effect.mapError(transportError))
    const collector = new OutputItemCollector()
    let sawOutputDelta = false
    const modelLevelCooling = context.config.upstream.codex["model-level-cooling"]
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const event = tryParseJson(line.slice(5).trim())
      context.usage.observeResponseModel(responseModelOf(event))
      const eventType = asString(get(event, "type"))
      if (hasMeaningfulOutputDelta(event)) sawOutputDelta = true
      const failure = codexTerminalFailure(event, { modelLevelCooling, nowMs: yield* Clock.currentTimeMillis })
      if (failure !== undefined) {
        if (isThinkingSignatureInvalid(failure.error.status, failure.body)) {
          yield* replayStore.clear(prepared.replayScope.modelName, prepared.replayScope.sessionKey)
        }
        return yield* failure.error
      }
      if (eventType === "response.output_item.done") {
        collector.collect(event)
        continue
      }
      if (eventType !== "response.completed" && eventType !== "response.incomplete") continue
      if (!isJsonObject(event)) continue
      if (isTerminalEmptyIncomplete(event, collector.count, sawOutputDelta))
        return yield* codexEmptyIncompleteStreamError()
      const completed = cloneJson(event)
      if (isJsonObject(completed)) patchCodexCompletedOutput(completed, collector)
      if (eventType === "response.completed")
        yield* cacheReplayFromCompleted(replayStore, prepared.replayScope, completed)
      let out = registry.translateNonStream(
        prepared.responseFormat,
        prepared.providerFormat,
        responseContext(prepared, request),
        JSON.stringify(completed)
      )
      if (out === undefined || out === "") return yield* failedTranslation()
      const detail = parseCodexUsage(event)
      if (detail !== undefined) context.usage.publish(detail)
      if (prepared.responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out)
      return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
    }
    const error = codexIncompleteStreamError()
    context.usage.fail(error.status, error.message)
    return yield* error
  })

  const executeCompact = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepare(context, request, options, { stream: false, compact: true })
    const response = yield* send(context, prepared.url, prepared.headers, prepared.body)
    const text = yield* response.text.pipe(Effect.mapError(transportError))
    let out = registry.translateNonStream(
      prepared.responseFormat,
      prepared.providerFormat,
      responseContext(prepared, request),
      text
    )
    if (out === undefined || out === "") return yield* failedTranslation()
    context.usage.publish(parseOpenAIUsage(text))
    if (prepared.responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out)
    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  // -------------------------------------------------------------------------------------------------------------
  // Responses: stream
  // -------------------------------------------------------------------------------------------------------------

  const executeResponsesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepare(context, request, options, { stream: true, compact: false })
    const response = yield* send(
      context,
      prepared.url,
      prepared.headers,
      prepared.body,
      prepared.replayScope,
      "token-event"
    )
    const reader = new CodexStreamReader({
      registry,
      responseFormat: prepared.responseFormat,
      providerFormat: prepared.providerFormat,
      context: responseContext(prepared, request),
      usage: context.usage,
      preserveNativeOutput: isNativeCodexRequest(
        request.payload,
        options.headers,
        options.sourceFormat,
        prepared.responseFormat
      ),
      modelLevelCooling: context.config.upstream.codex["model-level-cooling"],
      nowMs: () => Date.now(),
      replayScope: prepared.replayScope
    })
    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccumEffect(
        () => reader,
        (state, line: string) =>
          Effect.gen(function* () {
            const step = state.push(line)
            if (step.cacheCompleted !== undefined)
              yield* cacheReplayFromCompleted(replayStore, prepared.replayScope, step.cacheCompleted)
            if (
              step.failureBody !== undefined &&
              isThinkingSignatureInvalid(step.failureBody.status, step.failureBody.body)
            ) {
              yield* replayStore.clear(prepared.replayScope.modelName, prepared.replayScope.sessionKey)
            }
            return [state, [step]] as const
          }),
        { onHalt: (state) => [state.end()] }
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks.filter((chunk) => chunk.length > 0))
        return step.error === undefined ? emitted : Stream.concat(emitted, Stream.fail(step.error))
      }),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  // -------------------------------------------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------------------------------------------

  const imagePlan = (context: ExecutionContext, request: ExecutorRequest, options: ExecutorOptions) => {
    const requestPath = options.metadata.requestPath
    const endpoint = directImageEndpoint(request.payload, request.model, requestPath)
    return { requestPath, endpoint }
  }

  const configuredImageMainModel = (context: ExecutionContext): string => {
    const model = context.config.multimedia["gpt-image-2-base-model"].trim()
    return model !== "" && model.toLowerCase().startsWith("gpt-") ? model : CODEX_IMAGES_MAIN_MODEL
  }

  const prepareDirectImage = (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    endpoint: string,
    stream: boolean
  ) => {
    const model = directImageModel(request.payload, request.model)
    let body = prepareDirectImageBody(request.payload, model, stream)
    body = finalize(
      context,
      { ...options, sourceFormat: CODEX_IMAGE_SOURCE_FORMAT },
      model,
      request.model,
      "openai",
      request.payload,
      body
    )
    const headers = buildCodexHeaders({
      credential: context.credential,
      config: context.config,
      clientHeaders: options.headers,
      stream,
      body,
      baseModel: model,
      omitClientUserAgent: true,
      ...(options.metadata.sessionId !== undefined ? { sessionId: options.metadata.sessionId } : {}),
      ...(executorOptions.modelHeaderOverrides?.(model) !== undefined
        ? { modelHeaderOverrides: executorOptions.modelHeaderOverrides(model) as Record<string, string> }
        : {})
    })
    return { url: `${codexBaseUrl(context.credential)}${endpoint}`, headers, body, model }
  }

  const prepareToolImage = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const thinking = yield* Thinking
    const prepared = prepareImageRequest(request.payload, request.model, options.metadata.requestPath)
    if (typeof prepared === "string") {
      return yield* new ExecutionError({ status: 400, message: prepared, requestScoped: true })
    }
    const mainModel = configuredImageMainModel(context)
    const source = cloneJson(prepared.body)
    let body = yield* thinking.apply({
      body: prepared.body,
      model: mainModel,
      from: CODEX_IMAGE_SOURCE_FORMAT,
      to: Formats.Codex,
      provider: CODEX_PROVIDER,
      source
    })
    body = finishImageResponsesBody(body, mainModel)
    const cacheId = promptCacheId({
      from: CODEX_IMAGE_SOURCE_FORMAT,
      model: request.model,
      payload: request.payload,
      body,
      headers: options.headers,
      callerScope: options.metadata.callerScope,
      sessionId: options.metadata.sessionId
    })
    if (cacheId !== "") body = setIfDifferent(body, "prompt_cache_key", cacheId)
    body = sanitizeCodexInputItemIds(body)
    body = finalize(
      context,
      { ...options, sourceFormat: CODEX_IMAGE_SOURCE_FORMAT },
      mainModel,
      request.model,
      Formats.Codex,
      source,
      body
    )
    const headers = buildCodexHeaders({
      credential: context.credential,
      config: context.config,
      clientHeaders: options.headers,
      stream: true,
      ...(cacheId !== "" ? { sessionHeader: cacheId } : {}),
      body,
      baseModel: mainModel,
      ...(options.metadata.sessionId !== undefined ? { sessionId: options.metadata.sessionId } : {}),
      ...(executorOptions.modelHeaderOverrides?.(mainModel) !== undefined
        ? { modelHeaderOverrides: executorOptions.modelHeaderOverrides(mainModel) as Record<string, string> }
        : {})
    })
    return { url: `${codexBaseUrl(context.credential)}/responses`, headers, body, image: prepared }
  })

  const executeImage = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const { endpoint } = imagePlan(context, request, options)
    if (endpoint !== "") {
      const direct = prepareDirectImage(context, request, options, endpoint, false)
      const response = yield* send(context, direct.url, direct.headers, direct.body)
      const text = yield* response.text.pipe(Effect.mapError(transportError))
      context.usage.publish(parseOpenAIUsage(text))
      return { payload: text, headers: new Headers(response.headers) } satisfies ExecutorResponse
    }
    const tool = yield* prepareToolImage(context, request, options)
    const response = yield* send(context, tool.url, tool.headers, tool.body)
    const text = yield* response.text.pipe(Effect.mapError(transportError))
    const collector = new OutputItemCollector()
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const event = tryParseJson(line.slice(5).trim())
      context.usage.observeResponseModel(responseModelOf(event))
      const eventType = asString(get(event, "type"))
      if (eventType === "response.output_item.done") collector.collect(event)
      else if (eventType === "response.completed" && event !== undefined) {
        const detail = parseCodexUsage(event)
        if (detail !== undefined) context.usage.publish(detail)
        const extracted = extractImageResults(event, collector, Math.floor((yield* Clock.currentTimeMillis) / 1000))
        if (extracted.results.length === 0) {
          return yield* new ExecutionError({ status: 502, message: "upstream did not return image output" })
        }
        return {
          payload: buildImagesApiResponse(extracted, tool.image.responseFormat),
          headers: new Headers(response.headers)
        } satisfies ExecutorResponse
      }
    }
    return yield* new ExecutionError({ status: 504, message: "stream error: stream disconnected before completion" })
  })

  const executeImageStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const { endpoint } = imagePlan(context, request, options)
    if (endpoint !== "") {
      const direct = prepareDirectImage(context, request, options, endpoint, true)
      const response = yield* send(context, direct.url, direct.headers, direct.body, undefined, "token-event")
      const chunks = response.stream.pipe(Stream.decodeText, Stream.mapError(transportError))
      return { headers: new Headers(response.headers), chunks } satisfies StreamResult
    }
    const tool = yield* prepareToolImage(context, request, options)
    const response = yield* send(context, tool.url, tool.headers, tool.body, undefined, "token-event")
    const collector = new OutputItemCollector()
    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccumEffect(
        () => false,
        (done, line: string) =>
          Effect.gen(function* () {
            if (done || !line.startsWith("data:")) return [done, [] as string[]] as const
            const event = tryParseJson(line.slice(5).trim())
            context.usage.observeResponseModel(responseModelOf(event))
            if (!context.usage.ttftObserved) {
              context.usage.observeTokenEvent(yield* Clock.currentTimeMillis, isResponsesTokenEvent(line))
            }
            switch (asString(get(event, "type"))) {
              case "response.output_item.done":
                collector.collect(event)
                break
              case "response.image_generation_call.partial_image": {
                const frame = imagePartialFrame(event as Json, tool.image.responseFormat, tool.image.streamPrefix)
                return [done, frame === undefined ? [] : [frame]] as const
              }
              case "response.completed": {
                const detail = parseCodexUsage(event)
                if (detail !== undefined) context.usage.publish(detail)
                const extracted = extractImageResults(
                  event as Json,
                  collector,
                  Math.floor((yield* Clock.currentTimeMillis) / 1000)
                )
                if (extracted.results.length === 0) {
                  return yield* new ExecutionError({ status: 502, message: "upstream did not return image output" })
                }
                return [
                  true,
                  extracted.results.map((image) =>
                    imageCompletedFrame(image, extracted.usage, tool.image.responseFormat, tool.image.streamPrefix)
                  )
                ] as const
              }
            }
            return [done, [] as string[]] as const
          })
      ),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  // -------------------------------------------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------------------------------------------

  const execute: ProviderExecutor["execute"] = (context, request, options) => {
    if (options.alt === "responses/compact") return executeCompact(context, request, options)
    if (isCodexImageRequest(options.sourceFormat, options.metadata.requestPath))
      return executeImage(context, request, options)
    return executeResponses(context, request, options)
  }

  const executeStream: ProviderExecutor["executeStream"] = (context, request, options) => {
    if (options.alt === "responses/compact") {
      return Effect.fail(new ExecutionError({ status: 400, message: "streaming not supported for /responses/compact" }))
    }
    if (isCodexImageRequest(options.sourceFormat, options.metadata.requestPath)) {
      return executeImageStream(context, request, options)
    }
    return executeResponsesStream(context, request, options)
  }

  /**
   * `CountTokens`: the request is shaped like `prepare` up to the payload rules (no replay, cache key, image tool or
   * schema normalisation), then counted locally with the model's BPE encoding.
   */
  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const thinking = yield* Thinking
    const baseModel = parseSuffix(request.model).modelName
    const from = options.sourceFormat
    const to = Formats.Codex
    const responseFormat = responseFormatOf(options)
    const pair = translatePair(context, request, options, to, baseModel, false, thinking.summary)
    if (pair instanceof ExecutionError) return yield* pair
    const { translated, original } = pair

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider: CODEX_PROVIDER,
      source: request.payload,
      ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup
    })
    body = setIfDifferent(body, "model", baseModel)
    for (const field of [
      "previous_response_id",
      "generate",
      "prompt_cache_retention",
      "safety_identifier",
      "stream_options"
    ]) {
      body = del(body, field)
    }
    body = setIfDifferent(body, "stream", false)
    body = normalizeCodexInstructions(
      body,
      isNativeCodexRequest(request.payload, options.headers, from, responseFormat)
    )
    body = finalize(context, options, baseModel, request.model, to, original.body, body)

    const count = countCodexInputTokens(getCodec(encodingForCodexModel(baseModel)), body)
    return {
      payload: registry.translateTokenCount(responseFormat, to, count, buildResponsesUsageJson(count)),
      headers: new Headers()
    } satisfies ExecutorResponse
  })

  return { identifier: CODEX_PROVIDER, execute, executeStream, countTokens }
}
