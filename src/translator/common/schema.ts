/**
 * JSON Schema keyword tables and regex-escape checks shared by translators.
 *
 * Go source: internal/util/claude_schema.go (SchemaMapKeywords, SchemaValueKeywords,
 * HasUnsupportedUnicodePropertyEscape).
 */

/** Keywords whose values are maps of subschemas. */
export const SCHEMA_MAP_KEYWORDS: readonly string[] = [
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
  "dependencies"
]

/** Keywords with a single nested subschema or a list of subschemas. */
export const SCHEMA_VALUE_KEYWORDS: readonly string[] = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
  "contentSchema",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else"
]

/** `HasUnsupportedUnicodePropertyEscape`: `\p{..}`/`\P{..}` and the octal NUL escape `\0`. */
export const hasUnsupportedUnicodePropertyEscape = (pattern: string): boolean => {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue

    if (i + 1 >= pattern.length) break
    const next = pattern[i + 1]

    if ((next === "p" || next === "P") && i + 2 < pattern.length && pattern[i + 2] === "{") return true

    if (next === "0") return true
    i++ // skip the escaped character (including an escaped backslash)
  }

  return false
}
