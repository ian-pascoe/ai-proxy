/**
 * count_tokens request validation.
 *
 * Go source: internal/runtime/executor/claude_executor_tokens.go (validateClaudeTokenCountRequest). The local
 * estimate used for third-party gateways (first-party requests are counted by Anthropic) is `src/tokenizer/claude-input.ts`.
 */
import type { Json } from "../../json/index.ts"
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
