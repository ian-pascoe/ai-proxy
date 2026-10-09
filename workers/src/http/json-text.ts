/**
 * JSON text helpers reproducing Go `encoding/json` output where clients can observe it (error bodies, SSE frames).
 *
 * Go source: encoding/json (Marshal HTML-escapes `<`, `>`, `&`, U+2028 and U+2029, and sorts map keys; Compact only
 * strips insignificant whitespace and keeps number text verbatim).
 */

/** `json.Valid`. */
export const isValidJson = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029"
}

/**
 * Applies Go's HTML-safe escaping to JSON text produced by `JSON.stringify`. The escaped characters can only occur
 * inside string literals, so a global replacement is safe.
 */
export const htmlEscapeJson = (json: string): string =>
  json.replace(/[<>&\u2028\u2029]/g, (ch) => HTML_ESCAPES[ch] ?? ch)

/** `json.Marshal` of a struct-like value: field order as given, HTML-safe escaping. */
export const goMarshal = (value: unknown): string => htmlEscapeJson(JSON.stringify(value))

export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).toSorted()) {
      Object.defineProperty(out, key, {
        value: sortKeys((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    return out
  }
  return value
}

/** `json.Marshal` of `map[string]any` values: object keys sorted (recursively), HTML-safe escaping. */
export const goMarshalSorted = (value: unknown): string => goMarshal(sortKeys(value))

/** `json.Compact`: removes whitespace outside string literals, leaving everything else (numbers, escapes) intact. */
export const compactJson = (text: string): string => {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      out += ch
    }
  }
  return out
}
