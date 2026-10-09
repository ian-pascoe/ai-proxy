/**
 * Error bodies per client protocol.
 *
 * Go source: sdk/api/handlers/handlers.go (BuildErrorResponseBodyWithError, ErrorResponse),
 * sdk/api/handlers/claude/code_handlers.go (toClaudeError, claudeErrorDetailFromText, claudeErrorTypeFromStatus),
 * internal/clienterror/client_error.go (IsClaudeThreadNotFound), sdk/api/handlers/openai_responses_stream_error.go
 * (BuildOpenAIResponsesStreamErrorChunk, BuildOpenAIResponsesStreamFailedChunk).
 *
 * Gemini and Interactions handlers reuse the OpenAI-shaped body.
 */
import { compactJson, goMarshal, goMarshalSorted, isValidJson } from "./json-text.ts"
import { statusText } from "./status.ts"

type JsonRecord = Record<string, unknown>

const parseObject = (text: string): JsonRecord | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
  } catch {
    return undefined
  }
}

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined

const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

// --- OpenAI-compatible ------------------------------------------------------------------------------------------

export interface OpenAIErrorOptions {
  /** The upstream OAuth credential is permanently invalid (`coreauth.IsTerminalAuthError`). */
  readonly terminalAuth?: boolean
}

const openAIErrorClass = (status: number): { type: string; code?: string } => {
  switch (status) {
    case 401:
      return { type: "authentication_error", code: "invalid_api_key" }
    case 403:
      return { type: "permission_error", code: "insufficient_quota" }
    case 429:
      return { type: "rate_limit_error", code: "rate_limit_exceeded" }
    case 404:
      return { type: "invalid_request_error", code: "model_not_found" }
    case 408:
      return { type: "server_error", code: "request_timeout" }
    default:
      return status >= 500 ? { type: "server_error", code: "internal_server_error" } : { type: "invalid_request_error" }
  }
}

/**
 * `BuildErrorResponseBodyWithError`: JSON error text (e.g. an upstream error body) is passed through compacted;
 * plain text is wrapped as `{"error":{"message","type","code"}}` with type/code derived from the status.
 */
export const openAIErrorBody = (status: number, text: string, options: OpenAIErrorOptions = {}): string => {
  const effectiveStatus = status <= 0 ? 500 : status
  const errText = text.trim() === "" ? statusText(effectiveStatus) : text
  const trimmed = errText.trim()

  if (options.terminalAuth === true) {
    let message = errText
    const parsed = trimmed !== "" ? parseObject(trimmed) : undefined
    if (parsed !== undefined) {
      const direct = nonBlank(parsed["message"])
      const nested = nonBlank(asRecord(parsed["error"])?.["message"])
      message = direct ?? nested ?? message
    }
    return goMarshal({
      error: {
        message,
        type: "authentication_error",
        code: "upstream_authentication_required",
        retryable: false
      }
    })
  }

  if (trimmed !== "" && isValidJson(trimmed)) return compactJson(trimmed)

  const { type, code } = openAIErrorClass(effectiveStatus)
  return goMarshal({ error: { message: errText, type, ...(code !== undefined ? { code } : {}) } })
}

/** Handler-level body read/parse failure: `400 {"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}`. */
export const invalidRequestBody = (message: string): string =>
  goMarshal({ error: { message: `Invalid request: ${message}`, type: "invalid_request_error" } })

// --- Claude -------------------------------------------------------------------------------------------------------

export const claudeErrorTypeFromStatus = (status: number): string => {
  switch (status) {
    case 401:
      return "authentication_error"
    case 402:
      return "billing_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 413:
      return "request_too_large"
    case 429:
      return "rate_limit_error"
    case 408:
    case 504:
      return "timeout_error"
    case 529:
      return "overloaded_error"
    default:
      return status >= 500 ? "api_error" : "invalid_request_error"
  }
}

/** `claudeErrorDetailFromText`: JSON error text may override the derived type and message. */
export const claudeErrorDetailFromText = (status: number, text: string): { type: string; message: string } => {
  let message = text.trim() === "" ? statusText(status) : text.trim()
  let type = claudeErrorTypeFromStatus(status)
  const payload = parseObject(message)
  if (payload !== undefined) {
    const error = asRecord(payload["error"])
    if (error !== undefined) {
      const t = nonBlank(error["type"])
      if (t !== undefined) type = t.trim()
      const m = nonBlank(error["message"]) ?? nonBlank(error["code"])
      if (m !== undefined) message = m.trim()
    } else {
      const t = nonBlank(payload["type"])
      if (t !== undefined && t.trim() !== "error") type = t.trim()
      const m = nonBlank(payload["message"])
      if (m !== undefined) message = m.trim()
    }
  }
  return { type, message }
}

/** `clienterror.IsClaudeThreadNotFound`. */
export const isClaudeThreadNotFound = (status: number, text: string): boolean => {
  if (status !== 404) return false
  const body = text.trim()
  if (body === "") return false
  if (isValidJson(body)) {
    const error = asRecord(parseObject(body)?.["error"])
    const message = typeof error?.["message"] === "string" ? error["message"].toLowerCase() : ""
    return (
      typeof error?.["type"] === "string" &&
      error["type"].trim().toLowerCase() === "not_found_error" &&
      message.includes("thread state") &&
      message.includes("previous_message_id")
    )
  }
  const lower = body.toLowerCase()
  return lower.includes("thread state") && lower.includes("previous_message_id")
}

/** Claude Messages error body: `{"type":"error","error":{"type","message"[,"details":{"error_code"}]}}`. */
export const claudeErrorBody = (status: number, text: string): string => {
  const effectiveStatus = status <= 0 ? 500 : status
  const errText = text.trim() === "" ? statusText(effectiveStatus) : text
  const detail = claudeErrorDetailFromText(effectiveStatus, errText)
  return goMarshal({
    type: "error",
    error: {
      type: detail.type,
      message: detail.message,
      ...(isClaudeThreadNotFound(effectiveStatus, errText) ? { details: { error_code: "thread_not_found" } } : {})
    }
  })
}

// --- OpenAI Responses (streaming) -------------------------------------------------------------------------------

const responsesErrorClass = (status: number): { code: string; type: string } => {
  switch (status) {
    case 401:
      return { code: "invalid_api_key", type: "invalid_request_error" }
    case 403:
      return { code: "insufficient_quota", type: "invalid_request_error" }
    case 429:
      return { code: "rate_limit_exceeded", type: "invalid_request_error" }
    case 404:
      return { code: "model_not_found", type: "invalid_request_error" }
    case 408:
      return { code: "request_timeout", type: "server_error" }
    default:
      if (status >= 500) return { code: "internal_server_error", type: "server_error" }
      if (status >= 400) return { code: "invalid_request_error", type: "invalid_request_error" }
      return { code: "unknown_error", type: "invalid_request_error" }
  }
}

const responsesErrorDetail = (status: number, errText: string, initialCode: string, initialMessage: string) => {
  let code = initialCode
  let message = initialMessage
  const trimmed = errText.trim()
  const payload = trimmed !== "" ? parseObject(trimmed) : undefined
  if (payload !== undefined) {
    const error = asRecord(payload["error"])
    if (error !== undefined) return error
    const responseError = asRecord(asRecord(payload["response"])?.["error"])
    if (responseError !== undefined) return responseError
    const m = nonBlank(payload["message"])
    if (m !== undefined) message = m.trim()
    const c = payload["code"]
    if (c !== undefined && c !== null) code = typeof c === "string" && c.trim() !== "" ? c.trim() : String(c).trim()
  }
  const detail: JsonRecord = { type: responsesErrorClass(status).type, code, message, param: null }
  if (payload !== undefined) {
    const t = nonBlank(payload["type"])
    if (t !== undefined && t.trim() !== "error") detail["type"] = t.trim()
    if (Object.hasOwn(payload, "param")) detail["param"] = payload["param"]
  }
  return detail
}

const responsesErrorParts = (status: number, errText: string, sequenceNumber: number) => {
  const effectiveStatus = status <= 0 ? 500 : status
  let sequence = Math.max(sequenceNumber, 0)
  const message = errText.trim() === "" ? statusText(effectiveStatus) : errText.trim()
  const payload = errText.trim() !== "" ? parseObject(errText.trim()) : undefined
  const seq = payload?.["sequence_number"]
  if (typeof seq === "number" && Number.isFinite(seq)) sequence = Math.trunc(seq)
  const code = responsesErrorClass(effectiveStatus).code
  return { sequence, error: responsesErrorDetail(effectiveStatus, errText, code, message) }
}

/** `BuildOpenAIResponsesStreamErrorChunk`: `{"type":"error","error":{...},"sequence_number":N}`. */
export const responsesStreamErrorChunk = (status: number, errText: string, sequenceNumber: number): string => {
  const { sequence, error } = responsesErrorParts(status, errText, sequenceNumber)
  return `{"type":"error","error":${goMarshalSorted(error)},"sequence_number":${sequence}}`
}

/** `BuildOpenAIResponsesStreamFailedChunk`: `{"type":"response.failed","sequence_number":N,"response":{...}}`. */
export const responsesStreamFailedChunk = (status: number, errText: string, sequenceNumber: number): string => {
  const { sequence, error } = responsesErrorParts(status, errText, sequenceNumber)
  return `{"type":"response.failed","sequence_number":${sequence},"response":{"status":"failed","error":${goMarshalSorted(error)}}}`
}
