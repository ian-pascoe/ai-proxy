/**
 * Go sources: internal/util/claude_attribution.go (IsClaudeCodeAttributionSystemText),
 * internal/util/claude_schema.go (schema keyword lists, HasUnsupportedUnicodePropertyEscape),
 * internal/translator/common/claude_messages.go (AlignClaudeToolResults) and claude_system.go
 * (SystemReminderText, ClaudeMessageSystemReminderText).
 */
import { type Json, type JsonObject } from "../../../json/index.ts"
import { getStr, isArr, str } from "./read.ts"

const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:"

/** Claude Code attribution block that carries per-request billing/fingerprint data. */
export const isClaudeCodeAttributionSystemText = (text: string): boolean =>
  text.trimStart().startsWith(ATTRIBUTION_PREFIX)

/** True for regex patterns upstream validators reject (`\p{..}`, `\P{..}`, octal NUL `\0`). */
export const hasUnsupportedUnicodePropertyEscape = (pattern: string): boolean => {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue
    if (i + 1 >= pattern.length) break
    const next = pattern[i + 1]
    if ((next === "p" || next === "P") && i + 2 < pattern.length && pattern[i + 2] === "{") return true
    if (next === "0") return true
    i++
  }
  return false
}

export const SCHEMA_MAP_KEYWORDS = [
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
  "dependencies"
] as const

export const SCHEMA_VALUE_KEYWORDS = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
  "contentSchema",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else"
] as const

/** `AlignClaudeToolResults`: orders tool_result blocks by the preceding tool_use ids (complete 1:1 match only). */
export const alignClaudeToolResults = (content: Json | undefined, toolUseIds: readonly string[]): Json | undefined => {
  if (!isArr(content) || toolUseIds.length === 0) return content
  const toolResults: Json[] = []
  const indices: number[] = []
  content.forEach((part, i) => {
    if (getStr(part, "type") === "tool_result") {
      toolResults.push(part)
      indices.push(i)
    }
  })
  if (toolResults.length !== toolUseIds.length) return content
  const reordered: Json[] = []
  const used = toolResults.map(() => false)
  for (const id of toolUseIds) {
    const matched = toolResults.findIndex((r, i) => !used[i] && id !== "" && getStr(r, "tool_use_id") === id)
    if (matched < 0) return content
    used[matched] = true
    reordered.push(toolResults[matched] as Json)
  }
  const ordered = [...content]
  indices.forEach((slot, i) => {
    ordered[slot] = reordered[i] as Json
  })
  return ordered
}

/** `SystemReminderText`. */
export const systemReminderText = (text: string): string => `<system-reminder>\n${text}\n</system-reminder>`

const claudeSystemTextParts = (content: Json | undefined): string[] => {
  if (content === undefined) return []
  if (typeof content === "string") {
    return content === "" || isClaudeCodeAttributionSystemText(content) ? [] : [content]
  }
  if (!isArr(content)) return []
  const parts: string[] = []
  for (const item of content) {
    if (getStr(item, "type") !== "text") continue
    const text = str((item as JsonObject).text)
    if (text === "" || isClaudeCodeAttributionSystemText(text)) continue
    parts.push(text)
  }
  return parts
}

/** `ClaudeMessageSystemReminderText`: message-level system content as user-visible reminder text. */
export const claudeMessageSystemReminderText = (content: Json | undefined): string | undefined => {
  const parts = claudeSystemTextParts(content)
  if (parts.length === 0) return undefined
  const text = parts.join("\n")
  return text.trim() === "" ? undefined : systemReminderText(text)
}
