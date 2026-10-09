/**
 * Codex Responses WebSocket transport (upstream), used for downstream WebSocket requests with a credential that has
 * `websockets` enabled.
 *
 * Go source: internal/runtime/executor/codex_websockets_executor.go (CodexAutoExecutor routing, codexWebsocketsEnabled),
 * codex_websockets_stream.go (ExecuteStream, prepareCodexWebsocketStream), codex_websockets_request.go
 * (applyCodexWebsocketHeaders), codex_websockets_connection.go (buildCodexResponsesWebsocketURL,
 * frameCodexWebsocketRequestBody), codex_websockets_errors.go (parseCodexWebsocketError, normalizeCodexWebsocketCompletion),
 * codex_websockets_session.go (sessions: see `../websocket/session.ts`).
 *
 * The request pipeline is the HTTP one (`executor.ts` `prepare`, websocket mode: `previous_response_id`, `generate` and
 * `stream_options` are kept) followed by transport framing only: `type: "response.create"` is the last, non-business
 * mutation. Upstream events are forwarded as bare JSON chunks (Go skips response translation for downstream
 * WebSockets); terminal events get the same normalisation as the SSE path (`response.done` -> `response.completed`,
 * rebuilt `response.output`, usage detail objects).
 *
 * Not ported: response steering / full duplex (`codex.response-steering`, off by default), multi-agent-v2 request
 * rewriting, stream bootstrap buffering, and non-stream execution over WebSocket (the downstream handler only streams).
 */
import { Clock, Effect, Option, Stream } from "effect"
import { restoreCodexMultiAgentV2Response } from "../helps/codex-multi-agent-v2.ts"
import { asInt, asString, get, isJsonObject, type Json, type JsonObject, tryParseJson } from "../../json/index.ts"
import { statusText } from "../../http/status.ts"
import { responseModelOf } from "../../usage/record.ts"
import { isResponsesTokenEvent } from "../../usage/ttft.ts"
import { ExecutionError } from "../errors.ts"
import type { Thinking } from "../thinking.ts"
import type { ExecutionContext, ExecutorOptions, ExecutorRequest, StreamResult } from "../types.ts"
import { websocketUrl } from "../websocket/connector.ts"
import { codexSessionStore, openTurn, type UpstreamSessionStore } from "../websocket/session.ts"
import {
  codexEmptyIncompleteStreamError,
  codexTerminalFailure,
  isCodexUsageLimitError,
  isThinkingSignatureInvalid,
  newCodexStatusError,
  parseCodexRetryAfterMs
} from "./errors.ts"
import type { PreparedRequest } from "./executor.ts"
import { buildCodexWebsocketHeaders, codexBaseUrl } from "./headers.ts"
import {
  ensureResponsesUsageDetails,
  hasMeaningfulOutputDelta,
  isTerminalEmptyIncomplete,
  normalizeCodexCompletion,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput
} from "./output.ts"
import type { CodexReplayStore } from "./replay.ts"
import { cacheReplayFromCompleted } from "./replay.ts"

/** Go `strconv.ParseBool` (the subset of spellings Go accepts, lower/upper case variants included). */
const parseBool = (raw: string): boolean | undefined => {
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "t":
    case "true":
      return true
    case "0":
    case "f":
    case "false":
      return false
    default:
      return undefined
  }
}

/** `codexWebsocketsEnabled`: the `websockets` attribute, else the metadata flag (Go `ParseBool` / bool). */
export const codexWebsocketsEnabled = (credential: {
  readonly attributes: Readonly<Record<string, string>>
  readonly metadata: Readonly<Record<string, unknown>>
}): boolean => {
  const attribute = (credential.attributes["websockets"] ?? "").trim()
  if (attribute !== "") {
    const parsed = parseBool(attribute)
    if (parsed !== undefined) return parsed
  }
  const raw = credential.metadata["websockets"]
  if (typeof raw === "boolean") return raw
  if (typeof raw === "string") return parseBool(raw) ?? false
  return false
}

/** `frameCodexWebsocketRequestBody`: the request JSON with `type: "response.create"`. */
export const frameCodexWebsocketBody = (body: Json): string =>
  JSON.stringify(isJsonObject(body) ? { ...body, type: "response.create" } : body)

const CONNECTION_LIMIT_PATHS = [
  "error.code",
  "error.type",
  "body.error.code",
  "body.error.type",
  "code",
  "error"
] as const

/** `buildCodexWebsocketErrorPayload`. */
const websocketErrorBody = (event: Json | undefined, status: number): JsonObject => {
  const out: JsonObject = { status }
  const body = get(event, "body")
  if (body !== undefined) {
    out["body"] = body
    const bodyError = get(body, "error")
    if (bodyError !== undefined) {
      out["error"] = bodyError
      return out
    }
  }
  const error = get(event, "error")
  if (error !== undefined) {
    out["error"] = error
    return out
  }
  out["error"] = { type: "server_error", message: statusText(status) }
  return out
}

const websocketErrorHeaders = (event: Json | undefined): Record<string, string> | undefined => {
  const headers = get(event, "headers")
  if (!isJsonObject(headers)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim()
    if (name === "") continue
    if (typeof value === "string" && value.trim() !== "") out[name.toLowerCase()] = value.trim()
    else if (typeof value === "number" || typeof value === "boolean") out[name.toLowerCase()] = String(value)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * `parseCodexWebsocketErrorWithCooling`: an `error` frame with a positive `status`/`status_code`. A connection-limit
 * error retries immediately (`retryAfterMs` 0) on another credential.
 */
export const parseCodexWebsocketError = (
  event: Json | undefined,
  options: { readonly modelLevelCooling: boolean; readonly nowMs: number }
): { readonly error: ExecutionError; readonly body: string } | undefined => {
  if (asString(get(event, "type")).trim() !== "error") return undefined
  let status = asInt(get(event, "status"))
  if (status === 0) status = asInt(get(event, "status_code"))
  if (status <= 0) return undefined
  const body = JSON.stringify(websocketErrorBody(event, status))
  const usageLimit = isCodexUsageLimitError(body)
  let retryAfterMs = parseCodexRetryAfterMs(status, body, options.nowMs)
  if (
    retryAfterMs === undefined &&
    CONNECTION_LIMIT_PATHS.some((path) => asString(get(event, path)).trim() === "websocket_connection_limit_reached")
  ) {
    retryAfterMs = 0
  }
  const headers = websocketErrorHeaders(event)
  return {
    body,
    error: new ExecutionError({
      status,
      message: body,
      ...(usageLimit && !options.modelLevelCooling ? { credentialScoped: true } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(headers !== undefined ? { headers } : {})
    })
  }
}

export interface CodexWebsocketDeps {
  readonly prepare: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    mode: { readonly stream: boolean; readonly compact: boolean; readonly websocket: boolean }
  ) => Effect.Effect<PreparedRequest, ExecutionError, Thinking>
  readonly replayStore: CodexReplayStore
  readonly modelHeaderOverrides?: ((model: string) => Readonly<Record<string, string>> | undefined) | undefined
  readonly store?: UpstreamSessionStore
}

/** The Go `CodexWebsocketsExecutor.ExecuteStream` path. */
export const makeCodexWebsocketStream =
  (deps: CodexWebsocketDeps) => (context: ExecutionContext, request: ExecutorRequest, options: ExecutorOptions) =>
    Effect.gen(function* () {
      const prepared = yield* deps.prepare(context, request, options, { stream: true, compact: false, websocket: true })
      const websocket = options.metadata.websocket
      const modelLevelCooling = context.config.upstream.codex["model-level-cooling"]
      const url = websocketUrl(`${codexBaseUrl(context.credential)}/responses`)
      const overrides = deps.modelHeaderOverrides?.(prepared.baseModel)
      const headers = buildCodexWebsocketHeaders({
        credential: context.credential,
        config: context.config,
        clientHeaders: options.headers,
        cacheId: prepared.cacheId,
        nativeRequest: prepared.nativeOutput,
        body: prepared.body,
        baseModel: prepared.baseModel,
        ...(options.metadata.sessionId !== undefined ? { sessionId: options.metadata.sessionId } : {}),
        ...(overrides !== undefined ? { modelHeaderOverrides: overrides } : {})
      })
      const frame = frameCodexWebsocketBody(prepared.body)

      const chunks = Stream.unwrap(
        Effect.gen(function* () {
          const dialedAt = yield* Clock.currentTimeMillis
          const turn = yield* openTurn({
            store: deps.store ?? codexSessionStore,
            sessionId: websocket?.sessionId,
            authId: context.credential.id,
            url,
            headers,
            frame: () => frame,
            requireUpstream: websocket?.requireUpstream === true,
            label: "codex",
            classifyHandshake: (status, body, responseHeaders) =>
              // A 426 means the endpoint has no WebSocket support: surfaced as is (Go falls back to HTTP only when
              // the client is not a WebSocket, which cannot be the case here).
              status === 426
                ? new ExecutionError({ status, message: body })
                : newCodexStatusError(status, body, { modelLevelCooling, nowMs: dialedAt, headers: responseHeaders })
          })
          context.usage.recordFirstPacket(yield* Clock.currentTimeMillis)
          const collector = new OutputItemCollector()
          let sawOutputDelta = false

          const fail = (error: ExecutionError) =>
            turn.invalidate.pipe(
              Effect.andThen(() =>
                isThinkingSignatureInvalid(error.status, error.message) ? clearReplay : Effect.void
              ),
              Effect.andThen(Effect.fail(error))
            )
          const clearReplay = deps.replayStore.clear(prepared.replayScope.modelName, prepared.replayScope.sessionKey)

          const page = Effect.gen(function* () {
            const text = yield* turn.read
            const nowMs = yield* Clock.currentTimeMillis
            const event = tryParseJson(restoreCodexMultiAgentV2Response(text, prepared.multiAgentV2))
            context.usage.observeResponseModel(responseModelOf(event))
            if (!context.usage.ttftObserved) context.usage.observeTokenEvent(nowMs, isResponsesTokenEvent(text))

            const wsError = parseCodexWebsocketError(event, { modelLevelCooling, nowMs })
            if (wsError !== undefined) return yield* fail(wsError.error)
            const failure = codexTerminalFailure(event, { modelLevelCooling, nowMs })
            if (failure !== undefined) return yield* fail(failure.error)

            if (hasMeaningfulOutputDelta(event)) sawOutputDelta = true
            if (isTerminalEmptyIncomplete(event, collector.count, sawOutputDelta)) {
              return yield* fail(codexEmptyIncompleteStreamError())
            }
            const type = asString(get(event, "type"))
            if (type === "response.output_item.done") collector.collect(event)
            if (
              (type === "response.completed" || type === "response.done" || type === "response.incomplete") &&
              isJsonObject(event)
            ) {
              const completed = normalizeCodexCompletion(event)
              if (!prepared.nativeOutput) patchCodexCompletedOutput(completed, collector)
              if (type !== "response.incomplete")
                yield* cacheReplayFromCompleted(deps.replayStore, prepared.replayScope, completed)
              const detail = parseCodexUsage(completed)
              if (detail !== undefined) context.usage.publish(detail)
              turn.complete()
              return [[ensureResponsesUsageDetails(JSON.stringify(completed))], Option.none<void>()] as const
            }
            const out = text.includes('"usage"') ? ensureResponsesUsageDetails(text) : text
            return [[out], Option.some<void>(undefined)] as const
          })
          return Stream.paginate(undefined as void, () => page).pipe(
            Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
          )
        })
      )
      return { headers: new Headers(), chunks } satisfies StreamResult
    })
