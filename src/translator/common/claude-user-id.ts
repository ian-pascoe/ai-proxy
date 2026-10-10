/**
 * Stable Claude `metadata.user_id` derivation for translated requests.
 *
 * Go source: internal/translator/common/claude_user_id.go.
 */
import { createHash } from "node:crypto"
import { get, type Json } from "../../json/index.ts"
import { eachValue, exists, isArr, str, trimmed } from "./gjson.ts"
import { isGeminiThoughtPart } from "./gemini-parts.ts"

const extractTextContent = (content: Json | undefined): string => {
  if (typeof content === "string") return content.trim()

  if (!isArr(content)) return ""
  const texts: string[] = []

  for (const part of content) {
    if (str(get(part, "type")) !== "text") continue
    const text = get(part, "text")

    if (exists(text) && trimmed(text) !== "") texts.push(trimmed(text))
  }

  return texts.join("\n").trim()
}

const extractResponsesItemText = (content: Json | undefined): string => {
  if (typeof content === "string") return content.trim()

  if (!isArr(content)) return ""
  const texts: string[] = []

  for (const part of content) {
    switch (str(get(part, "type"))) {
      case "input_text":
      case "output_text":
      case "text": {
        const text = get(part, "text")

        if (exists(text) && trimmed(text) !== "") texts.push(trimmed(text))
      }
    }
  }

  return texts.join("\n").trim()
}

const isResponsesUserItem = (item: Json | undefined): boolean => {
  const role = trimmed(get(item, "role")).toLowerCase()

  if (role === "user") return true

  if (role === "system" || role === "developer" || role === "assistant") return false

  return trimmed(get(item, "type")).toLowerCase() === "message"
}

const firstStableRequestContent = (root: Json): string => {
  const messages = get(root, "messages")

  if (isArr(messages)) {
    for (const message of messages) {
      if (trimmed(get(message, "role")).toLowerCase() !== "user") continue
      const content = extractTextContent(get(message, "content"))

      if (content !== "") return content
    }
  }

  const input = get(root, "input")

  if (exists(input)) {
    if (typeof input === "string") {
      if (input.trim() !== "") return input.trim()
    } else if (isArr(input)) {
      for (const item of input) {
        if (!isResponsesUserItem(item)) continue
        const content = extractResponsesItemText(get(item, "content"))

        if (content !== "") return content
      }
    }
  }

  const contents = get(root, "contents")

  if (isArr(contents)) {
    for (const contentItem of contents) {
      const role = trimmed(get(contentItem, "role")).toLowerCase()

      if (role !== "" && role !== "user") continue
      const parts = get(contentItem, "parts")

      if (!isArr(parts)) continue
      const texts: string[] = []

      for (const part of eachValue(parts)) {
        if (isGeminiThoughtPart(part)) continue
        const text = get(part, "text")

        if (exists(text) && trimmed(text) !== "") texts.push(trimmed(text))
      }

      if (texts.length > 0) return texts.join("\n")
    }
  }

  return ""
}

/** `DeriveClaudeUserID`. */
export const deriveClaudeUserID = (root: Json): string => {
  const metaUser = get(root, "metadata.user_id")

  if (typeof metaUser === "string" && metaUser.trim() !== "") return metaUser
  const user = get(root, "user")

  if (typeof user === "string" && user.trim() !== "") return user

  let seed = ""
  const promptCacheKey = get(root, "prompt_cache_key")

  if (exists(promptCacheKey) && trimmed(promptCacheKey) !== "") seed = `prompt_cache_key:${trimmed(promptCacheKey)}`

  if (seed === "") {
    for (const path of ["session_id", "sessionId"]) {
      const value = get(root, path)

      if (exists(value) && trimmed(value) !== "") {
        seed = `session_id:${trimmed(value)}`
        break
      }
    }
  }

  if (seed === "") {
    const conversation = get(root, "conversation")
    const sid = trimmed(get(conversation, "id"))

    if (sid !== "") {
      seed = `conversation_id:${sid}`
    } else if (typeof conversation === "string") {
      if (conversation.trim() !== "") seed = `conversation_id:${conversation.trim()}`
    } else {
      const id = get(root, "conversation_id")

      if (exists(id) && trimmed(id) !== "") seed = `conversation_id:${trimmed(id)}`
    }
  }

  if (seed === "") {
    const content = firstStableRequestContent(root)

    if (content !== "") seed = `content:${content}`
  }

  if (seed === "") {
    const model = get(root, "model")

    if (exists(model) && trimmed(model) !== "") seed += `model:${trimmed(model)}`
    const instructions = get(root, "instructions")

    if (exists(instructions)) seed += `;instructions:${str(instructions)}`
    const system = get(root, "system")

    if (exists(system)) seed += `;system:${str(system)}`
    const systemInstruction = get(root, "systemInstruction")

    if (exists(systemInstruction)) seed += `;systemInstruction:${str(systemInstruction)}`
    const systemInstructionSnake = get(root, "system_instruction")

    if (exists(systemInstructionSnake)) seed += `;system_instruction:${str(systemInstructionSnake)}`
  }

  if (seed === "") return "unknown"

  return createHash("sha256").update(seed).digest("hex")
}
