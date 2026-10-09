/**
 * Claude message helpers shared by non-Claude targets.
 *
 * Go source: internal/translator/common/claude_system.go (SystemReminderText, ClaudeMessageSystemReminderText),
 * internal/translator/common/claude_messages.go (AlignClaudeToolResults), internal/util/claude_attribution.go
 * (IsClaudeCodeAttributionSystemText).
 */
import { asString, get, isJsonArray, type Json } from "../../json/index.ts"

const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:"

/** Go `strings.TrimLeftFunc(text, unicode.IsSpace)` + prefix test. */
export const isClaudeCodeAttributionSystemText = (text: string): boolean =>
  text.trimStart().startsWith(ATTRIBUTION_PREFIX)

/** `SystemReminderText`: wraps text in the `<system-reminder>` envelope. */
export const systemReminderText = (text: string): string => `<system-reminder>\n${text}\n</system-reminder>`

const claudeSystemTextParts = (content: Json | undefined): string[] => {
  if (content === undefined) return []
  if (typeof content === "string") {
    return content === "" || isClaudeCodeAttributionSystemText(content) ? [] : [content]
  }
  if (!isJsonArray(content)) return []
  const parts: string[] = []
  for (const item of content) {
    if (asString(get(item, "type")) !== "text") continue
    const text = asString(get(item, "text"))
    if (text === "" || isClaudeCodeAttributionSystemText(text)) continue
    parts.push(text)
  }
  return parts
}

/** `ClaudeMessageSystemReminderText`: a message-level system value as reminder text, if it has any. */
export const claudeMessageSystemReminderText = (content: Json | undefined): string | undefined => {
  const parts = claudeSystemTextParts(content)
  if (parts.length === 0) return undefined
  const text = parts.join("\n")
  return text.trim() === "" ? undefined : systemReminderText(text)
}

/**
 * `AlignClaudeToolResults`: orders `tool_result` blocks by the preceding `tool_use` ids, keeping other blocks at
 * their indexes. Without a complete one-to-one match the original content is returned.
 */
export const alignClaudeToolResults = (content: Json[], toolUseIds: readonly string[]): Json[] => {
  if (toolUseIds.length === 0) return content
  const results: Json[] = []
  const indices: number[] = []
  content.forEach((part, index) => {
    if (asString(get(part, "type")) === "tool_result") {
      results.push(part)
      indices.push(index)
    }
  })
  if (results.length !== toolUseIds.length) return content
  const reordered: Json[] = []
  const used = results.map(() => false)
  for (const toolUseId of toolUseIds) {
    const matched = results.findIndex(
      (result, i) => !used[i] && toolUseId !== "" && asString(get(result, "tool_use_id")) === toolUseId
    )
    if (matched < 0) return content
    used[matched] = true
    reordered.push(results[matched] as Json)
  }
  const ordered = [...content]
  indices.forEach((slot, i) => {
    ordered[slot] = reordered[i] as Json
  })
  return ordered
}

let toolIdCounter = 0

/** `SanitizeClaudeToolID` (`^[a-zA-Z0-9_-]+$`; an empty result gets a generated fallback). */
export const sanitizeClaudeToolId = (id: string): string => {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/gu, "_")
  return sanitized !== "" ? sanitized : `toolu_${Date.now()}_${++toolIdCounter}`
}
