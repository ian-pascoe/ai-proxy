/**
 * Legacy `/v1/completions` <-> Chat Completions conversion.
 *
 * Go source: sdk/api/handlers/openai/openai_handlers.go (convertCompletionsRequestToChatCompletions,
 * convertChatCompletionsResponseToCompletions, convertChatCompletionsStreamChunkToCompletions). Go marshals the
 * per-choice maps with sorted keys; that order is kept.
 */
import { goMarshalSorted } from "../../http/json-text.ts"
import {
  asBool,
  asFloat,
  asInt,
  asString,
  cloneJson,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  tryParseJson
} from "../../json/index.ts"

/** `convertCompletionsRequestToChatCompletions`: the prompt (string, or raw JSON text otherwise) becomes one user message. */
export const completionsRequestToChat = (body: Json): JsonObject => {
  const prompt = asString(get(body, "prompt"))

  const out: JsonObject = {
    model: "",
    messages: [{ role: "user", content: prompt === "" ? "Complete this:" : prompt }]
  }

  const field = (path: string) => get(body, path)

  if (field("model") !== undefined) out["model"] = asString(field("model"))

  if (field("max_tokens") !== undefined) out["max_tokens"] = asInt(field("max_tokens"))

  if (field("temperature") !== undefined) out["temperature"] = asFloat(field("temperature"))

  if (field("top_p") !== undefined) out["top_p"] = asFloat(field("top_p"))

  if (field("frequency_penalty") !== undefined) out["frequency_penalty"] = asFloat(field("frequency_penalty"))

  if (field("presence_penalty") !== undefined) out["presence_penalty"] = asFloat(field("presence_penalty"))
  const stop = field("stop")

  if (stop !== undefined) out["stop"] = cloneJson(stop)

  if (field("stream") !== undefined) out["stream"] = asBool(field("stream"))

  if (field("logprobs") !== undefined) out["logprobs"] = asBool(field("logprobs"))

  if (field("top_logprobs") !== undefined) out["top_logprobs"] = asInt(field("top_logprobs"))

  if (field("echo") !== undefined) out["echo"] = asBool(field("echo"))

  return out
}

const header = (root: Json | undefined) => {
  const id = get(root, "id")
  const created = get(root, "created")
  const model = get(root, "model")

  return `{"id":${JSON.stringify(id !== undefined ? asString(id) : "")},"object":"text_completion","created":${
    created !== undefined ? asInt(created) : 0
  },"model":${JSON.stringify(model !== undefined ? asString(model) : "")}`
}

/** `convertChatCompletionsResponseToCompletions`. */
export const chatResponseToCompletions = (payload: string): string => {
  const root = tryParseJson(payload)
  const usage = get(root, "usage")
  const choices: JsonObject[] = []
  const chatChoices = get(root, "choices")

  if (isJsonArray(chatChoices)) {
    for (const choice of chatChoices) {
      const out: JsonObject = { index: asInt(get(choice, "index")) }
      const message = get(choice, "message")
      const delta = get(choice, "delta")

      if (message !== undefined) {
        const content = get(message, "content")

        if (content !== undefined) out["text"] = asString(content)
      } else if (delta !== undefined) {
        const content = get(delta, "content")

        if (content !== undefined) out["text"] = asString(content)
      }

      const finishReason = get(choice, "finish_reason")

      if (finishReason !== undefined) out["finish_reason"] = asString(finishReason)
      const logprobs = get(choice, "logprobs")

      if (logprobs !== undefined) out["logprobs"] = logprobs
      choices.push(out)
    }
  }

  const choicesJson = choices.length > 0 ? goMarshalSorted(choices) : "[]"

  return `${header(root)},"choices":${choicesJson}${usage !== undefined ? `,"usage":${JSON.stringify(usage)}` : ""}}`
}

/**
 * `convertChatCompletionsStreamChunkToCompletions`: `undefined` for chunks without text, finish reason or usage
 * (they are dropped).
 */
export const chatStreamChunkToCompletions = (chunk: string): string | undefined => {
  const root = tryParseJson(chunk)
  const usage = get(root, "usage")
  const chatChoices = get(root, "choices")
  const list = isJsonArray(chatChoices) ? chatChoices : []

  const hasContent = list.some((choice) => {
    const content = get(choice, "delta.content")

    if (get(choice, "delta") !== undefined && content !== undefined && asString(content) !== "") return true
    const reason = get(choice, "finish_reason")

    return reason !== undefined && asString(reason) !== "" && asString(reason) !== "null"
  })

  if (!hasContent && usage === undefined) return undefined

  const choices: JsonObject[] = list.map((choice) => {
    const out: JsonObject = { index: asInt(get(choice, "index")) }
    const content = get(choice, "delta.content")
    out["text"] =
      get(choice, "delta") !== undefined && content !== undefined && asString(content) !== "" ? asString(content) : ""
    const reason = get(choice, "finish_reason")

    if (reason !== undefined && asString(reason) !== "null") out["finish_reason"] = asString(reason)
    const logprobs = get(choice, "logprobs")

    if (logprobs !== undefined) out["logprobs"] = logprobs

    return out
  })

  const choicesJson = choices.length > 0 ? goMarshalSorted(choices) : "[]"

  return `${header(root)},"choices":${choicesJson}${usage !== undefined ? `,"usage":${JSON.stringify(usage)}` : ""}}`
}
