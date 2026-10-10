/**
 * Google Interactions API: native `generation_config.thinking_level` / `thinking_summaries`.
 *
 * Go source: internal/thinking/provider/interactions/apply.go.
 */
import { get, type Json } from "../../json/index.ts"
import { convertBudgetToLevel } from "../convert.ts"
import { delPaths, ensureBody, equalFold, normalize, setPath } from "../json.ts"
import { Level } from "../types.ts"
import type { ProviderApplier, ThinkingConfig, ThinkingModelInfo } from "../types.ts"

const LEGACY_FIELDS = [
  "generation_config.thinking_level",
  "generation_config.thinkingLevel",
  "generation_config.thinking_budget",
  "generation_config.thinkingBudget",
  "generation_config.thinking_summaries",
  "generation_config.thinkingSummaries",
  "generation_config.thinking_config",
  "generation_config.thinkingConfig",
  "generationConfig.thinkingLevel",
  "generationConfig.thinking_level",
  "generationConfig.thinkingBudget",
  "generationConfig.thinking_budget",
  "generationConfig.thinkingSummaries",
  "generationConfig.thinking_summaries",
  "generationConfig.thinkingConfig"
]

/**
 * The summary intent of the original body: an explicit `thinking_summaries` enum (auto/none), else an
 * `include_thoughts` boolean mapped to auto/none. Captured before the legacy fields are stripped.
 */
const originalThinkingSummaries = (body: Json | undefined): string | undefined => {
  for (const path of ["generation_config.thinking_summaries", "generation_config.thinkingSummaries"]) {
    const value = get(body, path)
    if (typeof value !== "string") continue
    const normalized = normalize(value)
    if (normalized === "auto" || normalized === "none") return normalized
  }
  for (const path of [
    "generation_config.thinking_config.include_thoughts",
    "generation_config.thinking_config.includeThoughts",
    "generation_config.thinkingConfig.include_thoughts",
    "generation_config.thinkingConfig.includeThoughts"
  ]) {
    const value = get(body, path)
    if (value === true) return "auto"
    if (value === false) return "none"
  }
  return undefined
}

/** Level normalised to the model's advertised set (`""` for none/auto, which have no wire level). */
const normalizeInteractionsLevel = (levelRaw: string, modelInfo: ThinkingModelInfo | undefined): string => {
  const level = normalize(levelRaw)
  if (level === "" || level === Level.none || level === Level.auto) return ""
  const levels = modelInfo?.thinking?.levels ?? []
  if (levels.length > 0) {
    const match = levels.find((candidate) => equalFold(candidate, level))
    return (match ?? (levels[levels.length - 1] as string)).toLowerCase()
  }
  return level === Level.max || level === Level.xhigh ? Level.high : level
}

const setSummaries = (body: Json | undefined, summaries: string | undefined): Json | undefined =>
  summaries === undefined ? body : setPath(body, "generation_config.thinking_summaries", summaries)

const applyLevel = (
  body: Json | undefined,
  summaries: string | undefined,
  level: string,
  modelInfo: ThinkingModelInfo | undefined
): Json | undefined => {
  const normalized = normalizeInteractionsLevel(level, modelInfo)
  const result = normalized === "" ? body : setPath(body, "generation_config.thinking_level", normalized)
  return setSummaries(result, summaries)
}

const applyBudget = (
  body: Json | undefined,
  summaries: string | undefined,
  budget: number,
  modelInfo: ThinkingModelInfo | undefined
): Json | undefined => {
  const level = convertBudgetToLevel(budget)
  // Interactions has no wire-level "none": preserve only explicit summary intent.
  if (level === undefined || level === Level.none || level === Level.auto) return setSummaries(body, summaries)
  return applyLevel(body, summaries, level, modelInfo)
}

const applyNone = (
  body: Json | undefined,
  summaries: string | undefined,
  config: ThinkingConfig,
  modelInfo: ThinkingModelInfo | undefined
): Json | undefined => {
  if (config.level !== "") return applyLevel(body, summaries, config.level, modelInfo)
  if (config.budget > 0) return applyBudget(body, summaries, config.budget, modelInfo)
  // Fully disabled: restoring thinking_summaries alone could make a default-on model reason again.
  return body
}

export const interactionsApplier: ProviderApplier = {
  apply(body, config, modelInfo) {
    const root = ensureBody(body)
    const summaries = originalThinkingSummaries(root)
    const stripped = delPaths(root, LEGACY_FIELDS)
    switch (config.mode) {
      case "level":
        return applyLevel(stripped, summaries, config.level, modelInfo)
      case "budget":
        return applyBudget(stripped, summaries, config.budget, modelInfo)
      case "auto":
        return setSummaries(stripped, summaries)
      case "none":
        return applyNone(stripped, summaries, config, modelInfo)
    }
  }
}
