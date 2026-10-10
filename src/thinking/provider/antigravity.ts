/**
 * Antigravity: Gemini's thinkingConfig under `request.generationConfig`, with extra normalisation for Claude
 * model ids (budget < max output, dropped when below the model minimum).
 *
 * Go source: internal/thinking/provider/antigravity/apply.go.
 */
import { asInt, get, type Json } from "../../json/index.ts";
import { delPath, ensureBody, setPath } from "../json.ts";
import { isUserDefinedModel } from "../types.ts";
import type { ProviderApplier, ThinkingModelInfo } from "../types.ts";
import { applyBudgetFormat, applyLevelFormat } from "./google.ts";

const PREFIX = "request.generationConfig.thinkingConfig";

const MAX_OUTPUT_PATH = "request.generationConfig.maxOutputTokens";

const isClaudeModel = (modelInfo: ThinkingModelInfo | undefined): boolean =>
  modelInfo !== undefined && modelInfo.id.toLowerCase().includes("claude");

/** Request maxOutputTokens, else the model default (`fromModel` = it must be written back). */
const effectiveMaxTokens = (
  payload: Json | undefined,
  modelInfo: ThinkingModelInfo,
): { readonly max: number; readonly fromModel: boolean } => {
  const requested = get(payload, MAX_OUTPUT_PATH);

  if (requested !== undefined && asInt(requested) > 0)
    return { max: asInt(requested), fromModel: false };
  const modelMax = modelInfo.maxCompletionTokens ?? 0;

  return modelMax > 0 ? { max: modelMax, fromModel: true } : { max: 0, fromModel: false };
};

/** Ensures budget < max output; removes thinkingConfig (`"removed"`) when the budget is below the model minimum. */
const normalizeClaudeBudget = (
  budgetIn: number,
  payloadIn: Json | undefined,
  modelInfo: ThinkingModelInfo,
): { readonly budget: number | "removed"; readonly body: Json | undefined } => {
  let budget = budgetIn;
  let payload = payloadIn;
  const { max, fromModel } = effectiveMaxTokens(payload, modelInfo);

  if (max > 0 && budget >= max) budget = max - 1;

  const minBudget = modelInfo.thinking?.min ?? 0;

  if (minBudget > 0 && budget >= 0 && budget < minBudget) {
    return { budget: "removed", body: delPath(payload, PREFIX) };
  }

  if (fromModel && max > 0) payload = setPath(payload, MAX_OUTPUT_PATH, max);

  return { budget, body: payload };
};

const budgetFormat = (
  body: Json | undefined,
  modelInfo: ThinkingModelInfo | undefined,
  config: Parameters<typeof applyBudgetFormat>[1],
) =>
  applyBudgetFormat(
    body,
    config,
    PREFIX,
    isClaudeModel(modelInfo) && modelInfo !== undefined
      ? (budget, payload) => normalizeClaudeBudget(budget, payload, modelInfo)
      : undefined,
  );

export const antigravityApplier: ProviderApplier = {
  apply(body, config, modelInfo) {
    const userDefined = isUserDefinedModel(modelInfo);

    if (!userDefined && modelInfo?.thinking === undefined) return body;

    const root = ensureBody(body);

    if (config.mode === "auto" || config.mode === "budget")
      return budgetFormat(root, modelInfo, config);

    if (userDefined) {
      if (config.mode === "level" || (config.mode === "none" && config.level !== "")) {
        return applyLevelFormat(root, config, PREFIX);
      }

      return budgetFormat(root, modelInfo, config);
    }

    // Known models choose the format from their capabilities.
    if ((modelInfo?.thinking?.levels?.length ?? 0) > 0)
      return applyLevelFormat(root, config, PREFIX);

    return budgetFormat(root, modelInfo, config);
  },
};
