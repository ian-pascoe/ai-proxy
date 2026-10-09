/**
 * Gemini thought-signature replay policy (decision-table subset).
 *
 * Go source: internal/signature/gemini_sanitize.go (SanitizeGeminiRequestThoughtSignatures,
 * GeminiReplaySignatureOrBypass), internal/signature/provider_compatibility.go (DecideSignatureCompatibility for the
 * Gemini target, SplitSignatureProviderPrefix, SignaturePayloadWithoutProviderPrefix), internal/signature/
 * gemini_validation.go (envelope inspection). Only the Gemini target is ported: detecting Claude/GPT/Kimi/Grok
 * signatures never changes the outcome for a Gemini target (they are neither Gemini nor the bypass sentinel, so they
 * are replaced/dropped), and Claude/GPT envelopes never satisfy the Gemini protobuf shape (first tag must be field 2,
 * a single record, wrapping a Tink `0x01` payload, a UUID or a tool-invocation message). Debug logging is not ported.
 */
import { asString, del, exists, get, isJsonArray, isJsonObject, type Json, set } from "../../../json/index.ts"
import { consumeBytes, consumeFixed, consumeTag, consumeVarint, WireType } from "./protowire.ts"

export const GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator"
export const GEMINI_CONTEXT_ENGINEERING_BYPASS = "context_engineering_is_the_way_to_go"
const MAX_GEMINI_THOUGHT_SIGNATURE_LEN = 32 * 1024 * 1024

export type SignatureBlockKind = "unknown" | "gemini_model_part" | "gemini_function_call"

/** `IsGeminiThoughtSignatureBypass`. */
export const isGeminiThoughtSignatureBypass = (raw: string): boolean => {
  const sig = raw.trim()
  return sig === GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR || sig === GEMINI_CONTEXT_ENGINEERING_BYPASS
}

const CACHE_PREFIXES: Readonly<Record<string, string>> = {
  claude: "claude",
  anthropic: "claude",
  cais: "claude",
  "claude-cais": "claude",
  claude_cais: "claude",
  ccmax: "claude",
  "claude-code-max": "claude",
  claude_code_max: "claude",
  gemini: "gemini",
  google: "gemini",
  openai: "gpt",
  gpt: "gpt",
  codex: "gpt",
  swe: "swe",
  sealed: "swe"
}

/** `SplitSignatureProviderPrefix`: this repo's `provider#payload` cache envelope. */
const splitProviderPrefix = (raw: string): { provider: string; unprefixed: string } | undefined => {
  const trimmed = raw.trim()
  const index = trimmed.indexOf("#")
  if (index < 0) return undefined
  const provider = CACHE_PREFIXES[trimmed.slice(0, index).trim().toLowerCase()]
  return provider === undefined ? undefined : { provider, unprefixed: trimmed.slice(index + 1).trim() }
}

/** `SignaturePayloadWithoutProviderPrefix`. */
export const signaturePayloadWithoutProviderPrefix = (raw: string): string =>
  splitProviderPrefix(raw)?.unprefixed ?? raw.trim()

const decodeBase64 = (sig: string): Uint8Array | undefined => {
  if (sig.length > MAX_GEMINI_THOUGHT_SIGNATURE_LEN) return undefined
  const text = sig.replace(/[\r\n]/g, "")
  // StdEncoding requires padding, RawStdEncoding forbids it.
  if (text.includes("=")) {
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={1,2}$/.test(text)) return undefined
  } else if (text.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(text)) {
    return undefined
  }
  try {
    const binary = atob(text)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return undefined
  }
}

const isAsciiUuid = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 36) return false
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (b !== 0x2d) return false
    } else if (!((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46))) {
      return false
    }
  }
  return true
}

/** Tink prefix-type byte of the opaque ciphertext. */
const isLikelyOpaquePayload = (value: Uint8Array): boolean => value.length > 0 && value[0] === 0x01

/** Server-side tool blocks wrap the Tink ciphertext in a protobuf message with a bytes field starting with 0x01. */
const isLikelyToolInvocationPayload = (value: Uint8Array): boolean => {
  if (value.length === 0) return false
  let offset = 0
  let hasTink = false
  while (offset < value.length) {
    const tag = consumeTag(value, offset)
    if (tag === undefined) return false
    offset += tag.length
    switch (tag.type) {
      case WireType.Varint: {
        const v = consumeVarint(value, offset)
        if (v === undefined) return false
        offset += v.length
        break
      }
      case WireType.Bytes: {
        const b = consumeBytes(value, offset)
        if (b === undefined) return false
        offset += b.length
        if (isLikelyOpaquePayload(b.value)) hasTink = true
        break
      }
      case WireType.Fixed32:
      case WireType.Fixed64: {
        const width = consumeFixed(value, offset, tag.type === WireType.Fixed32 ? 4 : 8)
        if (width === undefined) return false
        offset += width
        break
      }
      default:
        return false
    }
  }
  return hasTink && offset === value.length
}

/** `consumeGeminiField2Field1Value`: field 2 (bytes) holding exactly one field-1 (bytes) record. */
const field2Field1Value = (decoded: Uint8Array): Uint8Array | undefined => {
  const tag = consumeTag(decoded, 0)
  if (tag === undefined || tag.num !== 2 || tag.type !== WireType.Bytes) return undefined
  const container = consumeBytes(decoded, tag.length)
  if (container === undefined || tag.length + container.length !== decoded.length) return undefined
  const inner = consumeTag(container.value, 0)
  if (inner === undefined || inner.num !== 1 || inner.type !== WireType.Bytes) return undefined
  const value = consumeBytes(container.value, inner.length)
  if (value === undefined || inner.length + value.length !== container.value.length) return undefined
  return value.value
}

/** `IsValidGeminiThoughtSignature(sig, {RequireKnownEnvelope: true})` (the bypass sentinel is not accepted here). */
const isKnownGeminiEnvelope = (raw: string): boolean => {
  const sig = raw.trim()
  if (sig === "" || isGeminiThoughtSignatureBypass(sig)) return false
  const decoded = decodeBase64(sig)
  if (decoded === undefined || decoded.length === 0) return false
  if (isAsciiUuid(decoded)) return false
  const value = field2Field1Value(decoded)
  if (value === undefined) return false
  return isLikelyOpaquePayload(value) || isAsciiUuid(value) || isLikelyToolInvocationPayload(value)
}

type Detected = "gemini" | "gemini_bypass" | "other"

/** `DetectSignatureProviderForBlock` reduced to "is this a Gemini-replayable signature". */
const detectForGemini = (raw: string): Detected => {
  const sig = raw.trim()
  if (sig === "") return "other"
  const prefixed = splitProviderPrefix(sig)
  if (prefixed !== undefined) {
    if (prefixed.provider !== "gemini" || prefixed.unprefixed.includes("#")) return "other"
    if (isGeminiThoughtSignatureBypass(prefixed.unprefixed)) return "gemini_bypass"
    return isKnownGeminiEnvelope(prefixed.unprefixed) ? "gemini" : "other"
  }
  if (sig.includes("#")) return "other"
  if (isGeminiThoughtSignatureBypass(sig)) return "gemini_bypass"
  return isKnownGeminiEnvelope(sig) ? "gemini" : "other"
}

export interface GeminiSignatureDecision {
  readonly action: "preserve" | "replace_with_gemini_bypass"
  /** Replayable signature (payload without cache prefix) when `action` is `preserve`. */
  readonly normalized: string
}

/** `DecideSignatureCompatibility(Gemini, raw, blockKind)` (every Gemini block kind shares the same outcome). */
export const decideGeminiSignature = (raw: string): GeminiSignatureDecision => {
  if (detectForGemini(raw) !== "other") {
    const payload = signaturePayloadWithoutProviderPrefix(raw)
    if (isGeminiThoughtSignatureBypass(payload) || isKnownGeminiEnvelope(payload)) {
      return { action: "preserve", normalized: payload }
    }
  }
  return { action: "replace_with_gemini_bypass", normalized: "" }
}

/** `CompatibleSignatureForProviderBlock(Gemini, raw, kind)`: the replayable signature, or `undefined`. */
export const compatibleGeminiSignature = (raw: string): string | undefined => {
  const decision = decideGeminiSignature(raw)
  return decision.action === "preserve" && decision.normalized !== "" ? decision.normalized : undefined
}

/** `SignatureProviderFromModelName(model) == SignatureProviderGemini`. */
export const isGeminiSignatureModel = (modelName: string): boolean => {
  const lower = modelName.trim().toLowerCase()
  return !lower.includes("claude") && lower.includes("gemini")
}

/** `sigcompat.MaxGeminiThoughtSignatureLen`. */
export const MAX_GEMINI_SIGNATURE_LEN = MAX_GEMINI_THOUGHT_SIGNATURE_LEN

/** `GeminiReplaySignatureOrBypass`. */
export const geminiReplaySignatureOrBypass = (raw: string): string => {
  const decision = decideGeminiSignature(raw)
  return decision.action === "preserve" && decision.normalized !== ""
    ? decision.normalized
    : GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR
}

const SIGNATURE_PATHS = [
  "thoughtSignature",
  "thought_signature",
  "functionCall.thoughtSignature",
  "functionCall.thought_signature",
  "functionResponse.thoughtSignature",
  "functionResponse.thought_signature",
  "extra_content.google.thought_signature"
] as const

const partThoughtSignature = (part: Json): { raw: string; has: boolean } => {
  for (const path of SIGNATURE_PATHS) {
    const value = get(part, path)
    if (value !== undefined) return { raw: asString(value), has: true }
  }
  return { raw: "", has: false }
}

const hasNormalizedSignature = (part: Json, replay: string): boolean => {
  if (!isJsonObject(part) || part["thoughtSignature"] !== replay) return false
  return SIGNATURE_PATHS.slice(1).every((path) => !exists(part, path))
}

const deleteSignatureFields = (part: Json): void => {
  for (const path of SIGNATURE_PATHS) del(part, path)
}

const hasServerToolBlock = (part: Json): boolean =>
  ["toolCall", "tool_call", "toolResponse", "tool_response"].some((key) => exists(part, key))

/**
 * `SanitizeGeminiRequestThoughtSignatures`: applies the Gemini replay policy in place to `payload[contentsPath]`
 * (`contents` or `request.contents`). Provider signatures stay on their parts, only a missing/incompatible *first*
 * functionCall of a model turn gets the bypass sentinel, sibling calls stay unsigned and functionResponse parts never
 * carry signatures. Returns `payload`.
 */
export const sanitizeGeminiRequestThoughtSignatures = (payload: Json, contentsPath = "contents"): Json => {
  const contents = get(payload, contentsPath.trim() === "" ? "contents" : contentsPath.trim())
  if (!isJsonArray(contents)) return payload
  for (const content of contents) {
    const parts = get(content, "parts")
    if (!isJsonArray(parts)) continue
    const isModelTurn = asString(get(content, "role")) === "model"
    let firstFunctionCallSeen = false
    for (const part of parts) {
      const { raw, has } = partThoughtSignature(part)
      if (exists(part, "functionResponse")) {
        if (has) deleteSignatureFields(part)
        continue
      }
      if (!isModelTurn || hasServerToolBlock(part)) continue
      const hasFunctionCall = exists(part, "functionCall")
      const isFirstFunctionCall = hasFunctionCall && !firstFunctionCallSeen
      if (hasFunctionCall) firstFunctionCallSeen = true
      if (!hasFunctionCall && !has) continue

      const decision = decideGeminiSignature(raw)
      let replay = ""
      if (isFirstFunctionCall) replay = geminiReplaySignatureOrBypass(raw)
      else if (
        has &&
        decision.action === "preserve" &&
        !isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(raw))
      ) {
        replay = decision.normalized
      }
      if (replay !== "") {
        if (!hasNormalizedSignature(part, replay)) {
          deleteSignatureFields(part)
          set(part, "thoughtSignature", replay)
        }
      } else if (has) {
        deleteSignatureFields(part)
      }
    }
  }
  return payload
}
