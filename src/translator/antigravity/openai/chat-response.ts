/**
 * Antigravity provider -> OpenAI Chat Completions client (response).
 *
 * Go source: internal/translator/antigravity/openai/chat-completions/antigravity_openai_response.go. Stream lines are
 * JSON payloads (the executor strips `data:`); the non-stream conversion delegates to the Gemini one like Go.
 */
import {
  asBool,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson
} from "../../../json/index.ts"
import type { ResponseContext, ResponseTransform } from "../../registry.ts"
import { convertGeminiResponseToOpenAINonStream, usageFields } from "../../gemini/openai/chat-response.ts"
import { disambiguatedToolNameMap, type NameMap, restoreSanitizedToolName } from "../../common/tool-names.ts"
import { hasAntigravityResponsePayload } from "../common/payload.ts"

interface Params {
  unixTimestamp: number
  functionIndex: number
  sawResponse: boolean
  sawToolCall: boolean
  sawFinishReason: boolean
  upstreamFinishReason: string
  modelVersion: string
  responseId: string
  pendingUsageMetadata: Json | undefined
  sanitizedNameMap: NameMap | null
}

let functionCallIdCounter = 0

const functionCallId = (name: string): string => {
  functionCallIdCounter++

  return `${name}-${Date.now()}000000-${functionCallIdCounter}`
}

const paramsOf = (context: ResponseContext): Params => {
  if (context.state.value === undefined) {
    const fresh: Params = {
      unixTimestamp: 0,
      functionIndex: 0,
      sawResponse: false,
      sawToolCall: false,
      sawFinishReason: false,
      upstreamFinishReason: "",
      modelVersion: "",
      responseId: "",
      pendingUsageMetadata: undefined,
      sanitizedNameMap: null
    }

    context.state.value = fresh
  }

  return context.state.value as Params
}

/** `resolveOpenAIFinishReason`. */
const resolveFinishReason = (params: Params): { finishReason: string; nativeFinishReason: string } => {
  let finishReason = "stop"

  if (params.sawToolCall) finishReason = "tool_calls"
  else if (params.upstreamFinishReason === "MAX_TOKENS") finishReason = "max_tokens"

  return {
    finishReason,
    nativeFinishReason: params.upstreamFinishReason !== "" ? params.upstreamFinishReason.toLowerCase() : "stop"
  }
}

const setUsage = (template: JsonObject, usage: Json): void => usageFields(usage, template)

/** `ConvertAntigravityResponseToOpenAI`. */
export const convertAntigravityResponseToOpenAI = (context: ResponseContext, line: string): ReadonlyArray<string> => {
  const params = paramsOf(context)

  if (params.sanitizedNameMap === null) params.sanitizedNameMap = disambiguatedToolNameMap(context.originalRequest)

  if (line === "[DONE]") {
    // Never finalize a stream that produced no response at all.
    if (!params.sawResponse || params.sawFinishReason) return []
    params.sawFinishReason = true
    const { finishReason, nativeFinishReason } = resolveFinishReason(params)

    const template: JsonObject = {
      id: "",
      object: "chat.completion.chunk",
      created: params.unixTimestamp,
      model: "model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }]
    }

    if (params.modelVersion !== "") template["model"] = params.modelVersion

    if (params.responseId !== "") template["id"] = params.responseId

    if (params.pendingUsageMetadata !== undefined) setUsage(template, params.pendingUsageMetadata)
    const choice = (template["choices"] as JsonObject[])[0] as JsonObject
    choice["finish_reason"] = finishReason
    choice["native_finish_reason"] = nativeFinishReason

    return [JSON.stringify(template)]
  }

  const raw = tryParseJson(line)

  if (!params.sawResponse) params.sawResponse = hasAntigravityResponsePayload(raw)

  const delta: JsonObject = { role: null, content: null, reasoning_content: null, tool_calls: null }
  const choice: JsonObject = { index: 0, delta, finish_reason: null, native_finish_reason: null }

  const template: JsonObject = {
    id: "",
    object: "chat.completion.chunk",
    created: 12345,
    model: "model",
    choices: [choice]
  }

  const modelVersion = get(raw, "response.modelVersion")

  if (modelVersion !== undefined) {
    params.modelVersion = asString(modelVersion)
    template["model"] = params.modelVersion
  }

  const createTime = get(raw, "response.createTime")

  if (createTime !== undefined) {
    const ms = Date.parse(asString(createTime))

    if (!Number.isNaN(ms)) params.unixTimestamp = Math.floor(ms / 1000)
  }

  template["created"] = params.unixTimestamp
  const responseId = get(raw, "response.responseId")

  if (responseId !== undefined) {
    params.responseId = asString(responseId)
    template["id"] = params.responseId
  }

  // The finish reason is cached and only emitted on the final chunk.
  const finishReason = get(raw, "response.candidates.0.finishReason")

  if (finishReason !== undefined) params.upstreamFinishReason = asString(finishReason).toUpperCase()

  // FilterSSEUsageMetadata renames non-terminal usage to cpaUsageMetadata: retain the latest copy for [DONE].
  const usage = get(raw, "response.usageMetadata")

  if (usage === undefined) {
    const pending = get(raw, "response.cpaUsageMetadata")

    if (pending !== undefined) params.pendingUsageMetadata = structuredClone(pending)
  } else {
    setUsage(template, usage)
  }

  const parts = get(raw, "response.candidates.0.content.parts")

  if (isJsonArray(parts)) {
    for (const part of parts) {
      const text = get(part, "text")
      const functionCall = get(part, "functionCall")
      const thoughtSignature = get(part, "thoughtSignature") ?? get(part, "thought_signature")
      const inlineData = get(part, "inlineData") ?? get(part, "inline_data")
      const hasThoughtSignature = thoughtSignature !== undefined && asString(thoughtSignature) !== ""
      const hasContentPayload = text !== undefined || functionCall !== undefined || inlineData !== undefined

      // Ignore an encrypted thoughtSignature but keep any actual content in the same part.
      if (hasThoughtSignature && !hasContentPayload) continue

      if (text !== undefined) {
        if (asBool(get(part, "thought"))) delta["reasoning_content"] = asString(text)
        else delta["content"] = asString(text)
        delta["role"] = "assistant"
      } else if (functionCall !== undefined) {
        params.sawToolCall = true
        let index = params.functionIndex
        params.functionIndex++
        const existing = delta["tool_calls"]

        if (isJsonArray(existing)) index = existing.length
        else delta["tool_calls"] = []
        const name = restoreSanitizedToolName(params.sanitizedNameMap, asString(get(functionCall, "name")))

        const call: JsonObject = {
          id: functionCallId(name),
          index,
          type: "function",
          function: { name, arguments: "" }
        }

        const args = get(functionCall, "args")

        if (args !== undefined) (call["function"] as JsonObject)["arguments"] = asString(args)
        delta["role"] = "assistant"
        ;(delta["tool_calls"] as Json[]).push(call)
      } else if (inlineData !== undefined) {
        const data = asString(get(inlineData, "data"))

        if (data === "") continue
        let mimeType = asString(get(inlineData, "mimeType"))

        if (mimeType === "") mimeType = asString(get(inlineData, "mime_type"))

        if (mimeType === "") mimeType = "image/png"

        if (!isJsonArray(delta["images"])) delta["images"] = []
        const images = delta["images"] as Json[]
        delta["role"] = "assistant"
        images.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` }, index: images.length })
      }
    }
  }

  // Only the chunk with both finishReason and usage is terminal; [DONE] synthesises one when upstream never sends it.
  const isFinalChunk = params.upstreamFinishReason !== "" && get(raw, "response.usageMetadata") !== undefined

  if (isFinalChunk) {
    const reasons = resolveFinishReason(params)
    choice["finish_reason"] = reasons.finishReason
    choice["native_finish_reason"] = reasons.nativeFinishReason
    params.sawFinishReason = true
  }

  return [JSON.stringify(template)]
}

/** `restoreAntigravityOpenAIFunctionNames`. */
const restoreFunctionNames = (response: Json, originalRequest: Json | undefined): Json => {
  const nameMap = disambiguatedToolNameMap(originalRequest)

  if (nameMap === undefined) return response
  const candidates = get(response, "candidates")

  if (!isJsonArray(candidates)) return response

  for (const candidate of candidates) {
    const parts = get(candidate, "content.parts")

    if (!isJsonArray(parts)) continue

    for (const part of parts) {
      if (!isJsonObject(part)) continue

      for (const field of ["functionCall", "functionResponse"]) {
        const nameResult = get(part, `${field}.name`)
        const name = asString(nameResult)

        if (name === "") continue
        const restored = restoreSanitizedToolName(nameMap, name)

        if (typeof nameResult === "string" && restored === name) continue
        set(part, `${field}.name`, restored)
      }
    }
  }

  return response
}

/** `ConvertAntigravityResponseToOpenAINonStream`. */
export const convertAntigravityResponseToOpenAINonStream = (context: ResponseContext, body: string): string => {
  const response = get(tryParseJson(body), "response")

  if (response === undefined) return ""
  const restored = restoreFunctionNames(structuredClone(response), context.originalRequest)

  return convertGeminiResponseToOpenAINonStream(context, JSON.stringify(restored))
}

export const antigravityToOpenAIResponse: ResponseTransform = {
  stream: convertAntigravityResponseToOpenAI,
  nonStream: convertAntigravityResponseToOpenAINonStream
}
