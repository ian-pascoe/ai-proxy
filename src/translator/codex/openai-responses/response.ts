/**
 * Codex response -> OpenAI Responses (near passthrough).
 *
 * Go source: internal/translator/codex/openai/responses/codex_openai-responses_response.go. Native Codex never
 * opts into the apply_patch bridge, so only the `response.model` backfill and the non-stream unwrapping remain.
 */
import { asString, get, isJsonArray, type Json, set, tryParseJson } from "../../../json/index.ts"
import { requestModelNameOf } from "../../common/request.ts"
import type { ResponseContext } from "../../registry.ts"

/** `setResponsesModel`: `response.created`/`in_progress` events without a model get the request's model. */
const setResponsesModel = (root: Json, modelName: string, context: ResponseContext): Json | undefined => {
  const eventType = asString(get(root, "type"))
  if (eventType !== "response.created" && eventType !== "response.in_progress") return undefined
  if (get(root, "response.model") !== undefined) return undefined
  let name = requestModelNameOf(context.originalRequest, context.translatedRequest)
  if (name === "") name = modelName
  if (name === "") return undefined
  return set(root, "response.model", name)
}

/** `ConvertCodexResponseToOpenAIResponses`. */
export const convertCodexResponseToOpenAIResponses = (
  context: ResponseContext,
  line: string
): ReadonlyArray<string> => {
  const sse = line.startsWith("data:")
  const payload = sse ? line.slice(5).trim() : line
  const root = tryParseJson(payload)
  if (root === undefined) return [line]
  const updated = setResponsesModel(root, context.model, context)
  if (updated === undefined) return [line]
  const text = JSON.stringify(updated)
  return [sse ? `data: ${text}` : text]
}

/** `ConvertCodexResponseToOpenAIResponsesNonStream`. */
export const convertCodexResponseToOpenAIResponsesNonStream = (_context: ResponseContext, body: string): string => {
  const root = tryParseJson(body)
  const responseType = asString(get(root, "type"))
  if (responseType === "" && isJsonArray(get(root, "output"))) return body
  if (responseType !== "response.completed" && responseType !== "response.incomplete") return ""
  const response = get(root, "response")
  return response === undefined ? "" : JSON.stringify(response)
}
