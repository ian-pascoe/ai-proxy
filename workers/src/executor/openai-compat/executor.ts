/**
 * Executor for OpenAI-compatible upstreams (`api-keys.openai-compatibility`).
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (Execute, ExecuteStream, CountTokens,
 * resolveCredentials, applyPromptCacheKey, newOpenAICompatStatusError). Per attempt: translate the client body to
 * Chat Completions -> thinking -> max-token field normalisation -> prompt cache key -> `stream_options.include_usage`
 * (stream) -> user payload rules (final semantic mutation) -> POST `{base-url}/chat/completions`.
 *
 * Images (`openai-image` source format) take the `executeImages` path below: the body is forwarded to
 * `{base-url}/images/generations|edits` (see `images.ts`).
 *
 * `CountTokens` counts locally with the model's BPE encoding (`helps/token-count.ts`).
 *
 * Not ported yet (later slices): `/responses/compact` (Responses slice), the text-only tool-result normalisation for models whose `input-modalities` exclude
 * images, and derived prompt cache keys (session identity lives in the conductor slice; a client-supplied
 * `prompt_cache_key` is honoured).
 */
import { Clock, Effect, Stream } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { get, type Json, type JsonObject, set, tryParseJson } from "../../json/index.ts"
import { splitLines } from "../../http/sse.ts"
import { builtinTranslators } from "../../translator/builtin.ts"
import { EntryOnlyFormats, Formats } from "../../translator/formats.ts"
import { makeTranslationState, type ResponseContext, type TranslatorRegistry } from "../../translator/registry.ts"
import { encodingForModel, getCodec } from "../../tokenizer/index.ts"
import { parseOpenAIStreamUsage, parseOpenAIUsage, responseModelOf, ssePayloadObject } from "../../usage/record.ts"
import { ExecutionError, headersRecord } from "../errors.ts"
import { ensureResponsesUsageDetails } from "../codex/output.ts"
import { applyCustomHeaders } from "../helps/custom-headers.ts"
import { finalizePayload } from "../helps/payload.ts"
import {
  normalizeOpenAIMaxTokens,
  setBoolIfDifferent,
  shouldUseMaxCompletionTokens
} from "../helps/openai-compat-models.ts"
import { openAICompatRetryAfterMs } from "../helps/retry-after.ts"
import { buildOpenAIUsageJson, countOpenAIChatTokens } from "../helps/token-count.ts"
import { resolveCompatConfig } from "../models.ts"
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
import { compatImageEndpointPath, editBodyToFormData, prepareCompatImagesBody, wantsMultipartEdit } from "./images.ts"
import { OpenAICompatStreamReader, TOOL_INPUT_ERROR_MESSAGE } from "./stream.ts"

const USER_AGENT = "cli-proxy-openai-compat"
const CHAT_COMPLETIONS_PATH = "/chat/completions"

interface PreparedRequest {
  readonly url: string
  readonly headers: Record<string, string>
  /** Final business payload (after payload rules). */
  readonly body: Json
  readonly baseModel: string
  /** Multipart form sent instead of `body` (image edits uploaded as multipart by the client). */
  readonly form?: FormData
}

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error
  })

/** `resolveCredentials`: trimmed `base_url` and `api_key` attributes. */
const credentialEndpoint = (context: ExecutionContext) => ({
  baseURL: (context.credential.attributes["base_url"] ?? "").trim(),
  apiKey: (context.credential.attributes["api_key"] ?? "").trim()
})

/** `applyPromptCacheKey` (client-supplied keys only, see module docs). */
const applyPromptCacheKey = (
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  translated: Json
): Json => {
  const group = resolveCompatConfig(context.config, context.credential)
  if (group?.["support-prompt-cache-key"] !== true) return translated
  for (const payload of [request.payload, options.originalRequest, translated]) {
    const value = get(payload, "prompt_cache_key")
    const key = typeof value === "string" ? value.trim() : ""
    if (key !== "")
      return get(translated, "prompt_cache_key") === key ? translated : set(translated, "prompt_cache_key", key)
  }
  return translated
}

const responseContext = (request: ExecutorRequest, options: ExecutorOptions, translated: Json): ResponseContext => ({
  model: request.model,
  originalRequest: options.originalRequest ?? request.payload,
  translatedRequest: translated,
  state: makeTranslationState()
})

export interface OpenAICompatExecutorOptions {
  /** Translator registry (defaults to the built-in one). */
  readonly translators?: TranslatorRegistry
}

/** Creates the executor for one OpenAI-compatible provider key (e.g. `openai-compatible-openrouter`). */
export const makeOpenAICompatExecutor = (
  provider: string,
  executorOptions: OpenAICompatExecutorOptions = {}
): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators
  const to = Formats.OpenAI

  const prepare = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean
  ) {
    const thinking = yield* Thinking
    const baseModel = parseSuffix(request.model).modelName
    const { baseURL, apiKey } = credentialEndpoint(context)
    if (baseURL === "") return yield* new ExecutionError({ status: 401, message: "missing provider baseURL" })
    if (options.alt === "responses/compact") {
      return yield* new ExecutionError({
        status: 501,
        message: "responses/compact is not supported by the openai-compatibility executor yet",
        requestScoped: true
      })
    }

    const from = options.sourceFormat
    const original = registry.translateRequest(
      from,
      to,
      { format: from, model: baseModel, stream, body: options.originalRequest ?? request.payload },
      thinking.summary
    )
    const translated = registry.translateRequest(
      from,
      to,
      { format: from, model: baseModel, stream, body: request.payload },
      thinking.summary
    )
    if (translated.error !== undefined) {
      return yield* new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true
      })
    }

    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider,
      source: request.payload,
      ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup
    })

    const requestedModel = options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model
    const group = resolveCompatConfig(context.config, context.credential)
    body = normalizeOpenAIMaxTokens(body, shouldUseMaxCompletionTokens(group, baseModel, requestedModel))
    body = applyPromptCacheKey(context, request, options, body)
    if (stream) {
      // Ask for usage in the final chunk so token statistics are captured.
      body = setBoolIfDifferent(body, "stream_options.include_usage", true)
    }
    const effort = get(body, "reasoning_effort")
    context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined)

    // User payload rules: the final semantic mutation of the business payload (AGENTS.md).
    body = finalizePayload(
      context.config,
      provider,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: original.body
      },
      body
    )

    const headers: Record<string, string> = { "content-type": "application/json" }
    if (apiKey !== "") headers["authorization"] = `Bearer ${apiKey}`
    headers["user-agent"] = USER_AGENT
    applyCustomHeaders(headers, context.credential, options.headers, options.metadata.sessionId)
    if (stream) {
      headers["accept"] = "text/event-stream"
      headers["cache-control"] = "no-cache"
    }
    const url = (baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL) + CHAT_COMPLETIONS_PATH
    return { url, headers, body, baseModel } satisfies PreparedRequest
  })

  /** Images API request (`executeImages` / `executeImagesStream` preparation). */
  const prepareImages = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean
  ) {
    const baseModel = parseSuffix(request.model).modelName
    const { baseURL, apiKey } = credentialEndpoint(context)
    if (baseURL === "") return yield* new ExecutionError({ status: 401, message: "missing provider baseURL" })
    const endpoint = compatImageEndpointPath(options.metadata.requestPath)
    const requestedModel = options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model
    const from = options.sourceFormat
    const original = prepareCompatImagesBody(options.originalRequest ?? request.payload, baseModel, stream)
    let body: Json = prepareCompatImagesBody(request.payload, baseModel, stream)
    const effort = get(body, "reasoning_effort")
    context.usage.setReasoningEffort(typeof effort === "string" ? effort : undefined)
    // User payload rules stay the final mutation of the business payload; a multipart upload is rebuilt afterwards.
    body = finalizePayload(
      context.config,
      provider,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original
      },
      body
    )
    const multipart = wantsMultipartEdit(endpoint, options.headers.get("content-type") ?? "")
    const headers: Record<string, string> = multipart ? {} : { "content-type": "application/json" }
    if (apiKey !== "") headers["authorization"] = `Bearer ${apiKey}`
    headers["user-agent"] = USER_AGENT
    applyCustomHeaders(headers, context.credential, options.headers, options.metadata.sessionId)
    if (stream) {
      headers["accept"] = "text/event-stream"
      headers["cache-control"] = "no-cache"
    }
    const url = (baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL) + endpoint
    const form = multipart ? editBodyToFormData(body as JsonObject, baseModel, stream) : undefined
    return { url, headers, body, baseModel, ...(form === undefined ? {} : { form }) } satisfies PreparedRequest
  })

  /** Sends the request; non-2xx answers become `ExecutionError`s carrying the upstream body. */
  const send = Effect.fnUntraced(function* (context: ExecutionContext, prepared: PreparedRequest) {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(prepared.url).pipe(
      prepared.form === undefined
        ? HttpClientRequest.bodyText(JSON.stringify(prepared.body), "application/json")
        : HttpClientRequest.bodyFormData(prepared.form),
      HttpClientRequest.setHeaders(prepared.headers)
    )
    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(request)
      .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.mapError(transportError))
    context.usage.markFirstByte(yield* Clock.currentTimeMillis)
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      const webHeaders = new Headers(response.headers)
      const retryAfterMs = openAICompatRetryAfterMs(response.status, webHeaders, text, yield* Clock.currentTimeMillis)
      context.usage.fail(response.status, text)
      return yield* new ExecutionError({
        status: response.status,
        message: text,
        headers: headersRecord(webHeaders),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
      })
    }
    return response
  })

  /** `executeImages`: the upstream Images API answer is returned unchanged. */
  const executeImages = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepareImages(context, request, options, false)
    const response = yield* send(context, prepared)
    const text = yield* response.text.pipe(Effect.mapError(transportError))
    context.usage.observeResponseModel(responseModelOf(tryParseJson(text)))
    context.usage.publish(parseOpenAIUsage(text))
    return { payload: text, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  /** `executeImagesStream`: upstream SSE bytes are forwarded as they arrive. */
  const executeImagesStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepareImages(context, request, options, true)
    const response = yield* send(context, prepared)
    const chunks = response.stream.pipe(
      Stream.decodeText,
      Stream.mapError(transportError),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    if (options.sourceFormat === EntryOnlyFormats.OpenAIImage) return yield* executeImages(context, request, options)
    const prepared = yield* prepare(context, request, options, options.stream)
    const response = yield* send(context, prepared)
    const text = yield* response.text.pipe(Effect.mapError(transportError))
    context.usage.observeResponseModel(responseModelOf(tryParseJson(text)))
    const out = registry.translateNonStream(
      responseFormatOf(options),
      to,
      responseContext(request, options, prepared.body),
      text
    )
    if (out === undefined || out === "") {
      return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })
    }
    context.usage.publish(parseOpenAIUsage(text))
    const payload = responseFormatOf(options) === Formats.OpenAIResponse ? ensureResponsesUsageDetails(out) : out
    return { payload, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    if (options.sourceFormat === EntryOnlyFormats.OpenAIImage)
      return yield* executeImagesStream(context, request, options)
    const prepared = yield* prepare(context, request, options, true)
    const response = yield* send(context, prepared)
    const reader = new OpenAICompatStreamReader({
      registry,
      responseFormat: responseFormatOf(options),
      providerFormat: to,
      context: responseContext(request, options, prepared.body)
    })
    const observe = (line: string) => {
      const usage = parseOpenAIStreamUsage(line)
      if (usage !== undefined) context.usage.publish(usage)
      context.usage.observeResponseModel(responseModelOf(ssePayloadObject(line)))
    }
    const chunks = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapAccum(
        () => reader,
        (state, line: string) => {
          observe(line)
          return [state, [state.push(line)]] as const
        },
        { onHalt: (state) => [state.end()] }
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap((step) => {
        const emitted = Stream.fromIterable(step.chunks)
        if (step.error === undefined) return emitted
        const error = step.error
        context.usage.fail(
          error.status,
          step.payloadError === true ? "upstream stream returned an error payload" : error.message
        )
        return Stream.concat(emitted, Stream.fail(error))
      }),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  /**
   * `CountTokens`: translate to Chat Completions, thinking and payload rules (no max-token or cache-key shaping, no
   * credential needed), then count locally with the model's BPE encoding.
   */
  const countTokens = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const thinking = yield* Thinking
    const baseModel = parseSuffix(request.model).modelName
    const from = options.sourceFormat
    const responseFormat = responseFormatOf(options)
    const translate = (payload: Json) =>
      registry.translateRequest(
        from,
        to,
        { format: from, model: baseModel, stream: false, body: payload },
        thinking.summary
      )
    const translated = translate(request.payload)
    if (translated.error !== undefined) {
      return yield* new ExecutionError({
        status: translated.error.status,
        message: translated.error.message,
        requestScoped: true
      })
    }
    const original = options.originalRequest === undefined ? translated : translate(options.originalRequest)
    let body = yield* thinking.apply({
      body: translated.body,
      model: request.model,
      from,
      to,
      provider,
      source: request.payload,
      ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
      configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
      modelInfo: request.modelInfo,
      lookupModelInfo: request.modelLookup
    })
    body = finalizePayload(
      context.config,
      provider,
      {
        model: baseModel,
        requestedModel: options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: original.body
      },
      body
    )
    const count = countOpenAIChatTokens(getCodec(encodingForModel(baseModel)), body)
    return {
      payload: registry.translateTokenCount(responseFormat, to, count, buildOpenAIUsageJson(count)),
      headers: new Headers()
    } satisfies ExecutorResponse
  })

  return { identifier: provider, execute, executeStream, countTokens }
}
