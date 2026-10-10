/**
 * Gemini: `generationConfig.thinkingConfig.thinkingLevel` (Gemini 3.x levels) or `thinkingBudget` (2.5 budgets,
 * `-1` for auto). Preserves an explicit `includeThoughts`.
 *
 * Go source: internal/thinking/provider/gemini/apply.go.
 */
import { ensureBody } from "../json.ts";
import { isUserDefinedModel } from "../types.ts";
import type { ProviderApplier } from "../types.ts";
import { applyBudgetFormat, applyLevelFormat } from "./google.ts";

const PREFIX = "generationConfig.thinkingConfig";

export const geminiApplier: ProviderApplier = {
  apply(body, config, modelInfo) {
    if (isUserDefinedModel(modelInfo) || modelInfo === undefined) {
      const root = ensureBody(body);

      if (config.mode === "auto") return applyBudgetFormat(root, config, PREFIX);

      if (config.mode === "level" || (config.mode === "none" && config.level !== "")) {
        return applyLevelFormat(root, config, PREFIX);
      }

      return applyBudgetFormat(root, config, PREFIX);
    }

    if (modelInfo.thinking === undefined) return body;

    const root = ensureBody(body);

    switch (config.mode) {
      case "level":
        return applyLevelFormat(root, config, PREFIX);
      case "none":
        // Route on model capability: level format when the model has levels, else budget format.
        return (modelInfo.thinking.levels?.length ?? 0) > 0
          ? applyLevelFormat(root, config, PREFIX)
          : applyBudgetFormat(root, config, PREFIX);
      default:
        return applyBudgetFormat(root, config, PREFIX);
    }
  },
};
