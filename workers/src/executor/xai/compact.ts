/**
 * xAI compaction helpers: a streaming request whose `input` carries a `compaction_trigger` item is executed through
 * `/responses/compact` and re-emitted as a synthetic Responses SSE stream.
 *
 * Go source: internal/runtime/executor/xai_executor_execute.go (xaiBuildCompactionTriggerStreamChunks,
 * xaiBuildCompactionBaseResponse, xaiCompactionOutputItem, xaiCompactionResponseID, xaiCompactionItemID,
 * xaiBuildSSEFrame).
 */
import { asInt, asString, cloneJson, get, isJsonObject, type Json, type JsonObject } from "../../json/index.ts"
import { sseEvent } from "../../http/sse.ts"
import { ensureResponsesUsageDetails } from "../codex/output.ts"

/** Fields of the prepared request echoed into the synthetic response objects. */
const ECHOED_FIELDS = [
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "metadata"
]

/** `xaiCompactionResponseID`: `resp_<id>` (a `cmp_` prefix is replaced). */
export const compactionResponseId = (compact: Json, nowMs: number): string => {
  const id = asString(get(compact, "id")).trim()
  if (id !== "") return id.startsWith("resp_") ? id : `resp_${id.replace(/^cmp_/, "")}`
  return `resp_xai_compaction_${nowMs}000000`
}

/** `xaiCompactionItemID`. */
export const compactionItemId = (responseId: string): string => {
  const suffix = responseId.startsWith("resp_") ? responseId.slice("resp_".length) : responseId
  return suffix !== "" && suffix !== responseId ? `cmp_${suffix}` : `cmp_${responseId}`
}

const compactionOutputItem = (compact: Json, responseId: string): JsonObject => {
  const first = get(compact, "output.0")
  const item: JsonObject = isJsonObject(first) ? cloneJson(first) : { type: "compaction" }
  if (item["type"] === undefined) item["type"] = "compaction"
  if (item["id"] === undefined) item["id"] = compactionItemId(responseId)
  return item
}

const baseResponse = (
  body: Json,
  compact: Json,
  baseModel: string,
  responseId: string,
  createdAt: number,
  status: string
): JsonObject => {
  const response: JsonObject = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    output: []
  }
  const model = asString(get(compact, "model"))
  if (model !== "") response["model"] = model
  else if (baseModel !== "") response["model"] = baseModel
  for (const field of ECHOED_FIELDS) {
    const value = get(body, field)
    if (value !== undefined) response[field] = cloneJson(value)
  }
  return response
}

export interface CompactionStreamInput {
  /** The prepared (final) compact request body. */
  readonly body: Json
  readonly baseModel: string
  /** The client's model name (original payload), when present. */
  readonly requestModel: string
  /** The upstream compact answer. */
  readonly compact: Json
  readonly nowMs: number
}

const frame = (name: string, payload: Json | string): string =>
  sseEvent(name, typeof payload === "string" ? payload : JSON.stringify(payload))

/** `xaiBuildCompactionTriggerStreamChunks`: six SSE frames. */
export const buildCompactionTriggerStreamChunks = (input: CompactionStreamInput): string[] => {
  const { compact, body, baseModel, nowMs } = input
  const nowSec = Math.floor(nowMs / 1000)
  const responseId = compactionResponseId(compact, nowMs)
  let createdAt = asInt(get(compact, "created_at"))
  if (createdAt === 0) createdAt = nowSec
  let completedAt = asInt(get(compact, "completed_at"))
  if (completedAt === 0) completedAt = nowSec

  const item = compactionOutputItem(compact, responseId)
  const created = baseResponse(body, compact, baseModel, responseId, createdAt, "in_progress")
  const inProgress = baseResponse(body, compact, baseModel, responseId, createdAt, "in_progress")
  const completed = baseResponse(body, compact, baseModel, responseId, createdAt, "completed")
  let requestModelName = input.requestModel !== "" ? input.requestModel : baseModel
  if (requestModelName === "") requestModelName = asString(get(compact, "model"))
  if (requestModelName !== "") {
    created["model"] = requestModelName
    inProgress["model"] = requestModelName
  }
  completed["completed_at"] = completedAt
  completed["output"] = [item]
  const usage = get(compact, "usage")
  if (isJsonObject(usage)) completed["usage"] = cloneJson(usage)

  const completedEvent = ensureResponsesUsageDetails(
    JSON.stringify({ type: "response.completed", sequence_number: 5, response: completed })
  )
  return [
    frame("response.created", { type: "response.created", sequence_number: 0, response: created }),
    frame("response.in_progress", { type: "response.in_progress", sequence_number: 1, response: inProgress }),
    frame("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item
    }),
    frame("keepalive", { type: "keepalive", sequence_number: 3 }),
    frame("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item
    }),
    frame("response.completed", completedEvent)
  ]
}
