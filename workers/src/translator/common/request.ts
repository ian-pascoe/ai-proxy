/**
 * Go source: internal/translator/common/request.go (RequestModelName, GenerateClaudeToolCallID).
 */
import { asString, get, type Json } from "../../json/index.ts"

const requestModelName = (root: Json | undefined): string => {
  if (root === undefined) return ""
  for (const path of ["model", "request.model"]) {
    const model = get(root, path)
    if (typeof model === "string" && model.trim() !== "") return model
  }
  return ""
}

/** Model name of the original request, falling back to the translated one. */
export const requestModelNameOf = (original: Json | undefined, translated: Json | undefined): string => {
  for (const root of [original, translated]) {
    const name = requestModelName(root)
    if (name !== "") return name
  }
  return ""
}

const TOOLU_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** `GenerateClaudeToolCallID`: `toolu_` + 24 uniformly random alphanumerics. */
export const generateClaudeToolCallId = (): string => {
  const max = 256 - (256 % TOOLU_LETTERS.length)
  let out = "toolu_"
  let n = 0
  const buffer = new Uint8Array(32)
  while (n < 24) {
    crypto.getRandomValues(buffer)
    for (const value of buffer) {
      if (value < max) {
        out += TOOLU_LETTERS[value % TOOLU_LETTERS.length]
        n++
        if (n === 24) break
      }
    }
  }
  return out
}

/** Convenience: `gjson.Get(...).String()`. */
export const stringAt = (root: Json | undefined, path: string): string => asString(get(root, path))
