// Go-compatible string ordering.

/** Orders strings like Go (`<` on UTF-8 bytes equals code point order). */
export const compareStrings = (a: string, b: string): number => {
  if (a === b) return 0
  const left = Array.from(a)
  const right = Array.from(b)
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const x = (left[index] as string).codePointAt(0) as number
    const y = (right[index] as string).codePointAt(0) as number

    if (x !== y) return x < y ? -1 : 1
  }

  return left.length - right.length
}
