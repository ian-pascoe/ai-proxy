/**
 * SSE frame builders shared by translators.
 *
 * Go source: internal/translator/common/bytes.go (SSEEventData, AppendSSEEventBytes/String,
 * GeminiTokenCountJSON, ClaudeInputTokensJSON).
 */

/** `SSEEventData`: one complete frame with its own blank-line terminator. */
export const sseEventData = (event: string, payload: string): string => `event: ${event}\ndata: ${payload}\n\n`

/** `AppendSSEEventBytes`: `event:`/`data:` lines followed by `trailingNewlines` newlines (no extra separator). */
export const sseEventLines = (event: string, payload: string, trailingNewlines: number): string =>
  `event: ${event}\ndata: ${payload}${"\n".repeat(trailingNewlines)}`

export const geminiTokenCountJson = (count: number): string =>
  `{"totalTokens":${count},"promptTokensDetails":[{"modality":"TEXT","tokenCount":${count}}]}`

export const claudeInputTokensJson = (count: number): string => `{"input_tokens":${count}}`
