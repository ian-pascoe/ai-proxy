/**
 * Usage records: one per upstream attempt (successful or failed).
 *
 * Go source: sdk/cliproxy/usage/manager.go (Record, Detail), internal/runtime/executor/helps/usage_helpers.go
 * (ParseOpenAIUsage, ParseOpenAIStreamUsage, parseOpenAIStyleUsageNode, extractResponseServiceTier). The v2 token
 * breakdown (`usage/accounting.go`) and persistence belong to the usage slice.
 */
import { get, isJsonObject, type Json, tryParseJson } from "../json/index.ts"

export interface UsageDetail {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cachedTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly totalTokens: number
  readonly responseServiceTier?: string
}

export const emptyUsageDetail: UsageDetail = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0
}

export interface UsageRecord {
  /** Unique id of this attempt. */
  readonly requestId: string
  /** Provider key of the credential (e.g. `openai-compatible-openrouter`). */
  readonly provider: string
  /** Executor identifier. */
  readonly executorType: string
  /** Upstream (billed) base model. */
  readonly model: string
  /** Model string the client asked for. */
  readonly alias: string
  /** Inbound route, e.g. `POST /v1/chat/completions`. */
  readonly endpoint: string
  /** Access principal (replaces Go's client API key). */
  readonly principalId: string
  readonly authId: string
  readonly authType: string
  readonly source: string
  readonly stream: boolean
  readonly requestedAt: number
  readonly latencyMs: number
  readonly ttftMs?: number
  readonly failed: boolean
  readonly fail?: { readonly statusCode: number; readonly body: string }
  readonly detail: UsageDetail
  readonly responseModel?: string
  readonly reasoningEffort?: string
  readonly serviceTier: string
}

const int = (value: Json | undefined): number => (typeof value === "number" ? Math.trunc(value) : 0)

const first = (node: Json, ...paths: ReadonlyArray<string>): Json | undefined => {
  for (const path of paths) {
    const value = get(node, path)
    if (value !== undefined) return value
  }
  return undefined
}

const USAGE_BUCKET_PATHS = [
  "prompt_tokens",
  "input_tokens",
  "completion_tokens",
  "output_tokens",
  "prompt_tokens_details.cached_tokens",
  "input_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cache_creation_tokens",
  "input_tokens_details.cache_write_tokens",
  "input_tokens_details.cache_creation_tokens",
  "completion_tokens_details.reasoning_tokens",
  "output_tokens_details.reasoning_tokens"
] as const

export const hasUsageFields = (node: Json | undefined): node is Json =>
  isJsonObject(node) &&
  (get(node, "total_tokens") !== undefined || USAGE_BUCKET_PATHS.some((path) => get(node, path) !== undefined))

/** `parseOpenAIStyleUsageNode` without the v2 token breakdown. */
export const parseOpenAIUsageNode = (node: Json): UsageDetail => {
  const input = int(first(node, "prompt_tokens", "input_tokens"))
  const output = int(first(node, "completion_tokens", "output_tokens"))
  const cached = first(node, "prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens")
  const reasoning = first(node, "completion_tokens_details.reasoning_tokens", "output_tokens_details.reasoning_tokens")
  const cacheCreation = first(
    node,
    "input_tokens_details.cache_creation_tokens",
    "input_tokens_details.cache_write_tokens",
    "prompt_tokens_details.cache_creation_tokens",
    "prompt_tokens_details.cache_write_tokens"
  )
  const total = int(get(node, "total_tokens"))
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: int(reasoning),
    cachedTokens: int(cached),
    cacheReadTokens: int(cached),
    cacheCreationTokens: int(cacheCreation),
    totalTokens: total !== 0 ? total : input + output
  }
}

/** `extractResponseServiceTier`. */
export const responseServiceTier = (payload: Json | undefined): string | undefined => {
  for (const path of ["response.service_tier", "service_tier", "interaction.service_tier"]) {
    const value = get(payload, path)
    const tier = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : ""
    if (tier !== "") return tier
  }
  return undefined
}

const withTier = (detail: UsageDetail, tier: string | undefined): UsageDetail =>
  tier === undefined ? detail : { ...detail, responseServiceTier: tier }

/** `ParseOpenAIUsage` over a non-stream response body. */
export const parseOpenAIUsage = (body: string): UsageDetail => {
  const parsed = tryParseJson(body)
  const node = get(parsed, "usage")
  return withTier(hasUsageFields(node) ? parseOpenAIUsageNode(node) : emptyUsageDetail, responseServiceTier(parsed))
}

/** `jsonPayload`: the JSON object carried by one SSE line, if any. */
export const ssePayloadObject = (line: string): Json | undefined => {
  let trimmed = line.trim()
  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return undefined
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  if (!trimmed.startsWith("{")) return undefined
  const parsed = tryParseJson(trimmed)
  return isJsonObject(parsed) ? parsed : undefined
}

/** `ParseOpenAIStreamUsage`: usage carried by one OpenAI-style stream line. */
export const parseOpenAIStreamUsage = (line: string): UsageDetail | undefined => {
  const payload = ssePayloadObject(line)
  if (payload === undefined) return undefined
  const tier = responseServiceTier(payload)
  const node = get(payload, "usage")
  if (!hasUsageFields(node)) return tier === undefined ? undefined : withTier(emptyUsageDetail, tier)
  return withTier(parseOpenAIUsageNode(node), tier)
}

/** Model reported by the upstream (`model`, `response.model`, `interaction.model`), bounded to 256 chars. */
export const responseModelOf = (payload: Json | undefined): string | undefined => {
  for (const path of ["response.model", "interaction.model", "model"]) {
    const value = get(payload, path)
    if (typeof value === "string" && value.trim() !== "" && value.trim().length <= 256) return value.trim()
  }
  return undefined
}
