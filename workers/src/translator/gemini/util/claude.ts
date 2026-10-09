/**
 * Claude-side helpers used by the Gemini translators.
 *
 * Go source: internal/util/claude_attribution.go (IsClaudeCodeAttributionSystemText), internal/util/util.go
 * (SanitizeFunctionName), internal/util/claude_tool_result.go (ConvertClaudeToolResultContent),
 * internal/translator/common/claude_system.go (SystemReminderText, ClaudeMessageSystemReminderText),
 * internal/translator/common/claude_messages.go (AlignClaudeToolResults).
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "../../../json/index.ts"

/** `IsClaudeCodeAttributionSystemText`. */
export const isClaudeCodeAttributionSystemText = (text: string): boolean =>
  text.trimStart().startsWith("x-anthropic-billing-header:")

/** `SanitizeFunctionName`: `[^a-zA-Z0-9_.:-]` -> `_`, must start with a letter/underscore, max 64 characters. */
export const sanitizeFunctionName = (name: string): string => {
  if (name === "") return ""
  let sanitized = name.replace(/[^a-zA-Z0-9_.:-]/g, "_")
  const first = sanitized[0] as string
  if (!/[a-zA-Z_]/.test(first)) {
    if (sanitized.length >= 64) sanitized = sanitized.slice(0, 63)
    sanitized = `_${sanitized}`
  }
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized
}

/** `SystemReminderText`. */
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

/** `ClaudeMessageSystemReminderText`: mid-session system/developer content as a reminder, `undefined` when empty. */
export const claudeMessageSystemReminderText = (content: Json | undefined): string | undefined => {
  const parts = claudeSystemTextParts(content)
  if (parts.length === 0) return undefined
  const text = parts.join("\n")
  return text.trim() === "" ? undefined : systemReminderText(text)
}

/** `AlignClaudeToolResults`: reorders `tool_result` blocks to follow the preceding `tool_use` id order. */
export const alignClaudeToolResults = (
  content: Json | undefined,
  toolUseIds: ReadonlyArray<string>
): Json | undefined => {
  if (!isJsonArray(content) || toolUseIds.length === 0) return content
  const indices: number[] = []
  content.forEach((part, index) => {
    if (asString(get(part, "type")) === "tool_result") indices.push(index)
  })
  if (indices.length !== toolUseIds.length) return content
  const used = indices.map(() => false)
  const reordered: Json[] = []
  for (const toolUseId of toolUseIds) {
    let matched = -1
    for (let i = 0; i < indices.length; i++) {
      const result = content[indices[i] as number]
      if (!used[i] && toolUseId !== "" && asString(get(result, "tool_use_id")) === toolUseId) {
        matched = i
        break
      }
    }
    if (matched < 0) return content
    used[matched] = true
    reordered.push(content[indices[matched] as number] as Json)
  }
  const ordered = [...content]
  indices.forEach((slot, i) => {
    ordered[slot] = reordered[i] as Json
  })
  return ordered
}

export interface ClaudeToolResultImage {
  readonly mimeType: string
  readonly data: string
}

export interface ClaudeToolResult {
  /** Value for `functionResponse.response.result`. */
  readonly result: Json
  /** `true` when `result` is structured JSON (set as value); `false` for a plain string. */
  readonly resultIsRaw: boolean
  readonly images: ClaudeToolResultImage[]
}

const isClaudeBase64Image = (block: Json | undefined): boolean =>
  asString(get(block, "type")) === "image" && asString(get(block, "source.type")) === "base64"

const claudeImageFromBlock = (block: Json): ClaudeToolResultImage | undefined => {
  const data = asString(get(block, "source.data"))
  return data === "" ? undefined : { mimeType: asString(get(block, "source.media_type")), data }
}

/** `ConvertClaudeToolResultContent`: string / structured content plus separated base64 images. */
export const convertClaudeToolResultContent = (content: Json | undefined): ClaudeToolResult => {
  if (typeof content === "string") return { result: content, resultIsRaw: false, images: [] }
  if (isJsonArray(content)) {
    const images: ClaudeToolResultImage[] = []
    const nonImage: Json[] = []
    for (const block of content) {
      if (isClaudeBase64Image(block)) {
        const image = claudeImageFromBlock(block)
        if (image !== undefined) images.push(image)
        continue
      }
      nonImage.push(block)
    }
    if (nonImage.length === 1) return { result: nonImage[0] as Json, resultIsRaw: true, images }
    if (nonImage.length > 1) return { result: nonImage, resultIsRaw: true, images }
    return { result: "", resultIsRaw: false, images }
  }
  if (isJsonObject(content)) {
    if (isClaudeBase64Image(content)) {
      const image = claudeImageFromBlock(content)
      return { result: "", resultIsRaw: false, images: image === undefined ? [] : [image] }
    }
    return { result: content, resultIsRaw: true, images: [] }
  }
  if (content !== undefined) return { result: content, resultIsRaw: true, images: [] }
  return { result: "", resultIsRaw: false, images: [] }
}
