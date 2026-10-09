/**
 * Downstream SSE framing per client protocol.
 *
 * Go source: sdk/api/handlers/openai/openai_handlers.go (handleStreamResult, chunkHasFinishReason),
 * sdk/api/handlers/claude/code_handlers.go (stream writer, `event: error`), sdk/api/handlers/gemini/
 * gemini_handlers.go (`alt` framing), sdk/api/handlers/gemini/interactions_handlers.go,
 * sdk/api/handlers/openai_responses_handlers.go (terminal events, `[DONE]`-less close), stream_forwarder.go
 * (`: keep-alive`). A framer is stateful and must be created per request.
 *
 * The Responses framer covers termination and errors; the full frame assembler (partial-frame buffering, private
 * event filtering, `response.output` repair, Codex-client detection) belongs to the Responses slice.
 */
import { ExecutionError } from "../executor/errors.ts"
import {
  claudeErrorBody,
  openAIErrorBody,
  responsesStreamErrorChunk,
  responsesStreamFailedChunk
} from "../http/errors.ts"
import { SSE_KEEP_ALIVE, sseData, sseEvent } from "../http/sse.ts"
import { statusText } from "../http/status.ts"
import { get, isJsonArray, tryParseJson } from "../json/index.ts"

export interface StreamFramer {
  /** Frames one executor chunk. */
  readonly chunk: (payload: string) => string
  /** Frames a terminal error after the stream was committed. */
  readonly terminalError: (error: ExecutionError) => string
  /** Validation run when the upstream closes cleanly (e.g. no finish_reason seen); returns the error to report. */
  readonly closeError: () => ExecutionError | undefined
  /** Trailer written after a clean close. */
  readonly done: () => string
  /** Body written when the stream closed without any chunk and without error. */
  readonly emptyBody: string
  /** Keep-alive frame, or `undefined` when keep-alives are disabled for this protocol/variant. */
  readonly keepAlive: string | undefined
}

const errorText = (error: ExecutionError, status: number): string =>
  error.message.trim() !== "" ? error.message : statusText(status)

const statusOf = (error: ExecutionError): number => (error.status > 0 ? error.status : 500)

/** `chunkHasFinishReason`: some choice carries a non-empty, non-null `finish_reason`. */
export const chunkHasFinishReason = (chunk: string): boolean => {
  let text = chunk.trim()
  if (text.startsWith("data:")) text = text.slice(5).trim()
  const choices = get(tryParseJson(text), "choices")
  if (!isJsonArray(choices)) return false
  return choices.some((choice) => {
    const reason = get(choice, "finish_reason")
    return reason !== undefined && reason !== null && reason !== ""
  })
}

/** OpenAI Chat Completions (and legacy Completions): `data: <json>\n\n`, terminated by `data: [DONE]`. */
export const openAIFramer = (): StreamFramer => {
  let sawFinishReason = false
  return {
    chunk: (payload) => {
      if (!sawFinishReason && chunkHasFinishReason(payload)) sawFinishReason = true
      return sseData(payload)
    },
    terminalError: (error) => {
      const status = statusOf(error)
      return sseData(openAIErrorBody(status, errorText(error, status)))
    },
    closeError: () =>
      sawFinishReason
        ? undefined
        : new ExecutionError({ status: 502, message: "upstream stream closed before any chunk carried finish_reason" }),
    done: () => sseData("[DONE]"),
    emptyBody: sseData("[DONE]"),
    keepAlive: SSE_KEEP_ALIVE
  }
}

/** Claude Messages: chunks already carry `event:`/`data:` lines; errors become `event: error`. */
export const claudeFramer = (): StreamFramer => ({
  chunk: (payload) => payload,
  terminalError: (error) => {
    const status = statusOf(error)
    return sseEvent("error", claudeErrorBody(status, errorText(error, status)))
  },
  closeError: () => undefined,
  done: () => "",
  emptyBody: "",
  keepAlive: SSE_KEEP_ALIVE
})

/** Gemini: `alt=""` frames chunks as SSE `data:`; any other `alt` (e.g. `json`) writes raw chunks without keep-alives. */
export const geminiFramer = (alt: string): StreamFramer => ({
  chunk: (payload) => (alt === "" ? sseData(payload) : payload),
  terminalError: (error) => {
    const status = statusOf(error)
    const body = openAIErrorBody(status, errorText(error, status))
    return alt === "" ? sseEvent("error", body) : body
  },
  closeError: () => undefined,
  done: () => "",
  emptyBody: "",
  keepAlive: alt === "" ? SSE_KEEP_ALIVE : undefined
})

/** Interactions: chunks get `data: ` / a blank-line terminator when the executor did not frame them. */
export const interactionsFramer = (): StreamFramer => ({
  chunk: (payload) => {
    let out = payload
    if (!out.startsWith("data:") && !out.startsWith("event:")) out = `data: ${out}`
    if (!out.endsWith("\n\n")) out = out.endsWith("\n") ? `${out}\n` : `${out}\n\n`
    return out
  },
  terminalError: (error) => {
    const status = statusOf(error)
    return sseEvent("error", openAIErrorBody(status, errorText(error, status)))
  },
  closeError: () => undefined,
  done: () => "",
  emptyBody: "",
  keepAlive: SSE_KEEP_ALIVE
})

const RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.done",
  "response.error",
  "error"
])

/**
 * OpenAI Responses: chunks are complete `event:`/`data:` frames. Errors become `event: error` (or `response.failed`
 * for Codex clients) with a sequence number; the stream ends with a bare newline and no `[DONE]`.
 */
export const responsesFramer = (options: { readonly codexClient: boolean }): StreamFramer => {
  let dataFrames = 0
  let lastEvent = ""
  let terminal = false
  return {
    chunk: (payload) => {
      for (const line of payload.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("event:")) lastEvent = trimmed.slice(6).trim()
        if (trimmed.startsWith("data:")) {
          dataFrames++
          const type = get(tryParseJson(trimmed.slice(5).trim()), "type")
          if (typeof type === "string") lastEvent = type
        }
      }
      if (RESPONSES_TERMINAL_EVENTS.has(lastEvent)) terminal = true
      return payload
    },
    terminalError: (error) => {
      const status = statusOf(error)
      const text = errorText(error, status)
      // The error frame is the next data frame of the stream.
      const sequence = dataFrames
      return options.codexClient
        ? sseEvent("response.failed", responsesStreamFailedChunk(status, text, sequence))
        : sseEvent("error", responsesStreamErrorChunk(status, text, sequence))
    },
    closeError: () =>
      terminal
        ? undefined
        : new ExecutionError({
            status: 502,
            message:
              dataFrames === 0
                ? "upstream stream closed before first payload"
                : `upstream stream closed before a terminal event (last event: ${lastEvent})`
          }),
    done: () => "\n",
    emptyBody: "\n",
    keepAlive: SSE_KEEP_ALIVE
  }
}
