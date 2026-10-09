/**
 * Signature provider detection and compatibility decision table.
 *
 * Go source: internal/signature/provider_compatibility.go (`SignatureProviderFromModelName`,
 * `DetectSignatureProviderForBlock`, `DecideSignatureCompatibility*`, `CompatibleSignatureForProviderBlock`).
 * Claude envelopes are validated by `claude.ts`, Gemini envelopes by `translator/gemini/common/signature.ts`, GPT
 * Fernet payloads by `translator/common/signature.ts`; this module only orders the probes and decides.
 */
import { entropyRatio, isValidGptReasoningSignature } from "../translator/common/signature.ts"
import {
  GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  isGeminiThoughtSignatureBypass,
  isKnownGeminiEnvelope
} from "../translator/gemini/common/signature.ts"
import { decodeBase64Std } from "./base64.ts"
import {
  isValidClaudeCaisSignature,
  isValidClaudeThinkingSignature,
  normalizeClaudeProviderNativeThinkingSignature
} from "./claude.ts"

export type SignatureProvider = "unknown" | "claude" | "gemini" | "gemini_bypass" | "gpt" | "kimi" | "grok" | "swe"
export type SignatureBlockKind =
  "unknown" | "claude_thinking" | "gemini_model_part" | "gemini_function_call" | "gpt_reasoning"
export type SignatureAction =
  "preserve" | "drop_block" | "drop_signature" | "replace_with_gemini_bypass" | "no_compatible_replacement"

export interface SignatureCompatibilityDecision {
  readonly targetProvider: SignatureProvider
  readonly detectedProvider: SignatureProvider
  readonly blockKind: SignatureBlockKind
  readonly compatible: boolean
  readonly action: SignatureAction
  readonly replacementSignature: string
  readonly normalizedSignature: string
}

/** `SignatureProviderFromModelName`. */
export const signatureProviderFromModelName = (modelName: string): SignatureProvider => {
  const lower = modelName.trim().toLowerCase()
  if (lower.includes("claude")) return "claude"
  if (lower.includes("gemini")) return "gemini"
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    lower.includes("codex") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return "gpt"
  }
  if (lower.includes("kimi") || lower.includes("moonshot") || lower.startsWith("k2") || lower.startsWith("k3")) {
    return "kimi"
  }
  if (lower.includes("grok")) return "grok"
  if (lower.includes("swe-")) return "swe"
  return "unknown"
}

/** `SignatureProviderFromCachePrefix`. */
const providerFromCachePrefix = (prefix: string): SignatureProvider => {
  switch (prefix.trim().toLowerCase()) {
    case "claude":
    case "anthropic":
    case "cais":
    case "claude-cais":
    case "claude_cais":
    case "ccmax":
    case "claude-code-max":
    case "claude_code_max":
      return "claude"
    case "gemini":
    case "google":
      return "gemini"
    case "openai":
    case "gpt":
    case "codex":
      return "gpt"
    case "swe":
    case "sealed":
      return "swe"
    default:
      return "unknown"
  }
}

/** `SplitSignatureProviderPrefix`. */
export const splitSignatureProviderPrefix = (
  raw: string
): { readonly provider: SignatureProvider; readonly unprefixed: string } | undefined => {
  const trimmed = raw.trim()
  const index = trimmed.indexOf("#")
  if (index < 0) return undefined
  const provider = providerFromCachePrefix(trimmed.slice(0, index))
  return provider === "unknown" ? undefined : { provider, unprefixed: trimmed.slice(index + 1).trim() }
}

/** `SignaturePayloadWithoutProviderPrefix`. */
export const signaturePayloadWithoutProviderPrefix = (raw: string): string =>
  splitSignatureProviderPrefix(raw)?.unprefixed ?? raw.trim()

const KIMI_LENGTHS = new Set([12946, 4340])
const KIMI_MIN_ENTROPY_RATIO = 0.85

/** `IsValidKimiThinkingSignature`: size, character class and entropy of an unpadded standard base64 blob. */
export const isValidKimiThinkingSignature = (raw: string): boolean => {
  const sig = raw.trim()
  if (sig === "" || sig !== raw || !KIMI_LENGTHS.has(sig.length)) return false
  if (sig.includes("=") || !/^[A-Za-z0-9+/]+$/.test(sig)) return false
  if (splitSignatureProviderPrefix(sig) !== undefined) return false
  if (selfDescribingFirstChar(sig)) {
    if (sig.startsWith("gAAAA")) return false
    if (isValidClaudeCaisSignature(sig)) return false
    if (isValidClaudeThinkingSignature(sig, { strict: true })) return false
    if (isRecognizedGeminiSignature(sig)) return false
  }
  const decoded = decodeBase64Std(sig + "=".repeat((4 - (sig.length % 4)) % 4))
  return decoded !== undefined && entropyRatio(decoded) >= KIMI_MIN_ENTROPY_RATIO
}

const selfDescribingFirstChar = (sig: string): boolean => sig !== "" && "CEQRg".includes(sig[0] as string)

/** `isRecognizedGeminiProviderSignature`. */
const isRecognizedGeminiSignature = (raw: string): boolean =>
  !isValidClaudeCaisSignature(raw) && isKnownGeminiEnvelope(raw)

/** `DetectSignatureProviderForBlock`. */
export const detectSignatureProvider = (raw: string, _blockKind: SignatureBlockKind = "unknown"): SignatureProvider => {
  const sig = raw.trim()
  if (sig === "") return "unknown"
  const prefixed = splitSignatureProviderPrefix(sig)
  if (prefixed !== undefined) {
    // Validators may strip cache prefixes themselves; a second prefix never lets detection disagree with replay.
    if (prefixed.unprefixed.includes("#")) return "unknown"
    switch (prefixed.provider) {
      case "gemini":
        if (isGeminiThoughtSignatureBypass(prefixed.unprefixed)) return "gemini_bypass"
        if (isRecognizedGeminiSignature(prefixed.unprefixed)) return "gemini"
        break
      case "claude":
        if (
          isValidClaudeThinkingSignature(prefixed.unprefixed, { strict: true }) ||
          isValidClaudeCaisSignature(prefixed.unprefixed)
        ) {
          return "claude"
        }
        break
      case "gpt":
        if (isValidGptReasoningSignature(prefixed.unprefixed)) return "gpt"
        break
      case "swe":
        if (prefixed.unprefixed.startsWith("sealed.v1.")) return "swe"
        break
    }
    return "unknown"
  }
  if (sig.includes("#")) return "unknown"
  if (isGeminiThoughtSignatureBypass(sig)) return "gemini_bypass"
  if (sig.startsWith("sealed.v1.")) return "swe"
  if (selfDescribingFirstChar(sig)) {
    if (isValidGptReasoningSignature(sig)) return "gpt"
    if (isValidClaudeCaisSignature(sig)) return "claude"
    if (isValidClaudeThinkingSignature(sig, { strict: true })) return "claude"
    if (isRecognizedGeminiSignature(sig)) return "gemini"
  }
  if (isValidKimiThinkingSignature(sig)) return "kimi"
  return "unknown"
}

const providerMatchesTarget = (target: SignatureProvider, detected: SignatureProvider): boolean => {
  switch (target) {
    case "gemini":
      return detected === "gemini" || detected === "gemini_bypass"
    case "claude":
    case "gpt":
    case "swe":
    case "kimi":
      return detected === target
    default:
      return false
  }
}

/** `normalizeCompatibleSignatureForProvider`: the replayable payload for the target or `""`. */
const normalizeForProvider = (target: SignatureProvider, raw: string): string => {
  const payload = signaturePayloadWithoutProviderPrefix(raw)
  switch (target === "gemini_bypass" ? "gemini" : target) {
    case "claude": {
      if (isValidClaudeCaisSignature(payload)) return payload
      try {
        return normalizeClaudeProviderNativeThinkingSignature(payload)
      } catch {
        return ""
      }
    }
    case "gemini":
      return isGeminiThoughtSignatureBypass(payload) || isRecognizedGeminiSignature(payload) ? payload : ""
    case "gpt":
      return isValidGptReasoningSignature(payload) ? payload : ""
    case "swe":
      return payload.startsWith("sealed.v1.") ? payload : ""
    case "kimi":
      return isValidKimiThinkingSignature(payload) ? payload : ""
    default:
      return ""
  }
}

/** `DecideSignatureCompatibility`: the safe handling policy for replaying a signed block into `targetProvider`. */
export const decideSignatureCompatibility = (
  targetProvider: SignatureProvider,
  raw: string,
  blockKind: SignatureBlockKind = "unknown"
): SignatureCompatibilityDecision => {
  const target: SignatureProvider = targetProvider === "gemini_bypass" ? "gemini" : targetProvider
  const detected = detectSignatureProvider(raw, blockKind)
  const base = { targetProvider: target, detectedProvider: detected, blockKind }
  const none = { replacementSignature: "", normalizedSignature: "" }

  // Recognising a Claude envelope does not authorise a Google transport wrapper on native Claude endpoints.
  if (target === "claude" && detected === "claude" && signaturePayloadWithoutProviderPrefix(raw).startsWith("Q")) {
    return { ...base, ...none, compatible: false, action: "drop_block" }
  }
  if (providerMatchesTarget(target, detected)) {
    const normalized = normalizeForProvider(target, raw)
    if (normalized !== "") {
      return {
        ...base,
        replacementSignature: "",
        normalizedSignature: normalized,
        compatible: true,
        action: "preserve"
      }
    }
  }
  const incompatible = { ...base, compatible: false }
  switch (target) {
    case "gemini":
      if (blockKind === "gemini_function_call" || blockKind === "gemini_model_part" || blockKind === "unknown") {
        return {
          ...incompatible,
          replacementSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR,
          normalizedSignature: "",
          action: "replace_with_gemini_bypass"
        }
      }
      return { ...incompatible, ...none, action: "drop_block" }
    case "kimi":
      // Kimi never reads the field back, so only the signature is dropped.
      return { ...incompatible, ...none, action: "drop_signature" }
    case "claude":
    case "gpt":
    case "swe":
    case "grok":
      return { ...incompatible, ...none, action: "drop_block" }
    default:
      return { ...incompatible, ...none, action: "no_compatible_replacement" }
  }
}

/** `CompatibleSignatureForProviderBlock`. */
export const compatibleSignatureForProvider = (
  targetProvider: SignatureProvider,
  raw: string,
  blockKind: SignatureBlockKind = "unknown"
): string | undefined => {
  const decision = decideSignatureCompatibility(targetProvider, raw, blockKind)
  return decision.compatible && decision.normalizedSignature !== "" ? decision.normalizedSignature : undefined
}
