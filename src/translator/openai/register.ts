/** Registers the translator pairs whose provider side is OpenAI-compatible (plus the Interactions pairs of Go's openai package). */
import { Formats } from "../formats.ts"
import type { TranslatorRegistry } from "../registry.ts"
import { convertClaudeRequestToOpenAI } from "./claude/request.ts"
import { openAIToClaudeResponse } from "./claude/response.ts"
import { convertGeminiRequestToOpenAI } from "./gemini/request.ts"
import { openAIToGeminiResponse } from "./gemini/response.ts"
import { convertInteractionsRequestToOpenAI } from "./interactions/chat-completions/request-interactions-to-openai.ts"
import { convertOpenAIRequestToInteractions } from "./interactions/chat-completions/request-openai-to-interactions.ts"
import { interactionsToOpenAIResponse } from "./interactions/chat-completions/response-interactions-to-openai.ts"
import { openAIToInteractionsResponse } from "./interactions/chat-completions/response-openai-to-interactions.ts"
import { convertInteractionsRequestToOpenAIResponses } from "./interactions/responses/request-interactions-to-responses.ts"
import { convertOpenAIResponsesRequestToInteractions } from "./interactions/responses/request-responses-to-interactions.ts"
import { interactionsToOpenAIResponsesResponse } from "./interactions/responses/response-interactions-to-responses.ts"
import { openAIResponsesToInteractionsResponse } from "./interactions/responses/response-responses-to-interactions.ts"
import { convertOpenAIResponsesRequestToOpenAIChatCompletions } from "./openai/responses/request.ts"
import { openAIToOpenAIResponsesResponse } from "./openai/responses/response.ts"

export const registerOpenAICompatTranslators = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry
    .register(Formats.Claude, Formats.OpenAI, convertClaudeRequestToOpenAI, openAIToClaudeResponse)
    .register(Formats.Gemini, Formats.OpenAI, convertGeminiRequestToOpenAI, openAIToGeminiResponse)
    .register(
      Formats.OpenAIResponse,
      Formats.OpenAI,
      convertOpenAIResponsesRequestToOpenAIChatCompletions,
      openAIToOpenAIResponsesResponse
    )
    .register(Formats.OpenAI, Formats.Interactions, convertOpenAIRequestToInteractions, interactionsToOpenAIResponse)
    .register(Formats.Interactions, Formats.OpenAI, convertInteractionsRequestToOpenAI, openAIToInteractionsResponse)
    .register(
      Formats.OpenAIResponse,
      Formats.Interactions,
      convertOpenAIResponsesRequestToInteractions,
      interactionsToOpenAIResponsesResponse
    )
    .register(
      Formats.Interactions,
      Formats.OpenAIResponse,
      convertInteractionsRequestToOpenAIResponses,
      openAIResponsesToInteractionsResponse
    )
