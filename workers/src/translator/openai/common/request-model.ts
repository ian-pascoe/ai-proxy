/** Go source: internal/translator/common/request.go (RequestModelName, GenerateClaudeToolCallID). */
import { get, type Json } from "../../../json/index.ts"

const requestModelName = (root: Json | undefined): string => {
  for (const path of ["model", "request.model"]) {
    const model = get(root, path)
    if (typeof model === "string" && model.trim() !== "") return model
  }
  return ""
}

/** The model of the original request, falling back to the translated request. */
export const requestModelNameOf = (original: Json | undefined, translated: Json | undefined): string => {
  for (const body of [original, translated]) {
    const name = requestModelName(body)
    if (name !== "") return name
  }
  return ""
}

const TOOLU_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** `toolu_` + 24 random alphanumerics (rejection sampling keeps the distribution uniform). */
export const generateClaudeToolCallId = (): string => {
  const maxValid = 256 - (256 % TOOLU_LETTERS.length)
  let out = "toolu_"
  let n = 0
  const buf = new Uint8Array(32)
  while (n < 24) {
    crypto.getRandomValues(buf)
    for (const byte of buf) {
      if (byte < maxValid) {
        out += TOOLU_LETTERS[byte % TOOLU_LETTERS.length]
        n++
        if (n === 24) break
      }
    }
  }
  return out
}
