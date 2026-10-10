/**
 * OpenAI Chat Completions client -> OpenAI-compatible provider (near passthrough).
 *
 * Go source: internal/translator/openai/openai/chat-completions/{init.go,openai_openai_request.go,
 * openai_openai_response.go}.
 */
import { get, type Json, set } from "../../../json/index.ts"
import type { ResponseContext, ResponseTransform } from "../../registry.ts"

/** `ConvertOpenAIRequestToOpenAI`: only forces `model`. */
export const convertOpenAIRequestToOpenAI = (model: string, body: Json, _stream: boolean): Json => {
  if (get(body, "model") === model) return body
  try {
    return set(body, "model", model)
  } catch {
    return body
  }
}

/**
 * `ConvertOpenAIResponseToOpenAI`: strips the `data:` prefix and swallows `[DONE]`; the state remembers `[DONE]` so
 * trailing provider chunks (e.g. OpenRouter cost frames) are dropped.
 */
export const convertOpenAIResponseToOpenAI = (context: ResponseContext, line: string): ReadonlyArray<string> => {
  if (context.state.value === true) return []
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line
  if (payload === "[DONE]") {
    context.state.value = true
    return []
  }
  return [payload]
}

/** `ConvertOpenAIResponseToOpenAINonStream`: passthrough. */
export const convertOpenAIResponseToOpenAINonStream = (_context: ResponseContext, body: string): string => body

export const openAIToOpenAIResponse: ResponseTransform = {
  stream: convertOpenAIResponseToOpenAI,
  nonStream: convertOpenAIResponseToOpenAINonStream
}
