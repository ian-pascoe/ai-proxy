/**
 * Credential weight validation.
 *
 * Go source: internal/credentialweight/weight.go. Weights are integers; non-positive values are valid and normalise
 * to 0 (excluded from weighted round-robin); values above 1,000,000 are rejected; absent/empty means 1.
 */
export const DEFAULT_WEIGHT = 1
export const MAX_WEIGHT = 1_000_000

export type WeightResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string }

const normalize = (weight: number): WeightResult => {
  if (weight <= 0) return { ok: true, value: 0 }
  if (weight > MAX_WEIGHT) return { ok: false, message: `weight must not exceed ${MAX_WEIGHT}` }
  return { ok: true, value: weight }
}

/** Parses an auth-file metadata value (number or numeric string). */
export const parseWeightValue = (value: unknown): WeightResult => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.trunc(value) !== value)
      return { ok: false, message: "weight must be an integer" }
    return normalize(value)
  }
  if (typeof value === "string") {
    const text = value.trim()
    if (text === "") return { ok: true, value: DEFAULT_WEIGHT }
    if (!/^[+-]?\d+$/.test(text)) return { ok: false, message: "weight must be an integer" }
    return normalize(Number(text))
  }
  return { ok: false, message: "weight must be an integer" }
}
