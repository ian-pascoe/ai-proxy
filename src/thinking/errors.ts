/**
 * Go source: internal/thinking/errors.go.
 */
import { Schema } from "effect"

export const ThinkingErrorCode = Schema.Literals([
  "INVALID_SUFFIX",
  "UNKNOWN_LEVEL",
  "THINKING_NOT_SUPPORTED",
  "LEVEL_NOT_SUPPORTED",
  "BUDGET_OUT_OF_RANGE",
  "PROVIDER_MISMATCH"
])

export type ThinkingErrorCode = typeof ThinkingErrorCode.Type

/** Invalid thinking configuration for the model; maps to HTTP 400 (`statusCode`). Messages are lowercase, no period. */
export class ThinkingError extends Schema.TaggedError<ThinkingError>()("ThinkingError", {
  code: ThinkingErrorCode,
  message: Schema.String,
  model: Schema.optional(Schema.String)
}) {
  readonly statusCode = 400
}

export const thinkingError = (code: ThinkingErrorCode, message: string, model?: string): ThinkingError =>
  model === undefined ? new ThinkingError({ code, message }) : new ThinkingError({ code, message, model })
