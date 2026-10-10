/**
 * Codex (Responses) stream/non-stream response -> Gemini generateContent.
 *
 * Go source: internal/translator/codex/gemini/codex_gemini_response.go (ConvertCodexResponseToGemini,
 * ...NonStream, GeminiTokenCount). Timestamps are formatted in UTC (Go formats in the process' local zone).
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson
} from "../../../json/index.ts"
import { geminiTokenCountJson } from "../../common/bytes.ts"
import type { ResponseContext } from "../../registry.ts"
import { geminiShortNameMap } from "./request.ts"

/** Go `ConvertCodexResponseToGeminiParams`. */
interface GeminiParams {
  model: string
  createdAt: number
  responseId: string
  lastStorageOutput: string | undefined
  hasOutputTextDelta: boolean
  readonly lastImageById: Map<string, string>
}

/** `time.Unix(sec, 0).Format(time.RFC3339Nano)` in UTC. */
const rfc3339 = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z")

const mimeTypeFromOutputFormat = (outputFormat: string): string => {
  if (outputFormat === "") return "image/png"
  if (outputFormat.includes("/")) return outputFormat
  switch (outputFormat.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    default:
      return "image/png"
  }
}

const incompleteFinishReason = (reason: string): string => {
  switch (reason) {
    case "max_tokens":
    case "max_output_tokens":
      return "MAX_TOKENS"
    case "content_filter":
      return "SAFETY"
    default:
      return "OTHER"
  }
}

/** `buildReverseMapFromGeminiOriginal`: shortened -> original tool names. */
const reverseNames = (original: Json | undefined): Map<string, string> => {
  const reverse = new Map<string, string>()
  for (const [name, short] of geminiShortNameMap(original)) reverse.set(short, name)
  return reverse
}

const setFunctionCallId = (functionCall: Json, item: Json | undefined): Json => {
  const callId = asString(get(item, "call_id")).trim()
  if (callId !== "") return set(functionCall, "functionCall.id", callId)
  const id = asString(get(item, "id")).trim()
  return id !== "" ? set(functionCall, "functionCall.id", id) : functionCall
}

const inlineDataPart = (b64: string, outputFormat: string): JsonObject => ({
  inlineData: { data: b64, mimeType: mimeTypeFromOutputFormat(outputFormat) }
})

const functionCallPart = (item: Json | undefined, original: Json | undefined, argsFirst: boolean): Json => {
  const n = asString(get(item, "name"))
  const name = reverseNames(original).get(n) ?? n
  let functionCall: Json = argsFirst
    ? { functionCall: { args: {}, name: "" } }
    : { functionCall: { name: "", args: {} } }
  functionCall = set(functionCall, "functionCall.name", name)
  const argsText = asString(get(item, "arguments"))
  if (argsText !== "") {
    const args = tryParseJson(argsText)
    if (isJsonObject(args)) functionCall = set(functionCall, "functionCall.args", args)
  }
  return setFunctionCallId(functionCall, item)
}

const baseTemplate = (): Json => ({
  candidates: [{ content: { role: "model", parts: [] } }],
  usageMetadata: { trafficType: "PROVISIONED_THROUGHPUT" },
  modelVersion: "gemini-2.5-pro",
  createTime: "2025-08-15T02:52:03.884209Z",
  responseId: "06CeaPH7NaCU48APvNXDyA4"
})

/** `ConvertCodexResponseToGemini`. */
export const convertCodexResponseToGemini = (context: ResponseContext, line: string): ReadonlyArray<string> => {
  if (context.state.value === undefined) {
    const initial: GeminiParams = {
      model: context.model,
      createdAt: 0,
      responseId: "",
      lastStorageOutput: undefined,
      hasOutputTextDelta: false,
      lastImageById: new Map()
    }
    context.state.value = initial
  }
  const params = context.state.value as GeminiParams
  if (!line.startsWith("data:")) return []
  const root = tryParseJson(line.slice(5).trim())
  const type = asString(get(root, "type"))
  const original = context.originalRequest

  let template = baseTemplate()
  template = set(template, "modelVersion", params.model)
  const createdAt = get(root, "response.created_at")
  if (createdAt !== undefined) {
    params.createdAt = asInt(createdAt)
    template = set(template, "createTime", rfc3339(params.createdAt))
  }
  template = set(template, "responseId", params.responseId)

  const emitImage = (itemId: string, b64: string, outputFormat: string): ReadonlyArray<string> => {
    if (b64 === "") return []
    if (itemId !== "") {
      if (params.lastImageById.get(itemId) === b64) return []
      params.lastImageById.set(itemId, b64)
    }
    template = set(template, "candidates.0.content.parts", [inlineDataPart(b64, outputFormat)])
    return [JSON.stringify(template)]
  }

  if (type === "response.image_generation_call.partial_image") {
    return emitImage(
      asString(get(root, "item_id")),
      asString(get(root, "partial_image_b64")),
      asString(get(root, "output_format"))
    )
  }

  if (type === "response.output_item.done") {
    const item = get(root, "item")
    const itemType = asString(get(item, "type"))
    if (itemType === "image_generation_call") {
      return emitImage(asString(get(item, "id")), asString(get(item, "result")), asString(get(item, "output_format")))
    }
    if (itemType === "function_call") {
      template = set(template, "candidates.0.content.parts", [functionCallPart(item, original, false)])
      template = set(template, "candidates.0.finishReason", "STOP")
      // Held back until the next chunk so the finish reason can be emitted with the last call.
      params.lastStorageOutput = JSON.stringify(template)
      return []
    }
  }

  if (type === "response.created") {
    template = set(template, "modelVersion", asString(get(root, "response.model")))
    template = set(template, "responseId", asString(get(root, "response.id")))
    params.responseId = asString(get(root, "response.id"))
  } else if (type === "response.reasoning_summary_text.delta") {
    template = set(template, "candidates.0.content.parts", [{ thought: true, text: asString(get(root, "delta")) }])
  } else if (type === "response.output_text.delta") {
    params.hasOutputTextDelta = true
    template = set(template, "candidates.0.content.parts", [{ text: asString(get(root, "delta")) }])
  } else if (type === "response.output_item.done") {
    const item = get(root, "item")
    if (asString(get(item, "type")) !== "message" || params.hasOutputTextDelta) return []
    const content = get(item, "content")
    if (!isJsonArray(content)) return []
    let wroteText = false
    for (const part of content) {
      if (asString(get(part, "type")) !== "output_text") continue
      const text = asString(get(part, "text"))
      if (text === "") continue
      template = set(template, "candidates.0.content.parts.-1", { text })
      wroteText = true
    }
    if (!wroteText) return []
    params.hasOutputTextDelta = true
    return [JSON.stringify(template)]
  } else if (type === "response.completed" || type === "response.incomplete") {
    const input = asInt(get(root, "response.usage.input_tokens"))
    const output = asInt(get(root, "response.usage.output_tokens"))
    template = set(template, "usageMetadata.promptTokenCount", input)
    template = set(template, "usageMetadata.candidatesTokenCount", output)
    template = set(template, "usageMetadata.totalTokenCount", input + output)
    if (type === "response.incomplete") {
      template = set(
        template,
        "candidates.0.finishReason",
        incompleteFinishReason(asString(get(root, "response.incomplete_details.reason")))
      )
    }
  } else {
    return []
  }

  if (params.lastStorageOutput !== undefined && params.lastStorageOutput !== "") {
    const stored = params.lastStorageOutput
    params.lastStorageOutput = undefined
    return [stored, JSON.stringify(template)]
  }
  return [JSON.stringify(template)]
}

/** `ConvertCodexResponseToGeminiNonStream`. */
export const convertCodexResponseToGeminiNonStream = (context: ResponseContext, body: string): string => {
  const root = tryParseJson(body)
  const responseType = asString(get(root, "type"))
  if (responseType !== "response.completed" && responseType !== "response.incomplete") return ""
  const original = context.originalRequest

  let template: Json = {
    candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
    usageMetadata: { trafficType: "PROVISIONED_THROUGHPUT" },
    modelVersion: "",
    createTime: "",
    responseId: ""
  }
  template = set(template, "modelVersion", context.model)
  const responseData = get(root, "response")
  if (responseData !== undefined) {
    if (responseType === "response.incomplete") {
      template = set(
        template,
        "candidates.0.finishReason",
        incompleteFinishReason(asString(get(responseData, "incomplete_details.reason")))
      )
    }
    const id = get(responseData, "id")
    if (id !== undefined) template = set(template, "responseId", asString(id))
    const createdAt = get(responseData, "created_at")
    if (createdAt !== undefined) template = set(template, "createTime", rfc3339(asInt(createdAt)))
    const usage = get(responseData, "usage")
    if (usage !== undefined) {
      const input = asInt(get(usage, "input_tokens"))
      const output = asInt(get(usage, "output_tokens"))
      template = set(template, "usageMetadata.promptTokenCount", input)
      template = set(template, "usageMetadata.candidatesTokenCount", output)
      template = set(template, "usageMetadata.totalTokenCount", input + output)
    }

    const parts: Json[] = []
    let pendingFunctionCalls: Json[] = []
    const flush = () => {
      parts.push(...pendingFunctionCalls)
      pendingFunctionCalls = []
    }
    const output = get(responseData, "output")
    if (isJsonArray(output)) {
      for (const value of output) {
        switch (asString(get(value, "type"))) {
          case "reasoning": {
            flush()
            const content = get(value, "content")
            if (content !== undefined) parts.push({ text: asString(content), thought: true })
            break
          }
          case "message": {
            flush()
            const content = get(value, "content")
            if (isJsonArray(content)) {
              for (const item of content) {
                if (asString(get(item, "type")) !== "output_text") continue
                const text = get(item, "text")
                if (text !== undefined) parts.push({ text: asString(text) })
              }
            }
            break
          }
          case "image_generation_call": {
            flush()
            const b64 = asString(get(value, "result"))
            if (b64 !== "") parts.push(inlineDataPart(b64, asString(get(value, "output_format"))))
            break
          }
          case "function_call":
            pendingFunctionCalls.push(functionCallPart(value, original, true))
            break
        }
      }
      flush()
      if (parts.length > 0) template = set(template, "candidates.0.content.parts", parts)
    }
  }
  return JSON.stringify(template)
}

/** `GeminiTokenCount`. */
export const geminiTokenCount = (count: number): string => geminiTokenCountJson(count)
