/**
 * `rebuild-mid-system-message`: folds caller `{"role":"system"}` messages into the top-level `system` field.
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (`rebuildMidSystemMessagesToTopLevel`,
 * `claudeSystemTextParts`, `claudePayloadHasMidSystemMessage`), claude_signing.go (`rebuildMidSystemMessageEnabled`).
 * For operators whose upstream rejects mid-conversation system turns (legacy models, gateways) instead of the local 400
 * of `validateMidSystemMessageModel`; it runs right after the thinking step, before cloaking.
 */
import type { Config } from "../../config/schema.ts"
import type { Json, JsonObject } from "../../json/index.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"
import type { CredentialSnapshot } from "../picker.ts"
import { resolveClaudeKeyConfig } from "./credentials.ts"

/** `rebuildMidSystemMessageEnabled`: the credential attribute or its `api-keys.claude` entry. */
export const rebuildMidSystemEnabled = (config: Config, credential: CredentialSnapshot): boolean =>
  (credential.attributes["rebuild_mid_system_message"] ?? "").trim().toLowerCase() === "true" ||
  resolveClaudeKeyConfig(config, credential)?.entry["rebuild-mid-system-message"] === true

const textBlock = (text: string): JsonObject => ({ type: "text", text })

/** `claudeSystemTextParts`: the text blocks of a system/message content value (blank text is dropped). */
const systemTextParts = (content: Json | undefined): Json[] => {
  if (content === undefined) return []

  if (typeof content === "string") return content.trim() === "" ? [] : [textBlock(content)]

  if (!isArr(content)) return []
  const parts: Json[] = []

  for (const item of content) {
    if (typeof item === "string") {
      if (item.trim() !== "") parts.push(textBlock(item))
    } else if (isObj(item) && str(item.type) === "text" && str(item.text).trim() !== "") {
      parts.push(item)
    }
  }

  return parts
}

/**
 * `rebuildMidSystemMessagesToTopLevel`: moves every `role: "system"` message into `system` (after the existing blocks,
 * keeping their order and `cache_control`). Nothing changes when the moved messages carry no text.
 */
export const rebuildMidSystemMessagesToTopLevel = (body: JsonObject): void => {
  const messages = body.messages

  if (!isArr(messages)) return
  const moved: Json[] = []
  const kept: Json[] = []

  for (const message of messages) {
    if (
      str(isObj(message) ? message.role : undefined)
        .trim()
        .toLowerCase() === "system"
    ) {
      moved.push(...systemTextParts(isObj(message) ? message.content : undefined))
    } else {
      kept.push(message)
    }
  }

  if (moved.length === 0) return
  const system = [...systemTextParts(body.system), ...moved]
  body.system = system
  body.messages = kept
}

/** `claudePayloadHasMidSystemMessage`. */
export const hasMidSystemMessage = (body: JsonObject): boolean =>
  isArr(body.messages) &&
  body.messages.some((message) => isObj(message) && str(message.role).trim().toLowerCase() === "system")
