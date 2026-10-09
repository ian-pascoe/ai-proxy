/**
 * Shared implementation of the effort-string appliers (OpenAI Chat `reasoning_effort`, Codex/xAI
 * `reasoning.effort`).
 *
 * Go source: internal/thinking/provider/openai/apply.go and internal/thinking/provider/codex/apply.go (the two are
 * identical except for the target path).
 */
import type { Json } from "../../json/index.ts"
import { convertBudgetToLevel, hasLevel } from "../convert.ts"
import { ensureBody, setPath } from "../json.ts"
import { isUserDefinedModel, Level } from "../types.ts"
import type { ProviderApplier, ThinkingConfig, ThinkingModelInfo } from "../types.ts"

/** User-defined models: every mode is written without validation (budget → level, auto → "auto"). */
const applyCompatible = (body: Json | undefined, config: ThinkingConfig, path: string): Json | undefined => {
  const root = ensureBody(body)
  let effort: string
  switch (config.mode) {
    case "level":
      if (config.level === "") return root
      effort = config.level
      break
    case "none":
      effort = config.level !== "" ? config.level : Level.none
      break
    case "auto":
      effort = Level.auto
      break
    case "budget": {
      const level = convertBudgetToLevel(config.budget)
      if (level === undefined) return root
      effort = level
      break
    }
  }
  return setPath(root, path, effort)
}

const applyKnown = (
  body: Json | undefined,
  config: ThinkingConfig,
  modelInfo: ThinkingModelInfo,
  path: string
): Json | undefined => {
  const support = modelInfo.thinking
  if (support === undefined) return body
  // Only level and none are expressible; other modes pass through unchanged.
  if (config.mode !== "level" && config.mode !== "none") return body

  const root = ensureBody(body)
  if (config.mode === "level") return setPath(root, path, config.level)

  let effort = ""
  if (config.budget === 0 && (support.zeroAllowed === true || hasLevel(support.levels, Level.none))) effort = Level.none
  if (effort === "" && config.level !== "") effort = config.level
  if (effort === "" && (support.levels?.length ?? 0) > 0) effort = support.levels?.[0] ?? ""
  if (effort === "") return root
  return setPath(root, path, effort)
}

export const effortApplier = (path: string): ProviderApplier => ({
  apply: (body, config, modelInfo) =>
    isUserDefinedModel(modelInfo) || modelInfo === undefined
      ? applyCompatible(body, config, path)
      : applyKnown(body, config, modelInfo, path)
})
