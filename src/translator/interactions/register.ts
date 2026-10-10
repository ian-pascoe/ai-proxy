/**
 * Registrations of the translators whose provider side is Interactions and whose client is not Gemini/OpenAI
 * (Go: internal/translator/interactions/claude/init.go). The Gemini and OpenAI pairs live with their own families.
 */
import { Formats } from "../formats.ts"
import type { TranslatorRegistry } from "../registry.ts"
import { convertClaudeRequestToInteractions } from "./claude/request.ts"
import { interactionsClaudeResponse } from "./claude/response.ts"

export const registerInteractionsTranslators = (registry: TranslatorRegistry): TranslatorRegistry =>
  registry.register(
    Formats.Claude,
    Formats.Interactions,
    convertClaudeRequestToInteractions,
    interactionsClaudeResponse
  )
