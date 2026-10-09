/**
 * Gemini inbound routes: `POST /v1beta/models/{model}:{generateContent|streamGenerateContent|countTokens}` (entry
 * protocol `gemini`) and `POST /v1beta/interactions` (entry protocol `interactions`).
 *
 * Go source: sdk/api/handlers/gemini/gemini_handlers.go (GeminiHandler, handleGenerateContent,
 * handleStreamGenerateContent, handleCountTokens, forwardGeminiStream) and sdk/api/handlers/gemini/
 * interactions_handlers.go (Interactions, parseInteractionsRequestTarget, prepareInteractionsExecutionTarget).
 * Authentication is the Access gate. Difference: a body that is not JSON answers `400 Invalid request`.
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { routeServices } from "../../http/route-services.ts"
import type { ExecutionError } from "../../executor/errors.ts"
import { invalidRequestBody } from "../../http/errors.ts"
import { asString, get, isJsonObject, type Json, set } from "../../json/index.ts"
import { Formats } from "../../translator/formats.ts"
import { executeCountTokens, executeNonStream, executeStream, type ExecutionInput } from "../execute.ts"
import { geminiFramer, interactionsFramer, type StreamFramer } from "../framing.ts"
import { altOf, currentConfig, type ProxyServices, readRequestBody } from "../request.ts"
import { errorResponse, jsonResponse, streamResponse } from "../respond.ts"

const GEMINI_INTERACTIONS = "gemini-interactions"
const INTERACTIONS_AGENT_AUTH_SELECTION_MODEL = "gemini-2.5-flash"
const MODELS_PREFIX = "/v1beta/models/"

const badRequest = (message: string, status = 400): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(invalidRequestBody(message), { status, contentType: "application/json" })

/** `GeminiHandler` 404 for unroutable actions. */
const notFound = (path: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify({ error: { message: `${path} not found.`, type: "invalid_request_error" } }), {
    status: 404,
    contentType: "application/json"
  })

/** `model:method` after the `/v1beta/models/` prefix (percent-decoded, exactly one `:`). */
export const parseGeminiAction = (
  pathname: string
): { readonly model: string; readonly method: string } | undefined => {
  let rest = pathname.slice(MODELS_PREFIX.length)
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // keep the raw text
  }
  const parts = rest.replace(/^\//, "").split(":")
  const [model, method] = parts
  return parts.length === 2 && model !== undefined && method !== undefined ? { model, method } : undefined
}

interface Context {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly body: Json
  readonly passthroughHeaders: boolean
  readonly keepAliveSeconds: number
}

/** Reads the config and the JSON body shared by every route. */
const readContext = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const configResult = yield* Effect.result(currentConfig)
  if (configResult._tag === "Failure") {
    return { response: errorResponse("openai", configResult.failure, { passthroughHeaders: false }) }
  }
  const config = configResult.success
  const read = yield* Effect.result(readRequestBody(request))
  if (read._tag === "Failure") return { response: badRequest(read.failure.message, read.failure.status) }
  if (read.success.json === undefined) return { response: badRequest("request body is not valid JSON") }
  return {
    context: {
      request,
      body: read.success.json,
      passthroughHeaders: config.requests["passthrough-headers"],
      keepAliveSeconds: config.requests.streaming["keepalive-seconds"]
    } satisfies Context
  }
})

const run = (
  context: Context,
  input: ExecutionInput,
  options: { readonly stream: boolean; readonly framer: () => StreamFramer; readonly contentType?: string }
) => {
  const onError = (error: ExecutionError) =>
    errorResponse("openai", error, { passthroughHeaders: context.passthroughHeaders })
  if (options.stream) {
    return streamResponse(executeStream(input), {
      framer: options.framer(),
      onError,
      keepAliveSeconds: context.keepAliveSeconds,
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {})
    })
  }
  return Effect.gen(function* () {
    const result = yield* Effect.result(executeNonStream(input))
    return result._tag === "Failure"
      ? onError(result.failure)
      : jsonResponse(result.success.payload, result.success.headers)
  })
}

const geminiAction = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.originalUrl, "http://localhost")
  const action = parseGeminiAction(url.pathname)
  if (action === undefined) return notFound(url.pathname)
  if (!["generateContent", "streamGenerateContent", "countTokens"].includes(action.method))
    return notFound(url.pathname)
  const read = yield* readContext(request)
  if (read.response !== undefined) return read.response
  const { context } = read
  const alt = altOf(request)
  const input: ExecutionInput = { entryProtocol: Formats.Gemini, model: action.model, body: context.body, alt, request }

  if (action.method === "countTokens") {
    const result = yield* Effect.result(executeCountTokens(input))
    return result._tag === "Failure"
      ? errorResponse("openai", result.failure, { passthroughHeaders: context.passthroughHeaders })
      : jsonResponse(result.success.payload, result.success.headers)
  }
  const stream = action.method === "streamGenerateContent"
  return yield* run(context, input, {
    stream,
    framer: () => geminiFramer(alt),
    // `alt` other than SSE writes raw chunks.
    ...(alt !== "" ? { contentType: "application/json" } : {})
  })
})

/** `parseInteractionsRequestTarget`: exactly one of `model`/`agent`, boolean `stream`. */
export const parseInteractionsTarget = (
  body: Json
): { readonly model: string; readonly agent: string; readonly stream: boolean } | { readonly error: string } => {
  const model = asString(get(body, "model")).trim()
  const agent = asString(get(body, "agent")).trim()
  if ((model === "" && agent === "") || (model !== "" && agent !== "")) {
    return { error: "request requires exactly one of model or agent" }
  }
  const stream = get(body, "stream")
  if (stream !== undefined && typeof stream !== "boolean") return { error: "stream must be a boolean" }
  return { model, agent, stream: stream === true }
}

/** `normalizeGeminiModelResourceName`: `models/<name>` -> `<name>`. */
const normalizeModelResourceName = (model: string): string => {
  const trimmed = model.trim()
  return trimmed.startsWith("models/") && trimmed.length > "models/".length ? trimmed.slice("models/".length) : trimmed
}

const interactions = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const read = yield* readContext(request)
  if (read.response !== undefined) return read.response
  const { context } = read
  const target = parseInteractionsTarget(context.body)
  if ("error" in target) {
    return HttpServerResponse.text(
      JSON.stringify({ error: { message: target.error, type: "invalid_request_error" } }),
      { status: 400, contentType: "application/json" }
    )
  }
  let body = context.body
  let model = target.agent
  if (target.agent === "") {
    model = normalizeModelResourceName(target.model)
    if (model !== target.model && isJsonObject(body)) body = set(body, "model", model)
  }
  const input: ExecutionInput = {
    entryProtocol: Formats.Interactions,
    model,
    body,
    alt: altOf(request),
    request,
    ...(target.agent !== ""
      ? { forcedProvider: GEMINI_INTERACTIONS, authSelectionModel: INTERACTIONS_AGENT_AUTH_SELECTION_MODEL }
      : {})
  }
  return yield* run(context, input, { stream: target.stream, framer: interactionsFramer })
})

/** Route layer; requires the {@link ProxyServices} (see `handlers/layer.ts`) and `AccessPrincipal` (`withAccess`). */
export const GeminiRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ProxyServices>()
    yield* router.add("POST", "/v1beta/models/*", Effect.provide(geminiAction, services))
    yield* router.add("POST", "/v1beta/interactions", Effect.provide(interactions, services))
  })
)
