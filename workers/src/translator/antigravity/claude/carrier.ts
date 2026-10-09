/**
 * Gemini signature carriers on the Claude-facing wire and Claude thinking-signature validation wrappers.
 *
 * Go source: internal/translator/antigravity/claude/signature_validation.go. Gemini carrier envelopes
 * (`cpa-gemini-carrier-v1:<direction>:<kind>:<base64 raw signature>`) exist only on the Claude-facing wire; the
 * request translator validates and unwraps them before writing native Gemini parts.
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "../../../json/index.ts"
import {
  stripInvalidClaudeThinkingBlocks,
  validateClaudeThinkingSignatures,
  normalizeClaudeThinkingSignature,
  type ClaudeSignatureValidationOptions
} from "../../../signature/claude.ts"
import { decodeBase64Raw, encodeBase64Raw } from "../../../signature/base64.ts"
import { signatureBypassStrictMode } from "../../../signature/cache.ts"
import {
  compatibleSignatureForProvider,
  signaturePayloadWithoutProviderPrefix,
  type SignatureBlockKind
} from "../../../signature/provider.ts"
import { isGeminiThoughtSignatureBypass, MAX_GEMINI_SIGNATURE_LEN } from "../../gemini/common/signature.ts"

export const CARRIER_PREFIX = "cpa-gemini-carrier-v1:"
export const CarrierDirection = { Next: "next", Previous: "previous", Standalone: "standalone" } as const
export const CarrierKind = { Text: "text", Function: "function", Any: "any" } as const

export interface DecodedCarrier {
  readonly signature: string
  readonly direction: string
  readonly targetKind: string
  readonly marked: boolean
  readonly ok: boolean
}

/** `encodeGeminiClaudeCarrierSignature`. */
export const encodeGeminiClaudeCarrierSignature = (
  rawSignature: string,
  direction: string,
  targetKind: string
): string => {
  const raw = rawSignature.trim()
  if (raw === "") return ""
  return `${CARRIER_PREFIX}${direction}:${targetKind}:${encodeBase64Raw(raw)}`
}

const blockKindOf = (targetKind: string): SignatureBlockKind =>
  targetKind === CarrierKind.Function ? "gemini_function_call" : "gemini_model_part"

/** `decodeGeminiClaudeCarrierSignature`: unmarked signatures pass through (`marked: false, ok: true`). */
export const decodeGeminiClaudeCarrierSignature = (rawSignature: string): DecodedCarrier => {
  const raw = rawSignature.trim()
  const invalid: DecodedCarrier = { signature: "", direction: "", targetKind: "", marked: true, ok: false }
  if (!raw.startsWith(CARRIER_PREFIX)) {
    return { signature: raw, direction: "", targetKind: "", marked: false, ok: true }
  }
  if (raw.length > Math.floor((MAX_GEMINI_SIGNATURE_LEN * 4) / 3) + 1024) return invalid
  const fields = raw.slice(CARRIER_PREFIX.length).split(":")
  if (fields.length < 3) return invalid
  const direction = fields[0] as string
  const targetKind = fields[1] as string
  // Go `SplitN(..., 3)`: the payload keeps any further colons.
  const payload = fields.slice(2).join(":")
  if (![CarrierDirection.Next, CarrierDirection.Previous, CarrierDirection.Standalone].includes(direction as never)) {
    return invalid
  }
  if (![CarrierKind.Text, CarrierKind.Function, CarrierKind.Any].includes(targetKind as never)) return invalid
  const bytes = decodeBase64Raw(payload)
  if (bytes === undefined || bytes.length === 0) return invalid
  const decoded = new TextDecoder().decode(bytes)
  if (decoded.startsWith(CARRIER_PREFIX)) return invalid
  const normalized = compatibleSignatureForProvider("gemini", decoded, blockKindOf(targetKind))
  if (normalized === undefined || isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(normalized))) {
    return invalid
  }
  return { signature: normalized, direction, targetKind, marked: true, ok: true }
}

/** `geminiClaudeSemanticTargetKind`. */
const semanticTargetKind = (block: Json): string => {
  switch (asString(get(block, "type"))) {
    case "text":
      return CarrierKind.Text
    case "tool_use":
      return CarrierKind.Function
    case "thinking":
      if (asString(get(block, "thinking")).trim() !== "") return CarrierKind.Text
  }
  return ""
}

/** `geminiClaudeCarrierMatchesAdjacent`. */
export const carrierMatchesAdjacent = (
  blocks: ReadonlyArray<Json>,
  index: number,
  direction: string,
  targetKind: string
): boolean => {
  const step = direction === CarrierDirection.Previous ? -1 : 1
  for (let adjacent = index + step; adjacent >= 0 && adjacent < blocks.length; adjacent += step) {
    const block = blocks[adjacent] as Json
    const kind = semanticTargetKind(block)
    if (kind !== "") return targetKind === CarrierKind.Any || targetKind === kind
    if (asString(get(block, "type")) !== "thinking" || asString(get(block, "thinking")).trim() !== "") return false
  }
  return false
}

/** `geminiClaudeIsValidNonEmptyThinking`. */
const isValidNonEmptyThinking = (rawSignature: string, nextSemanticKind: string): boolean => {
  if (rawSignature === "") return false
  const carrier = decodeGeminiClaudeCarrierSignature(rawSignature)
  const blockKind =
    carrier.marked && carrier.targetKind === CarrierKind.Function ? "gemini_function_call" : "gemini_model_part"
  if (carrier.ok) {
    if (compatibleSignatureForProvider("gemini", carrier.signature, blockKind) === undefined) return false
    if (carrier.marked) {
      if (carrier.direction === CarrierDirection.Previous) return false
      if (carrier.direction === CarrierDirection.Standalone && carrier.targetKind === CarrierKind.Function) return false
      if (carrier.direction === CarrierDirection.Next) {
        if (
          nextSemanticKind === "" ||
          (carrier.targetKind !== CarrierKind.Any && carrier.targetKind !== nextSemanticKind)
        ) {
          return false
        }
      }
    }
    return true
  }
  return compatibleSignatureForProvider("gemini", rawSignature, "gemini_model_part") !== undefined
}

interface CarrierContext {
  readonly nextSemanticKind: string[]
  readonly hasTrailingPreviousCarrier: boolean[]
}

/** `geminiClaudePrecomputeCarrierContext`. */
const precomputeCarrierContext = (blocks: ReadonlyArray<Json>): CarrierContext => {
  const n = blocks.length
  const ctx: CarrierContext = {
    nextSemanticKind: Array.from({ length: n }, () => ""),
    hasTrailingPreviousCarrier: Array.from({ length: n }, () => false)
  }
  let activeKind = ""
  let activeValid = false
  let latestSemanticIndex = -1
  let currentNext = ""
  for (let i = n - 1; i >= 0; i--) {
    const block = blocks[i] as Json
    const blockType = asString(get(block, "type"))
    ctx.nextSemanticKind[i] = currentNext
    switch (blockType) {
      case "thinking": {
        const thinkingText = asString(get(block, "thinking")).trim()
        const rawSig = asString(get(block, "signature")).trim()
        if (thinkingText === "") {
          const carrier = decodeGeminiClaudeCarrierSignature(rawSig)
          if (carrier.ok && carrier.marked && carrier.direction === CarrierDirection.Previous) {
            const kind = carrier.targetKind === CarrierKind.Function ? "gemini_function_call" : "gemini_model_part"
            if (compatibleSignatureForProvider("gemini", carrier.signature, kind) !== undefined) {
              activeKind = carrier.targetKind
              activeValid = true
              continue
            }
          }
          activeKind = ""
          activeValid = false
          continue
        }
        if (rawSig !== "" && !isValidNonEmptyThinking(rawSig, currentNext)) {
          activeKind = ""
          activeValid = false
          latestSemanticIndex = -1
          currentNext = ""
          continue
        }
        currentNext = CarrierKind.Text
        if (activeValid && (activeKind === CarrierKind.Any || activeKind === CarrierKind.Text)) {
          ctx.hasTrailingPreviousCarrier[i] = true
        } else if (latestSemanticIndex !== -1 && ctx.hasTrailingPreviousCarrier[latestSemanticIndex]) {
          ctx.hasTrailingPreviousCarrier[i] = true
        }
        activeKind = ""
        activeValid = false
        latestSemanticIndex = i
        break
      }
      case "text":
      case "tool_use": {
        const semanticKind = blockType === "tool_use" ? CarrierKind.Function : CarrierKind.Text
        currentNext = semanticKind
        if (activeValid && (activeKind === CarrierKind.Any || activeKind === semanticKind)) {
          ctx.hasTrailingPreviousCarrier[i] = true
        }
        activeKind = ""
        activeValid = false
        latestSemanticIndex = i
        break
      }
      default:
        activeKind = ""
        activeValid = false
        latestSemanticIndex = -1
        currentNext = ""
    }
  }
  return ctx
}

/** `StripEmptySignatureThinkingBlocks`. */
export const stripEmptySignatureThinkingBlocks = (payload: Json): Json =>
  stripInvalidClaudeThinkingBlocks(payload, { prefixOnly: true })

/**
 * `StripInvalidGeminiSignatureThinkingBlocks`: keeps only thinking carriers whose signatures can be replayed to Gemini.
 * Mutates and returns `payload`.
 */
export const stripInvalidGeminiSignatureThinkingBlocks = (payload: Json): Json => {
  const messages = get(payload, "messages")
  if (!isJsonArray(messages)) return payload
  for (const message of messages) {
    if (!isJsonObject(message) || !isJsonArray(message["content"])) continue
    const blocks = message["content"]
    const assistantMessage = asString(message["role"]).toLowerCase() === "assistant"
    const ctx = precomputeCarrierContext(blocks)
    const kept: Json[] = []
    let contentChanged = false
    let pendingTargetKind = ""
    let currentPrevSemanticKind = ""
    blocks.forEach((block, blockIndex) => {
      const blockType = asString(get(block, "type"))
      if (blockType === "thinking") {
        const rawSignature = asString(get(block, "signature")).trim()
        const thinkingText = asString(get(block, "thinking")).trim()
        if (
          assistantMessage &&
          rawSignature === "" &&
          thinkingText !== "" &&
          (pendingTargetKind === CarrierKind.Any ||
            pendingTargetKind === CarrierKind.Text ||
            ctx.hasTrailingPreviousCarrier[blockIndex] === true)
        ) {
          pendingTargetKind = ""
          currentPrevSemanticKind = CarrierKind.Text
          kept.push(block)
          return
        }
        const carrier = decodeGeminiClaudeCarrierSignature(rawSignature)
        const blockKind =
          carrier.marked && carrier.targetKind === CarrierKind.Function ? "gemini_function_call" : "gemini_model_part"
        let invalidMarkedPlacement = false
        if (carrier.marked) {
          switch (carrier.direction) {
            case CarrierDirection.Next: {
              const nextKind = ctx.nextSemanticKind[blockIndex] as string
              invalidMarkedPlacement =
                nextKind === "" || (carrier.targetKind !== CarrierKind.Any && carrier.targetKind !== nextKind)
              break
            }
            case CarrierDirection.Previous:
              invalidMarkedPlacement =
                currentPrevSemanticKind === "" ||
                (carrier.targetKind !== CarrierKind.Any && carrier.targetKind !== currentPrevSemanticKind)
              break
            case CarrierDirection.Standalone:
              invalidMarkedPlacement = thinkingText !== "" && carrier.targetKind === CarrierKind.Function
              break
          }
          if (thinkingText !== "" && carrier.direction === CarrierDirection.Previous) invalidMarkedPlacement = true
        }
        if (!carrier.ok || !assistantMessage || invalidMarkedPlacement) {
          pendingTargetKind = ""
          if (thinkingText !== "") currentPrevSemanticKind = ""
          contentChanged = true
          return
        }
        const inner = carrier.marked ? carrier.signature : rawSignature
        if (compatibleSignatureForProvider("gemini", inner, blockKind) === undefined) {
          pendingTargetKind = ""
          if (thinkingText !== "") currentPrevSemanticKind = ""
          contentChanged = true
          return
        }
        pendingTargetKind = carrier.marked && carrier.direction === CarrierDirection.Next ? carrier.targetKind : ""
        if (thinkingText !== "") currentPrevSemanticKind = CarrierKind.Text
      } else {
        pendingTargetKind = ""
        if (blockType === "tool_use") currentPrevSemanticKind = CarrierKind.Function
        else if (blockType === "text") currentPrevSemanticKind = CarrierKind.Text
        else currentPrevSemanticKind = ""
      }
      kept.push(block)
    })
    if (contentChanged) message["content"] = kept
  }
  return payload
}

/** `claudeBypassSignatureValidationOptions`. */
export const claudeBypassSignatureValidationOptions = (): ClaudeSignatureValidationOptions => ({
  strict: signatureBypassStrictMode()
})

/** `StripInvalidBypassSignatureThinkingBlocks`. */
export const stripInvalidBypassSignatureThinkingBlocks = (payload: Json): Json =>
  stripInvalidClaudeThinkingBlocks(payload, claudeBypassSignatureValidationOptions())

/** `ValidateClaudeBypassSignatures`: the first invalid thinking block as an error text. */
export const validateClaudeBypassSignatures = (payload: Json): string | undefined =>
  validateClaudeThinkingSignatures(payload, claudeBypassSignatureValidationOptions())

/** `normalizeClaudeBypassSignature`; throws on an invalid signature. */
export const normalizeClaudeBypassSignature = (rawSignature: string): string =>
  normalizeClaudeThinkingSignature(rawSignature, claudeBypassSignatureValidationOptions())
