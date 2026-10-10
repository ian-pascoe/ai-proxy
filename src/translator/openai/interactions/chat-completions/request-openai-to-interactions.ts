/**
 * OpenAI Chat Completions client -> Interactions provider (request).
 *
 * Go source: internal/translator/openai/interactions/chat-completions/openai_interactions_request.go.
 */
import { asBool, asInt, cloneJson, get, isJsonObject, type Json, type JsonObject, set } from "../../../../json/index.ts"
import { antigravityToolNameToUpstream } from "../../common/antigravity-tools.ts"
import { normalizeOpenAIFileData } from "../../../common/file-data.ts"
import { getStr, isArr, str } from "../../common/read.ts"
import { UserTurnDrops } from "../../../common/parts.ts"
import {
  firstExisting,
  firstNonEmpty,
  interactionsTextStep,
  isAntigravityModel,
  openAIReasoningTexts,
  openAIToolCallToInteractionsStep,
  openAIInputAudioMimeType
} from "./shared.ts"

const openAIChatPartType = (part: Json): string => {
  let partType = getStr(part, "type").trim().toLowerCase()

  if (partType === "" && get(part, "text") !== undefined) partType = "text"

  return partType
}

/** `isOpenAIChatAttachmentType`: part types whose loss must be refused when they leave a user turn empty. */
const isOpenAIChatAttachmentType = (partType: string): boolean =>
  ["file", "input_file", "document", "input_audio", "audio"].includes(partType)

const openAIChatParseDataUrl = (value: string): { mimeType: string; data: string } | undefined => {
  if (!value.startsWith("data:")) return undefined
  const rest = value.slice("data:".length)
  const comma = rest.indexOf(",")

  if (comma < 0) return undefined
  const meta = rest.slice(0, comma)
  const data = rest.slice(comma + 1)
  const semi = meta.indexOf(";")
  const mimeType = semi >= 0 ? meta.slice(0, semi) : meta
  const encoding = semi >= 0 ? meta.slice(semi + 1) : ""

  if (encoding.toLowerCase() !== "base64" || mimeType.trim() === "" || data === "") return undefined

  return { mimeType, data }
}

const openAIChatImagePartToInteractions = (part: Json): JsonObject => {
  const out: JsonObject = { type: "image" }
  const imageUrl = firstNonEmpty(getStr(part, "image_url.url"), getStr(part, "image_url"), getStr(part, "url"))
  const parsed = openAIChatParseDataUrl(imageUrl)

  if (parsed !== undefined) {
    out.mime_type = parsed.mimeType
    out.data = parsed.data

    return out
  }

  const data = getStr(part, "data")

  if (data !== "") {
    out.data = data
    const mimeType = getStr(part, "mime_type")

    if (mimeType !== "") out.mime_type = mimeType

    return out
  }

  if (imageUrl !== "") out.image_url = imageUrl

  return out
}

const openAIChatContentPartToInteractions = (part: Json): JsonObject | undefined => {
  switch (openAIChatPartType(part)) {
    case "text":
    case "input_text":
    case "output_text":
      return { type: "text", text: getStr(part, "text") }
    case "image_url":
    case "input_image":
    case "image":
      return openAIChatImagePartToInteractions(part)
    case "input_audio":
    case "audio": {
      const audio = get(part, "input_audio")
      const data = firstNonEmpty(getStr(audio, "data"), getStr(part, "data"))

      if (data === "") return undefined
      const out: JsonObject = { type: "audio", data }
      const format = firstNonEmpty(getStr(audio, "format"), getStr(part, "format"))

      if (format !== "") out.mime_type = openAIInputAudioMimeType(format)

      return out
    }

    case "file":
    case "input_file":
    case "document": {
      const file = get(part, "file")
      const filename = firstNonEmpty(getStr(file, "filename"), getStr(part, "filename"))

      const fallbackMimeType = firstNonEmpty(
        getStr(file, "mime_type"),
        getStr(file, "mimeType"),
        getStr(part, "mime_type"),
        getStr(part, "mimeType")
      )

      const fileData = firstNonEmpty(getStr(file, "file_data"), getStr(part, "file_data"), getStr(part, "data"))
      const fileUrl = firstNonEmpty(getStr(file, "file_url"), getStr(part, "file_url"), getStr(part, "url"))
      const out: JsonObject = { type: "document" }

      if (filename !== "") out.filename = filename
      let hasContent = false
      const normalized = normalizeOpenAIFileData(filename, fallbackMimeType, fileData)

      if (normalized !== undefined) {
        out.mime_type = normalized.mimeType
        out.data = normalized.data
        hasContent = true
      }

      if (fileUrl !== "") {
        out.file_url = fileUrl
        hasContent = true
      }

      return hasContent ? out : undefined
    }

    default:
      return undefined
  }
}

/**
 * `openAIChatContentStep`: one message content as an Interactions step. A non-undefined `drops` closes the user turn:
 * an attachment that cannot be sent is recorded and other sendable parts keep the turn alive.
 */
const openAIChatContentStep = (
  stepType: string,
  content: Json | undefined,
  drops: UserTurnDrops | undefined
): JsonObject | undefined => {
  const contentItems: Json[] = []
  let sendable = 0

  try {
    if (typeof content === "string") {
      if (content === "") return undefined
      contentItems.push({ type: "text", text: content })
      sendable++
    } else {
      const appendPart = (part: Json): void => {
        const converted = openAIChatContentPartToInteractions(part)

        if (converted === undefined) {
          const partType = openAIChatPartType(part)

          if (drops !== undefined && isOpenAIChatAttachmentType(partType)) drops.drop(partType)

          return
        }

        contentItems.push(converted)

        if (converted.type !== "text" || str(converted.text) !== "") sendable++
      }

      if (isArr(content)) for (const part of content) appendPart(part)
      else if (isJsonObject(content)) appendPart(content)
    }

    if (contentItems.length === 0) return undefined

    return { type: stepType, content: contentItems }
  } finally {
    drops?.endTurn(sendable)
  }
}

/** `openAIChatContentText`. */
const openAIChatContentText = (content: Json | undefined): string => {
  if (typeof content === "string") return content

  if (isJsonObject(content)) return getStr(content, "text")

  if (!isArr(content)) return ""
  let text = ""

  for (const part of content) {
    const t = getStr(part, "text")

    if (t !== "") text += t
  }

  return text
}

const openAIToolResultToInteractions = (
  message: Json,
  forAntigravity: boolean,
  toolNamesById: Map<string, string>
): JsonObject => {
  const out: JsonObject = { type: "function_result", result: "" }
  const callId = firstNonEmpty(getStr(message, "tool_call_id"), getStr(message, "id"))

  if (callId !== "") out.call_id = callId
  let name = getStr(message, "name")

  if (name === "" && callId !== "") name = toolNamesById.get(callId) ?? ""

  if (name !== "") {
    if (forAntigravity) name = antigravityToolNameToUpstream(name)
    out.name = name
  }

  const content = get(message, "content")

  if (typeof content === "string") out.result = content
  else if (content !== undefined) out.result = cloneJson(content)

  return out
}

const appendOpenAIMessageToInteractions = (
  items: Json[],
  message: Json,
  forAntigravity: boolean,
  toolNamesById: Map<string, string>,
  drops: UserTurnDrops
): void => {
  const role = getStr(message, "role").trim().toLowerCase()

  switch (role) {
    case "assistant": {
      const reasoning = get(message, "reasoning_content")

      if (reasoning !== undefined)
        for (const text of openAIReasoningTexts(reasoning)) items.push(interactionsTextStep("thought", text))
      const step = openAIChatContentStep("model_output", get(message, "content"), undefined)

      if (step !== undefined) items.push(step)
      const toolCalls = get(message, "tool_calls")

      if (isArr(toolCalls)) {
        for (const toolCall of toolCalls) {
          const id = getStr(toolCall, "id")

          if (id !== "") {
            const name = getStr(toolCall, "function.name")

            if (name !== "") toolNamesById.set(id, name)
          }

          const s = openAIToolCallToInteractionsStep(toolCall, forAntigravity)

          if (s !== undefined) items.push(s)
        }
      }

      break
    }

    case "tool":
    case "function":
      items.push(openAIToolResultToInteractions(message, forAntigravity, toolNamesById))
      break
    default: {
      const step = openAIChatContentStep("user_input", get(message, "content"), drops)

      if (step !== undefined) items.push(step)
    }
  }
}

const openAIChatToolToInteractions = (tool: Json, forAntigravity: boolean): JsonObject | undefined => {
  const toolType = getStr(tool, "type").trim().toLowerCase()

  if (toolType !== "" && toolType !== "function") return undefined
  let name = firstNonEmpty(getStr(tool, "function.name"), getStr(tool, "name"))

  if (name === "") return undefined

  if (forAntigravity) name = antigravityToolNameToUpstream(name)
  const out: JsonObject = { type: "function", name }
  const desc = firstExisting(get(tool, "function.description"), get(tool, "description"))

  if (desc !== undefined) out.description = str(desc)
  const parameters = firstExisting(get(tool, "function.parameters"), get(tool, "parameters"))

  if (parameters !== undefined) out.parameters = cloneJson(parameters)

  return out
}

/** `ConvertOpenAIRequestToInteractions`. */
export const convertOpenAIRequestToInteractions = (modelName: string, root: Json, stream: boolean): Json => {
  const out: JsonObject = { model: "", input: [] }
  const model = firstNonEmpty(modelName, getStr(root, "model"))
  out.model = model
  const streamValue = get(root, "stream")

  if (streamValue !== undefined) out.stream = asBool(streamValue)
  else if (stream) out.stream = true
  const previous = firstNonEmpty(getStr(root, "previous_response_id"), getStr(root, "previous_interaction_id"))

  if (previous !== "") out.previous_interaction_id = previous
  const environmentId = firstNonEmpty(getStr(root, "environment_id"), getStr(root, "environment.id"))

  if (environmentId !== "") out.environment_id = environmentId
  const agentConfig = get(root, "agent_config")

  if (agentConfig !== undefined) out.agent_config = cloneJson(agentConfig)

  const forAntigravity = isAntigravityModel(model)
  const drops = new UserTurnDrops()
  const messages = get(root, "messages")

  if (isArr(messages)) {
    const inputItems: Json[] = []
    const systemParts: string[] = []
    const toolNamesById = new Map<string, string>()

    for (const message of messages) {
      const role = getStr(message, "role").trim().toLowerCase()

      if (role === "system" || role === "developer") {
        const text = openAIChatContentText(get(message, "content"))

        if (text !== "") systemParts.push(text)
      } else {
        appendOpenAIMessageToInteractions(inputItems, message, forAntigravity, toolNamesById, drops)
      }
    }

    if (systemParts.length > 0) out.system_instruction = systemParts.join("\n")

    if (inputItems.length > 0) out.input = inputItems
  }

  // Generation config.
  const copyNumber = (path: string, value: Json | undefined): void => {
    if (value !== undefined) set(out, path, cloneJson(value))
  }

  if (isAntigravityModel(model)) {
    const maxOutputTokens = firstExisting(
      get(root, "max_completion_tokens"),
      get(root, "max_tokens"),
      get(root, "max_output_tokens")
    )

    if (maxOutputTokens !== undefined && get(root, "agent_config.max_total_tokens") === undefined) {
      set(out, "agent_config.max_total_tokens", asInt(maxOutputTokens))
    }
  } else {
    copyNumber(
      "generation_config.max_output_tokens",
      firstExisting(get(root, "max_completion_tokens"), get(root, "max_tokens"))
    )
    copyNumber("generation_config.temperature", get(root, "temperature"))
    copyNumber("generation_config.top_p", get(root, "top_p"))
    copyNumber("generation_config.presence_penalty", get(root, "presence_penalty"))
    copyNumber("generation_config.frequency_penalty", get(root, "frequency_penalty"))
    copyNumber("generation_config.candidate_count", get(root, "n"))
    const stop = get(root, "stop")

    if (stop !== undefined) set(out, "generation_config.stop_sequences", cloneJson(stop))
  }

  const toolChoice = get(root, "tool_choice")

  if (toolChoice !== undefined) {
    if (isAntigravityModel(model) && isJsonObject(toolChoice)) {
      const tc = cloneJson(toolChoice)
      const fnName = getStr(toolChoice, "function.name")

      if (fnName !== "") set(tc, "function.name", antigravityToolNameToUpstream(fnName))
      else {
        const name = getStr(toolChoice, "name")

        if (name !== "") set(tc, "name", antigravityToolNameToUpstream(name))
      }

      set(out, "generation_config.tool_choice", tc)
    } else {
      set(out, "generation_config.tool_choice", cloneJson(toolChoice))
    }
  }

  const effort = get(root, "reasoning_effort")

  if (typeof effort === "string") set(out, "generation_config.thinking_level", effort.trim().toLowerCase())
  const responseFormat = get(root, "response_format")

  if (responseFormat !== undefined) out.response_format = cloneJson(responseFormat)
  const modalities = get(root, "modalities")

  if (modalities !== undefined) out.response_modalities = cloneJson(modalities)
  const serviceTier = get(root, "service_tier")

  if (typeof serviceTier === "string") out.service_tier = serviceTier

  const tools = get(root, "tools")

  if (isArr(tools)) {
    const toolItems: Json[] = []

    for (const tool of tools) {
      const converted = openAIChatToolToInteractions(tool, forAntigravity)

      if (converted !== undefined) toolItems.push(converted)
    }

    if (toolItems.length > 0) out.tools = toolItems
  }

  const err = drops.err(out)

  if (err !== undefined) throw err

  return out
}
