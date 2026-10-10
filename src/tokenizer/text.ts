/** Go `strings.TrimSpace` (`unicode.IsSpace`): differs from `String.prototype.trim` for U+0085 and U+FEFF. */
const GO_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"

const leading = new RegExp(`^[${GO_SPACE}]+`, "u")

const trailing = new RegExp(`[${GO_SPACE}]+$`, "u")

export const goTrimSpace = (text: string): string => text.replace(leading, "").replace(trailing, "")

/** Source of the regex character class equal to Go regexp2's `\s` (`unicode.IsSpace`; JS `\s` adds U+FEFF). */
export const GO_SPACE_CLASS = GO_SPACE

/** {@link GO_SPACE_CLASS} without `\r` and `\n`. */
export const GO_SPACE_NO_NEWLINE_CLASS =
  "\\t\\v\\f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
