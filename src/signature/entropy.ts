/**
 * Byte entropy ratio used by the opaque-blob validators (Kimi, Grok).
 *
 * Go source: internal/signature/grok_validation.go (`byteEntropyRatio`).
 */
/** `byteEntropyRatio`: Shannon entropy against the sample-size ceiling. */
export const entropyRatio = (bytes: Uint8Array): number => {
  if (bytes.length === 0) return 0
  const counts = Array.from({ length: 256 }, () => 0)
  for (const byte of bytes) counts[byte] = (counts[byte] as number) + 1
  const n = bytes.length
  let entropy = 0
  for (const count of counts) {
    if (count === 0) continue
    const p = count / n
    entropy -= p * Math.log2(p)
  }
  const maxSymbols = Math.min(n, 256)
  return maxSymbols <= 1 ? 0 : entropy / Math.log2(maxSymbols)
}
