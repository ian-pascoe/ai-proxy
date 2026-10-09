/**
 * Devin (Cognition / Codeium "chisel") executor: Connect-RPC protobuf chat (`GetChatMessage`).
 *
 * Go source: internal/runtime/executor/devin_executor.go (PrepareRequest, Execute, ExecuteStream,
 * `prepareDevinHTTPRequest`, `streamDevinFrames`, `consumeDevinFramesToInteractions`, CountTokens),
 * helps/devin_wire.go, helps/devin_payload.go, helps/devin_models.go. The client request is translated to the
 * Interactions format, hand-encoded as `GetChatMessageRequest` (user payload rules run on the protobuf business
 * fields, the last mutation before framing) and the response frames are assembled into Interactions events, which the
 * translator registry turns into the client format.
 *
 * Not ported: the apply_patch bridge, request/response debug logs, the
 * metadata/quota refresh (`GetUserStatus`, cron follow-up) and outbound proxies. `fetch` always sends a User-Agent
 * (native devin-cli omits it); the executor sets it empty and relies on the runtime to drop it.
 */
import { Clock, Effect, Stream } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { asString, cloneJson, get, type Json, tryParseJson } from "../../json/index.ts"
import { builtinTranslators } from "../../translator/builtin.ts"
import { Formats } from "../../translator/formats.ts"
import { makeTranslationState, type ResponseContext, type TranslatorRegistry } from "../../translator/registry.ts"
import { type UsageDetail } from "../../usage/record.ts"
import { buildSensitiveWordMatcher } from "../claude/cloaking.ts"
import { ExecutionError } from "../errors.ts"
import { applyCustomHeaders } from "../helps/custom-headers.ts"
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
import { ConnectFrameError, ConnectFrameParser, inflateFrame } from "./connect.ts"
import { devinCredentials, devinStatusError, nextSessionTurnIndex, resolveSessionIds } from "./credentials.ts"
import { checkDevinUserTurns, parseInteractionsPayload } from "./interactions.ts"
import { resolveDevinChatModelUid } from "./models.ts"
import { devinPayloadDefaultsSource, finalizeDevinPayload } from "./payload.ts"
import { DevinAggregator, DevinStreamAssembler } from "./stream.ts"
import {
  buildGetChatMessageRequest,
  CONNECT_FLAG_END_STREAM,
  DEVIN_CHAT_PATH,
  type DevinUsage,
  generateSentryTrace,
  parseDevinFrame,
  parseTrailerError,
  wrapConnectEnvelope
} from "./wire.ts"
import { devinLevelLookup, devinMaxCompletionTokens } from "./catalog.ts"

export const DEVIN_PROVIDER = "devin"
const MAX_ERROR_BODY_BYTES = 1 << 20
const TRUNCATED_STREAM = "devin stream terminated prematurely before EOS trailer"

export interface DevinExecutorOptions {
  readonly translators?: TranslatorRegistry
  /** Catalog lookup for thinking levels (defaults to the embedded `devin_models.json`). */
  readonly levelsOf?: (modelId: string) => ReadonlyArray<string> | undefined
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error
  })

const readError = (message: string) => new ExecutionError({ status: 502, message })

/** `ParseInteractionsUsage` of the aggregate Devin totals. */
export const devinUsageDetail = (usage: DevinUsage | undefined): UsageDetail => {
  if (usage === undefined) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0
    }
  }
  const input = usage.promptTokens + usage.cachedTokens
  return {
    inputTokens: input,
    outputTokens: usage.completionTokens,
    reasoningTokens: 0,
    cachedTokens: usage.cachedTokens,
    cacheReadTokens: usage.cachedTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    totalTokens: input + usage.completionTokens
  }
}

interface PreparedDevin {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Uint8Array
  readonly chatModelUid: string
  readonly sessionId: string
}

interface StreamStep {
  /** Interactions event documents to translate (in order). */
  readonly events: ReadonlyArray<string>
  /** Terminal `[DONE]` follows the events. */
  readonly done?: boolean
  readonly error?: ExecutionError
  readonly stop: boolean
}

export const makeDevinExecutor = (executorOptions: DevinExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators
  const levelsOf = executorOptions.levelsOf ?? devinLevelLookup

  /** `prepareDevinHTTPRequest`. */
  const prepare = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    stream: boolean
  ) {
    const thinking = yield* Thinking
    const { apiKey, baseUrl, deviceSeed } = devinCredentials(context.credential)
    if (apiKey === "") {
      return yield* new ExecutionError({
        status: 401,
        message: "devin credentials missing: api_key or session_token required"
      })
    }
    const from = options.sourceFormat
    let payload: Json = request.payload
    const nativeSource = from === "" || from === Formats.Interactions
    if (!nativeSource) {
      const translated = registry.translateRequest(
        from,
        Formats.Interactions,
        { format: from, model: request.model, stream, body: payload },
        thinking.summary
      )
      if (translated.error !== undefined) {
        return yield* new ExecutionError({
          status: translated.error.status,
          message: translated.error.message,
          requestScoped: true
        })
      }
      payload = translated.body
    }
    const parsed = parseInteractionsPayload(payload, options.originalRequest)
    // Devin cannot fetch a remote uri or take audio, video or documents: a user turn with nothing else is refused.
    const turns = checkDevinUserTurns(parsed.prompts)
    if (turns.error !== undefined) {
      return yield* new ExecutionError({
        status: turns.error.status,
        message: turns.error.message,
        requestScoped: true
      })
    }
    const ids = resolveSessionIds(parsed.sessionId, parsed.cascadeId, options.metadata.sessionId)
    const baseModel = parseSuffix(request.model).modelName
    let maxTokens = parsed.maxTokens
    const info = request.modelLookup?.(baseModel, DEVIN_PROVIDER)
    const modelMax = info?.maxCompletionTokens ?? devinMaxCompletionTokens(baseModel)
    if (modelMax > 0 && (maxTokens > modelMax || maxTokens <= 0)) maxTokens = modelMax
    const chatModelUid = resolveDevinChatModelUid(request.model, parsed.thinkingLevel, parsed.budgetTokens, levelsOf)

    const turnIndex = yield* nextSessionTurnIndex(ids.sessionId, options.metadata.callerScope)
    const matcher = buildSensitiveWordMatcher(context.config.oauth.providers.devin["sensitive-words"])
    const wire = buildGetChatMessageRequest({
      sessionToken: apiKey,
      deviceSeed,
      chatModelUid,
      systemPrompt: parsed.systemPrompt,
      prompts: turns.prompts,
      tools: parsed.tools,
      temperature: parsed.temperature,
      maxTokens,
      sessionId: ids.sessionId,
      cascadeId: ids.cascadeId,
      turnIndex,
      matcher
    })
    // User payload rules over the protobuf business fields: the last mutation before framing.
    const finalized = finalizeDevinPayload(wire, (view) =>
      finalizePayload(
        context.config,
        DEVIN_PROVIDER,
        {
          model: baseModel,
          requestedModel: options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
          protocol: DEVIN_PROVIDER,
          fromProtocol: from,
          requestPath: options.metadata.requestPath,
          headers: options.headers,
          original: devinPayloadDefaultsSource(view, payload)
        },
        view
      )
    )
    const headers: Record<string, string> = {
      authorization: `Basic ${apiKey}-${apiKey}`,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      accept: "*/*",
      "sentry-trace": generateSentryTrace(),
      // Native devin-cli sends no User-Agent.
      "user-agent": ""
    }
    applyCustomHeaders(headers, context.credential, options.headers, options.metadata.sessionId)
    return {
      url: `${baseUrl.replace(/\/+$/, "")}${DEVIN_CHAT_PATH}`,
      headers,
      body: wrapConnectEnvelope(finalized.wire),
      chatModelUid,
      sessionId: ids.sessionId
    } satisfies PreparedDevin
  })

  const send = Effect.fnUntraced(function* (context: ExecutionContext, prepared: PreparedDevin) {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(prepared.url).pipe(
      HttpClientRequest.bodyUint8Array(prepared.body, "application/connect+proto"),
      HttpClientRequest.setHeaders(prepared.headers)
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.mapError(transportError))
    context.usage.markFirstByte(yield* Clock.currentTimeMillis)
    if (response.status < 200 || response.status >= 300) {
      const bytes = yield* response.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0)))
      const text = new TextDecoder().decode(bytes.slice(0, MAX_ERROR_BODY_BYTES))
      const error = devinStatusError(
        response.status,
        new Headers(response.headers),
        text,
        yield* Clock.currentTimeMillis
      )
      context.usage.fail(error.status, error.message)
      return yield* error
    }
    return response
  })

  const responseContext = (request: ExecutorRequest, options: ExecutorOptions): ResponseContext => ({
    model: request.model,
    originalRequest: options.originalRequest ?? request.payload,
    translatedRequest: request.payload,
    state: makeTranslationState()
  })

  // -------------------------------------------------------------------------------------------------------------
  // Non-stream
  // -------------------------------------------------------------------------------------------------------------

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepare(context, request, options, false)
    const response = yield* send(context, prepared)
    const body = yield* response.arrayBuffer.pipe(
      Effect.mapError((error) => readError(`devin upstream read failed: ${error.reason._tag}`))
    )
    const parser = new ConnectFrameParser()
    const aggregator = new DevinAggregator()
    let sawEos = false
    const frames = yield* Effect.try({
      try: () => parser.push(new Uint8Array(body)),
      catch: (error) => readError(error instanceof ConnectFrameError ? error.message : String(error))
    })
    for (const frame of frames) {
      const payload = yield* Effect.tryPromise({
        try: () => inflateFrame(frame),
        catch: (error) => readError(error instanceof Error ? error.message : String(error))
      })
      if ((frame.flag & CONNECT_FLAG_END_STREAM) !== 0) {
        const trailer = parseTrailerError(payload)
        if (trailer !== undefined) {
          context.usage.fail(trailer.status, trailer.message)
          return yield* new ExecutionError({ status: trailer.status, message: trailer.message })
        }
        sawEos = true
        break
      }
      try {
        aggregator.push(parseDevinFrame(payload))
      } catch {
        // A malformed frame is skipped (Go `continue`).
      }
    }
    if (!sawEos) {
      const message =
        parser.pending > 0 ? "unexpected EOF" : "devin upstream stream terminated prematurely before EOS trailer"
      context.usage.fail(502, message)
      return yield* readError(message)
    }
    const aggregate = aggregator.finish(request.model)
    if (aggregate.usage?.modelName !== undefined && aggregate.usage.modelName !== "") {
      context.usage.observeResponseModel(aggregate.usage.modelName)
    }
    const responseFormat = responseFormatOf(options)
    const out = registry.translateNonStream(
      responseFormat,
      Formats.Interactions,
      responseContext(request, options),
      JSON.stringify(aggregate.interaction)
    )
    if (out === undefined || out === "")
      return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE })
    context.usage.publish(devinUsageDetail(aggregate.usage))
    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse
  })

  // -------------------------------------------------------------------------------------------------------------
  // Stream
  // -------------------------------------------------------------------------------------------------------------

  class FrameState {
    readonly parser = new ConnectFrameParser()
    readonly assembler: DevinStreamAssembler
    stopped = false

    constructor(model: string, responseFormat: string) {
      this.assembler = new DevinStreamAssembler(model, responseFormat)
    }

    feed(bytes: Uint8Array): Effect.Effect<StreamStep> {
      return Effect.promise(async (): Promise<StreamStep> => {
        if (this.stopped) return { events: [], stop: true }
        const events: string[] = []
        let frames
        try {
          frames = this.parser.push(bytes)
        } catch (error) {
          return this.#readFailure(events, error)
        }
        for (const frame of frames) {
          let payload: Uint8Array
          try {
            payload = await inflateFrame(frame)
          } catch (error) {
            return this.#readFailure(events, error)
          }
          if ((frame.flag & CONNECT_FLAG_END_STREAM) !== 0) {
            this.stopped = true
            const trailer = parseTrailerError(payload)
            if (trailer !== undefined) {
              events.push(...this.assembler.fail(trailer.status, trailer.message))
              return {
                events,
                error: new ExecutionError({ status: trailer.status, message: trailer.message }),
                stop: true
              }
            }
            events.push(...this.assembler.complete())
            return { events, done: true, stop: true }
          }
          try {
            events.push(...this.assembler.push(parseDevinFrame(payload)))
          } catch {
            // A malformed frame is skipped (Go `continue`).
          }
        }
        return { events, stop: false }
      })
    }

    #readFailure(events: string[], error: unknown): StreamStep {
      this.stopped = true
      const message = error instanceof Error ? error.message : String(error)
      events.push(...this.assembler.abort("stream_read_error", message))
      return { events, error: readError(message), stop: true }
    }

    /** Clean EOF before the EOS trailer. */
    end(): StreamStep {
      if (this.stopped) return { events: [], stop: true }
      this.stopped = true
      if (this.parser.pending > 0) return this.#readFailure([], new Error("unexpected EOF"))
      return {
        events: this.assembler.abort("stream_truncated", TRUNCATED_STREAM),
        error: readError(TRUNCATED_STREAM),
        stop: true
      }
    }
  }

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions
  ) {
    const prepared = yield* prepare(context, request, options, true)
    const response = yield* send(context, prepared)
    const responseFormat = responseFormatOf(options)
    const state = new FrameState(request.model, responseFormat)
    const translation = responseContext(request, options)
    const frameInteractions = (json: string): string[] =>
      responseFormat === Formats.Interactions
        ? [`data: ${json}\n\n`]
        : [...registry.translateStream(responseFormat, Formats.Interactions, translation, json)]
    const translate = (step: StreamStep): Stream.Stream<string, ExecutionError> => {
      const chunks: string[] = []
      for (const json of step.events) {
        const event = tryParseJson(json)
        const type = asString(get(event, "event_type"))
        if (type === "interaction.completed") {
          const usage = state.assembler.usage
          context.usage.publish(devinUsageDetail(usage))
          if (usage?.modelName !== undefined && usage.modelName !== "")
            context.usage.observeResponseModel(usage.modelName)
        }
        chunks.push(...frameInteractions(json))
      }
      if (step.done === true) {
        chunks.push(...(responseFormat === Formats.Interactions ? ["data: [DONE]\n\n"] : frameInteractions("[DONE]")))
      }
      const emitted = Stream.fromIterable(chunks)
      if (translation.state.toolInputError !== undefined) {
        return Stream.concat(
          emitted,
          Stream.fail(new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE }))
        )
      }
      return step.error === undefined ? emitted : Stream.concat(emitted, Stream.fail(step.error))
    }
    const chunks = response.stream.pipe(
      Stream.mapError(transportError),
      Stream.mapAccumEffect(
        () => state,
        (frames, bytes: Uint8Array) => Effect.map(frames.feed(bytes), (step) => [frames, [step]] as const),
        { onHalt: (frames) => [frames.end()] }
      ),
      Stream.takeUntil((step) => step.stop),
      Stream.flatMap(translate),
      Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
    )
    return { headers: new Headers(response.headers), chunks } satisfies StreamResult
  })

  /** `CountTokens`: no upstream endpoint; `len(payload)/4` like Go. */
  const countTokens: ProviderExecutor["countTokens"] = (_context, request) => {
    const tokens = Math.floor(new TextEncoder().encode(JSON.stringify(cloneJson(request.payload))).length / 4)
    return Effect.succeed({
      payload: `{"total_tokens":${tokens},"input_tokens":${tokens}}`,
      headers: new Headers()
    } satisfies ExecutorResponse)
  }

  return { identifier: DEVIN_PROVIDER, execute, executeStream, countTokens }
}
