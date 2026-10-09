/**
 * count_tokens: request validation and the local input token estimate.
 *
 * Go source: internal/runtime/executor/claude_executor_tokens.go (validateClaudeTokenCountRequest,
 * shouldUseClaudeUpstreamTokenCount), internal/runtime/executor/helps/claude_input_tokens.go (segment collection).
 * Deviation: Go counts the segments with the o200k_base BPE tokenizer; Workers has no tokenizer dependency, so the
 * count is an estimate (see {@link estimateTextTokens}). It is only used for third-party gateways; first-party
 * requests (API key or OAuth) are counted by Anthropic.
 */
import { get, type Json, type JsonObject } from "../../json/index.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"

/** Request-scoped 400 for malformed count_tokens bodies. */
export class TokenCountValidationError extends Error {
  override readonly name = "TokenCountValidationError"
}

/** `validateClaudeTokenCountRequest`. */
export const validateTokenCountRequest = (body: Json): void => {
  if (!isObj(body)) throw new TokenCountValidationError("Claude token count request must be a JSON object")
  const messages = body.messages
  if (!isArr(messages) || messages.length === 0) {
    throw new TokenCountValidationError("Claude token count request messages must be a non-empty array")
  }
  for (const message of messages) {
    if (!isObj(message)) throw new TokenCountValidationError("Claude token count request messages must contain objects")
    const role = str(message.role)
    if (role !== "user" && role !== "assistant") {
      throw new TokenCountValidationError("Claude token count request message role must be user or assistant")
    }
    const content = message.content
    if (typeof content === "string") continue
    if (!isArr(content))
      throw new TokenCountValidationError("Claude token count request message content must be a string or array")
    for (const block of content) {
      if (!isObj(block) || typeof block.type !== "string" || block.type === "") {
        throw new TokenCountValidationError("Claude token count request content blocks must be typed objects")
      }
    }
  }
}

const addString = (segments: string[], value: string): void => {
  const text = value.trim()
  if (text !== "") segments.push(text)
}

const addJson = (segments: string[], value: Json | undefined): void => {
  if (value === undefined) return
  if (typeof value === "string") addString(segments, value)
  else addString(segments, JSON.stringify(value))
}

const collectContent = (content: Json | undefined, segments: string[]): void => {
  if (content === undefined) return
  if (typeof content === "string") return addString(segments, content)
  if (isArr(content)) {
    for (const part of content) collectContent(part, segments)
    return
  }
  if (!isObj(content)) return
  const field = (name: string): string => str(content[name])
  switch (str(content.type)) {
    case "text":
      return addString(segments, field("text"))
    case "thinking":
      return addString(segments, field("thinking"))
    case "document": {
      const source = content.source
      if (str(get(source, "type")) !== "text") return
      addString(segments, field("title"))
      addString(segments, field("context"))
      addString(segments, str(get(source, "data")))
      addString(segments, str(get(source, "content")))
      return
    }
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      addString(segments, field("id"))
      addString(segments, field("name"))
      return addJson(segments, content.input)
    case "tool_result":
    case "mcp_tool_result":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
      addString(segments, field("tool_use_id"))
      addString(segments, field("tool_call_id"))
      return collectContent(content.content, segments)
    case "web_search_result":
    case "search_result":
      if (typeof content.source === "string") addString(segments, content.source)
      for (const name of ["title", "url", "page_age"]) addString(segments, field(name))
      return collectContent(content.content, segments)
    case "web_fetch_result":
      addString(segments, field("url"))
      addString(segments, field("retrieved_at"))
      return collectContent(content.content, segments)
    case "code_execution_result":
    case "bash_code_execution_result":
    case "text_editor_code_execution_result":
      for (const name of ["stdout", "stderr", "return_code"]) addString(segments, field(name))
      collectContent(content.content, segments)
      return collectContent(content.output, segments)
    case "tool_reference":
      return addString(segments, field("tool_name"))
    case "image":
    case "input_audio":
    case "audio":
    case "video":
    case "redacted_thinking":
      return
    case "":
      return addJson(segments, content)
    default:
      return addString(segments, field("text"))
  }
}

/** `collectClaudeInputTokenSegments`. */
export const collectTokenSegments = (body: JsonObject): string[] => {
  const segments: string[] = []
  const system = body.system
  if (typeof system === "string") addString(segments, system)
  else if (isArr(system)) {
    for (const part of system) {
      if (typeof part === "string") addString(segments, part)
      else if (str(get(part, "type")) === "text") addString(segments, str(get(part, "text")))
    }
  }
  if (isArr(body.messages)) {
    for (const message of body.messages) {
      addString(segments, str(get(message, "role")))
      collectContent(get(message, "content"), segments)
    }
  }
  if (isArr(body.tools)) {
    for (const tool of body.tools) {
      for (const name of ["type", "name", "description"]) addString(segments, str(get(tool, name)))
      addJson(segments, get(tool, "input_schema"))
    }
  }
  const choice = body.tool_choice
  if (choice !== undefined) {
    if (typeof choice === "string") addString(segments, choice)
    else {
      addString(segments, str(get(choice, "type")))
      addString(segments, str(get(choice, "name")))
    }
  }
  return segments
}

/** BPE-like estimate: pre-tokenise into words, digit runs and punctuation; long words cost one token per ~4 characters. */
export const estimateTextTokens = (text: string): number => {
  let tokens = 0
  for (const match of text.matchAll(/\p{L}+|\p{N}{1,3}|[^\s\p{L}\p{N}]+|\s+/gu)) {
    const piece = match[0]
    if (/^\s+$/u.test(piece)) {
      if (piece.includes("\n")) tokens += 1
      continue
    }
    tokens += Math.max(1, Math.ceil([...piece].length / 4))
  }
  return tokens
}

/** `CountClaudeInputTokens` (estimate, see module docs). */
export const countInputTokens = (body: JsonObject): number => {
  const segments = collectTokenSegments(body)
  return segments.length === 0 ? 0 : estimateTextTokens(segments.join("\n"))
}
