/**
 * Reasoning signature checks needed by the Codex translators.
 *
 * Go source: internal/signature/{gpt_validation.go, provider_compatibility.go (CompatibleSignatureForProvider for the
 * GPT target), grok_validation.go, kimi_validation.go (length check)}. Subset: GPT replay validation is exact; the
 * Grok shape check omits the Claude/Gemini envelope probes (Grok replay only applies to `grok*` models).
 */

const B64URL = /^[A-Za-z0-9\-_=]*$/
const B64STD = /^[A-Za-z0-9+/]*$/

const b64Value = (ch: string): number => {
  const code = ch.charCodeAt(0)
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (ch === "-" || ch === "+") return 62
  return 63 // "_" or "/"
}

/** Decoded length and first byte of a base64url string (raw or padded), or `undefined` when it does not decode. */
const decodeBase64UrlHead = (sig: string): { readonly length: number; readonly first: number } | undefined => {
  const pad = sig.indexOf("=")
  let length: number
  if (pad === -1) {
    if (sig.length % 4 === 1) return undefined
    length = Math.floor((sig.length * 3) / 4)
  } else {
    if (sig.length % 4 !== 0) return undefined
    const padding = sig.length - pad
    if (padding > 2 || sig.slice(pad) !== "=".repeat(padding)) return undefined
    length = (sig.length / 4) * 3 - padding
  }
  if (sig.length < 2) return undefined
  return { length, first: (b64Value(sig[0] as string) << 2) | (b64Value(sig[1] as string) >> 4) }
}

const MAX_GPT_SIGNATURE_LEN = 32 * 1024 * 1024

/** `IsValidGPTReasoningSignature`: Fernet-like outer format check of Codex `encrypted_content`. */
export const isValidGptReasoningSignature = (raw: string): boolean => {
  const sig = raw.trim()
  if (sig === "" || sig.length > MAX_GPT_SIGNATURE_LEN) return false
  if (!sig.startsWith("gAAAA") || !B64URL.test(sig)) return false
  const decoded = decodeBase64UrlHead(sig)
  if (decoded === undefined || decoded.length < 73 || decoded.first !== 0x80) return false
  const ciphertext = decoded.length - 1 - 8 - 16 - 32
  return ciphertext > 0 && ciphertext % 16 === 0
}

const GPT_PREFIXES = new Set(["openai", "gpt", "codex"])
const OTHER_PREFIXES = new Set([
  "claude",
  "anthropic",
  "cais",
  "claude-cais",
  "claude_cais",
  "ccmax",
  "claude-code-max",
  "claude_code_max",
  "gemini",
  "google",
  "swe",
  "sealed"
])

/** `SplitSignatureProviderPrefix` for known cache prefixes: `[prefix, payload]` or `undefined`. */
const splitProviderPrefix = (raw: string): readonly [string, string] | undefined => {
  const trimmed = raw.trim()
  const index = trimmed.indexOf("#")
  if (index === -1) return undefined
  const prefix = trimmed.slice(0, index).trim().toLowerCase()
  if (!GPT_PREFIXES.has(prefix) && !OTHER_PREFIXES.has(prefix)) return undefined
  return [prefix, trimmed.slice(index + 1).trim()]
}

/** `CompatibleSignatureForProvider(GPT, raw)`: the replayable payload, or `undefined`. */
export const compatibleGptSignature = (raw: string): string | undefined => {
  const sig = raw.trim()
  if (sig === "") return undefined
  const split = splitProviderPrefix(sig)
  let payload = sig
  if (split !== undefined) {
    if (!GPT_PREFIXES.has(split[0]) || split[1].includes("#")) return undefined
    payload = split[1]
  } else if (sig.includes("#")) {
    return undefined
  }
  return isValidGptReasoningSignature(payload) ? payload : undefined
}

const KIMI_LENGTHS = new Set([12946, 4340])

export const entropyRatio = (bytes: Uint8Array): number => {
  if (bytes.length === 0) return 0
  const counts = Array.from({ length: 256 }, () => 0)
  for (const b of bytes) counts[b] = (counts[b] ?? 0) + 1
  const n = bytes.length
  let entropy = 0
  for (const count of counts) {
    if (count === 0) continue
    const p = count / n
    entropy -= p * Math.log2(p)
  }
  const maxSymbols = Math.min(n, 256)
  return maxSymbols <= 1 ? 0 : entropy / Math.log2(maxSymbols)
}

/** `InspectGrokEncryptedContent` as a boolean replay-safety check (see the module note about omitted probes). */
export const isReplaySafeGrokEncryptedContent = (raw: string): boolean => {
  const sig = raw.trim()
  if (sig === "" || sig.length > 8 * 1024 * 1024 || sig !== raw) return false
  if (sig.includes("=") || !B64STD.test(sig)) return false
  if (splitProviderPrefix(sig) !== undefined) return false
  if (sig.startsWith("gAAAA")) return false
  if (KIMI_LENGTHS.has(sig.length)) return false
  let decoded: Uint8Array
  try {
    const binary = atob(sig)
    decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return false
  }
  return decoded.length >= 32 && entropyRatio(decoded) >= 0.85
}

const CLAUDE_ENVELOPE = /^[ER][A-Za-z0-9+/_-]{40,}={0,2}$/

/**
 * `DetectSignatureProvider(raw) != unknown`: whether `raw` is recognisably another provider's signature (GPT, Claude
 * envelopes, SWE sealed blobs, the Gemini bypass sentinel or a known cache prefix). Structural approximation: the
 * Claude/Gemini protobuf provenance probes of `internal/signature` are replaced by shape checks.
 */
export const isKnownProviderSignature = (raw: string): boolean => {
  const sig = raw.trim()
  if (sig === "") return false
  if (sig === "skip_thought_signature_validator" || sig.startsWith("sealed.v1.")) return true
  const split = splitProviderPrefix(sig)
  if (split !== undefined) return !split[1].includes("#") && split[1] !== ""
  if (sig.includes("#")) return false
  return sig.startsWith("gAAAA") || CLAUDE_ENVELOPE.test(sig)
}
