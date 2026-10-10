/**
 * xxHash64 over bytes (pure BigInt implementation; the Claude CCH signature uses seed 0x4D659218E32A3268).
 *
 * Reference: https://github.com/Cyan4973/xxHash (XXH64). Go uses github.com/pierrec/xxHash.
 */
const MASK = (1n << 64n) - 1n
const P1 = 11400714785074694791n
const P2 = 14029467366897019727n
const P3 = 1609587929392839161n
const P4 = 9650029242287828579n
const P5 = 2870177450012600261n

const rotl = (value: bigint, bits: bigint): bigint => ((value << bits) | (value >> (64n - bits))) & MASK
const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK
const round = (acc: bigint, input: bigint): bigint => mul(rotl((acc + mul(input, P2)) & MASK, 31n), P1)
const mergeRound = (acc: bigint, value: bigint): bigint => ((acc ^ round(0n, value)) * P1 + P4) & MASK

export const xxh64 = (input: Uint8Array, seed: bigint): bigint => {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const length = input.length
  let offset = 0
  let hash: bigint
  if (length >= 32) {
    let v1 = (seed + P1 + P2) & MASK
    let v2 = (seed + P2) & MASK
    let v3 = seed
    let v4 = (seed - P1) & MASK
    const limit = length - 32
    while (offset <= limit) {
      v1 = round(v1, view.getBigUint64(offset, true))
      v2 = round(v2, view.getBigUint64(offset + 8, true))
      v3 = round(v3, view.getBigUint64(offset + 16, true))
      v4 = round(v4, view.getBigUint64(offset + 24, true))
      offset += 32
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK
    hash = mergeRound(hash, v1)
    hash = mergeRound(hash, v2)
    hash = mergeRound(hash, v3)
    hash = mergeRound(hash, v4)
  } else {
    hash = (seed + P5) & MASK
  }
  hash = (hash + BigInt(length)) & MASK
  while (offset + 8 <= length) {
    hash ^= round(0n, view.getBigUint64(offset, true))
    hash = (rotl(hash, 27n) * P1 + P4) & MASK
    offset += 8
  }
  if (offset + 4 <= length) {
    hash ^= mul(BigInt(view.getUint32(offset, true)), P1)
    hash = (rotl(hash, 23n) * P2 + P3) & MASK
    offset += 4
  }
  while (offset < length) {
    hash ^= mul(BigInt(input[offset] as number), P5)
    hash = mul(rotl(hash, 11n), P1)
    offset += 1
  }
  hash ^= hash >> 33n
  hash = mul(hash, P2)
  hash ^= hash >> 29n
  hash = mul(hash, P3)
  hash ^= hash >> 32n
  return hash
}
