// Hand-built zstd frames (RFC 8878) for the bounded decoder tests: raw and RLE blocks need no entropy coding.

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const MAX_BLOCK = 128 * 1024

const blockHeader = (type: 0 | 1, size: number, last: boolean): number[] => {
  const header = (size << 3) | (type << 1) | (last ? 1 : 0)
  return [header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]
}

export type Block = { readonly raw: string } | { readonly rle: number; readonly byte: string }

/** One frame with an explicit window descriptor (`2^(10 + exponent)` bytes, no content size, no checksum). */
export const zstdFrame = (blocks: ReadonlyArray<Block>, windowExponent = 13): Uint8Array => {
  const bytes: number[] = [...MAGIC, 0x00, windowExponent << 3]
  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1
    if ("raw" in block) {
      const data = new TextEncoder().encode(block.raw)
      bytes.push(...blockHeader(0, data.length, last), ...data)
    } else {
      bytes.push(...blockHeader(1, block.rle, last), block.byte.charCodeAt(0))
    }
  })
  return Uint8Array.from(bytes)
}

/** A frame (8 MiB window) of RLE blocks expanding to `size` bytes of `a`: about 4 bytes per 128 KiB. */
export const zstdRleBomb = (size: number): Uint8Array => {
  const blocks: Block[] = []
  for (let offset = 0; offset < size; offset += MAX_BLOCK)
    blocks.push({ rle: Math.min(MAX_BLOCK, size - offset), byte: "a" })
  return zstdFrame(blocks)
}

/** A frame header only, declaring a single-segment frame of `contentSize` bytes (8-byte content size field). */
export const zstdDeclaredSizeHeader = (contentSize: number): Uint8Array => {
  const bytes = [...MAGIC, 0xe0]
  let value = contentSize
  for (let index = 0; index < 8; index++) {
    bytes.push(value % 256)
    value = Math.floor(value / 256)
  }
  return Uint8Array.from([...bytes, ...blockHeader(1, 16, true), 0x61])
}

/** A skippable frame (magic 0x184D2A5?) carrying `payload`. */
export const zstdSkippable = (payload: Uint8Array): Uint8Array => {
  const size = payload.length
  return Uint8Array.from([0x50, 0x2a, 0x4d, 0x18, size & 0xff, (size >> 8) & 0xff, 0, 0, ...payload])
}

export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
