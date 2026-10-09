/**
 * Upstream message sanitising for Claude targets.
 *
 * Go source: internal/runtime/executor/claude_executor.go (sanitizeClaudeMessagesForClaudeUpstreamWithDebug,
 * shouldSanitizeClaudeMessagesForUpstream, sanitizeClaudeWebSearchDomains). Signature handling is the full
 * `internal/signature` port (`signature/claude-messages.ts`); the report logging of Go is not ported.
 */
import type { JsonObject } from "../../json/index.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"
import { sanitizeClaudeMessagesForClaudeUpstream } from "../../signature/claude-messages.ts"
import { signatureProviderFromModelName } from "../../signature/provider.ts"

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
  if (signatureProviderFromModelName(baseModel) === "claude" || preserveEmptyThinkingBlocks) {
    sanitizeClaudeMessagesForClaudeUpstream(body, baseModel, preserveEmptyThinkingBlocks)
  }
  sanitizeWebSearchDomains(body)
}
