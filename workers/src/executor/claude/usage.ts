/**
 * Claude usage parsing.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (ParseClaudeUsage, ParseClaudeStreamUsage,
 * parseClaudeUsageNode, StreamUsageBuffer.ObserveClaudeStream / ObserveMergedStreamUsage).
 */
import { asInt, get, type Json, tryParseJson } from "../../json/index.ts"
import { emptyUsageDetail, ssePayloadObject, type UsageDetail } from "../../usage/record.ts"

const nonNegative = (value: Json | undefined): number => Math.max(0, asInt(value))

const parseNode = (node: Json): UsageDetail => {
  const cacheRead = asInt(get(node, "cache_read_input_tokens"))
  const cacheCreation = asInt(get(node, "cache_creation_input_tokens"))
  const output = asInt(get(node, "output_tokens"))
  const reasoning = nonNegative(
    get(node, "output_tokens_details.thinking_tokens") ??
      get(node, "output_tokens_details.reasoning_tokens") ??
      get(node, "thinking_tokens")
  )
  const input = asInt(get(node, "input_tokens"))
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cacheRead !== 0 ? cacheRead : cacheCreation,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens: input + output + cacheRead + cacheCreation
  }
}

/** `ParseClaudeUsage` over a non-stream body. */
export const parseClaudeUsage = (body: string): UsageDetail => {
  const node = get(tryParseJson(body), "usage")
  return node === undefined ? emptyUsageDetail : parseNode(node)
}

/** `ParseClaudeStreamUsage`: usage of one SSE line (`usage` or `message.usage`). */
export const parseClaudeStreamUsage = (line: string): UsageDetail | undefined => {
  const payload = ssePayloadObject(line)
  if (payload === undefined) return undefined
  const node = get(payload, "usage") ?? get(payload, "message.usage")
  return node === undefined ? undefined : parseNode(node)
}

/** Merges stream usage events: the latest non-zero value of each field wins (start carries input, delta output). */
export const mergeUsage = (previous: UsageDetail | undefined, next: UsageDetail): UsageDetail => {
  if (previous === undefined) return next
  const pick = (a: number, b: number): number => (b !== 0 ? b : a)
  const merged = {
    inputTokens: pick(previous.inputTokens, next.inputTokens),
    outputTokens: pick(previous.outputTokens, next.outputTokens),
    reasoningTokens: pick(previous.reasoningTokens, next.reasoningTokens),
    cachedTokens: pick(previous.cachedTokens, next.cachedTokens),
    cacheReadTokens: pick(previous.cacheReadTokens, next.cacheReadTokens),
    cacheCreationTokens: pick(previous.cacheCreationTokens, next.cacheCreationTokens)
  }
  return {
    ...merged,
    totalTokens: merged.inputTokens + merged.outputTokens + merged.cacheReadTokens + merged.cacheCreationTokens
  }
}
