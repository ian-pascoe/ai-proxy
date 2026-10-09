/**
 * xAI Responses WebSocket transport (upstream), used for downstream WebSocket requests with a credential that has
 * `websockets` enabled.
 *
 * Go source: internal/runtime/executor/xai_websockets_executor.go (XAIWebsocketsExecutor.ExecuteStream,
 * buildXAIWebsocketRequestBody, buildXAIResponsesWebsocketURL, applyXAIWebsocketHeaders, parseXAIWebsocketError,
 * xaiBareWebsocketErrorStatus, buildXAIWebsocketWarmupCompletedPayload, XAIAutoExecutor routing).
 *
 * The request pipeline is the HTTP one (`executor.ts` `prepare`) plus the WebSocket framing: `type: "response.create"`,
 * no `stream`/`stream_options`/`background`, `store: true`, `instructions` dropped when continuing a response; user
 * payload rules run on that final body and only `type` is re-forced afterwards. WebSocket requests always use the
 * official API base URL (or an explicit `base_url`): the CLI chat proxy answers 405 to upgrades. Events pass through the
 * same reasoning-summary normalisation and namespace/alias/X Search pipeline as the SSE path and are forwarded as bare
 * JSON chunks. `generate: false` warm-ups end after `response.created` with a synthesised `response.completed`.
 *
 * Not ported: `compaction_trigger` over the socket (it runs through the HTTP `/responses/compact` path with the input the
 * client sent; Go builds the compaction input from the socket transcript), the apply_patch bridge and the Claude
 * stream input-token estimate.
 */
import { Clock, Effect, Option, Stream } from "effect"
import {
  asInt,
  asString,
  cloneJson,
  del,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson
} from "../../json/index.ts"
import { responseModelOf } from "../../usage/record.ts"
import { isResponsesTokenEvent } from "../../usage/ttft.ts"
import { ensureResponsesUsageDetails, OutputItemCollector, parseCodexUsage } from "../codex/output.ts"
import { ExecutionError } from "../errors.ts"
import type { Thinking } from "../thinking.ts"
import type { ExecutionContext, ExecutorOptions, ExecutorRequest, StreamResult } from "../types.ts"
import { websocketUrl } from "../websocket/connector.ts"
import { openTurn, type UpstreamSessionStore, xaiSessionStore } from "../websocket/session.ts"
import { joinUrl, XAI_DEFAULT_API_BASE_URL, xaiCreds } from "./credentials.ts"
import { xaiStatusError } from "./errors.ts"
import { buildXaiWebsocketHeaders } from "./headers.ts"
import type { PreparedRequest } from "./executor.ts"
import { cacheReplayFromCompleted, type XaiReplayStore } from "./replay.ts"
import { normalizeReasoningSummaryEvent, normalizeReasoningSummaryEvents, patchCompletedOutput } from "./response.ts"
import { type XaiIdStateStore, XaiRequestIdMapper, xaiIdStates } from "./websocket-ids.ts"

const WARMUP_USAGE = {
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0
}

/** `buildXAIWebsocketRequestBody`; `finalize` is the payload-rule barrier and runs on the framed body. */
export const buildXaiWebsocketBody = (body: JsonObject, finalize: (body: Json) => Json): Json => {
  let out: Json = cloneJson(body)
  out = set(out, "type", "response.create")
  for (const field of ["stream", "stream_options", "background"]) out = del(out, field)
  out = set(out, "store", true)
  if (asString(get(out, "previous_response_id")).trim() !== "") out = del(out, "instructions")
  out = finalize(out)
  return set(out, "type", "response.create")
}

/** `buildXAIWebsocketWarmupCompletedPayload`: the `response.completed` of a `generate: false` request. */
export const buildWarmupCompletedPayload = (created: Json): JsonObject => {
  const completed: JsonObject = { type: "response.completed", response: { output: [], usage: cloneJson(WARMUP_USAGE) } }
  const sequence = get(created, "sequence_number")
  if (sequence !== undefined) completed["sequence_number"] = asInt(sequence) + 1
  const response = get(created, "response")
  if (isJsonObject(response)) {
    const copy = cloneJson(response)
    copy["status"] = "completed"
    if (copy["output"] === undefined) copy["output"] = []
    if (copy["usage"] === undefined) copy["usage"] = cloneJson(WARMUP_USAGE)
    completed["response"] = copy
  }
  const out = tryParseJson(ensureResponsesUsageDetails(JSON.stringify(completed)))
  return isJsonObject(out) ? out : completed
}

/** `xaiBareWebsocketErrorStatus`. */
const bareErrorStatus = (event: Json): number => {
  for (const path of ["error.code", "error.status", "code"]) {
    const raw = asString(get(event, path)).trim()
    if (raw === "") continue
    const status = Number.parseInt(raw, 10)
    if (Number.isFinite(status) && status > 0 && String(status) === raw) return status
  }
  const message = asString(get(event, "error.message")).trim()
  if (message.includes('"code":"400"') || message.includes("Request validation error")) return 400
  return 500
}

/**
 * `parseXAIWebsocketError`: Codex-style `{"type":"error","status":N,...}` frames or a bare `{"error":{...}}`; the
 * status goes through the xAI classification (403 bad credentials -> 401, free usage cooldown).
 */
export const parseXaiWebsocketError = (event: Json | undefined, payload: string): ExecutionError | undefined => {
  if (event === undefined) return undefined
  if (asString(get(event, "type")).trim() === "error") {
    let status = asInt(get(event, "status"))
    if (status === 0) status = asInt(get(event, "status_code"))
    if (status > 0) return xaiStatusError(status, payload)
  }
  const errorNode = get(event, "error")
  if (errorNode === undefined) return undefined
  let status = asInt(get(event, "status"))
  if (status <= 0) status = asInt(get(event, "status_code"))
  if (status <= 0) status = bareErrorStatus(event)
  return xaiStatusError(status, JSON.stringify({ type: "error", status, error: errorNode }))
}

export interface XaiWebsocketDeps {
  readonly prepare: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    mode: { readonly stream: boolean; readonly to: string; readonly websocket: boolean }
  ) => Effect.Effect<PreparedRequest, ExecutionError, Thinking>
  readonly finalize: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
    prepared: PreparedRequest,
    body: Json
  ) => Json
  readonly replayStore: XaiReplayStore
  readonly codexTarget: string
  readonly store?: UpstreamSessionStore
  readonly idStates?: XaiIdStateStore
}

/** The Go `XAIWebsocketsExecutor.ExecuteStream` path. */
export const makeXaiWebsocketStream =
  (deps: XaiWebsocketDeps) => (context: ExecutionContext, request: ExecutorRequest, options: ExecutorOptions) =>
    Effect.gen(function* () {
      const websocket = options.metadata.websocket
      const sessionId = websocket?.sessionId
      const prepared = yield* deps.prepare(context, request, options, {
        stream: true,
        to: deps.codexTarget,
        websocket: true
      })
      const previousResponseId = asString(get(request.payload, "previous_response_id")).trim()
      let body: JsonObject = isJsonObject(prepared.body) ? prepared.body : {}
      if (previousResponseId !== "") body = { ...body, previous_response_id: previousResponseId }
      // The client's frame type is only read for `response.append` (Go reads it from the raw request payload).
      const requestType = asString(get(request.payload, "type")).trim()
      if (requestType !== "") body = { ...body, type: requestType }

      const { baseURL } = xaiCreds(context.credential)
      const url = websocketUrl(joinUrl(baseURL === "" ? XAI_DEFAULT_API_BASE_URL : baseURL, "/responses"))
      const store = deps.store ?? xaiSessionStore
      const state = sessionId === undefined ? undefined : (deps.idStates ?? xaiIdStates).get(sessionId)
      const mapper = state === undefined ? undefined : new XaiRequestIdMapper(state, request.payload)
      if (mapper !== undefined) {
        const session = sessionId === undefined ? undefined : store.peek(sessionId)
        // A different credential/URL means a different upstream connection: its response ids are unknown there.
        if (session?.socket !== undefined && (session.authId !== context.credential.id || session.url !== url)) {
          mapper.upstreamPreviousId = ""
        }
        body = mapper.upstreamRequestPayload(body)
      }
      const frameBody = buildXaiWebsocketBody(body, (framed) =>
        deps.finalize(context, request, options, prepared, framed)
      )
      const frame = JSON.stringify(frameBody)
      const effort = asString(get(frameBody, "reasoning.effort"))
      context.usage.setReasoningEffort(effort !== "" ? effort : undefined)
      const headers = buildXaiWebsocketHeaders({
        credential: context.credential,
        clientHeaders: options.headers,
        stream: true,
        convId: prepared.sessionId,
        ...(options.metadata.sessionId !== undefined ? { sessionId: options.metadata.sessionId } : {})
      })
      const warmupRequest = get(frameBody, "generate") === false
      const transcriptReset =
        asString(get(frameBody, "previous_response_id")).trim() === "" &&
        (requestType !== "response.append" || mapper?.replayedCompactedTranscript === true)

      const chunks = Stream.unwrap(
        Effect.gen(function* () {
          const turn = yield* openTurn({
            store,
            sessionId,
            authId: context.credential.id,
            url,
            headers,
            frame: () => frame,
            requireUpstream: websocket?.requireUpstream === true,
            label: "xai",
            classifyHandshake: xaiStatusError
          })
          context.usage.recordFirstPacket(yield* Clock.currentTimeMillis)
          const collector = new OutputItemCollector()
          let recordedTranscript = false
          const fail = (error: ExecutionError) => turn.invalidate.pipe(Effect.andThen(Effect.fail(error)))

          const page = Effect.gen(function* () {
            const text = yield* turn.read
            const nowMs = yield* Clock.currentTimeMillis
            const parsed = tryParseJson(text)
            context.usage.markFirstByte(nowMs)
            const wsError = parseXaiWebsocketError(parsed, text)
            if (wsError !== undefined) return yield* fail(wsError)
            if (parsed === undefined) return [[text], Option.some<void>(undefined)] as const

            const out: string[] = []
            let terminal = false
            for (const raw of normalizeReasoningSummaryEvents(parsed)) {
              let event = prepared.pipeline.process(raw)
              if (event === undefined) continue
              const type = asString(get(event, "type"))
              context.usage.observeResponseModel(responseModelOf(event))
              if (!context.usage.ttftObserved) context.usage.observeTokenEvent(nowMs, isResponsesTokenEvent(text))
              let warmupCompleted: JsonObject | undefined
              switch (type) {
                case "response.created":
                  if (warmupRequest) {
                    warmupCompleted = buildWarmupCompletedPayload(event)
                    if (state !== undefined && !recordedTranscript) {
                      state.recordTranscriptTurn(frameBody, warmupCompleted, transcriptReset)
                      recordedTranscript = true
                    }
                  }
                  break
                case "response.output_item.done":
                  collector.collect(event)
                  break
                case "response.completed":
                case "response.done": {
                  if (!isJsonObject(event)) break
                  const detail = parseCodexUsage(event)
                  if (detail !== undefined) context.usage.publish(detail)
                  if (type === "response.completed") {
                    event = normalizeReasoningSummaryEvent(patchCompletedOutput(event, collector))
                    if (previousResponseId === "")
                      yield* cacheReplayFromCompleted(deps.replayStore, prepared.replayScope, event)
                  }
                  if (!warmupRequest && state !== undefined && !recordedTranscript) {
                    state.recordTranscriptTurn(frameBody, event, transcriptReset)
                    recordedTranscript = true
                  }
                  terminal = true
                  break
                }
              }
              const downstream = (value: JsonObject): string => {
                const ensured = tryParseJson(ensureResponsesUsageDetails(JSON.stringify(value)))
                const payload = isJsonObject(ensured) ? ensured : value
                return JSON.stringify(mapper === undefined ? payload : mapper.downstreamResponsePayload(payload))
              }
              if (isJsonObject(event)) out.push(downstream(event))
              if (warmupCompleted !== undefined) {
                out.push(downstream(warmupCompleted))
                terminal = true
              }
            }
            if (terminal) {
              turn.complete()
              return [out, Option.none<void>()] as const
            }
            return [out, Option.some<void>(undefined)] as const
          })
          return Stream.paginate(undefined as void, () => page).pipe(
            Stream.tapError((error) => Effect.sync(() => context.usage.fail(error.status, error.message)))
          )
        })
      )
      return { headers: new Headers(), chunks } satisfies StreamResult
    })
