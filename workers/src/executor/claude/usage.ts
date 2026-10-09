/**
 * Claude usage parsing: thin aliases over the shared token-accounting v2 parsers (`usage/parsers.ts`), which keep the
 * independent-bucket breakdown (cache outside `input_tokens`, thinking inside `output_tokens`).
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (ParseClaudeUsage, ParseClaudeStreamUsage,
 * parseClaudeUsageNode, StreamUsageBuffer.ObserveClaudeStream / ObserveMergedStreamUsage).
 */
import { mergeStreamUsageDetail, parseClaudeStreamUsage, parseClaudeUsage } from "../../usage/parsers.ts"
import type { UsageDetail } from "../../usage/record.ts"

export { parseClaudeStreamUsage, parseClaudeUsage }

/** Merges stream usage events (`message_start` carries input and cache, `message_delta` output). */
export const mergeUsage = (previous: UsageDetail | undefined, next: UsageDetail): UsageDetail =>
  previous === undefined ? next : mergeStreamUsageDetail(previous, next)
