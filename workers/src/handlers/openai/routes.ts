/**
 * OpenAI-compatible inbound routes: `POST /v1/chat/completions` and `POST /v1/completions` (entry protocol `openai`).
 *
 * Go source: sdk/api/handlers/openai/openai_handlers.go (ChatCompletions, shouldTreatAsResponsesFormat, Completions,
 * handleNonStreamingResponse, handleStreamingResponse, handleCompletions*). Difference: a body that is not JSON is
 * rejected with `400 Invalid request` instead of being forwarded and failing model resolution.
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { ExecutionError } from "../../executor/errors.ts"
import { invalidRequestBody } from "../../http/errors.ts"
import { asBool, asString, get, isJsonObject, type Json } from "../../json/index.ts"
import { builtinTranslators } from "../../translator/builtin.ts"
import { Formats } from "../../translator/formats.ts"
import { executeNonStream, executeStream, type ExecutionInput } from "../execute.ts"
import { openAIFramer, type StreamFramer } from "../framing.ts"
import { altOf, currentConfig, type ProxyServices, readRequestBody } from "../request.ts"
import { errorResponse, jsonResponse, streamResponse } from "../respond.ts"
import { chatResponseToCompletions, chatStreamChunkToCompletions, completionsRequestToChat } from "./completions.ts"

/** `shouldTreatAsResponsesFormat`: a Responses-shaped payload sent to `/v1/chat/completions`. */
export const isResponsesShaped = (body: Json): boolean =>
  get(body, "messages") === undefined && (get(body, "input") !== undefined || get(body, "instructions") !== undefined)

const badRequest = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(invalidRequestBody(message), { status: 400, contentType: "application/json" })

interface Exchange {
  /** Converts the request body; `stream` is derived from the result. */
  readonly prepare: (body: Json) => { readonly body: Json; readonly stream: boolean }
  readonly alt: (request: HttpServerRequest.HttpServerRequest) => string
  /** Converts a non-stream response payload. */
  readonly convertResponse: (payload: string) => string
  readonly framer: () => StreamFramer
}

const handle = (exchange: Exchange) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const configResult = yield* Effect.result(currentConfig)
    if (configResult._tag === "Failure") {
      return errorResponse("openai", configResult.failure, { passthroughHeaders: false })
    }
    const config = configResult.success
    const onError = (error: ExecutionError) =>
      errorResponse("openai", error, { passthroughHeaders: config.requests["passthrough-headers"] })

    const read = yield* Effect.result(readRequestBody(request))
    if (read._tag === "Failure") return badRequest(read.failure.message)
    if (read.success.json === undefined) return badRequest("request body is not valid JSON")
    const { body, stream } = exchange.prepare(read.success.json)

    const input: ExecutionInput = {
      entryProtocol: Formats.OpenAI,
      model: asString(get(body, "model")),
      body,
      alt: exchange.alt(request),
      request
    }
    if (stream) {
      return yield* streamResponse(executeStream(input), {
        framer: exchange.framer(),
        onError,
        keepAliveSeconds: config.requests.streaming["keepalive-seconds"]
      })
    }
    const result = yield* Effect.result(executeNonStream(input))
    if (result._tag === "Failure") return onError(result.failure)
    return jsonResponse(exchange.convertResponse(result.success.payload), result.success.headers)
  })

const chatCompletions = handle({
  prepare: (raw) => {
    let body = raw
    let stream = get(body, "stream") === true
    // Some clients send Responses-format payloads to /v1/chat/completions; convert them to Chat Completions.
    if (isResponsesShaped(body) && builtinTranslators.hasRequestTransformer(Formats.OpenAIResponse, Formats.OpenAI)) {
      const converted = builtinTranslators.translateRequest(Formats.OpenAIResponse, Formats.OpenAI, {
        format: Formats.OpenAIResponse,
        model: asString(get(body, "model")),
        stream,
        body
      })
      // Go ignores the conversion error and continues with the returned body.
      body = converted.body
      stream = asBool(get(body, "stream"))
    }
    return { body, stream }
  },
  alt: altOf,
  convertResponse: (payload) => payload,
  framer: openAIFramer
})

/** The completions framer converts chat chunks back and drops chunks without text, finish reason or usage. */
const completionsFramer = (): StreamFramer => {
  const inner = openAIFramer()
  return {
    ...inner,
    chunk: (payload) => {
      const converted = chatStreamChunkToCompletions(payload)
      return converted === undefined ? "" : inner.chunk(converted)
    }
  }
}

const completions = handle({
  prepare: (raw) => {
    const body = completionsRequestToChat(isJsonObject(raw) ? raw : {})
    return { body, stream: get(raw, "stream") === true }
  },
  alt: () => "",
  convertResponse: chatResponseToCompletions,
  framer: completionsFramer
})

/** Route layer; requires the {@link ProxyServices} (see `handlers/layer.ts`) and `AccessPrincipal` (`withAccess`). */
export const OpenAIRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ProxyServices>()
    yield* router.add("POST", "/v1/chat/completions", Effect.provide(chatCompletions, services))
    yield* router.add("POST", "/v1/completions", Effect.provide(completions, services))
  })
)
