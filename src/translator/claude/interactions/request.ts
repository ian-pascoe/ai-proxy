/**
 * Interactions client -> Claude Messages provider (request).
 *
 * Go source: internal/translator/claude/interactions/interactions_claude_request.go.
 */
import { asBool, get, type Json, type JsonObject } from "../../../json/index.ts"
import { applyTranslatedSummaryToClaude, convertLevelToBudget } from "../../../thinking/index.ts"
import { lookupModelInfo } from "../../model-info.ts"
import { ClaudeMessageAccumulator } from "../../common/claude-messages.ts"
import { normalizeClaudeToolInputSchema, sanitizeClaudeFunctionName } from "../../common/claude-util.ts"
import { sanitizeClaudeToolId } from "../../common/tool-names.ts"
import { exists, isArr, isObj, isStr, str } from "../../common/gjson.ts"
import { interactionsAttachmentType, isHttpUrl, isInteractionsInstructionStep, UserRun } from "../../common/parts.ts"

const firstExisting = (root: Json | undefined, ...paths: string[]): Json | undefined => {
  for (const path of paths) {
    const value = get(root, path)

    if (exists(value)) return value
  }

  return undefined
}

/** `ConvertInteractionsRequestToClaude`. */
export const convertInteractionsRequestToClaude = (modelName: string, root: Json, stream: boolean): Json => {
  const run = new UserRun()
  const out: JsonObject = { model: "", max_tokens: 32000, messages: [] }
  out.model = modelName

  if (stream || asBool(get(root, "stream"))) out.stream = true
  copySystem(out, root)
  copyGenerationConfig(out, root)
  const accumulator = new ClaudeMessageAccumulator()
  appendInput(accumulator, get(root, "input"), run)
  run.end()
  out.messages = accumulator.messages()
  copyTools(out, root)
  const result = applyTranslatedSummaryToClaude(out, root, "interactions", modelName, lookupModelInfo) ?? out
  const refusal = run.err(result)

  if (refusal !== undefined) throw refusal

  return result
}

const copySystem = (out: JsonObject, root: Json): void => {
  const text = interactionsText(firstExisting(root, "system_instruction", "systemInstruction"))

  if (text !== "") out.system = text
}

const copyGenerationConfig = (out: JsonObject, root: Json): void => {
  const cfg = firstExisting(root, "generation_config", "generationConfig")

  if (exists(cfg)) {
    copyField(out, cfg, "max_output_tokens", "max_tokens")
    copyField(out, cfg, "maxOutputTokens", "max_tokens")
    copyField(out, cfg, "top_p", "top_p")
    copyField(out, cfg, "topP", "top_p")
    copyField(out, cfg, "temperature", "temperature")
    copyField(out, cfg, "stop_sequences", "stop_sequences")
    copyField(out, cfg, "stopSequences", "stop_sequences")
    const level = firstExisting(cfg, "thinking_level", "thinkingLevel", "reasoning.effort")

    if (exists(level)) setThinkingFromLevel(out, str(level))
    copyToolChoice(out, get(cfg, "tool_choice"))
    copyToolChoice(out, get(cfg, "toolChoice"))
  }

  copyReasoning(out, get(root, "reasoning"))
  copyToolChoice(out, get(root, "tool_choice"))
  copyToolChoice(out, get(root, "toolChoice"))
}

const copyField = (out: JsonObject, root: Json, from: string, to: string): void => {
  const value = get(root, from)

  if (exists(value)) out[to] = value
}

const copyReasoning = (out: JsonObject, reasoning: Json | undefined): void => {
  if (!exists(reasoning)) return
  const effort = get(reasoning, "effort")

  if (exists(effort)) {
    setThinkingFromLevel(out, str(effort))

    return
  }

  const level = get(reasoning, "thinking_level")

  if (exists(level)) setThinkingFromLevel(out, str(level))
}

const thinkingObject = (out: JsonObject): JsonObject => {
  const current = isObj(out.thinking) ? out.thinking : {}
  out.thinking = current

  return current
}

const setThinkingFromLevel = (out: JsonObject, level: string): void => {
  const normalized = level.trim().toLowerCase()

  if (normalized === "") return

  switch (normalized) {
    case "none":
    case "disabled":
    case "off":
    case "false": {
      const thinking = thinkingObject(out)
      thinking.type = "disabled"
      delete thinking.budget_tokens

      return
    }

    case "auto":
    case "adaptive": {
      const thinking = thinkingObject(out)
      thinking.type = "adaptive"
      delete thinking.budget_tokens

      return
    }
  }

  const budget = convertLevelToBudget(normalized)

  if (budget !== undefined) {
    const thinking = thinkingObject(out)

    if (budget === 0) thinking.type = "disabled"
    else if (budget < 0) thinking.type = "enabled"
    else {
      thinking.type = "enabled"
      thinking.budget_tokens = budget
    }

    return
  }

  thinkingObject(out).type = "adaptive"
  const config = isObj(out.output_config) ? out.output_config : {}
  config.effort = normalized
  out.output_config = config
}

const appendInput = (accumulator: ClaudeMessageAccumulator, input: Json | undefined, run: UserRun): void => {
  if (!exists(input)) return

  if (isStr(input)) {
    appendStep(accumulator, { type: "user_input", content: [{ type: "text", text: input }] }, "user", false, run)

    return
  }

  if (isObj(input)) {
    appendInputItem(accumulator, input, run)

    return
  }

  if (isArr(input)) for (const step of input) appendInputItem(accumulator, step, run)
}

const appendInputItem = (accumulator: ClaudeMessageAccumulator, step: Json, run: UserRun): void => {
  const steps = get(step, "steps")

  if (isArr(steps)) {
    const role = str(get(step, "role"))
    const defaultRole = role === "model" || role === "assistant" ? "assistant" : "user"
    const instruction = isInteractionsInstructionStep(step, false)

    for (const nested of steps) appendStep(accumulator, nested, defaultRole, instruction, run)

    return
  }

  const parts = get(step, "parts")

  if (exists(parts)) {
    const role = str(get(step, "role"))

    const wrapped: JsonObject = {
      type: role === "model" || role === "assistant" ? "model_output" : "user_input",
      content: parts
    }

    appendStep(accumulator, wrapped, "user", isInteractionsInstructionStep(step, false), run)

    return
  }

  switch (str(get(step, "type"))) {
    case "function_call":
      appendFunctionCall(accumulator, step, run)
      break
    case "function_result":
      appendFunctionResult(accumulator, step, run)
      break
    case "model_output":
    case "thought":
      appendStep(accumulator, step, "assistant", false, run)
      break
    default:
      appendStep(accumulator, step, "user", false, run)
  }
}

/**
 * Adds one step. `instruction` says the step sits in a developer or system wrapper: its content is sent as user
 * content but closes the open user turn and never keeps an emptied one alive.
 */
const appendStep = (
  accumulator: ClaudeMessageAccumulator,
  step: Json,
  defaultRole: string,
  instruction: boolean,
  run: UserRun
): void => {
  let role = defaultRole
  const stepRole = str(get(step, "role"))

  if (stepRole === "user" || stepRole === "assistant") role = stepRole
  const userContent = role === "user" && !isInteractionsInstructionStep(step, instruction)
  const contentItems: JsonObject[] = []

  const appendPart = (part: Json): void => {
    const converted = contentToClaude(part, role)

    if (converted === undefined) {
      if (userContent) {
        const dropped = droppedPart(part)

        if (dropped !== "") run.drop(dropped)
      }

      return
    }

    contentItems.push(converted)

    if (userContent && partIsSendable(converted)) run.add()
  }

  const stepContent = get(step, "content")

  if (isStr(stepContent)) appendPart({ type: "text", text: stepContent })
  else if (isArr(stepContent)) for (const part of stepContent) appendPart(part)
  else if (exists(get(step, "text"))) appendPart({ type: "text", text: str(get(step, "text")) })
  else if (droppedMedia(step) !== "") appendPart(step)

  if (contentItems.length === 0) return

  if (!userContent) run.end()
  accumulator.append({ role, content: contentItems })
}

const contentToClaude = (part: Json, role: string): JsonObject | undefined => {
  let partType = str(get(part, "type"))

  if (partType === "" && exists(get(part, "text"))) partType = "text"

  switch (partType) {
    case "text":
      return { type: "text", text: str(get(part, "text")) }
    case "thinking":
    case "reasoning":
      return role === "assistant" ? { type: "thinking", thinking: interactionsText(part) } : undefined
    case "image":
      return mediaPart(part, "image")
    case "document":
    case "file":
      return mediaPart(part, "document")
    default: {
      const text = interactionsText(part)

      if (text !== "") return { type: "text", text }

      // A user attachment Claude cannot carry is recorded as dropped by the caller; echoed content keeps a placeholder.
      if (role !== "user" && (str(get(part, "data")) !== "" || str(get(part, "file_data")) !== "")) {
        return { type: "text", text: `[${partType} content omitted]` }
      }
    }
  }

  return undefined
}

const appendFunctionCall = (accumulator: ClaudeMessageAccumulator, step: Json, run: UserRun): void => {
  const toolUse: JsonObject = {
    type: "tool_use",
    id: toolId(step),
    name: sanitizeClaudeFunctionName(str(get(step, "name"))),
    input: {}
  }

  const args = firstExisting(step, "arguments", "args")

  if (isObj(args)) toolUse.input = args
  run.end()
  accumulator.append({ role: "assistant", content: [toolUse] })
}

const appendFunctionResult = (accumulator: ClaudeMessageAccumulator, step: Json, run: UserRun): void => {
  const toolResult: JsonObject = { type: "tool_result", tool_use_id: toolId(step), content: "" }
  const isError = get(step, "is_error")

  if (exists(isError) && asBool(isError)) toolResult.is_error = true
  const result = firstExisting(step, "result", "output")

  if (isArr(result)) {
    const items: JsonObject[] = []

    for (const part of result) {
      const converted = contentToClaude(part, "tool_result")

      if (converted !== undefined) items.push(converted)
    }

    toolResult.content = items
  } else if (exists(result)) {
    // Go stores the raw JSON text of the result as the content string.
    toolResult.content = JSON.stringify(result)
  }

  run.add()
  accumulator.append({ role: "user", content: [toolResult] })
}

const copyTools = (out: JsonObject, root: Json): void => {
  const tools = get(root, "tools")

  if (!isArr(tools)) return
  const items: JsonObject[] = []

  const push = (decl: Json): void => {
    const converted = toolToClaude(decl)

    if (converted !== undefined) items.push(converted)
  }

  for (const tool of tools) {
    const snake = get(tool, "function_declarations")

    if (isArr(snake)) {
      snake.forEach(push)
      continue
    }

    const camel = get(tool, "functionDeclarations")

    if (isArr(camel)) {
      camel.forEach(push)
      continue
    }

    push(tool)
  }

  if (items.length > 0) out.tools = items
}

const toolToClaude = (tool: Json): JsonObject | undefined => {
  let name = str(get(tool, "name"))

  if (name === "") name = str(get(tool, "function.name"))

  if (name === "") return undefined

  const converted: JsonObject = {
    name: sanitizeClaudeFunctionName(name),
    input_schema: { type: "object", properties: {} }
  }

  const desc = get(tool, "description")

  if (exists(desc)) converted.description = str(desc)
  else {
    const fnDesc = get(tool, "function.description")

    if (exists(fnDesc)) converted.description = str(fnDesc)
  }

  const params = firstExisting(tool, "parameters", "parametersJsonSchema", "parameters_json_schema", "input_schema")

  if (isObj(params)) converted.input_schema = normalizeClaudeToolInputSchema(params)

  return converted
}

const copyToolChoice = (out: JsonObject, toolChoice: Json | undefined): void => {
  if (!exists(toolChoice)) return

  if (isStr(toolChoice)) {
    switch (toolChoice.trim().toLowerCase()) {
      case "auto":
        out.tool_choice = { type: "auto" }
        break
      case "required":
      case "any":
        out.tool_choice = { type: "any" }
        break
    }

    return
  }

  if (!isObj(toolChoice) && !isArr(toolChoice)) return

  switch (str(get(toolChoice, "type")).trim().toLowerCase()) {
    case "auto":
      out.tool_choice = { type: "auto" }
      break
    case "required":
    case "any":
      out.tool_choice = { type: "any" }
      break
    case "function":
    case "tool": {
      let name = str(get(toolChoice, "name"))

      if (name === "") name = str(get(toolChoice, "function.name"))

      if (name !== "") out.tool_choice = { type: "tool", name: sanitizeClaudeFunctionName(name) }
      break
    }
  }
}

const toolId = (step: Json): string => {
  for (const path of ["call_id", "id", "tool_use_id"]) {
    const value = str(get(step, path))

    if (value !== "") return sanitizeClaudeToolId(value)
  }

  const name = str(get(step, "name"))

  if (name !== "") return sanitizeClaudeToolId(`toolu_${name}`)

  return "toolu_interactions"
}

const interactionsText = (value: Json | undefined): string => {
  if (!exists(value)) return ""

  if (isStr(value)) return value
  const text = get(value, "text")

  if (exists(text)) return str(text)
  const thinking = get(value, "thinking")

  if (exists(thinking)) return str(thinking)
  const content = get(value, "content")

  if (exists(content)) return interactionsText(content)
  const parts = get(value, "parts")

  if (isArr(parts)) {
    let out = ""

    for (const part of parts) {
      const text = interactionsText(part)

      if (text === "") continue

      if (out !== "") out += "\n"
      out += text
    }

    return out
  }

  return ""
}

/** Maps an Interactions image or document onto a Claude block (base64 bytes or an http(s) url). */
const mediaPart = (part: Json, claudeType: string): JsonObject | undefined => {
  let mimeType = str(firstExisting(part, "mime_type", "mimeType", "media_type", "mediaType"))
  let data = str(firstExisting(part, "data", "file_data", "fileData"))
  const source = get(part, "source")

  if (exists(source)) {
    if (mimeType === "") mimeType = str(get(source, "media_type"))

    if (data === "") data = str(get(source, "data"))
  }

  if (mimeType !== "" && data !== "")
    return { type: claudeType, source: { type: "base64", media_type: mimeType, data } }

  for (const path of ["uri", "file_uri", "fileUri", "url"]) {
    const uri = str(get(part, path)).trim()

    if (isHttpUrl(uri)) return { type: claudeType, source: { type: "url", url: uri } }
  }

  return undefined
}

const droppedMedia = (part: Json): string => {
  const type = str(get(part, "type"))

  if (type === "image" || type === "audio" || type === "video" || type === "document") return type

  return type === "file" ? "document" : ""
}

const droppedPart = (part: Json): string => {
  const media = droppedMedia(part)

  if (media !== "") return media

  if (str(get(part, "data")) !== "" || str(get(part, "file_data")) !== "") return interactionsAttachmentType(part)

  return ""
}

const partIsSendable = (block: JsonObject): boolean => str(block.type) !== "text" || str(block.text).trim() !== ""
