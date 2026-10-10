/**
 * `force-mapping` response rewrite: the upstream model name in a response is replaced by the alias the client asked
 * for.
 *
 * Go source: sdk/cliproxy/auth/response_model_rewriter.go (rewriteModelInResponse, rewriteSSEPayloadLines,
 * StreamRewriter.RewriteChunk), sdk/cliproxy/auth/conductor_models.go (rewriteForceMappedResponse,
 * rewriteForceMappedStreamChunk). Executors emit complete client chunks (one JSON object, or framed
 * `event:`/`data:` text), so the Go pending-buffer for partial SSE events is not needed.
 */
import { exists, set, type Json, tryParseJson } from "../json/index.ts"

const MODEL_FIELD_PATHS = ["model", "modelVersion", "response.model", "response.modelVersion", "message.model"] as const

/** Rewrites every present model field of one JSON document; `undefined` when nothing changed. */
const rewriteDocument = (value: Json, target: string): Json | undefined => {
  let changed = false
  for (const path of MODEL_FIELD_PATHS) {
    if (exists(value, path)) {
      set(value, path, target)
      changed = true
    }
  }
  return changed ? value : undefined
}

const isObject = (value: Json | undefined): value is Json & object =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** `rewriteModelInResponse` for a whole (non-stream) JSON body. Non-JSON bodies are returned unchanged. */
export const rewriteResponseModel = (payload: string, target: string): string => {
  if (target === "" || payload === "") return payload
  const parsed = tryParseJson(payload)
  if (!isObject(parsed)) return payload
  const rewritten = rewriteDocument(parsed, target)
  return rewritten === undefined ? payload : JSON.stringify(rewritten)
}

/** Rewrites one complete stream chunk (bare JSON, or SSE text with `data:` lines). */
export const rewriteStreamChunk = (chunk: string, target: string): string => {
  if (target === "" || chunk === "") return chunk
  const trimmed = chunk.trim()
  if (trimmed.startsWith("{")) {
    const parsed = tryParseJson(trimmed)
    if (isObject(parsed)) {
      const rewritten = rewriteDocument(parsed, target)
      return rewritten === undefined ? chunk : JSON.stringify(rewritten)
    }
  }
  if (!chunk.includes("data:")) return chunk
  return chunk
    .split("\n")
    .map((line) => {
      const prefix = line.startsWith("data: ") ? "data: " : line.startsWith("data:") ? "data:" : ""
      if (prefix === "") return line
      const data = line.slice(prefix.length)
      if (!data.startsWith("{")) return line
      const parsed = tryParseJson(data)
      if (!isObject(parsed)) return line
      const rewritten = rewriteDocument(parsed, target)
      return rewritten === undefined ? line : `${prefix}${JSON.stringify(rewritten)}`
    })
    .join("\n")
}
