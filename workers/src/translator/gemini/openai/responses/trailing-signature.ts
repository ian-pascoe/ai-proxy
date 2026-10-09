/**
 * Hidden text signatures of Gemini text parts, kept off the client-visible reasoning timeline.
 *
 * Go source: internal/translator/gemini/openai/responses/trailing_signature.go.
 */
import { createHash } from "node:crypto"
import { asString, get, type Json, type JsonObject, set } from "../../../../json/index.ts"
import { parseSuffix } from "../../../../executor/suffix.ts"
import {
  assistantVisibleText,
  CARRIER_PREVIOUS,
  CARRIER_TEXT,
  compatibleCarrierSignature,
  decodeCarrier,
  encodeCarrier,
  isDetachedCarrier
} from "./carrier.ts"
import { replayCache } from "./replay-cache.ts"

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const cacheKeyOf = (messageId: string): string => `gemini-responses-text:${messageId}`

/** `cacheGeminiResponsesTextSignatures`. */
export const cacheTextSignatures = (
  modelName: string,
  messageId: string,
  text: string,
  signatures: readonly string[]
): boolean => {
  if (messageId === "" || text === "") return false
  const textHash = sha256Hex(text)
  const items: Json[] = []
  for (const signature of signatures) {
    if (compatibleCarrierSignature(signature) === undefined) return false
    const item: JsonObject = { type: "thought_signature", targetKind: "text" }
    set(item, "thoughtSignature", signature)
    set(item, "targetHash", textHash)
    items.push(item)
  }
  return replayCache().set(parseSuffix(modelName).modelName, cacheKeyOf(messageId), items)
}

/** `restoreGeminiResponsesTextSignatures`: re-inserts cached carriers after the assistant message they belong to. */
export const restoreTextSignatures = (modelName: string, items: readonly Json[]): Json[] => {
  const restored: Json[] = []
  const skip = new Set<number>()
  const model = parseSuffix(modelName).modelName
  items.forEach((item, index) => {
    if (skip.has(index)) return
    restored.push(item)
    const text = assistantVisibleText(item)
    const messageId = asString(get(item, "id")).trim()
    if (text === undefined || messageId === "") return
    const cached = replayCache().get(model, cacheKeyOf(messageId))
    if (cached === undefined) return
    // Replay the cached prefix in its original order, then retain uncached explicit carriers. Skipping cached entries
    // instead would reorder A,B into B,A when the client also supplied an explicit carrier for A.
    const replayed = new Set<string>()
    const textHash = sha256Hex(text)
    for (const entry of cached) {
      const signature = asString(get(entry, "thoughtSignature"))
      if (asString(get(entry, "targetHash")) !== textHash) continue
      restored.push({
        type: "reasoning",
        summary: [],
        encrypted_content: encodeCarrier(signature, CARRIER_PREVIOUS, CARRIER_TEXT)
      })
      replayed.add(signature)
    }
    for (let adjacent = index + 1; adjacent < items.length && isDetachedCarrier(items[adjacent]); adjacent++) {
      const decoded = decodeCarrier(asString(get(items[adjacent], "encrypted_content")))
      if (
        decoded.ok &&
        decoded.direction === CARRIER_PREVIOUS &&
        decoded.targetKind === CARRIER_TEXT &&
        replayed.has(decoded.signature)
      ) {
        skip.add(adjacent)
      }
    }
  })
  return restored
}
