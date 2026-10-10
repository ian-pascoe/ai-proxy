/**
 * Text-only tool-result normalisation for OpenAI-compatible models whose `input-modalities` exclude images.
 *
 * Go source: internal/runtime/executor/helps/openai_compat_tool_results.go (ShouldNormalizeOpenAIToolResultsForModel,
 * NormalizeOpenAIToolResultsTextOnly and helpers). Tool message content becomes a string; relayed tool-result images
 * (the Claude relay notice + image parts of the following user message) are replaced by a short marker.
 */
import type { ModelEntry, OpenAICompatGroup } from "../../config/schema.ts"
import { asString, isJsonArray, isJsonObject, type Json, type JsonObject, set } from "../../json/index.ts"
import { parseSuffix } from "../suffix.ts"

const IMAGE_OMITTED_TEXT = "[image omitted: unsupported by upstream]"

const RELAY_NOTICE = "Images returned by the preceding tool call(s):"

const IMAGE_PLACEHOLDER = "[Tool returned image content; the images follow in the next user message.]"

const normalizeModelName = (model: string): string => {
  const trimmed = model.trim()

  return trimmed === "" ? "" : parseSuffix(trimmed).modelName.trim()
}

/** `inputModalitiesExcludeImages`: an explicit list with text and without image. */
const modalitiesExcludeImages = (modalities: ReadonlyArray<string> | undefined): boolean => {
  if (modalities === undefined || modalities.length === 0) return false
  let hasText = false

  for (const raw of modalities) {
    const modality = raw.trim().toLowerCase()

    if (modality === "image") return false

    if (modality === "text") hasText = true
  }

  return hasText
}

/** `openAICompatibilityModelExcludesImages`: `[excludes, matched]`; a name match wins over alias matches. */
const modelExcludesImages = (models: ReadonlyArray<ModelEntry>, model: string): readonly [boolean, boolean] => {
  const wanted = normalizeModelName(model).toLowerCase()

  if (wanted === "") return [false, false]

  for (const entry of models) {
    if (normalizeModelName(entry.name).toLowerCase() === wanted)
      return [modalitiesExcludeImages(entry["input-modalities"]), true]
  }

  let matched = false
  let excludes = true

  for (const entry of models) {
    if (normalizeModelName(entry.alias ?? "").toLowerCase() !== wanted) continue
    matched = true

    if (!modalitiesExcludeImages(entry["input-modalities"])) excludes = false
  }

  return [excludes && matched, matched]
}

/** `ShouldNormalizeOpenAIToolResultsForModel`: the selected model explicitly excludes image input. */
export const shouldNormalizeToolResults = (
  group: OpenAICompatGroup | undefined,
  upstreamModel: string,
  requestedModel: string
): boolean => {
  if (group === undefined) return false
  const models = group.models ?? []
  const [normalize, matched] = modelExcludesImages(models, upstreamModel)

  if (matched) return normalize

  return modelExcludesImages(models, requestedModel)[0]
}

const isImagePart = (item: Json | undefined): boolean => {
  if (!isJsonObject(item)) return false
  const type = asString(item["type"]).trim().toLowerCase()

  if (type === "image" || type === "image_url" || type === "input_image") return true

  return item["image_url"] !== undefined || item["input_image"] !== undefined
}

const partText = (item: Json): string => {
  if (typeof item === "string") return item

  if (isJsonObject(item)) {
    if (isImagePart(item)) return IMAGE_OMITTED_TEXT

    if (typeof item["text"] === "string") return item["text"]
  }

  return JSON.stringify(item)
}

/** `flattenOpenAIToolResultContent`. */
const flattenContent = (content: Json): string => {
  if (typeof content === "string") return content

  if (isJsonArray(content)) return content.map(partText).join("\n\n")

  if (isJsonObject(content)) {
    if (isImagePart(content)) return IMAGE_OMITTED_TEXT

    if (typeof content["text"] === "string") return content["text"]
  }

  return JSON.stringify(content)
}

/** gjson `.String()` of a value: strings unwrapped, others as raw JSON, missing as empty. */
const gjsonString = (value: Json | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)

/** `NormalizeOpenAIToolResultsTextOnly`. */
export const normalizeToolResultsTextOnly = (payload: Json): Json => {
  const messages = isJsonObject(payload) ? payload["messages"] : undefined

  if (!isJsonArray(messages) || messages.length === 0) return payload

  const out: Json[] = []
  let replacedPlaceholder = false

  for (const original of messages) {
    let message: Json = original
    const role = isJsonObject(message) ? asString(message["role"]) : ""

    if (role === "tool" && isJsonObject(message)) {
      const content = message["content"]

      if (content !== undefined && typeof content !== "string") {
        message = { ...message, content: flattenContent(content) }
      } else if (content === IMAGE_PLACEHOLDER) {
        message = { ...message, content: IMAGE_OMITTED_TEXT }
        replacedPlaceholder = true
      }

      out.push(message)
    } else if (role === "user" && isJsonObject(message)) {
      const content = message["content"]

      if (isJsonArray(content)) {
        const remaining: Json[] = []
        let hasRelayNotice = false
        let hasImages = false

        for (const part of content) {
          if (isJsonObject(part)) {
            if (part["type"] === "text" && part["text"] === RELAY_NOTICE) {
              hasRelayNotice = true
              continue
            }

            if (isImagePart(part)) {
              hasImages = true
              continue
            }
          }

          remaining.push(part)
        }

        if (hasRelayNotice && hasImages) {
          if (!replacedPlaceholder) {
            for (let j = out.length - 1; j >= 0; j--) {
              const previous = out[j]

              if (!isJsonObject(previous) || asString(previous["role"]) !== "tool") break
              const previousContent = gjsonString(previous["content"])

              if (!previousContent.includes(IMAGE_OMITTED_TEXT)) {
                out[j] = {
                  ...previous,
                  content: previousContent === "" ? IMAGE_OMITTED_TEXT : `${previousContent}\n\n${IMAGE_OMITTED_TEXT}`
                }
              }

              break
            }
          }

          replacedPlaceholder = false

          // The synthetic relay message contained only relayed images: omit it entirely.
          if (remaining.length === 0) continue
          message = { ...message, content: remaining } as JsonObject
        }
      }

      out.push(message)
    } else {
      replacedPlaceholder = false
      out.push(message)
    }
  }

  return set(payload, "messages", out)
}
