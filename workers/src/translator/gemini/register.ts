/**
 * Registrations of the Gemini-family translator pairs.
 *
 * Go source: the `init.go` files under internal/translator/gemini/* and internal/translator/interactions/*.
 */
import { Formats } from "../formats.ts"
import type { TranslatorRegistry } from "../registry.ts"
import { convertClaudeRequestToGemini } from "./claude/request.ts"
import { geminiToClaudeResponse } from "./claude/response.ts"
import { convertGeminiRequestToGemini, geminiToGeminiResponse } from "./gemini/gemini.ts"
import { convertOpenAIRequestToGemini } from "./openai/chat-request.ts"
import { geminiToOpenAIResponse } from "./openai/chat-response.ts"

export const registerGeminiTranslators = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry
    .register(Formats.Gemini, Formats.Gemini, convertGeminiRequestToGemini, geminiToGeminiResponse)
    .register(Formats.Claude, Formats.Gemini, convertClaudeRequestToGemini, geminiToClaudeResponse)
    .register(Formats.OpenAI, Formats.Gemini, convertOpenAIRequestToGemini, geminiToOpenAIResponse)
