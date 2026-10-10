/**
 * Strict/lenient standard base64 decoding with Go `encoding/base64` `StdEncoding` semantics (padding required,
 * `\r`/`\n` ignored, `Strict()` additionally rejects non-zero trailing bits).
 *
 * Go source: encoding/base64 as used by internal/signature/claude_validation.go.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

const VALUES = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]))

/** `base64.StdEncoding[.Strict()].DecodeString`; `undefined` on any decoding error. */
export const decodeBase64Std = (input: string, strict = false): Uint8Array | undefined => {
  const text = input.replace(/[\r\n]/g, "")

  if (text.length % 4 !== 0) return undefined
  const padStart = text.indexOf("=")
  const padding = padStart === -1 ? 0 : text.length - padStart

  if (padding > 2 || (padStart !== -1 && text.slice(padStart) !== "=".repeat(padding))) return undefined
  const bodyLength = text.length - padding
  const out = new Uint8Array((text.length / 4) * 3 - padding)
  let outIndex = 0
  let buffer = 0
  let bits = 0

  for (let i = 0; i < bodyLength; i++) {
    const value = VALUES.get(text[i] as string)

    if (value === undefined) return undefined
    buffer = (buffer << 6) | value
    bits += 6

    if (bits >= 8) {
      bits -= 8
      out[outIndex++] = (buffer >> bits) & 0xff
      buffer &= (1 << bits) - 1
    }
  }

  if (strict && buffer !== 0) return undefined

  return out
}

/** `base64.StdEncoding.EncodeToString`. */
export const encodeBase64Std = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  let binary = ""

  for (const byte of data) binary += String.fromCharCode(byte)

  return btoa(binary)
}

/** Decodes bytes as UTF-8 when valid (`utf8.Valid`), otherwise `undefined`. */
export const decodeUtf8Strict = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Latin-1 view of bytes (Go `string(decoded)` on a base64 payload that is itself base64 text). */
export const bytesToBinaryString = (bytes: Uint8Array): string => {
  let out = ""

  for (const byte of bytes) out += String.fromCharCode(byte)

  return out
}

/** `base64.RawStdEncoding.EncodeToString` of UTF-8 text. */
export const encodeBase64Raw = (text: string): string => encodeBase64Std(text).replace(/=+$/, "")

/** `base64.RawStdEncoding.DecodeString` (no padding allowed); `undefined` on error. */
export const decodeBase64Raw = (input: string): Uint8Array | undefined => {
  const text = input.replace(/[\r\n]/g, "")

  if (text.includes("=") || text.length % 4 === 1) return undefined

  return decodeBase64Std(text + "=".repeat((4 - (text.length % 4)) % 4))
}
