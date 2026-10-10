/**
 * Boundary user turns for Gemini upstreams.
 *
 * Go source: internal/runtime/executor/helps/gemini_content_turns.go (EnsureGeminiLeadingUserContent,
 * EnsureGeminiTrailingUserContent, EnsureGeminiBoundaryUserContent).
 */
import { asString, exists, get, isJsonArray, type Json } from "../../json/index.ts"

const emptyUserTurn = (): Json => ({ role: "user", parts: [{ text: "" }] })

/** A leading `model` turn gets an empty user turn in front of it. */
export const ensureGeminiLeadingUserContent = (body: Json, path = "contents"): Json => {
  const contents = get(body, path)
  if (!isJsonArray(contents) || contents.length === 0) return body
  if (asString(get(contents[0], "role")) !== "model") return body
  contents.unshift(emptyUserTurn())
  return body
}

const contentHasFunctionResponse = (content: Json | undefined): boolean => {
  const parts = get(content, "parts")
  return isJsonArray(parts) && parts.some((part) => exists(part, "functionResponse"))
}

/** A trailing `model`/`assistant` turn (without functionResponse) gets an empty user turn appended. */
export const ensureGeminiTrailingUserContent = (body: Json, path = "contents"): Json => {
  const contents = get(body, path)
  if (!isJsonArray(contents) || contents.length === 0) return body
  const last = contents[contents.length - 1]
  const role = asString(get(last, "role"))
  if ((role !== "model" && role !== "assistant") || contentHasFunctionResponse(last)) return body
  contents.push(emptyUserTurn())
  return body
}

export const ensureGeminiBoundaryUserContent = (body: Json, path = "contents"): Json =>
  ensureGeminiTrailingUserContent(ensureGeminiLeadingUserContent(body, path), path)
