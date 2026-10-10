/**
 * Responses `configuration_update` input items.
 *
 * Go source: internal/thinking/configuration_update.go.
 */
import { get, isJsonArray, isJsonObject, type Json } from "../json/index.ts"
import { delPath, getString, isEmptyObject, normalize } from "./json.ts"
import { autoConfig, EMPTY_CONFIG, levelConfig, noneConfig } from "./types.ts"
import type { ThinkingConfig } from "./types.ts"

export const isResponsesFormat = (format: string): boolean => format === "codex" || format === "openai-response"

/** The last nonempty `reasoning.effort` among `configuration_update` items of `input`. */
export const extractConfigurationUpdateConfig = (body: Json | undefined): ThinkingConfig => {
  const input = get(body, "input")

  if (!isJsonArray(input)) return EMPTY_CONFIG

  let effort = ""

  for (const item of input) {
    if (getString(item, "type") !== "configuration_update") continue
    const value = get(item, "reasoning.effort")

    if (typeof value === "string") {
      const normalized = normalize(value)

      if (normalized !== "") effort = normalized
    }
  }

  switch (effort) {
    case "":
      return EMPTY_CONFIG
    case "none":
      return noneConfig()
    case "auto":
      return autoConfig()
    default:
      return levelConfig(effort)
  }
}

/** Removes unsupported `configuration_update` input items without touching other items. */
export const stripConfigurationUpdates = (body: Json | undefined): Json | undefined => {
  if (!isJsonObject(body)) return body
  const input = body["input"]

  if (!isJsonArray(input)) return body
  const kept = input.filter((item) => getString(item, "type") !== "configuration_update")

  if (kept.length !== input.length) body["input"] = kept

  return body
}

/** Removes `reasoning.effort` (and an emptied `reasoning`), leaving summary and unrelated fields intact. */
export const stripResponsesEffort = (body: Json | undefined): Json | undefined => {
  if (body === undefined || get(body, "reasoning.effort") === undefined) return body
  const result = delPath(body, "reasoning.effort")

  return isEmptyObject(get(result, "reasoning")) ? delPath(result, "reasoning") : result
}
