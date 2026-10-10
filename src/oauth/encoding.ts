/**
 * Encoding and randomness helpers of the OAuth login flows.
 *
 * Go source: internal/misc/oauth.go (`GenerateRandomState`), internal/auth/{claude,codex,devin}/pkce.go, Go's
 * `url.Values.Encode` (sorted keys, `QueryEscape`). Randomness uses WebCrypto, never `Math.random`.
 */
import { sha256Hex as sha256HexFull } from "../hash.ts"

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

export const randomHex = (length: number): string => toHex(randomBytes(length))

/** `base64.RawURLEncoding`: URL-safe alphabet without padding. */
export const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))

/** Lowercase hex of the first `bytes` bytes of SHA-256 (`hex.EncodeToString(digest[:n])`). */
export const sha256Hex = async (text: string, bytes?: number): Promise<string> => {
  const hex = sha256HexFull(text)
  return bytes === undefined ? hex : hex.slice(0, bytes * 2)
}

export interface PkceCodes {
  readonly codeVerifier: string
  readonly codeChallenge: string
}

/** PKCE S256 pair; `entropyBytes` is 96 for Claude/Codex (128 chars) and 64 for Devin. */
export const generatePkce = async (entropyBytes: number): Promise<PkceCodes> => {
  const codeVerifier = base64Url(randomBytes(entropyBytes))
  return { codeVerifier, codeChallenge: base64Url(await sha256(codeVerifier)) }
}

/** `misc.GenerateRandomState`: 16 random bytes as 32 hex characters. */
export const generateState = (): string => randomHex(16)

/** Go `url.QueryEscape`: everything but `A-Za-z0-9-_.~` is percent-encoded and spaces become `+`. */
export const queryEscape = (value: string): string =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+")

/** Go `url.Values.Encode`: keys sorted, `key=value` pairs joined by `&`. */
export const encodeQuery = (params: Readonly<Record<string, string>>): string =>
  Object.keys(params)
    .toSorted()
    .map((key) => `${queryEscape(key)}=${queryEscape(params[key] ?? "")}`)
    .join("&")
