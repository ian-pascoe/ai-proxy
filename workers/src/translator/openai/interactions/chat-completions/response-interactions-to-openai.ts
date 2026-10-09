/**
 * Interactions provider -> OpenAI Chat Completions client (response).
 *
 * Go source: internal/translator/openai/interactions/chat-completions/openai_interactions_response.go.
 * `time.Now()` based ids and `created` values are kept (the fixture harness normalises clock fields).
 */
import { asInt, get, type Json, type JsonObject } from "../../../../json/index.ts"
import type { ResponseContext, ResponseTransform } from "../../../registry.ts"
import { antigravityUpstreamToolNameToClient } from "../../common/antigravity-tools.ts"
import { interactionsUsage } from "../../common/interactions-usage.ts"
import { getStr, isArr, raw } from "../../common/read.ts"
import { firstNonEmpty, isAntigravityModel, jsonStringValue, parseJsonOrUndefined, ssePayloadOf } from "./shared.ts"

/** Port of `interactionsToOpenAIChatStreamState`. */
interface InteractionsToOpenAIChatState {
  id: string
  model: string
  environmentId: string
  created: number
  started: boolean
  completed: boolean
  sawToolCall: boolean
  stepTypes: Map<number, string>
  toolIds: Map<number, string>
  toolNames: Map<number, string>
  toolArguments: Map<number, string>
  textByStepIndex: Map<number, string>
  toolCallIndexByStep: Map<number, number>
  nextToolCallIndex: number
}

const chatCreated = (st: InteractionsToOpenAIChatState): number => {
  if (st.created === 0) st.created = Math.floor(Date.now() / 1000)
  return st.created
}

const baseChunk = (st: InteractionsToOpenAIChatState): JsonObject => {
  const chunk: JsonObject = {
    id: firstNonEmpty(st.id, `chatcmpl_${Date.now()}000000`),
    object: "chat.completion.chunk",
    created: chatCreated(st),
    model: st.model,
    choices: [{ index: 0, delta: {}, finish_reason: null }]
  }
  if (st.environmentId !== "") chunk.environment_id = st.environmentId
  return chunk
}

const choiceOf = (chunk: JsonObject): JsonObject => (chunk.choices as JsonObject[])[0] as JsonObject

const deltaChunk = (st: InteractionsToOpenAIChatState, field: string, value: string): JsonObject => {
  const chunk = baseChunk(st)
  ;(choiceOf(chunk).delta as JsonObject)[field] = value
  return chunk
}

const ensureStarted = (out: JsonObject[], st: InteractionsToOpenAIChatState): void => {
  if (st.started) return
  const chunk = baseChunk(st)
  ;(choiceOf(chunk).delta as JsonObject).role = "assistant"
  st.started = true
  out.push(chunk)
}

const toolCallIndexOf = (st: InteractionsToOpenAIChatState, index: number): number => st.toolCallIndexByStep.get(index) ?? index

const toolCallStartChunk = (st: InteractionsToOpenAIChatState, index: number): JsonObject => {
  const chunk = baseChunk(st)
  const toolCallIndex = toolCallIndexOf(st, index)
  ;(choiceOf(chunk).delta as JsonObject).tool_calls = [
    {
      index: toolCallIndex,
      id: firstNonEmpty(st.toolIds.get(index) ?? "", `call_${toolCallIndex}`),
      type: "function",
      function: { name: st.toolNames.get(index) ?? "", arguments: "" }
    }
  ]
  return chunk
}

const toolCallArgumentsChunk = (st: InteractionsToOpenAIChatState, index: number, args: string): JsonObject => {
  const chunk = baseChunk(st)
  ;(choiceOf(chunk).delta as JsonObject).tool_calls = [{ index: toolCallIndexOf(st, index), function: { arguments: args } }]
  return chunk
}

const usageInt = (root: Json | undefined, ...paths: string[]): number | undefined => {
  for (const path of paths) {
    const value = get(root, path)
    if (value !== undefined) return asInt(value)
  }
  return undefined
}

/** `setOpenAIChatUsageFromInteractions` (mutates `out`). */
const setOpenAIChatUsageFromInteractions = (out: JsonObject, usage: Json | undefined): JsonObject => {
  if (usage === undefined) return out
  const target: JsonObject = {}
  const prompt = usageInt(usage, "input_tokens", "total_input_tokens")
  if (prompt !== undefined) target.prompt_tokens = prompt
  const completion = usageInt(usage, "output_tokens", "total_output_tokens")
  if (completion !== undefined) target.completion_tokens = completion
  const total = usageInt(usage, "total_tokens")
  if (total !== undefined) target.total_tokens = total
  const cached = usageInt(usage, "cached_tokens", "total_cached_tokens")
  if (cached !== undefined) target.prompt_tokens_details = { cached_tokens: cached }
  const reasoning = usageInt(usage, "reasoning_tokens", "total_thought_tokens")
  if (reasoning !== undefined) target.completion_tokens_details = { reasoning_tokens: reasoning }
  if (Object.keys(target).length > 0) out.usage = target
  return out
}

const interactionsContentTextsForOpenAIChat = (content: Json | undefined): string[] => {
  if (content === undefined) return []
  if (typeof content === "string") return [content]
  const out: string[] = []
  if (isArr(content)) {
    for (const part of content) {
      const text = firstNonEmpty(getStr(part, "text"), getStr(part, "content.text"))
      if (text !== "") out.push(text)
    }
  }
  return out
}

const openAIChatToolCallFromInteractions = (step: Json, forAntigravity: boolean): JsonObject => {
  const callId = firstNonEmpty(getStr(step, "call_id"), getStr(step, "id"), "call_0")
  let name = getStr(step, "name")
  if (forAntigravity) name = antigravityUpstreamToolNameToClient(name)
  return {
    id: callId,
    type: "function",
    function: { name, arguments: jsonStringValue(get(step, "arguments"), "{}") }
  }
}

const envIdOf = (interaction: Json | undefined, root: Json, ...extra: string[]): string =>
  firstNonEmpty(
    getStr(interaction, "environment_id"),
    getStr(root, "environment_id"),
    getStr(interaction, "environment.id"),
    getStr(root, "environment.id"),
    ...extra
  )

const appendCompleted = (out: JsonObject[], root: Json, st: InteractionsToOpenAIChatState): void => {
  if (st.completed) return
  ensureStarted(out, st)
  const chunk = baseChunk(st)
  let finishReason = st.sawToolCall ? "tool_calls" : "stop"
  const interaction = get(root, "interaction")
  const status = firstNonEmpty(getStr(interaction, "status"), getStr(root, "status"))
  const interactionFinishReason = firstNonEmpty(getStr(interaction, "finish_reason"), getStr(root, "finish_reason"))
  if (interactionFinishReason === "content_filter") finishReason = "content_filter"
  else if (status === "incomplete" || interactionFinishReason === "length" || interactionFinishReason === "max_tokens") {
    finishReason = "length"
  }
  choiceOf(chunk).finish_reason = finishReason
  setOpenAIChatUsageFromInteractions(chunk, interactionsUsage(root))
  st.completed = true
  out.push(chunk)
}

const failedToOpenAIChat = (root: Json): JsonObject[] => {
  let errNode = get(root, "error")
  if (errNode === undefined) errNode = get(root, "interaction.error")
  const msg = getStr(errNode, "message") || "upstream error occurred"
  const code = getStr(errNode, "code")
  const errType = getStr(errNode, "type") || "server_error"
  const error: JsonObject = { message: msg, type: errType }
  if (code !== "") error.code = code
  return [{ error }]
}

const stepStartToOpenAIChat = (modelName: string, root: Json, st: InteractionsToOpenAIChatState): JsonObject[] => {
  const out: JsonObject[] = []
  ensureStarted(out, st)
  const index = asInt(get(root, "index"))
  const step = get(root, "step")
  const stepType = getStr(step, "type")
  st.stepTypes.set(index, stepType)
  if (stepType !== "function_call") return out
  st.sawToolCall = true
  let toolCallIndex = st.nextToolCallIndex
  const existing = st.toolCallIndexByStep.get(index)
  if (existing !== undefined) toolCallIndex = existing
  else {
    st.toolCallIndexByStep.set(index, toolCallIndex)
    st.nextToolCallIndex++
  }
  st.toolIds.set(index, firstNonEmpty(getStr(step, "call_id"), getStr(step, "id"), `call_${toolCallIndex}`))
  let name = getStr(step, "name")
  if (isAntigravityModel(modelName) || isAntigravityModel(st.model)) name = antigravityUpstreamToolNameToClient(name)
  st.toolNames.set(index, name)
  if (!st.toolArguments.has(index)) st.toolArguments.set(index, "")
  const args = get(step, "arguments")
  if (args !== undefined && raw(args).trim() !== "{}") {
    st.toolArguments.set(index, (st.toolArguments.get(index) ?? "") + jsonStringValue(args, "{}"))
  }
  out.push(toolCallStartChunk(st, index))
  return out
}

const stepDeltaToOpenAIChat = (root: Json, st: InteractionsToOpenAIChatState): JsonObject[] => {
  const index = asInt(get(root, "index"))
  const delta = get(root, "delta")
  const out: JsonObject[] = []
  ensureStarted(out, st)
  switch (getStr(delta, "type")) {
    case "thought_summary": {
      const text = firstNonEmpty(getStr(delta, "content.text"), getStr(delta, "text"))
      if (text === "") return out
      out.push(deltaChunk(st, "reasoning_content", text))
      return out
    }
    case "arguments_delta": {
      const args = getStr(delta, "arguments")
      st.toolArguments.set(index, (st.toolArguments.get(index) ?? "") + args)
      out.push(toolCallArgumentsChunk(st, index, args))
      return out
    }
    default: {
      const text = getStr(delta, "text")
      if (text === "") return out
      st.textByStepIndex.set(index, (st.textByStepIndex.get(index) ?? "") + text)
      out.push(deltaChunk(st, "content", text))
      return out
    }
  }
}

const newState = (modelName: string): InteractionsToOpenAIChatState => ({
  id: "",
  model: modelName,
  environmentId: "",
  created: 0,
  started: false,
  completed: false,
  sawToolCall: false,
  stepTypes: new Map(),
  toolIds: new Map(),
  toolNames: new Map(),
  toolArguments: new Map(),
  textByStepIndex: new Map(),
  toolCallIndexByStep: new Map(),
  nextToolCallIndex: 0
})

/** `ConvertInteractionsResponseToOpenAI`: one Interactions SSE line -> Chat Completions chunks. */
export const convertInteractionsResponseToOpenAI = (context: ResponseContext, line: string): ReadonlyArray<string> => {
  const modelName = context.model
  if (context.state.value === undefined) context.state.value = newState(modelName)
  const st = context.state.value as InteractionsToOpenAIChatState
  st.model = firstNonEmpty(st.model, modelName)

  const payload = ssePayloadOf(line)
  if (payload === "" || payload.trim() === "[DONE]") return []
  const root = parseJsonOrUndefined(payload)
  if (root === undefined) return []
  let chunks: JsonObject[] = []
  switch (getStr(root, "event_type")) {
    case "interaction.created": {
      const interaction = get(root, "interaction")
      st.id = firstNonEmpty(getStr(interaction, "id"), st.id)
      st.model = firstNonEmpty(getStr(interaction, "model"), st.model, modelName)
      const envId = envIdOf(interaction, root)
      if (envId !== "") st.environmentId = envId
      ensureStarted(chunks, st)
      break
    }
    case "step.start":
      chunks = stepStartToOpenAIChat(modelName, root, st)
      break
    case "step.delta":
      chunks = stepDeltaToOpenAIChat(root, st)
      break
    case "interaction.completed":
    case "finish": {
      const interaction = get(root, "interaction")
      const envId = envIdOf(interaction, root)
      if (envId !== "") st.environmentId = envId
      appendCompleted(chunks, root, st)
      break
    }
    case "response.failed":
    case "interaction.failed":
      chunks = failedToOpenAIChat(root)
      break
    default:
      break
  }
  return chunks.map((chunk) => JSON.stringify(chunk))
}

/** `ConvertInteractionsResponseToOpenAINonStream`. */
export const convertInteractionsResponseToOpenAINonStream = (context: ResponseContext, body: string): string => {
  const modelName = context.model
  const root: Json = parseJsonOrUndefined(body) ?? {}
  let interaction: Json | undefined = root
  const nested = get(root, "interaction")
  if (nested !== undefined) interaction = nested
  const message: JsonObject = { role: "assistant", content: "" }
  const choice: JsonObject = { index: 0, message, finish_reason: "stop" }
  const out: JsonObject = {
    id: firstNonEmpty(getStr(interaction, "id"), getStr(root, "id"), `chatcmpl_${Date.now()}000000`),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: firstNonEmpty(getStr(interaction, "model"), modelName),
    choices: [choice]
  }
  let steps = get(interaction, "steps")
  if (steps === undefined) steps = get(root, "steps")
  let text = ""
  let reasoning = ""
  let sawToolCall = false
  const toolCalls: Json[] = []
  if (isArr(steps)) {
    for (const step of steps) {
      switch (getStr(step, "type")) {
        case "model_output":
          for (const t of interactionsContentTextsForOpenAIChat(get(step, "content"))) text += t
          break
        case "thought":
          for (const t of interactionsContentTextsForOpenAIChat(get(step, "content"))) reasoning += t
          break
        case "function_call": {
          sawToolCall = true
          const forAntigravity = isAntigravityModel(firstNonEmpty(getStr(interaction, "model"), modelName))
          toolCalls.push(openAIChatToolCallFromInteractions(step, forAntigravity))
          break
        }
      }
    }
  }
  if (text.length > 0) message.content = text
  if (reasoning.length > 0) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  if (sawToolCall) {
    message.content = null
    choice.finish_reason = "tool_calls"
  }
  const status = firstNonEmpty(getStr(interaction, "status"), getStr(root, "status"))
  const interactionFinishReason = firstNonEmpty(getStr(interaction, "finish_reason"), getStr(root, "finish_reason"))
  if (interactionFinishReason === "content_filter") choice.finish_reason = "content_filter"
  else if (status === "incomplete" || interactionFinishReason === "length" || interactionFinishReason === "max_tokens") {
    choice.finish_reason = "length"
  }
  const envId = firstNonEmpty(
    getStr(interaction, "environment_id"),
    getStr(root, "environment_id"),
    getStr(interaction, "environment.id"),
    getStr(root, "environment.id"),
    getStr(root, "interaction.environment_id")
  )
  if (envId !== "") out.environment_id = envId
  setOpenAIChatUsageFromInteractions(out, interactionsUsage(root))
  return JSON.stringify(out)
}

export const interactionsToOpenAIResponse: ResponseTransform = {
  stream: convertInteractionsResponseToOpenAI,
  nonStream: convertInteractionsResponseToOpenAINonStream
}

