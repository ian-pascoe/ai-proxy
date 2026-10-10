/**
 * Gemini thought-signature carriers on OpenAI Responses reasoning items.
 *
 * Go source: internal/translator/gemini/openai/responses/signature_carrier.go and the item predicates of
 * gemini_openai-responses_request.go (`openAIResponsesAssistantVisibleText`, `isOpenAIResponsesDetachedCarrier`).
 * Items are plain parsed JSON; Go's `item.Raw` re-parsing becomes structured clones.
 */
import {
  asString,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set
} from "../../../../json/index.ts"
import {
  compatibleGeminiSignature,
  isGeminiThoughtSignatureBypass,
  MAX_GEMINI_SIGNATURE_LEN,
  signaturePayloadWithoutProviderPrefix
} from "../../common/signature.ts"

export const CARRIER_PREFIX = "cpa-gemini-responses-carrier-v1:"

export const CARRIER_NEXT = "next"

export const CARRIER_PREVIOUS = "previous"

export const CARRIER_STANDALONE = "standalone"

export const CARRIER_TEXT = "text"

export const CARRIER_FUNCTION = "function"

export const CARRIER_ANY = "any"

export const CARRIER_DIRECTION_FIELD = "_cpa_reasoning_direction"

export const CARRIER_TARGET_FIELD = "_cpa_reasoning_target"

export const CARRIER_SIGNATURE_FIELD = "_cpa_reasoning_signature"

export const CARRIER_SUMMARY_FIELD = "_cpa_reasoning_summary"

const utf8 = new TextEncoder()

const encodeRawBase64 = (text: string): string => {
  let binary = ""

  for (const byte of utf8.encode(text)) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/=+$/, "")
}

/** `base64.RawStdEncoding.DecodeString`: unpadded standard alphabet only. */
const decodeRawBase64 = (text: string): string | undefined => {
  if (!/^[A-Za-z0-9+/]*$/.test(text) || text.length % 4 === 1) return undefined

  try {
    const binary = atob(text + "=".repeat((4 - (text.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** `encodeGeminiResponsesCarrier`. */
export const encodeCarrier = (rawSignature: string, direction: string, targetKind: string): string => {
  const raw = rawSignature.trim()

  return raw === "" ? "" : `${CARRIER_PREFIX}${direction}:${targetKind}:${encodeRawBase64(raw)}`
}

export interface DecodedCarrier {
  readonly signature: string
  readonly direction: string
  readonly targetKind: string
  readonly marked: boolean
  readonly ok: boolean
}

/** `decodeGeminiResponsesCarrier`. */
export const decodeCarrier = (rawSignature: string): DecodedCarrier => {
  const raw = rawSignature.trim()

  if (!raw.startsWith(CARRIER_PREFIX)) {
    return { signature: raw, direction: "", targetKind: "", marked: false, ok: true }
  }

  const bad: DecodedCarrier = { signature: "", direction: "", targetKind: "", marked: true, ok: false }

  if (raw.length > Math.floor((MAX_GEMINI_SIGNATURE_LEN * 4) / 3) + 1024) return bad
  const rest = raw.slice(CARRIER_PREFIX.length)
  const first = rest.indexOf(":")
  const second = first < 0 ? -1 : rest.indexOf(":", first + 1)

  if (first < 0 || second < 0) return bad
  const direction = rest.slice(0, first)
  const targetKind = rest.slice(first + 1, second)

  if (![CARRIER_NEXT, CARRIER_PREVIOUS, CARRIER_STANDALONE].includes(direction)) return bad

  if (![CARRIER_TEXT, CARRIER_FUNCTION, CARRIER_ANY].includes(targetKind)) return bad
  const decoded = decodeRawBase64(rest.slice(second + 1))

  if (decoded === undefined || decoded === "" || decoded.startsWith(CARRIER_PREFIX)) return bad

  return { signature: decoded, direction, targetKind, marked: true, ok: true }
}

/** `compatibleGeminiResponsesCarrierSignature`: a replayable, non-bypass Gemini signature. */
export const compatibleCarrierSignature = (rawSignature: string): string | undefined => {
  const normalized = compatibleGeminiSignature(rawSignature)

  if (normalized === undefined || isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(normalized))) {
    return undefined
  }

  return normalized
}

const trimmedString = (value: Json | undefined): string => asString(value).trim()

/** `openAIResponsesAssistantVisibleText`: the model-visible text of a message item. */
export const assistantVisibleText = (item: Json | undefined): string | undefined => {
  let itemType = asString(get(item, "type"))
  const itemRole = asString(get(item, "role"))

  if (itemType === "" && itemRole !== "") itemType = "message"

  if (itemType !== "message") return undefined
  const content = get(item, "content")

  if (content === undefined) return undefined

  if (typeof content === "string") {
    switch (itemRole.trim().toLowerCase()) {
      case "assistant":
      case "model":
        return content
      default:
        return undefined
    }
  }

  if (!isJsonArray(content)) return undefined
  const texts: string[] = []
  let hasOutputText = false

  for (const contentItem of content) {
    const contentType = asString(get(contentItem, "type")) || "input_text"

    if (contentType !== "output_text") continue
    hasOutputText = true
    texts.push(asString(get(contentItem, "text")))
  }

  // output_text marks model-visible content even when message.role is "user".
  return hasOutputText ? texts.join("\n") : undefined
}

/** `isOpenAIResponsesDetachedCarrier`. */
export const isDetachedCarrier = (item: Json | undefined): boolean =>
  asString(get(item, "type")) === "reasoning" &&
  trimmedString(get(item, "encrypted_content")) !== "" &&
  trimmedString(get(item, "summary.0.text")) === ""

export const carrierDirection = (item: Json | undefined): string => asString(get(item, CARRIER_DIRECTION_FIELD))

export const carrierTarget = (item: Json | undefined): string => asString(get(item, CARRIER_TARGET_FIELD))

const semanticTarget = (item: Json): string => {
  switch (asString(get(item, "type"))) {
    case "function_call":
    case "custom_tool_call":
      return CARRIER_FUNCTION
    case "reasoning":
      if (trimmedString(get(item, "summary.0.text")) !== "") return CARRIER_TEXT
      break
  }

  return assistantVisibleText(item) !== undefined ? CARRIER_TEXT : ""
}

const carrierMatchesAdjacent = (
  items: readonly Json[],
  index: number,
  direction: string,
  targetKind: string
): boolean => {
  const step = direction === CARRIER_PREVIOUS ? -1 : 1

  for (let adjacent = index + step; adjacent >= 0 && adjacent < items.length; adjacent += step) {
    const item = items[adjacent] as Json
    const kind = semanticTarget(item)

    if (kind !== "") return targetKind === CARRIER_ANY || targetKind === kind

    if (!isDetachedCarrier(item)) return false
  }

  return false
}

const CARRIER_FIELDS = [CARRIER_DIRECTION_FIELD, CARRIER_TARGET_FIELD, CARRIER_SIGNATURE_FIELD, CARRIER_SUMMARY_FIELD]

const hasInternalCarrierFields = (item: Json): boolean => CARRIER_FIELDS.some((field) => exists(item, field))

/** `stripGeminiResponsesCarrierMetadata`: Go re-marshals through a map, so the top-level keys end up sorted. */
const stripCarrierMetadata = (item: Json): JsonObject | undefined => {
  if (!isJsonObject(item)) return undefined
  const out: JsonObject = {}

  for (const key of Object.keys(item).toSorted()) {
    if (!CARRIER_FIELDS.includes(key)) out[key] = item[key] as Json
  }

  return out
}

/** `normalizeGeminiResponsesCarriers`: validates carrier markers and strips client-supplied internal fields. */
export const normalizeCarriers = (
  items: readonly Json[]
): { readonly items: Json[]; readonly hasValidCarrier: boolean } => {
  const normalized: Json[] = []
  let hasValidCarrier = false
  items.forEach((originalItem, itemIndex) => {
    let item: Json = originalItem

    if (hasInternalCarrierFields(originalItem)) {
      const stripped = stripCarrierMetadata(originalItem)

      if (stripped !== undefined) item = stripped
    }

    if (asString(get(item, "type")) !== "reasoning") {
      normalized.push(item)

      return
    }

    const rawSignature = trimmedString(get(item, "encrypted_content"))
    const decoded = decodeCarrier(rawSignature)

    if (!decoded.marked) {
      if (rawSignature !== "" && compatibleCarrierSignature(rawSignature) !== undefined) hasValidCarrier = true
      normalized.push(item)

      return
    }

    let ok = decoded.ok
    let signature = decoded.signature

    if (ok) {
      const compatible = compatibleCarrierSignature(signature)
      ok = compatible !== undefined
      signature = compatible ?? ""
    }

    if (ok && decoded.direction !== CARRIER_STANDALONE) {
      ok = carrierMatchesAdjacent(items, itemIndex, decoded.direction, decoded.targetKind)
    }

    const isDetached = isDetachedCarrier(item)
    const hasSummary = trimmedString(get(item, "summary.0.text")) !== ""

    const validSummaryCarrier =
      hasSummary &&
      ((decoded.direction === CARRIER_STANDALONE &&
        (decoded.targetKind === CARRIER_TEXT || decoded.targetKind === CARRIER_ANY)) ||
        decoded.direction === CARRIER_NEXT)

    if (!ok || (!isDetached && !validSummaryCarrier)) {
      if (!hasSummary) return
      const copy = structuredClone(item)
      del(copy, "encrypted_content")
      normalized.push(copy)

      return
    }

    hasValidCarrier = true
    const copy = structuredClone(item)
    set(copy, "encrypted_content", signature)
    set(copy, CARRIER_DIRECTION_FIELD, decoded.direction)
    set(copy, CARRIER_TARGET_FIELD, decoded.targetKind)
    normalized.push(copy)
  })

  return { items: normalized, hasValidCarrier }
}
