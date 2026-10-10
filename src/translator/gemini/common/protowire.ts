/**
 * Minimal protobuf wire reader (the subset of google.golang.org/protobuf/encoding/protowire that the Gemini
 * thought-signature envelope checks need). All consumers return `undefined` where protowire returns a negative length.
 */

export const WireType = { Varint: 0, Fixed64: 1, Bytes: 2, StartGroup: 3, EndGroup: 4, Fixed32: 5 } as const

const MAX_FIELD_NUMBER = 2 ** 29 - 1

/** Reads a varint at `offset`; returns its value and encoded length. */
export const consumeVarint = (buf: Uint8Array, offset: number): { value: number; length: number } | undefined => {
  let value = 0
  let scale = 1

  for (let i = 0; i < 10; i++) {
    const byte = buf[offset + i]

    if (byte === undefined) return undefined

    if (i === 9 && byte > 1) return undefined
    value += (byte & 0x7f) * scale
    scale *= 128

    if (byte < 0x80) return { value, length: i + 1 }
  }

  return undefined
}

/** `ConsumeTag`: field number, wire type and encoded length. */
export const consumeTag = (
  buf: Uint8Array,
  offset: number
): { num: number; type: number; length: number } | undefined => {
  const tag = consumeVarint(buf, offset)

  if (tag === undefined) return undefined
  const num = Math.floor(tag.value / 8)

  if (num < 1 || num > MAX_FIELD_NUMBER) return undefined

  return { num, type: tag.value % 8, length: tag.length }
}

/** `ConsumeBytes`: the length-delimited payload and the total encoded length. */
export const consumeBytes = (buf: Uint8Array, offset: number): { value: Uint8Array; length: number } | undefined => {
  const size = consumeVarint(buf, offset)

  if (size === undefined) return undefined
  const start = offset + size.length

  if (size.value > buf.length - start) return undefined

  return { value: buf.subarray(start, start + size.value), length: size.length + size.value }
}

/** Length of a fixed-width field at `offset`, or `undefined` when truncated. */
export const consumeFixed = (buf: Uint8Array, offset: number, width: 4 | 8): number | undefined =>
  buf.length - offset >= width ? width : undefined
