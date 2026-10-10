/**
 * Antigravity provider -> OpenAI Responses client (response).
 *
 * Go source: internal/translator/antigravity/openai/responses/antigravity_openai-responses_response.go (unwraps the
 * `response` envelope and delegates to the Gemini converters).
 */
import { get, type Json, tryParseJson } from "../../../json/index.ts"
import type { ResponseContext, ResponseTransform } from "../../registry.ts"
import { convertGeminiResponseToOpenAIResponses } from "../../gemini/openai/responses/response.ts"
import { convertGeminiResponseToOpenAIResponsesNonStream } from "../../gemini/openai/responses/response-nonstream.ts"

const unwrapResponse = (text: string): string => {
  const response = get(tryParseJson(text), "response")

  return response === undefined ? text : JSON.stringify(response)
}

/** `ConvertAntigravityResponseToOpenAIResponses`. */
export const convertAntigravityResponseToOpenAIResponses = (
  context: ResponseContext,
  line: string
): ReadonlyArray<string> => convertGeminiResponseToOpenAIResponses(context, unwrapResponse(line))

const unwrapRequest = (request: Json | undefined): Json | undefined => get(request, "request") ?? request

/** `ConvertAntigravityResponseToOpenAIResponsesNonStream`. */
export const convertAntigravityResponseToOpenAIResponsesNonStream = (
  context: ResponseContext,
  body: string
): string | undefined =>
  convertGeminiResponseToOpenAIResponsesNonStream(
    {
      ...context,
      originalRequest: unwrapRequest(context.originalRequest),
      translatedRequest: unwrapRequest(context.translatedRequest)
    },
    unwrapResponse(body)
  )

export const antigravityToOpenAIResponsesResponse: ResponseTransform = {
  stream: convertAntigravityResponseToOpenAIResponses,
  nonStream: convertAntigravityResponseToOpenAIResponsesNonStream
}
