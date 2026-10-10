/**
 * Bounded zstd decompression of request bodies (Codex CLI sends `Content-Encoding: zstd`).
 *
 * Go source: sdk/api/handlers/request_body.go (decodeZstdRequestBody, unbounded `io.ReadAll`). Workers have a
 * 128 MB isolate memory limit, so the port caps the decoded size: frame headers are checked first (fzstd allocates the
 * declared window up front, up to 2 GiB) and the streaming decoder stops one block past the limit.
 * Frame layout: RFC 8878 §3.1.
 */
import { Decompress } from "fzstd";

/** The decoded body would exceed the limit. */
export class DecodedBodyTooLargeError extends Error {
  override readonly name = "DecodedBodyTooLargeError";
  constructor(readonly limit: number) {
    super(`decoded request body exceeds ${limit} bytes`);
  }
}

/** Largest window the decoder may allocate (independent of the output limit; real encoders use 1-8 MiB). */
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;

const ZSTD_MAGIC = 0xfd2fb528;

const SKIPPABLE_MASK = 0xfffffff0;

const SKIPPABLE_MAGIC = 0x184d2a50;

class Truncated extends Error {}

const u32 = (data: Uint8Array, at: number): number => {
  if (at + 4 > data.length) throw new Truncated();

  return (
    ((data[at] as number) | ((data[at + 1] as number) << 8) | ((data[at + 2] as number) << 16)) +
    (data[at + 3] as number) * 0x1000000
  );
};

/** Little-endian unsigned integer of `size` bytes (<= 8); values beyond 2^53 saturate to Infinity. */
const uint = (data: Uint8Array, at: number, size: number): number => {
  if (at + size > data.length) throw new Truncated();
  let value = 0;

  for (let index = size - 1; index >= 0; index--)
    value = value * 256 + (data[at + index] as number);

  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
};

/**
 * Walks the frames without decoding them and rejects any frame whose declared content size exceeds `limit` or whose
 * window exceeds `max(limit, 32 MiB)`. Malformed or truncated input is left to the decoder, which reports it as
 * corrupt data.
 */
const checkFrameHeaders = (data: Uint8Array, limit: number): void => {
  const maxWindow = Math.max(limit, MAX_WINDOW_BYTES);
  let at = 0;

  try {
    while (at < data.length) {
      const magic = u32(data, at);

      if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
        at += 8 + u32(data, at + 4);
        continue;
      }

      if (magic !== ZSTD_MAGIC) return;
      const descriptor = data[at + 4];

      if (descriptor === undefined) return;
      const singleSegment = (descriptor >> 5) & 1;
      const contentSizeFlag = descriptor >> 6;
      const dictionaryBytes = [0, 1, 2, 4][descriptor & 3] as number;
      let cursor = at + 5;
      let windowSize = 0;

      if (singleSegment === 0) {
        const windowDescriptor = data[cursor];

        if (windowDescriptor === undefined) return;
        const base = 2 ** (10 + (windowDescriptor >> 3));
        windowSize = base + (base / 8) * (windowDescriptor & 7);
        cursor += 1;
      }

      cursor += dictionaryBytes;
      const contentSizeBytes = contentSizeFlag === 0 ? singleSegment : 1 << contentSizeFlag;

      if (contentSizeBytes > 0) {
        const contentSize =
          uint(data, cursor, contentSizeBytes) + (contentSizeBytes === 2 ? 256 : 0);

        if (contentSize > limit) throw new DecodedBodyTooLargeError(limit);

        if (singleSegment === 1) windowSize = contentSize;
      }

      if (windowSize > maxWindow) throw new DecodedBodyTooLargeError(limit);
      cursor += contentSizeBytes;

      // Blocks: 3-byte header (last flag, type, size); RLE blocks carry one byte, raw/compressed ones `size` bytes.
      for (;;) {
        const header = uint(data, cursor, 3);
        const type = (header >> 1) & 3;

        if (type === 3) return;
        cursor += 3 + (type === 1 ? 1 : header >> 3);

        if ((header & 1) === 1) break;
      }

      at = cursor + ((descriptor >> 2) & 1) * 4;
    }
  } catch (error) {
    if (error instanceof Truncated) return;
    throw error;
  }
};

/** Decompresses `data`; throws {@link DecodedBodyTooLargeError} when the output would exceed `limit` bytes. */
export const inflateZstd = (data: Uint8Array, limit: number): Uint8Array => {
  checkFrameHeaders(data, limit);
  const chunks: Uint8Array[] = [];
  let size = 0;

  const decoder = new Decompress((chunk) => {
    size += chunk.length;

    if (size > limit) throw new DecodedBodyTooLargeError(limit);
    chunks.push(chunk);
  });

  decoder.push(data, true);
  const out = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
};
