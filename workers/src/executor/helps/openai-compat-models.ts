/**
 * Per-model options of `api-keys.openai-compatibility` entries.
 *
 * Go source: internal/runtime/executor/helps/openai_compat_max_tokens.go (ShouldUseMaxCompletionTokensForModel,
 * NormalizeOpenAIMaxTokens), helps/payload_mutations.go (SetBoolIfDifferent).
 */
import type { ModelEntry, OpenAICompatGroup } from "../../config/schema.ts"
import { type Json, del, exists, get, set } from "../../json/index.ts"
import { parseSuffix } from "../suffix.ts"

const normalizeName = (model: string | undefined): string => parseSuffix((model ?? "").trim()).modelName.trim()

/** The configured model entry for `model`: first by upstream `name`, then by `alias`. */
export const findCompatModel = (
  models: ReadonlyArray<ModelEntry>,
  model: string
): { readonly entry: ModelEntry | undefined; readonly matched: boolean } => {
  const name = normalizeName(model).toLowerCase()
  if (name === "") return { entry: undefined, matched: false }
  const byName = models.find((entry) => normalizeName(entry.name).toLowerCase() === name)
  if (byName !== undefined) return { entry: byName, matched: true }
  const byAlias = models.find((entry) => normalizeName(entry.alias).toLowerCase() === name)
  return { entry: byAlias, matched: byAlias !== undefined }
}

/** `ShouldUseMaxCompletionTokensForModel`: upstream model first, then the requested model. */
export const shouldUseMaxCompletionTokens = (
  group: OpenAICompatGroup | undefined,
  upstreamModel: string,
  requestedModel: string
): boolean => {
  if (group === undefined) return false
  const models = group.models ?? []
  const upstream = findCompatModel(models, upstreamModel)
  if (upstream.matched) return upstream.entry?.["use-max-completion-tokens"] === true
  return findCompatModel(models, requestedModel).entry?.["use-max-completion-tokens"] === true
}

/** `NormalizeOpenAIMaxTokens`: keeps exactly one of `max_tokens` / `max_completion_tokens`. */
export const normalizeOpenAIMaxTokens = (payload: Json, useMaxCompletionTokens: boolean): Json => {
  const hasMaxTokens = exists(payload, "max_tokens")
  const hasMaxCompletionTokens = exists(payload, "max_completion_tokens")
  if (!hasMaxTokens && !hasMaxCompletionTokens) return payload
  const [from, to] = useMaxCompletionTokens
    ? (["max_tokens", "max_completion_tokens"] as const)
    : (["max_completion_tokens", "max_tokens"] as const)
  let out = payload
  if (exists(out, from) && !exists(out, to)) out = set(out, to, get(out, from) as Json)
  if (exists(out, from)) out = del(out, from)
  return out
}

/** `SetBoolIfDifferent`. */
export const setBoolIfDifferent = (payload: Json, path: string, value: boolean): Json =>
  get(payload, path) === value ? payload : set(payload, path, value)
