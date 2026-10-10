/**
 * Usage parsers for the Claude, Gemini, Interactions and Antigravity protocols (OpenAI-style and Codex parsers live
 * in `record.ts` / `executor/codex/output.ts`) plus the stream merge rule.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (parseClaudeUsageNode, parseGeminiFamilyUsageDetail,
 * parseInteractionsUsageDetail, Parse{Claude,Gemini,Interactions,Antigravity}[Stream]Usage),
 * helps/plugin_executor_usage.go (MergeStreamUsageDetail, ObserveMergedStreamUsage).
 */
import { get, isJsonObject, type Json, tryParseJson } from "../json/index.ts";
import {
  independentTokenBreakdown,
  inconsistentTokenBreakdown,
  separateReasoningTokenBreakdown,
} from "./accounting.ts";
import {
  emptyUsageDetail,
  firstExisting,
  hasNonZeroTokenUsage,
  responseServiceTier,
  ssePayloadObject,
  tokenInt,
  type UsageDetail,
} from "./record.ts";

/** `safeUsageTokenSum`. */
const safeSum = (...values: ReadonlyArray<number>): number | undefined => {
  let total = 0;

  for (const value of values) {
    if (value < 0 || total > Number.MAX_SAFE_INTEGER - value) return undefined;
    total += value;
  }

  return total;
};

const invalidDetail = (detail: UsageDetail, total: number): UsageDetail => ({
  ...detail,
  tokenBreakdown: inconsistentTokenBreakdown(Math.max(total, 0), 0),
});

// ---------------------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------------------

/** `parseClaudeUsageNode`: cache fields are independent of `input_tokens`, thinking is a subset of `output_tokens`. */
export const parseClaudeUsageNode = (node: Json): UsageDetail => {
  const cacheRead = tokenInt(get(node, "cache_read_input_tokens"));
  const cacheCreation = tokenInt(get(node, "cache_creation_input_tokens"));
  const rawOutput = tokenInt(get(node, "output_tokens"));

  const reasoning = Math.max(
    0,
    tokenInt(
      firstExisting(
        node,
        "output_tokens_details.thinking_tokens",
        "output_tokens_details.reasoning_tokens",
        "thinking_tokens",
      ),
    ),
  );

  // An inconsistent upstream (thinking > output) never invents extra non-reasoning output.
  const nonReasoningOutput = reasoning > rawOutput ? 0 : rawOutput - reasoning;
  const input = tokenInt(get(node, "input_tokens"));
  const total = input + rawOutput + cacheRead + cacheCreation;

  return {
    inputTokens: input,
    outputTokens: rawOutput,
    reasoningTokens: reasoning,
    cachedTokens: cacheRead === 0 ? cacheCreation : cacheRead,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens: total,
    tokenBreakdown: independentTokenBreakdown(
      input,
      cacheRead,
      cacheCreation,
      nonReasoningOutput,
      reasoning,
      total,
    ),
  };
};

/** `ParseClaudeUsage` over a non-stream response body. */
export const parseClaudeUsage = (body: string): UsageDetail => {
  const node = get(tryParseJson(body), "usage");

  return node === undefined ? emptyUsageDetail : parseClaudeUsageNode(node);
};

/** `parseClaudePayloadUsage` for an already parsed event/message (`usage` or `message.usage`). */
export const parseClaudePayloadUsage = (payload: Json | undefined): UsageDetail | undefined => {
  const node = get(payload, "usage") ?? get(payload, "message.usage");

  return node === undefined ? undefined : parseClaudeUsageNode(node);
};

/** `ParseClaudeStreamUsage`: usage of one SSE line (`message_start` carries `message.usage`, `message_delta` `usage`). */
export const parseClaudeStreamUsage = (line: string): UsageDetail | undefined =>
  parseClaudePayloadUsage(ssePayloadObject(line));

// ---------------------------------------------------------------------------------------------------------------
// Gemini family
// ---------------------------------------------------------------------------------------------------------------

/** `parseGeminiFamilyUsageDetail`: `candidatesTokenCount` excludes `thoughtsTokenCount`. */
export const parseGeminiFamilyNode = (node: Json): UsageDetail => {
  const cached = tokenInt(get(node, "cachedContentTokenCount"));

  const toolUse = tokenInt(
    firstExisting(node, "toolUsePromptTokenCount", "tool_use_prompt_token_count"),
  );

  const input = safeSum(tokenInt(get(node, "promptTokenCount")), toolUse);

  const base: UsageDetail = {
    ...emptyUsageDetail,
    inputTokens: input ?? 0,
    outputTokens: tokenInt(get(node, "candidatesTokenCount")),
    reasoningTokens: tokenInt(get(node, "thoughtsTokenCount")),
    totalTokens: tokenInt(get(node, "totalTokenCount")),
    cachedTokens: cached,
    cacheReadTokens: cached,
  };

  return finishSeparateReasoning(base, input !== undefined);
};

const finishSeparateReasoning = (detail: UsageDetail, inputValid: boolean): UsageDetail => {
  if (!inputValid) return invalidDetail(detail, detail.totalTokens);
  let total = detail.totalTokens;

  if (total === 0) {
    const sum = safeSum(detail.inputTokens, detail.outputTokens, detail.reasoningTokens);

    if (sum === undefined) return invalidDetail({ ...detail, totalTokens: 0 }, 0);
    total = sum;
  }

  return {
    ...detail,
    totalTokens: total,
    tokenBreakdown: separateReasoningTokenBreakdown(
      detail.inputTokens,
      detail.cacheReadTokens,
      detail.cacheCreationTokens,
      detail.outputTokens,
      detail.reasoningTokens,
      total,
    ),
  };
};

const geminiNode = (root: Json | undefined): Json | undefined =>
  firstExisting(root, "usageMetadata", "usage_metadata");

/** `ParseGeminiUsage` over a parsed non-stream response body. */
export const parseGeminiUsageBody = (root: Json | undefined): UsageDetail => {
  const node = geminiNode(root);

  return node === undefined ? emptyUsageDetail : parseGeminiFamilyNode(node);
};

/** `ParseGeminiUsage` over a non-stream response body. */
export const parseGeminiUsage = (body: string): UsageDetail =>
  parseGeminiUsageBody(tryParseJson(body));

/** `ParseGeminiStreamUsage`: zero placeholders (`usageMetadata` without counts) are skipped. */
export const parseGeminiStreamUsage = (line: string): UsageDetail | undefined => {
  const node = geminiNode(ssePayloadObject(line));

  if (node === undefined) return undefined;
  const detail = parseGeminiFamilyNode(node);

  return hasNonZeroTokenUsage(detail) ? detail : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Antigravity (Gemini envelope: `response.usageMetadata`)
// ---------------------------------------------------------------------------------------------------------------

const antigravityNode = (root: Json | undefined): Json | undefined =>
  firstExisting(root, "response.usageMetadata", "usageMetadata", "usage_metadata");

/** `ParseAntigravityUsage`. */
export const parseAntigravityUsage = (body: string): UsageDetail => {
  const node = antigravityNode(tryParseJson(body));

  return node === undefined ? emptyUsageDetail : parseGeminiFamilyNode(node);
};

/** `ParseAntigravityStreamUsage` (unlike Gemini, zero placeholders are kept). */
export const parseAntigravityStreamUsage = (line: string): UsageDetail | undefined => {
  const node = antigravityNode(ssePayloadObject(line));

  return node === undefined ? undefined : parseGeminiFamilyNode(node);
};

// ---------------------------------------------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------------------------------------------

const exists = (value: Json | undefined): boolean => value !== undefined;

/** `parseInteractionsUsageDetail`. */
export const parseInteractionsNode = (node: Json): UsageDetail => {
  const cacheRead = firstExisting(node, "cache_read_tokens", "cacheReadTokens");

  const toolUse = tokenInt(
    firstExisting(
      node,
      "tool_use_tokens",
      "total_tool_use_tokens",
      "toolUseTokens",
      "totalToolUseTokens",
    ),
  );

  const input = safeSum(
    tokenInt(firstExisting(node, "input_tokens", "prompt_tokens", "total_input_tokens")),
    toolUse,
  );

  const cached = tokenInt(
    firstExisting(node, "cached_tokens", "cachedContentTokenCount", "total_cached_tokens"),
  );

  const base: UsageDetail = {
    ...emptyUsageDetail,
    inputTokens: input ?? 0,
    outputTokens: tokenInt(
      firstExisting(node, "output_tokens", "completion_tokens", "total_output_tokens"),
    ),
    reasoningTokens: tokenInt(
      firstExisting(node, "reasoning_tokens", "thoughtsTokenCount", "total_thought_tokens"),
    ),
    totalTokens: tokenInt(firstExisting(node, "total_tokens", "totalTokenCount")),
    cachedTokens: cached,
    cacheReadTokens: tokenInt(cacheRead),
    cacheCreationTokens: tokenInt(
      firstExisting(
        node,
        "cache_creation_tokens",
        "cacheCreationTokens",
        "cache_write_tokens",
        "cacheWriteTokens",
      ),
    ),
  };

  if (input === undefined) return invalidDetail(base, base.totalTokens);
  const withCache = !exists(cacheRead) && cached > 0 ? { ...base, cacheReadTokens: cached } : base;

  return finishSeparateReasoning(withCache, true);
};

const INTERACTIONS_USAGE_PATHS = [
  "usage",
  "total_usage",
  "metadata.total_usage",
  "metadata.usage",
  "usageMetadata",
  "usage_metadata",
  "interaction.usage",
  "interaction.total_usage",
  "interaction.metadata.total_usage",
] as const;

const withTier = (detail: UsageDetail, root: Json | undefined): UsageDetail => {
  const tier = responseServiceTier(root);

  return tier === undefined ? detail : { ...detail, responseServiceTier: tier };
};

const parseInteractionsRoot = (root: Json | undefined): UsageDetail => {
  const node = firstExisting(root, ...INTERACTIONS_USAGE_PATHS);

  if (node === undefined) return emptyUsageDetail;

  const usesGeminiFields =
    exists(get(node, "promptTokenCount")) || exists(get(node, "candidatesTokenCount"));

  return withTier(
    usesGeminiFields ? parseGeminiFamilyNode(node) : parseInteractionsNode(node),
    root,
  );
};

/** `ParseInteractionsUsage` over a parsed non-stream response body. */
export const parseInteractionsUsageBody = (root: Json | undefined): UsageDetail =>
  parseInteractionsRoot(root);

/** `ParseInteractionsUsage` over a non-stream response body. */
export const parseInteractionsUsage = (body: string): UsageDetail =>
  parseInteractionsRoot(tryParseJson(body));

/** `ParseInteractionsStreamUsage`: the payload is the line's JSON (or the line itself). */
export const parseInteractionsStreamUsage = (line: string): UsageDetail | undefined => {
  const payload = ssePayloadObject(line) ?? tryParseJson(line.trim());

  if (!isJsonObject(payload)) return undefined;
  const detail = parseInteractionsRoot(payload);

  return hasNonZeroTokenUsage(detail) ? detail : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Stream merging
// ---------------------------------------------------------------------------------------------------------------

const pick = (next: number, previous: number): number =>
  next === 0 && previous > 0 ? previous : next;

/**
 * `MergeStreamUsageDetail`: protocols that report usage in several events (Claude `message_start` + `message_delta`,
 * Interactions) keep the earlier non-zero buckets that the update leaves at zero.
 */
export const mergeStreamUsageDetail = (existing: UsageDetail, update: UsageDetail): UsageDetail => {
  const inputTokens = pick(update.inputTokens, existing.inputTokens);
  const cachedTokens = pick(update.cachedTokens, existing.cachedTokens);
  const cacheReadTokens = pick(update.cacheReadTokens, existing.cacheReadTokens);
  const cacheCreationTokens = pick(update.cacheCreationTokens, existing.cacheCreationTokens);
  const outputTokens = pick(update.outputTokens, existing.outputTokens);
  const reasoningTokens = pick(update.reasoningTokens, existing.reasoningTokens);
  let cache = cacheReadTokens + cacheCreationTokens;

  if (cache === 0) cache = cachedTokens;
  const calculated = inputTokens + outputTokens + cache;

  const totalTokens =
    update.totalTokens === 0 || update.totalTokens < calculated ? calculated : update.totalTokens;

  const tier = update.responseServiceTier ?? existing.responseServiceTier;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    tokenBreakdown: independentTokenBreakdown(
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      Math.max(outputTokens - reasoningTokens, 0),
      reasoningTokens,
      totalTokens,
    ),
    ...(tier === undefined ? {} : { responseServiceTier: tier }),
  };
};
