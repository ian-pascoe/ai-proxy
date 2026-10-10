/**
 * Kimi (Moonshot): native `thinking` object; `reasoning_effort` is accepted as input only and removed from the
 * final payload.
 *
 * Go source: internal/thinking/provider/kimi/apply.go.
 */
import type { Json } from "../../json/index.ts"
import { convertBudgetToLevel } from "../convert.ts"
import { delPath, ensureBody, setPath } from "../json.ts"
import { isUserDefinedModel, Level } from "../types.ts"
import type { ProviderApplier, ThinkingConfig } from "../types.ts"

const applyEnabledThinking = (body: Json, effort: string): Json | undefined => {
  let result = delPath(body, "reasoning_effort")
  result = setPath(result, "thinking.type", "enabled")

  return setPath(result, "thinking.effort", effort)
}

/** Kimi requires an explicit disabled thinking object. */
const applyDisabledThinking = (body: Json): Json | undefined => {
  let result = delPath(body, "thinking")
  result = delPath(result, "reasoning_effort")

  return setPath(result, "thinking.type", "disabled")
}

export const kimiApplier: ProviderApplier = {
  apply(body: Json | undefined, config: ThinkingConfig, modelInfo): Json | undefined {
    const userDefined = isUserDefinedModel(modelInfo)

    if (!userDefined && modelInfo?.thinking === undefined) return body

    const root = ensureBody(body)
    let effort: string

    switch (config.mode) {
      case "level":
        if (config.level === "") return root
        effort = config.level
        break
      case "none":
        // Respect the clamped fallback level for models that cannot disable thinking.
        if (config.level === "" || config.level === Level.none) return applyDisabledThinking(root)
        effort = config.level
        break
      case "budget": {
        const level = convertBudgetToLevel(config.budget)

        if (level === undefined) return root
        effort = level
        break
      }

      case "auto":
        effort = Level.auto
        break
    }

    if (effort === "") return root

    return applyEnabledThinking(root, effort)
  }
}
