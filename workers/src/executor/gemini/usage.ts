/**
 * Gemini-family usage parsing and stream usage filtering.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (parseGeminiFamilyUsageDetail, ParseGeminiUsage,
 * ParseGeminiStreamUsage, parseInteractionsUsageDetail, ParseInteractionsUsage, ParseInteractionsStreamUsage,
 * FilterSSEUsageMetadata, StripUsageMetadataFromJSON, JSONPayload). The v2 token breakdown is not ported.
 */
import { asInt, asString, del, get, isJsonObject, type Json, set, tryParseJson } from "../../json/index.ts"
import { emptyUsageDetail, responseServiceTier, type UsageDetail } from "../../usage/record.ts"

const first = (root: Json | undefined, ...paths: ReadonlyArray<string>): Json | undefined => {
  for (const path of paths) {
    const node = get(root, path)
    if (node !== undefined) return node
  }
  return undefined
}

const hasUsage = (detail: UsageDetail): boolean =>
  detail.inputTokens > 0 ||
  detail.outputTokens > 0 ||
  detail.reasoningTokens > 0 ||
  detail.totalTokens > 0 ||
  detail.cachedTokens > 0 ||
  detail.cacheReadTokens > 0 ||
  detail.cacheCreationTokens > 0

/** `parseGeminiFamilyUsageDetail`: reasoning tokens are separate from output tokens. */
export const parseGeminiFamilyUsageDetail = (node: Json): UsageDetail => {
  const cached = asInt(get(node, "cachedContentTokenCount"))
  const toolUse = asInt(first(node, "toolUsePromptTokenCount", "tool_use_prompt_token_count"))
  const input = asInt(get(node, "promptTokenCount")) + toolUse
  const output = asInt(get(node, "candidatesTokenCount"))
  const reasoning = asInt(get(node, "thoughtsTokenCount"))
  let total = asInt(get(node, "totalTokenCount"))
  if (total === 0) total = input + output + reasoning
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
    totalTokens: total
  }
}

/** `parseInteractionsUsageDetail`. */
export const parseInteractionsUsageDetail = (node: Json): UsageDetail => {
  const cacheRead = first(node, "cache_read_tokens", "cacheReadTokens")
  const toolUse = asInt(first(node, "tool_use_tokens", "total_tool_use_tokens", "toolUseTokens", "totalToolUseTokens"))
  const input = asInt(first(node, "input_tokens", "prompt_tokens", "total_input_tokens")) + toolUse
  const output = asInt(first(node, "output_tokens", "completion_tokens", "total_output_tokens"))
  const reasoning = asInt(first(node, "reasoning_tokens", "thoughtsTokenCount", "total_thought_tokens"))
  let total = asInt(first(node, "total_tokens", "totalTokenCount"))
  const cached = asInt(first(node, "cached_tokens", "cachedContentTokenCount", "total_cached_tokens"))
  if (total === 0) total = input + output + reasoning
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cached,
    cacheReadTokens: cacheRead === undefined ? cached : asInt(cacheRead),
    cacheCreationTokens: asInt(
      first(node, "cache_creation_tokens", "cacheCreationTokens", "cache_write_tokens", "cacheWriteTokens")
    ),
    totalTokens: total
  }
}

/** `ParseGeminiUsage` over a parsed body. */
export const parseGeminiUsageBody = (root: Json | undefined): UsageDetail => {
  const node = first(root, "usageMetadata", "usage_metadata")
  return node === undefined ? emptyUsageDetail : parseGeminiFamilyUsageDetail(node)
}

/** `ParseGeminiUsage`. */
export const parseGeminiUsage = (body: string): UsageDetail => parseGeminiUsageBody(tryParseJson(body))

/** `JSONPayload`: the JSON object of an SSE line, `undefined` for events, `[DONE]` and non-objects. */
export const jsonPayload = (line: string): string | undefined => {
  let trimmed = line.trim()
  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return undefined
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  return trimmed.startsWith("{") ? trimmed : undefined
}

/** `ParseGeminiStreamUsage`: usage of one stream chunk, `undefined` when it carries none. */
export const parseGeminiStreamUsage = (line: string): UsageDetail | undefined => {
  const payload = jsonPayload(line)
  if (payload === undefined) return undefined
  const root = tryParseJson(payload)
  if (root === undefined) return undefined
  const node = first(root, "usageMetadata", "usage_metadata")
  if (node === undefined) return undefined
  const detail = parseGeminiFamilyUsageDetail(node)
  return hasUsage(detail) ? detail : undefined
}

/** `ParseInteractionsUsage`. */
export const parseInteractionsUsageBody = (root: Json | undefined): UsageDetail => {
  const node = first(
    root,
    "usage",
    "total_usage",
    "metadata.total_usage",
    "metadata.usage",
    "usageMetadata",
    "usage_metadata",
    "interaction.usage",
    "interaction.total_usage",
    "interaction.metadata.total_usage"
  )
  if (node === undefined) return emptyUsageDetail
  const detail =
    get(node, "promptTokenCount") !== undefined || get(node, "candidatesTokenCount") !== undefined
      ? parseGeminiFamilyUsageDetail(node)
      : parseInteractionsUsageDetail(node)
  const tier = responseServiceTier(root)
  return tier === undefined ? detail : { ...detail, responseServiceTier: tier }
}

export const parseInteractionsUsage = (body: string): UsageDetail => parseInteractionsUsageBody(tryParseJson(body))

/** `ParseInteractionsStreamUsage`. */
export const parseInteractionsStreamUsage = (payload: string): UsageDetail | undefined => {
  const root = tryParseJson(jsonPayload(payload) ?? payload)
  if (!isJsonObject(root)) return undefined
  const detail = parseInteractionsUsageBody(root)
  return hasUsage(detail) ? detail : undefined
}

/**
 * `StripUsageMetadataFromJSON`: renames `usageMetadata` to `cpaUsageMetadata` on non-terminal chunks (no
 * `finishReason`) so translators only report usage once the stream finishes.
 */
export const stripUsageMetadataFromJson = (raw: string): { readonly text: string; readonly changed: boolean } => {
  const root = tryParseJson(raw.trim())
  if (root === undefined) return { text: raw, changed: false }
  let finish = get(root, "candidates.0.finishReason")
  if (finish === undefined) finish = get(root, "response.candidates.0.finishReason")
  if (finish !== undefined && asString(finish).trim() !== "") return { text: raw, changed: false }
  let changed = false
  const usage = get(root, "usageMetadata")
  if (usage !== undefined) {
    set(root, "cpaUsageMetadata", usage)
    del(root, "usageMetadata")
    changed = true
  }
  const wrapped = get(root, "response.usageMetadata")
  if (wrapped !== undefined) {
    set(root, "response.cpaUsageMetadata", wrapped)
    del(root, "response.usageMetadata")
    changed = true
  }
  return changed ? { text: JSON.stringify(root), changed } : { text: raw, changed: false }
}

/**
 * `FilterSSEUsageMetadata` for one stream line (Gemini API keys carry no `traceId`, so the Antigravity stop-chunk
 * bookkeeping does not apply): a `data:` line, or a raw JSON line.
 */
export const filterSseUsageMetadata = (line: string): string => {
  if (line === "") return line
  const trimmed = line.trim()
  if (trimmed.startsWith("data:")) {
    const dataIndex = line.indexOf("data:")
    const cleaned = stripUsageMetadataFromJson(line.slice(dataIndex + 5).trim())
    if (!cleaned.changed) return line
    return `${line.slice(0, dataIndex)}data: ${cleaned.text}`
  }
  const cleaned = stripUsageMetadataFromJson(trimmed)
  return cleaned.changed ? cleaned.text : line
}
