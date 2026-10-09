/**
 * Request body decoding (Codex CLI sends zstd-compressed bodies).
 *
 * Go source: sdk/api/handlers/request_body.go (ReadRequestBody). `Content-Encoding` lists are decoded right to left;
 * `identity` is skipped; anything other than `zstd` is rejected. When decoding fails but the raw bytes are valid JSON
 * the raw bytes are used. Workers' `DecompressionStream` has no zstd, so the pure-JS `fzstd` decoder is used.
 */
import { decompress } from "fzstd"
import { isValidJson } from "./json-text.ts"

export class RequestBodyDecodeError extends Error {
  override readonly name = "RequestBodyDecodeError"
}

const decoder = new TextDecoder()

const decodeEncodings = (raw: Uint8Array, encoding: string): Uint8Array => {
  let body = raw
  const parts = encoding.split(",")
  for (let i = parts.length - 1; i >= 0; i--) {
    const enc = (parts[i] as string).trim().toLowerCase()
    if (enc === "" || enc === "identity") continue
    if (enc !== "zstd") throw new RequestBodyDecodeError(`unsupported request content encoding: ${enc}`)
    try {
      body = decompress(body)
    } catch (cause) {
      throw new RequestBodyDecodeError(`failed to decode zstd request body: ${String(cause)}`)
    }
  }
  return body
}

/**
 * Decodes a request body according to its `Content-Encoding` header and returns the text.
 * Throws {@link RequestBodyDecodeError} for unsupported encodings or corrupt data (unless the raw body is JSON).
 */
export const decodeRequestBody = (raw: Uint8Array, contentEncoding: string | undefined): string => {
  const encoding = (contentEncoding ?? "").trim()
  if (encoding === "" || encoding.toLowerCase() === "identity") return decoder.decode(raw)
  try {
    return decoder.decode(decodeEncodings(raw, encoding))
  } catch (error) {
    const text = decoder.decode(raw)
    if (isValidJson(text)) return text
    throw error
  }
}
