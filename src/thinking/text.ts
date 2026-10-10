/**
 * Thinking text extraction from content parts.
 *
 * Go source: internal/thinking/text.go.
 */
import { get, isJsonObject, type Json } from "../json/index.ts"

/** Handles `{text}` (Gemini style), `{thinking: "text"}` and `{thinking: {text|thinking}}`. */
export const getThinkingText = (part: Json | undefined): string => {
  const text = get(part, "text")

  if (typeof text === "string") return text

  const thinkingField = get(part, "thinking")

  if (thinkingField === undefined) return ""

  if (typeof thinkingField === "string") return thinkingField

  if (isJsonObject(thinkingField)) {
    const innerText = get(thinkingField, "text")

    if (typeof innerText === "string") return innerText
    const innerThinking = get(thinkingField, "thinking")

    if (typeof innerThinking === "string") return innerThinking
  }

  return ""
}
