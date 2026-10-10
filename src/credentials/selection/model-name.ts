/**
 * Model-name helpers shared by selection and routing.
 *
 * Go source: internal/thinking/suffix.go (`ParseSuffix`), sdk/cliproxy/auth/selector.go (`canonicalModelKey`),
 * sdk/cliproxy/service_models.go (`matchWildcard`, `applyExcludedModels`).
 */

export interface ModelSuffix {
  readonly modelName: string
  readonly hasSuffix: boolean
  readonly rawSuffix: string
}

/** `thinking.ParseSuffix`: the last `(` starts a suffix when the string ends with `)`. */
export const parseModelSuffix = (model: string): ModelSuffix => {
  const lastOpen = model.lastIndexOf("(")
  if (lastOpen === -1 || !model.endsWith(")")) return { modelName: model, hasSuffix: false, rawSuffix: "" }
  return { modelName: model.slice(0, lastOpen), hasSuffix: true, rawSuffix: model.slice(lastOpen + 1, -1) }
}

/** `canonicalModelKey`: trims and strips the thinking suffix. */
export const canonicalModelKey = (model: string): string => {
  const trimmed = model.trim()
  if (trimmed === "") return ""
  const name = parseModelSuffix(trimmed).modelName.trim()
  return name === "" ? trimmed : name
}

/** `preserveResolvedModelSuffix`: re-attach the request's suffix unless the resolved name has its own. */
export const preserveResolvedSuffix = (resolved: string, request: ModelSuffix): string => {
  const name = resolved.trim()
  if (name === "") return ""
  if (parseModelSuffix(name).hasSuffix) return name
  if (request.hasSuffix && request.rawSuffix !== "") return `${name}(${request.rawSuffix})`
  return name
}

/** Case-insensitive `*` wildcard match (`gpt-*`, `*-preview`, `a*b`); `*` matches any substring. */
export const matchWildcard = (pattern: string, value: string): boolean => {
  if (pattern === "") return false
  if (!pattern.includes("*")) return pattern === value
  const parts = pattern.split("*")
  let rest = value
  const prefix = parts[0] as string
  if (prefix !== "") {
    if (!rest.startsWith(prefix)) return false
    rest = rest.slice(prefix.length)
  }
  const suffix = parts[parts.length - 1] as string
  if (suffix !== "") {
    if (!rest.endsWith(suffix)) return false
    rest = rest.slice(0, rest.length - suffix.length)
  }
  for (let index = 1; index < parts.length - 1; index += 1) {
    const segment = parts[index] as string
    if (segment === "") continue
    const at = rest.indexOf(segment)
    if (at < 0) return false
    rest = rest.slice(at + segment.length)
  }
  return true
}

/** Normalises exclusion patterns: trimmed, lower-cased, de-duplicated, sorted (`ApplyAuthExcludedModelsMeta`). */
export const normalizeExclusions = (...lists: ReadonlyArray<ReadonlyArray<string> | undefined>): string[] => {
  const seen = new Set<string>()
  for (const list of lists) {
    for (const entry of list ?? []) {
      const trimmed = entry.trim().toLowerCase()
      if (trimmed !== "") seen.add(trimmed)
    }
  }
  return [...seen].toSorted()
}

/** Whether any pattern excludes `model` (case-insensitive, thinking suffix ignored). */
export const isModelExcluded = (patterns: ReadonlyArray<string>, model: string): boolean => {
  if (patterns.length === 0) return false
  const id = canonicalModelKey(model).toLowerCase()
  if (id === "") return false
  return patterns.some((pattern) => matchWildcard(pattern, id))
}
