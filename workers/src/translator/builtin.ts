/**
 * Built-in translator registrations (Go: internal/translator/init.go imports every pair's `init.go`).
 * Provider slices add their pairs here.
 */
import { registerClaudeTranslators } from "./claude/register.ts"
import { Formats } from "./formats.ts"
import { registerGeminiTranslators } from "./gemini/register.ts"
import { convertOpenAIRequestToOpenAI, openAIToOpenAIResponse } from "./openai/openai/chat-completions.ts"
import { registerInteractionsTranslators } from "./interactions/register.ts"
import { registerOpenAICompatTranslators } from "./openai/register.ts"
import { TranslatorRegistry } from "./registry.ts"
import { registerCodexTranslators } from "./codex/register.ts"

/** Registers every built-in pair on `registry`. */
export const registerBuiltinTranslators = (registry: TranslatorRegistry): TranslatorRegistry => {
  registry.register(Formats.OpenAI, Formats.OpenAI, convertOpenAIRequestToOpenAI, openAIToOpenAIResponse)
  registerCodexTranslators(registry)
  registerClaudeTranslators(registry)
  registerGeminiTranslators(registry)
  registerInteractionsTranslators(registry)
  registerOpenAICompatTranslators(registry)
  return registry
}

/** Process-wide registry populated with the built-in translators (immutable after module load). */
export const builtinTranslators: TranslatorRegistry = registerBuiltinTranslators(new TranslatorRegistry())
