/**
 * Go `encoding/json.Marshal` over parsed JSON: object keys sorted bytewise, HTML-sensitive characters escaped
 * (`<`, `>`, `&`, U+2028/2029), control characters as `\u00XX`. Session fingerprints and derived identities hash
 * this text, so it has to match what the Go server would have produced for the same value.
 */
import type { Json } from "../json/index.ts"

const HEX = "0123456789abcdef"

const escapeString = (value: string): string => {
  let out = '"'
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    let replacement: string | undefined
    if (code < 0x20 || code === 0x22 || code === 0x5c || code === 0x3c || code === 0x3e || code === 0x26) {
      switch (code) {
        case 0x22:
          replacement = '\\"'
          break
        case 0x5c:
          replacement = "\\\\"
          break
        case 0x08:
          replacement = "\\b"
          break
        case 0x0c:
          replacement = "\\f"
          break
        case 0x0a:
          replacement = "\\n"
          break
        case 0x0d:
          replacement = "\\r"
          break
        case 0x09:
          replacement = "\\t"
          break
        default:
          replacement = `\\u00${HEX[code >> 4]}${HEX[code & 0xf]}`
      }
    } else if (code === 0x2028 || code === 0x2029) {
      replacement = `\\u202${HEX[code & 0xf]}`
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // Lone surrogates are invalid UTF-8 for Go and become U+FFFD.
      const next = value.charCodeAt(index + 1)
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
      replacement = "\\ufffd"
    }
    if (replacement !== undefined) {
      out += value.slice(start, index) + replacement
      start = index + 1
    }
  }
  return `${out}${value.slice(start)}"`
}

/**
 * Bytewise (UTF-8) string order: UTF-16 order differs only when a surrogate pair meets U+E000..U+FFFF, so those
 * ranges are swapped before comparing code units.
 */
export const compareUtf8 = (a: string, b: string): number => {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    let x = a.charCodeAt(index)
    let y = b.charCodeAt(index)
    if (x === y) continue
    if (x >= 0xd800) x += x >= 0xe000 ? -0x800 : 0x2000
    if (y >= 0xd800) y += y >= 0xe000 ? -0x800 : 0x2000
    return x - y
  }
  return a.length - b.length
}

const marshalNumber = (value: number): string => (Object.is(value, -0) ? "-0" : String(value))

export const goMarshal = (value: Json): string => {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return escapeString(value)
    case "number":
      return marshalNumber(value)
    case "boolean":
      return value ? "true" : "false"
    default:
      break
  }
  if (Array.isArray(value)) return `[${value.map((item) => goMarshal(item)).join(",")}]`
  const keys = Object.keys(value).toSorted(compareUtf8)
  return `{${keys.map((key) => `${escapeString(key)}:${goMarshal(value[key] as Json)}`).join(",")}}`
}
