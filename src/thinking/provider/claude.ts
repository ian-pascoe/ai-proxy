/**
 * Claude: manual thinking (`thinking.type="enabled"` + `budget_tokens`) and adaptive thinking
 * (`thinking.type="adaptive"` + `output_config.effort`).
 *
 * Go source: internal/thinking/provider/claude/apply.go.
 */
import { asInt, get, type Json } from "../../json/index.ts";
import { convertLevelToBudget } from "../convert.ts";
import { delIfEmptyObject, delPath, delPaths, ensureBody, setPath } from "../json.ts";
import { isUserDefinedModel } from "../types.ts";
import type { ProviderApplier, ThinkingConfig, ThinkingModelInfo } from "../types.ts";

/** Removes `output_config.effort` and an `output_config` object it leaves empty. */
const clearEffort = (body: Json | undefined): Json | undefined =>
  delIfEmptyObject(delPath(body, "output_config.effort"), "output_config");

const disable = (body: Json | undefined): Json | undefined => {
  let result = setPath(body, "thinking.type", "disabled");
  // Summary display only applies to an active thinking block.
  result = delPaths(result, ["thinking.budget_tokens", "thinking.display"]);

  return clearEffort(result);
};

const enableWithoutBudget = (body: Json | undefined): Json | undefined =>
  clearEffort(delPath(setPath(body, "thinking.type", "enabled"), "thinking.budget_tokens"));

const adaptive = (body: Json | undefined, effort: string | undefined): Json | undefined => {
  const result = delPath(setPath(body, "thinking.type", "adaptive"), "thinking.budget_tokens");

  return effort === undefined
    ? clearEffort(result)
    : setPath(result, "output_config.effort", effort);
};

/** Request max_tokens, else the model default (`fromModel` = it must be written back). */
const effectiveMaxTokens = (
  body: Json | undefined,
  modelInfo: ThinkingModelInfo | undefined,
): { readonly max: number; readonly fromModel: boolean } => {
  const requested = get(body, "max_tokens");

  if (requested !== undefined && asInt(requested) > 0)
    return { max: asInt(requested), fromModel: false };
  const modelMax = modelInfo?.maxCompletionTokens ?? 0;

  if (modelMax > 0) return { max: modelMax, fromModel: true };

  return { max: 0, fromModel: false };
};

/** Anthropic requires max_tokens > budget_tokens: caps the budget at max_tokens-1 unless that goes below the model minimum. */
const normalizeClaudeBudget = (
  body: Json | undefined,
  budgetTokens: number,
  modelInfo: ThinkingModelInfo | undefined,
): Json | undefined => {
  if (budgetTokens <= 0) return body;
  let result = body;
  const { max, fromModel } = effectiveMaxTokens(result, modelInfo);

  if (fromModel && max > 0) result = setPath(result, "max_tokens", max);

  let adjusted = budgetTokens;

  if (max > 0 && adjusted >= max) adjusted = max - 1;

  const minBudget = modelInfo?.thinking?.min ?? 0;

  // Leave the request unchanged when the cap would push the budget below the model minimum.
  if (minBudget > 0 && adjusted > 0 && adjusted < minBudget) return result;

  if (adjusted !== budgetTokens) result = setPath(result, "thinking.budget_tokens", adjusted);

  return result;
};

const applyBudget = (
  body: Json | undefined,
  budget: number,
  modelInfo: ThinkingModelInfo,
): Json | undefined => {
  if (budget === 0) {
    return clearEffort(
      delPath(setPath(body, "thinking.type", "disabled"), "thinking.budget_tokens"),
    );
  }

  let result = setPath(body, "thinking.type", "enabled");
  result = setPath(result, "thinking.budget_tokens", budget);
  result = clearEffort(result);

  return normalizeClaudeBudget(result, budget, modelInfo);
};

/** User-defined models: written without validation; level → adaptive effort, auto → enabled. */
const applyCompatibleClaude = (
  body: Json | undefined,
  config: ThinkingConfig,
): Json | undefined => {
  const root = ensureBody(body);

  switch (config.mode) {
    case "none":
      return disable(root);
    case "auto":
      return enableWithoutBudget(root);
    case "level":
      return config.level === "" ? root : adaptive(root, config.level);
    case "budget":
      return clearEffort(
        setPath(setPath(root, "thinking.type", "enabled"), "thinking.budget_tokens", config.budget),
      );
  }
};

export const claudeApplier: ProviderApplier = {
  apply(body, config, modelInfo) {
    if (isUserDefinedModel(modelInfo) || modelInfo === undefined)
      return applyCompatibleClaude(body, config);

    if (modelInfo.thinking === undefined) return body;

    const root = ensureBody(body);
    // Adaptive thinking (effort) requires the model to advertise discrete levels.
    const supportsAdaptive = (modelInfo.thinking.levels?.length ?? 0) > 0;

    switch (config.mode) {
      case "none":
        return disable(root);
      case "level": {
        if (supportsAdaptive && config.level !== "") return adaptive(root, config.level);
        // Non-adaptive models: convert the level to a budget.
        const budget = convertLevelToBudget(config.level);

        if (budget === undefined) return root;

        return applyBudget(root, budget, modelInfo);
      }

      case "budget":
        return applyBudget(root, config.budget, modelInfo);
      case "auto":
        // Adaptive models use upstream defaults (no explicit effort); others enable thinking without a budget.
        return supportsAdaptive ? adaptive(root, undefined) : enableWithoutBudget(root);
    }
  },
};
