/**
 * Go sources: internal/signature/gpt_validation.go (IsValidGPTReasoningSignature) and the GPT branch of
 * internal/signature/provider_compatibility.go (CompatibleSignatureForProvider with SignatureProviderGPT).
 */

const MAX_GPT_REASONING_SIGNATURE_LEN = 32 * 1024 * 1024

const decodeBase64Url = (sig: string): Uint8Array | undefined => {
  try {
    const std = sig.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "")
    const binary = atob(std)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return undefined
  }
}

/** `IsValidGPTReasoningSignature`: the Fernet-like outer format of Codex `encrypted_content` (shape check only). */
export const isValidGptReasoningSignature = (rawSignature: string): boolean => {
  const sig = rawSignature.trim()
  if (sig === "" || sig.length > MAX_GPT_REASONING_SIGNATURE_LEN) return false
  if (!sig.startsWith("gAAAA")) return false
  if (!/^[A-Za-z0-9\-_=]+$/.test(sig)) return false
  const decoded = decodeBase64Url(sig)
  if (decoded === undefined || decoded.length < 73 || decoded[0] !== 0x80) return false
  const ciphertextLen = decoded.length - 1 - 8 - 16 - 32
  return ciphertextLen > 0 && ciphertextLen % 16 === 0
}

const GPT_PREFIXES = new Set(["openai", "gpt", "codex"])
const OTHER_PREFIXES = new Set([
  "claude", "anthropic", "cais", "claude-cais", "claude_cais", "ccmax", "claude-code-max", "claude_code_max",
  "gemini", "google", "swe", "sealed"
])

/**
 * True when `rawSignature` is replayable as a GPT reasoning signature: either bare or behind the explicit
 * `gpt#`/`openai#`/`codex#` cache prefix (a prefix naming another provider, or a second `#`, is never compatible).
 */
export const isCompatibleGptSignature = (rawSignature: string): boolean => {
  const sig = rawSignature.trim()
  const hash = sig.indexOf("#")
  if (hash < 0) return isValidGptReasoningSignature(sig)
  const prefix = sig.slice(0, hash).trim().toLowerCase()
  if (OTHER_PREFIXES.has(prefix) || !GPT_PREFIXES.has(prefix)) return false
  const rest = sig.slice(hash + 1).trim()
  return !rest.includes("#") && isValidGptReasoningSignature(rest)
}

const GEMINI_BYPASS_SENTINELS = new Set(["skip_thought_signature_validator", "context_engineering_is_the_way_to_go"])
const RECOGNIZED_CACHE_PREFIXES = new Set([...GPT_PREFIXES, "swe", "sealed", "gemini", "google"])

const isRecognizedUnprefixedSignature = (sig: string): boolean =>
  GEMINI_BYPASS_SENTINELS.has(sig) || sig.startsWith("sealed.v1.") || isValidGptReasoningSignature(sig)

/**
 * `signature.IsRecognizedReasoningSignature`, reduced to the families that can be validated without the protobuf
 * envelope parsers: GPT (Fernet shape), SWE (`sealed.v1.`), Gemini bypass sentinels, and the same behind an explicit
 * cache prefix. Claude/Gemini/Kimi/Grok envelope validation is not ported here (it belongs to the Claude and Gemini
 * slices); such signatures are treated as unrecognised and dropped from reasoning items.
 */
export const isRecognizedReasoningSignature = (rawSignature: string): boolean => {
  const sig = rawSignature.trim()
  if (sig === "") return false
  const hash = sig.indexOf("#")
  if (hash < 0) return isRecognizedUnprefixedSignature(sig)
  const prefix = sig.slice(0, hash).trim().toLowerCase()
  if (!RECOGNIZED_CACHE_PREFIXES.has(prefix) && !OTHER_PREFIXES.has(prefix)) return false
  const rest = sig.slice(hash + 1).trim()
  return !rest.includes("#") && isRecognizedUnprefixedSignature(rest)
}
