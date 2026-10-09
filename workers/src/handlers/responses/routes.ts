/**
 * Responses API routes: `POST /v1/responses`, `POST /v1/responses/compact` and the Codex aliases under
 * `/backend-api/codex/*` (entry protocol `openai-response`).
 *
 * Go source: sdk/api/handlers/openai/openai_responses_handlers.go (Responses, Compact, handleNonStreamingResponse,
 * handleStreamingResponse), internal/api/server_routes.go (route table). The websocket variants (`GET /v1/responses`,
 * `GET /backend-api/codex/responses`) are in websocket/. Multi-agent-v2 request rewriting is not ported.
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { ExecutionError } from "../../executor/errors.ts"
import { invalidRequestBody } from "../../http/errors.ts"
import { asString, del, get, type Json } from "../../json/index.ts"
import { Formats } from "../../translator/formats.ts"
import { executeNonStream, executeStream, type ExecutionInput } from "../execute.ts"
import { currentConfig, type ProxyServices, readRequestBody } from "../request.ts"
import { errorResponse, jsonResponse, streamResponse } from "../respond.ts"
import { isCodexResponsesClient, responsesFramer } from "./framer.ts"
import { handleResponsesSocket } from "./websocket/routes.ts"

const badRequest = (message: string, status = 400): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(invalidRequestBody(message), { status, contentType: "application/json" })

const handle = (compact: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const configResult = yield* Effect.result(currentConfig)
    if (configResult._tag === "Failure")
      return errorResponse("openai", configResult.failure, { passthroughHeaders: false })
    const config = configResult.success
    const onError = (error: ExecutionError) =>
      errorResponse("openai", error, { passthroughHeaders: config.requests["passthrough-headers"] })

    const read = yield* Effect.result(readRequestBody(request))
    if (read._tag === "Failure") return badRequest(read.failure.message)
    let body: Json | undefined = read.success.json
    if (body === undefined) return badRequest("request body is not valid JSON")

    const streamField = get(body, "stream")
    if (compact) {
      if (streamField === true) {
        return HttpServerResponse.text(
          JSON.stringify({
            error: { message: "Streaming not supported for compact responses", type: "invalid_request_error" }
          }),
          { status: 400, contentType: "application/json" }
        )
      }
      if (streamField !== undefined) body = del(body, "stream")
    }
    const input: ExecutionInput = {
      entryProtocol: Formats.OpenAIResponse,
      model: asString(get(body, "model")),
      body,
      alt: compact ? "responses/compact" : "",
      request
    }
    if (!compact && streamField === true) {
      return yield* streamResponse(executeStream(input), {
        framer: responsesFramer({
          codexClient: isCodexResponsesClient(new Headers(request.headers as Record<string, string>))
        }),
        onError,
        keepAliveSeconds: config.requests.streaming["keepalive-seconds"]
      })
    }
    const result = yield* Effect.result(executeNonStream(input))
    if (result._tag === "Failure") return onError(result.failure)
    return jsonResponse(result.success.payload, result.success.headers)
  })

const ROUTES = [
  ["/v1/responses", false],
  ["/v1/responses/compact", true],
  ["/backend-api/codex/responses", false],
  ["/backend-api/codex/responses/compact", true]
] as const

const SOCKET_ROUTES = ["/v1/responses", "/backend-api/codex/responses"] as const

/** Route layer; requires the {@link ProxyServices} and `AccessPrincipal` (see `handlers/layer.ts`). */
export const ResponsesRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ProxyServices>()
    for (const [path, compact] of ROUTES) yield* router.add("POST", path, Effect.provide(handle(compact), services))
    // The Responses WebSocket (`Upgrade: websocket`), see websocket/routes.ts.
    for (const path of SOCKET_ROUTES) yield* router.add("GET", path, Effect.provide(handleResponsesSocket, services))
  })
)
