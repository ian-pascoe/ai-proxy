/**
 * Upstream message sanitising for Claude targets.
 *
 * Go source: internal/runtime/executor/claude_executor.go (sanitizeClaudeMessagesForClaudeUpstreamWithDebug,
 * sanitizeClaudeWebSearchDomains), internal/signature/claude_messages_sanitize.go
 * (SanitizeClaudeMessagesForClaudeUpstream), internal/signature/claude_validation.go (HasClaudeThinkingSignaturePrefix).
 * Simplification: thinking signatures are validated by the decodable-prefix rule (`E…`/`R…` base64), not by the full
 * protobuf provenance inspection of internal/signature (Gemini/GPT/Kimi detection stays with the shared signature
 * slice); blocks failing it are dropped like Go drops foreign signatures.
 */
import { get, type Json, type JsonObject } from "../../json/index.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"

const MAX_SIGNATURE_LENGTH = 1 << 20

export const stripSignaturePrefix = (raw: string): string => {
  const sig = raw.trim()
  const hash = sig.indexOf("#")
  return (hash >= 0 ? sig.slice(hash + 1) : sig).trim()
}

const decodes = (value: string): boolean => {
  try {
    return atob(value).length > 0
  } catch {
    return false
  }
}

/** `HasDecodableClaudeThinkingSignature` (without the Antigravity `Q…` CAQS form). */
export const hasDecodableThinkingSignature = (raw: string): boolean => {
  const sig = stripSignaturePrefix(raw)
  if (sig === "" || sig.length > MAX_SIGNATURE_LENGTH) return false
  if (sig[0] === "E") return decodes(sig)
  if (sig[0] === "R") {
    try {
      const outer = atob(sig)
      return outer.length > 0 && outer[0] === "E" && atob(outer).length > 0
    } catch {
      return false
    }
  }
  return false
}

const TOOL_SIGNATURE_PATHS = [
  "signature",
  "thoughtSignature",
  "thought_signature",
  "extra_content.google.thought_signature",
  "model"
]

const stripToolUseSignatures = (part: JsonObject): boolean => {
  let changed = false
  for (const path of TOOL_SIGNATURE_PATHS) {
    const segments = path.split(".")
    let parent: Json | undefined = part
    for (const segment of segments.slice(0, -1)) parent = get(parent, segment)
    const key = segments[segments.length - 1] as string
    if (isObj(parent) && Object.hasOwn(parent, key)) {
      delete parent[key]
      changed = true
    }
  }
  const extra = part.extra_content
  if (isObj(extra) && isObj(extra.google) && Object.keys(extra.google).length === 0) {
    delete extra.google
    changed = true
  }
  if (isObj(extra) && Object.keys(extra).length === 0) {
    delete part.extra_content
    changed = true
  }
  return changed
}

/** Drops invalid thinking blocks/signatures from the history (`preserveEmpty` keeps thinking blocks untouched). */
export const sanitizeClaudeMessages = (body: JsonObject, preserveEmptyThinkingBlocks: boolean): void => {
  const messages = body.messages
  if (!isArr(messages)) return
  const kept: Json[] = []
  for (const message of messages) {
    const content = isObj(message) ? message.content : undefined
    if (!isObj(message) || !isArr(content)) {
      kept.push(message)
      continue
    }
    let modified = false
    const parts: Json[] = []
    for (const part of content) {
      if (!isObj(part)) {
        parts.push(part)
        continue
      }
      const type = str(part.type)
      if (type === "tool_use") {
        if (stripToolUseSignatures(part)) modified = true
        parts.push(part)
        continue
      }
      if (type !== "thinking" || preserveEmptyThinkingBlocks) {
        parts.push(part)
        continue
      }
      // Empty placeholders and blocks without a Claude signature cannot be replayed upstream.
      if (hasDecodableThinkingSignature(str(part.signature))) parts.push(part)
      else modified = true
    }
    if (!modified) {
      kept.push(message)
      continue
    }
    if (parts.length === 0) continue
    message.content = parts
    kept.push(message)
  }
  body.messages = kept
}

/** `sanitizeClaudeWebSearchDomains`: empty domain lists are rejected upstream. */
export const sanitizeWebSearchDomains = (body: JsonObject): void => {
  if (!isArr(body.tools)) return
  for (const tool of body.tools) {
    if (!isObj(tool) || !str(tool.type).startsWith("web_search_")) continue
    for (const field of ["allowed_domains", "blocked_domains"]) {
      const value = tool[field]
      if (isArr(value) && value.length === 0) delete tool[field]
    }
  }
}

/** `sanitizeClaudeMessagesForClaudeUpstreamWithDebug`. */
export const sanitizeForClaudeUpstream = (
  body: JsonObject,
  baseModel: string,
  preserveEmptyThinkingBlocks: boolean
): void => {
  if (baseModel.toLowerCase().includes("claude") || preserveEmptyThinkingBlocks) {
    sanitizeClaudeMessages(body, preserveEmptyThinkingBlocks)
  }
  sanitizeWebSearchDomains(body)
}
