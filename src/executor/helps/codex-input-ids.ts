/**
 * Codex input item id normalisation.
 *
 * Go source: internal/runtime/executor/helps/codex_input_ids.go (SanitizeCodexInputItemIDs). Item ids get a type
 * prefix, encrypted reasoning items with ids over 64 characters are dropped and other overlong ids are shortened
 * deterministically (sha256 suffix) without colliding with existing ids.
 */
import { createHash } from "node:crypto"
import { asString, get, isJsonArray, isJsonObject, type Json } from "../../json/index.ts"

const ID_LIMIT = 64

const PREFIXES: Readonly<Record<string, string>> = {
  message: "msg",
  reasoning: "rs",
  function_call: "fc",
  custom_tool_call: "ctc",
  custom_tool_call_output: "ctco"
}

const OCCUPIED = 1

const PRESERVED = 2

const runeLength = (text: string): number => {
  let count = 0

  for (const _ of text) count++

  return count
}

const runes = (text: string): string[] => [...text]

const normalizeItemId = (item: Json, id: string): string => {
  const prefix = PREFIXES[asString(get(item, "type"))]

  if (prefix === undefined) return id

  if (id === "" || id.startsWith(prefix)) return id

  return `${prefix}_${id}`
}

const shouldDropEncryptedReasoning = (item: Json): boolean => {
  if (asString(get(item, "type")) !== "reasoning") return false
  const id = get(item, "id")

  if (typeof id !== "string" || runeLength(id) <= ID_LIMIT) return false
  const encrypted = get(item, "encrypted_content")

  return typeof encrypted === "string" && encrypted !== ""
}

const withHashSuffix = (id: string, attempt: number): string => {
  const hashInput = attempt > 0 ? `${id}\u0000${attempt}` : id
  const suffix = `_${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`
  const characters = runes(id)
  const prefixLength = Math.min(characters.length, ID_LIMIT - suffix.length)

  return characters.slice(0, prefixLength).join("") + suffix
}

const shorten = (id: string, attempt: number): string => (runeLength(id) <= ID_LIMIT ? id : withHashSuffix(id, attempt))

/** `SanitizeCodexInputItemIDs`; mutates `body.input` in place and returns the body. */
export const sanitizeCodexInputItemIds = <T extends Json>(body: T): T => {
  const input = get(body, "input")

  if (!isJsonArray(input)) return body
  const states = new Map<string, number>()

  for (const item of input) {
    if (shouldDropEncryptedReasoning(item)) continue
    const itemId = get(item, "id")

    if (typeof itemId !== "string") continue
    const id = normalizeItemId(item, itemId)
    let state = states.get(id) ?? 0

    if (id === itemId) state |= PRESERVED

    if (runeLength(id) <= ID_LIMIT) state |= OCCUPIED

    if (state !== 0) states.set(id, state)
  }

  const mapped = new Map<string, string>()
  const collisionMapped = new Map<string, string>()
  const rebuilt: Json[] = []
  let changed = false

  for (const item of input) {
    if (shouldDropEncryptedReasoning(item)) {
      changed = true
      continue
    }

    const itemId = get(item, "id")

    if (typeof itemId === "string" && isJsonObject(item)) {
      let id = normalizeItemId(item, itemId)

      if (id !== itemId && ((states.get(id) ?? 0) & PRESERVED) !== 0) {
        let collisionId = collisionMapped.get(id)

        if (collisionId === undefined) {
          for (let attempt = 0; ; attempt++) {
            const candidate = withHashSuffix(id, attempt)

            if (((states.get(candidate) ?? 0) & OCCUPIED) !== 0) continue
            collisionId = candidate
            collisionMapped.set(id, candidate)
            states.set(candidate, (states.get(candidate) ?? 0) | OCCUPIED)
            break
          }
        }

        id = collisionId as string
      }

      if (runeLength(id) > ID_LIMIT) {
        let shortened = mapped.get(id)

        if (shortened === undefined) {
          shortened = shorten(id, 0)

          for (let attempt = 1; ((states.get(shortened) ?? 0) & OCCUPIED) !== 0; attempt++) {
            shortened = shorten(id, attempt)
          }

          mapped.set(id, shortened)
          states.set(shortened, (states.get(shortened) ?? 0) | OCCUPIED)
        }

        id = shortened
      }

      if (id !== itemId) {
        item["id"] = id
        changed = true
      }
    }

    rebuilt.push(item)
  }

  if (changed) input.splice(0, input.length, ...rebuilt)

  return body
}
