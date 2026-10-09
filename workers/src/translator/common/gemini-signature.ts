/**
 * Gemini thoughtSignature replay policy (simplified).
 *
 * Go source: internal/signature/gemini_sanitize.go (`GeminiReplaySignatureOrBypass`).
 * Deviation: the Go package detects Gemini-compatible envelopes inside the signature; here every signature that
 * reaches a Gemini client from a Claude thinking block is replaced by Gemini's bypass sentinel, which is what the
 * Go decision yields for Claude-issued signatures.
 */
export const GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator"

export const geminiReplaySignatureOrBypass = (_rawSignature: string): string => GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR
