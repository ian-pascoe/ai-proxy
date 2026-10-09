/**
 * Upstream profile of the Claude executor for delegating providers (Kimi).
 *
 * Go source: internal/runtime/executor/claude_executor.go (`upstreamModelNormalizer`, `requestLogProvider`,
 * `upstreamModel`, `restoreResponseModel`), claude_signing.go (`isKimiMessagesUpstream`,
 * `stripDefaultKimiClaudeCodeAttribution`), kimi_executor.go (the embedded `ClaudeExecutor`). A profile changes four
 * things: the model sent upstream, the model name restored in responses, the default attribution block stripping and
 * `count_tokens` always going upstream.
 */
import { get, type Json, set, tryParseJson } from "../../json/index.ts"

export interface ClaudeUpstreamProfile {
  /** Rewrites the base model for the upstream (`upstreamModelNormalizer`). */
  readonly normalizeModel?: (model: string) => string
  /** Remove the Claude Code billing/CCH attribution system block unless the CLI fingerprint profile is active. */
  readonly stripDefaultAttribution?: boolean
  /** `count_tokens` is always sent to the upstream (Kimi), not only for first-party hosts. */
  readonly upstreamCountTokens?: boolean
}

/** `upstreamModel`. */
export const upstreamModelOf = (profile: ClaudeUpstreamProfile | undefined, baseModel: string): string =>
  profile?.normalizeModel?.(baseModel) ?? baseModel

const setModelFields = (payload: Json, model: string): boolean => {
  let changed = false
  for (const path of ["model", "message.model"]) {
    if (get(payload, path) === undefined) continue
    set(payload, path, model)
    changed = true
  }
  return changed
}

/**
 * `restoreResponseModel`: with a model normalizer the `model`/`message.model` fields of a response body or SSE `data:`
 * line are set back to the model the client asked for.
 */
export const restoreResponseModel = (
  profile: ClaudeUpstreamProfile | undefined,
  payload: string,
  model: string
): string => {
  if (profile?.normalizeModel === undefined || model.trim() === "") return payload
  const whole = tryParseJson(payload.trim())
  if (whole !== undefined && typeof whole === "object" && whole !== null) {
    return setModelFields(whole, model) ? JSON.stringify(whole) : payload
  }
  const trimmed = payload.trimStart()
  if (!trimmed.startsWith("data:")) return payload
  const dataIndex = payload.indexOf("data:")
  const parsed = tryParseJson(payload.slice(dataIndex + 5).trim())
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) return payload
  return setModelFields(parsed, model) ? `${payload.slice(0, dataIndex)}data: ${JSON.stringify(parsed)}` : payload
}
