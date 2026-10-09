/**
 * Claude Messages inbound routes: `POST /v1/messages` and `POST /v1/messages/count_tokens` (entry protocol `claude`).
 *
 * Go source: sdk/api/handlers/claude/code_handlers.go (ClaudeMessages, ClaudeCountTokens, handleNonStreamingResponse,
 * handleStreamingResponse, rewriteClaudeDDModelInBody, WriteErrorResponse). `/v1/models` for Claude clients belongs to
 * the model registry slice.
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { routeServices } from "../../http/route-services.ts"
import type { ExecutionError } from "../../executor/errors.ts"
import { claudeErrorBody } from "../../http/errors.ts"
import { asString, get, type Json, set } from "../../json/index.ts"
import { Formats } from "../../translator/formats.ts"
import { executeCountTokens, executeNonStream, executeStream, type ExecutionInput } from "../execute.ts"
import { claudeFramer } from "../framing.ts"
import { altOf, currentConfig, type ProxyServices, readRequestBody } from "../request.ts"
import { errorResponse, jsonResponse, streamResponse } from "../respond.ts"
import { resolveClaudeModelIdPrefix } from "../../registry/listings.ts"

const badRequest = (message: string, status = 400): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(claudeErrorBody(status, `Invalid request: ${message}`), {
    status,
    contentType: "application/json"
  })

/** `rewriteClaudeDDModelInBody`. */
const rewriteModel = (body: Json): Json => {
  const model = asString(get(body, "model"))
  const resolved = resolveClaudeModelIdPrefix(model)
  if (resolved === model) return body
  try {
    return set(body, "model", resolved)
  } catch {
    return body
  }
}

const handle = (kind: "messages" | "count") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const configResult = yield* Effect.result(currentConfig)
    if (configResult._tag === "Failure")
      return errorResponse("claude", configResult.failure, { passthroughHeaders: false })
    const config = configResult.success
    const onError = (error: ExecutionError) =>
      errorResponse("claude", error, { passthroughHeaders: config.requests["passthrough-headers"] })

    const read = yield* Effect.result(readRequestBody(request))
    if (read._tag === "Failure") return badRequest(read.failure.message, read.failure.status)
    // Go forwards an unparsable body to model resolution, which answers with a model error; JSON is required here.
    if (read.success.json === undefined) return badRequest("request body is not valid JSON")
    const body = rewriteModel(read.success.json)
    const input: ExecutionInput = {
      entryProtocol: Formats.Claude,
      model: asString(get(body, "model")),
      body,
      alt: altOf(request),
      request
    }
    if (kind === "count") {
      const result = yield* Effect.result(executeCountTokens(input))
      if (result._tag === "Failure") return onError(result.failure)
      return jsonResponse(result.success.payload, result.success.headers)
    }
    const streamField = get(body, "stream")
    if (streamField !== undefined && streamField !== false) {
      return yield* streamResponse(executeStream({ ...input, alt: "" }), {
        framer: claudeFramer(),
        onError,
        keepAliveSeconds: config.requests.streaming["keepalive-seconds"]
      })
    }
    const result = yield* Effect.result(executeNonStream(input))
    if (result._tag === "Failure") return onError(result.failure)
    return jsonResponse(result.success.payload, result.success.headers)
  })

/** Route layer; requires the {@link ProxyServices} (see `handlers/layer.ts`) and `AccessPrincipal` (`withAccess`). */
export const ClaudeRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ProxyServices>()
    yield* router.add("POST", "/v1/messages", Effect.provide(handle("messages"), services))
    yield* router.add("POST", "/v1/messages/count_tokens", Effect.provide(handle("count"), services))
  })
)
