/**
 * Gemini `contents[]` helpers shared by the Gemini translators.
 *
 * Go source: internal/translator/common/gemini.go (MergeAdjacentGeminiContents, ContentHasGeminiFunctionCall/Response,
 * ReorderGeminiUserParts, MergeAdjacentGeminiUserContents, SplitGeminiFunctionResponseTurns, ContainsJSONRef,
 * SetGeminiFunctionResponseResult/Raw, IsGeminiThoughtPart) and internal/translator/common/bytes.go
 * (GeminiTokenCountJSON). Contents are parsed JSON objects; helpers never mutate their inputs except where noted.
 */
import {
  asBool,
  asString,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set
} from "../../../json/index.ts"

const isObject = (value: Json | undefined): value is JsonObject => isJsonObject(value)

/** gjson `Array()` of the `parts` field (empty when absent or not an array). */
export const partsOf = (content: Json | undefined): Json[] => {
  const parts = get(content, "parts")
  return isJsonArray(parts) ? parts : []
}

/** `IsGeminiThoughtPart`. */
export const isGeminiThoughtPart = (part: Json | undefined): boolean => asBool(get(part, "thought"))

const hasFunctionCallPart = (part: Json | undefined): boolean =>
  exists(part, "functionCall") || exists(part, "function_call")
const hasFunctionResponsePart = (part: Json | undefined): boolean =>
  exists(part, "functionResponse") || exists(part, "function_response")

/** `ContentHasGeminiFunctionCall`. */
export const contentHasGeminiFunctionCall = (content: Json | undefined): boolean =>
  partsOf(content).some(hasFunctionCallPart)

/** `ContentHasGeminiFunctionResponse`. */
export const contentHasGeminiFunctionResponse = (content: Json | undefined): boolean =>
  partsOf(content).some(hasFunctionResponsePart)

/** `ReorderGeminiUserParts`: text parts precede functionResponse parts when text trails a response. */
export const reorderGeminiUserParts = (parts: Json[]): Json[] => {
  let hasFR = false
  let hasTrailingText = false
  for (const part of parts) {
    if (hasFunctionResponsePart(part)) hasFR = true
    else if (hasFR && exists(part, "text")) {
      hasTrailingText = true
      break
    }
  }
  if (!hasFR || !hasTrailingText) return parts
  const prompt: Json[] = []
  const tool: Json[] = []
  for (const part of parts) (exists(part, "text") ? prompt : tool).push(part)
  return [...prompt, ...tool]
}

const emptyParts = (content: Json | undefined): boolean => {
  const parts = get(content, "parts")
  return !isJsonArray(parts) || parts.length === 0
}

const withParts = (content: Json, parts: Json[]): Json => {
  const copy: JsonObject = isObject(content) ? { ...content } : {}
  copy["parts"] = parts
  return copy
}

/** `MergeAdjacentGeminiContents`: merges consecutive user turns (model turns are kept apart). */
export const mergeAdjacentGeminiContents = (contents: Json[]): Json[] => {
  if (contents.length <= 1) return contents
  const merged: Json[] = []
  for (const content of contents) {
    if (content === undefined || content === null || (isObject(content) && Object.keys(content).length === 0)) continue
    const role = asString(get(content, "role"))
    if (emptyParts(content)) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && asString(get(last, "role")) === "user" && role === "user") {
      merged[merged.length - 1] = withParts(last, reorderGeminiUserParts([...partsOf(last), ...partsOf(content)]))
      continue
    }
    merged.push(content)
  }
  return merged
}

/** `MergeAdjacentGeminiUserContents`: like the above but turns with functionResponse stay separate. */
export const mergeAdjacentGeminiUserContents = (contents: Json[]): Json[] => {
  if (contents.length <= 1) return contents
  const merged: Json[] = []
  for (const content of contents) {
    if (content === undefined || content === null || (isObject(content) && Object.keys(content).length === 0)) continue
    const role = asString(get(content, "role"))
    if (emptyParts(content)) continue
    const last = merged[merged.length - 1]
    if (
      last !== undefined &&
      asString(get(last, "role")) === "user" &&
      role === "user" &&
      !contentHasGeminiFunctionResponse(last) &&
      !contentHasGeminiFunctionResponse(content)
    ) {
      merged[merged.length - 1] = withParts(last, [...partsOf(last), ...partsOf(content)])
      continue
    }
    merged.push(content)
  }
  return merged
}

/** `SplitGeminiFunctionResponseTurns`: function responses get their own turn directly after the model turn. */
export const splitGeminiFunctionResponseTurns = (contents: Json[]): Json[] => {
  if (contents.length === 0) return contents
  const split: Json[] = []
  for (const content of contents) {
    if (asString(get(content, "role")) !== "user" || !contentHasGeminiFunctionResponse(content)) {
      split.push(content)
      continue
    }
    const responseParts: Json[] = []
    const otherParts: Json[] = []
    for (const part of partsOf(content)) (hasFunctionResponsePart(part) ? responseParts : otherParts).push(part)
    if (responseParts.length > 0) split.push(withParts(content, responseParts))
    if (otherParts.length > 0) split.push(withParts(content, otherParts))
  }

  // Within a run of user turns that follows a model turn with function calls, responses come first.
  const out: Json[] = []
  const n = split.length
  for (let i = 0; i < n;) {
    const current = split[i]
    if (asString(get(current, "role")) !== "user") {
      out.push(current as Json)
      i++
      continue
    }
    const previous = out[out.length - 1]
    const precedingModelHasFC =
      previous !== undefined && asString(get(previous, "role")) === "model" && contentHasGeminiFunctionCall(previous)
    let j = i
    let hasFR = false
    while (j < n && asString(get(split[j], "role")) === "user") {
      if (contentHasGeminiFunctionResponse(split[j])) hasFR = true
      j++
    }
    const run = split.slice(i, j) as Json[]
    if (precedingModelHasFC && hasFR && run.length > 1) {
      const combined: Json[] = []
      const otherTurns: Json[] = []
      for (const turn of run) {
        if (contentHasGeminiFunctionResponse(turn)) combined.push(...partsOf(turn))
        else otherTurns.push(turn)
      }
      if (combined.length > 0) out.push({ role: "user", parts: combined })
      out.push(...otherTurns)
    } else {
      out.push(...run)
    }
    i = j
  }
  return out
}

/** `ContainsJSONRef`: a string-valued `$ref` property anywhere in the value. */
export const containsJsonRef = (value: Json | undefined): boolean => {
  if (isJsonArray(value)) return value.some(containsJsonRef)
  if (!isObject(value)) return false
  return Object.entries(value).some(
    ([key, child]) => (key === "$ref" && typeof child === "string") || containsJsonRef(child)
  )
}

/**
 * `SetGeminiFunctionResponseResult`: sets a functionResponse `result`/`response` field. A result containing a string
 * `$ref` is stored as opaque JSON text (Vertex would read `$ref` as a media part reference). Unlike Go, the text is the
 * compact re-serialisation, because parsed values do not keep their original whitespace.
 */
export const setGeminiFunctionResponseResult = (part: Json, path: string, result: Json | undefined): Json => {
  if (result === undefined) return set(part, path, "")
  if (containsJsonRef(result)) {
    const target = path.endsWith("response") ? `${path}.result` : path
    return set(part, target, JSON.stringify(result))
  }
  return set(part, path, result)
}

/** `SetGeminiFunctionResponseRaw`: raw JSON text; non-JSON text is parsed leniently as a string like gjson.Parse. */
export const setGeminiFunctionResponseRaw = (part: Json, path: string, raw: string): Json => {
  const trimmed = raw.trim()
  if (trimmed === "") return set(part, path, "")
  let parsed: Json | undefined
  try {
    parsed = JSON.parse(trimmed) as Json
  } catch {
    parsed = undefined
  }
  return setGeminiFunctionResponseResult(part, path, parsed === undefined ? trimmed : parsed)
}

/** `GeminiTokenCountJSON`. */
export const geminiTokenCountJson = (count: number): string =>
  `{"totalTokens":${count},"promptTokensDetails":[{"modality":"TEXT","tokenCount":${count}}]}`
