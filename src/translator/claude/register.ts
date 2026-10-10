/**
 * Registrations of the translators whose provider side is Claude (Go: internal/translator/claude/<client>/init.go).
 * The claude -> claude pair has no translator; the registry fallback forces `model` and passes responses through.
 */
import { Formats } from "../formats.ts";
import type { TranslatorRegistry } from "../registry.ts";
import { convertGeminiRequestToClaude } from "./gemini/request.ts";
import { claudeToGeminiResponse } from "./gemini/response.ts";
import { convertInteractionsRequestToClaude } from "./interactions/request.ts";
import { claudeToInteractionsResponse } from "./interactions/response.ts";
import { convertOpenAIResponsesRequestToClaude } from "./openai/responses/request.ts";
import { claudeToOpenAIResponsesResponse } from "./openai/responses/response.ts";
import { convertOpenAIRequestToClaude } from "./openai/chat-completions/request.ts";
import { claudeToOpenAIResponse } from "./openai/chat-completions/response.ts";

export const registerClaudeTranslators = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry
    .register(Formats.OpenAI, Formats.Claude, convertOpenAIRequestToClaude, claudeToOpenAIResponse)
    .register(Formats.Gemini, Formats.Claude, convertGeminiRequestToClaude, claudeToGeminiResponse)
    .register(
      Formats.Interactions,
      Formats.Claude,
      convertInteractionsRequestToClaude,
      claudeToInteractionsResponse,
    )
    .register(
      Formats.OpenAIResponse,
      Formats.Claude,
      convertOpenAIResponsesRequestToClaude,
      claudeToOpenAIResponsesResponse,
    );
