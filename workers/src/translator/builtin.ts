/**
 * Built-in translator registrations (Go: internal/translator/init.go imports every pair's `init.go`).
 * Provider slices add their pairs here.
 */
import { Formats } from "./formats.ts"
import { convertOpenAIRequestToOpenAI, openAIToOpenAIResponse } from "./openai/openai/chat-completions.ts"
import { TranslatorRegistry } from "./registry.ts"
import { registerCodexTranslators } from "./codex/register.ts"

/** Registers every built-in pair on `registry`. */
export const registerBuiltinTranslators = (registry: TranslatorRegistry): TranslatorRegistry => {
  registry.register(Formats.OpenAI, Formats.OpenAI, convertOpenAIRequestToOpenAI, openAIToOpenAIResponse)
  registerCodexTranslators(registry)
  return registry
}

/** Process-wide registry populated with the built-in translators (immutable after module load). */
export const builtinTranslators: TranslatorRegistry = registerBuiltinTranslators(new TranslatorRegistry())
