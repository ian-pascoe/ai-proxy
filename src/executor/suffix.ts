/**
 * Thinking suffix parsing on model names: `model(value)`.
 *
 * Go source: internal/thinking/suffix.go (ParseSuffix). Only the split is needed by the pipeline; interpreting the
 * suffix belongs to the thinking pipeline, which may re-export or replace this module.
 */

export interface SuffixResult {
  /** Model name without the suffix. */
  readonly modelName: string
  readonly hasSuffix: boolean
  /** Text between the last `(` and the final `)`. */
  readonly rawSuffix: string
}

/** Splits `name(suffix)`: the group starts at the last `(` and the string must end with `)`. */
export const parseSuffix = (model: string): SuffixResult => {
  const lastOpen = model.lastIndexOf("(")

  if (lastOpen === -1 || !model.endsWith(")")) return { modelName: model, hasSuffix: false, rawSuffix: "" }

  return { modelName: model.slice(0, lastOpen), hasSuffix: true, rawSuffix: model.slice(lastOpen + 1, -1) }
}

/** Re-attaches the request's suffix unless `resolved` already has one (Go `preserveResolvedModelSuffix`). */
export const preserveSuffix = (resolved: string, request: SuffixResult): string => {
  const trimmed = resolved.trim()

  if (trimmed === "") return ""

  if (parseSuffix(trimmed).hasSuffix) return trimmed

  return request.hasSuffix && request.rawSuffix !== "" ? `${trimmed}(${request.rawSuffix})` : trimmed
}
