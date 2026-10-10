/**
 * Connect-RPC streaming frame reader (`[flag][u32 BE length][payload]`).
 *
 * Go source: internal/runtime/executor/helps/devin_wire.go (`ReadConnectFrame`, `maxConnectFrameSize`,
 * `maxDecompressedFrameSize`). Flag bit 0x01 = gzip payload (decompressed size capped at 64 MiB), bit 0x02 = end-stream
 * trailer; any other flag is an error, as is a frame longer than 16 MiB. gzip uses `DecompressionStream`.
 */
import { CONNECT_FLAG_COMPRESSED } from "./wire.ts";

export const MAX_CONNECT_FRAME_SIZE = 16 * 1024 * 1024;

export const MAX_DECOMPRESSED_FRAME_SIZE = 64 * 1024 * 1024;

export class ConnectFrameError extends Error {
  override readonly name = "ConnectFrameError";
}

export interface ConnectFrame {
  readonly flag: number;
  /** Still gzip-compressed when `flag & 1` (see {@link inflateFrame}). */
  readonly payload: Uint8Array;
}

/** Incremental parser: feed network chunks, get complete frames. */
export class ConnectFrameParser {
  #chunks: Uint8Array[] = [];
  #size = 0;

  /** Bytes of an incomplete trailing frame (non-zero at EOF means the stream was cut). */
  get pending(): number {
    return this.#size;
  }

  #flatten(): Uint8Array {
    if (this.#chunks.length === 1) return this.#chunks[0] as Uint8Array;
    const out = new Uint8Array(this.#size);
    let offset = 0;

    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }

    this.#chunks = [out];

    return out;
  }

  push(chunk: Uint8Array): ConnectFrame[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
    }

    const frames: ConnectFrame[] = [];

    while (this.#size >= 5) {
      const buffer = this.#flatten();
      const flag = buffer[0] as number;

      if (flag !== 0 && flag !== 1 && flag !== 2 && flag !== 3) {
        throw new ConnectFrameError(
          `invalid connect frame flag: 0x${flag.toString(16).padStart(2, "0")}`,
        );
      }

      const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.length).getUint32(
        1,
        false,
      );

      if (length > MAX_CONNECT_FRAME_SIZE) {
        throw new ConnectFrameError(
          `connect frame length ${length} exceeds maximum limit (${MAX_CONNECT_FRAME_SIZE})`,
        );
      }

      if (this.#size < 5 + length) break;
      frames.push({ flag, payload: buffer.subarray(5, 5 + length) });
      const rest = buffer.subarray(5 + length);
      this.#chunks = rest.length > 0 ? [rest] : [];
      this.#size = rest.length;
    }

    return frames;
  }
}

/** Decompresses a gzip frame payload (size-limited). */
export const gunzip = async (payload: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.length;

    if (total > MAX_DECOMPRESSED_FRAME_SIZE) {
      await reader.cancel();
      throw new ConnectFrameError(
        `decompressed frame size exceeds maximum limit (${MAX_DECOMPRESSED_FRAME_SIZE})`,
      );
    }

    parts.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** The frame's plain payload (decompressing when flagged). */
export const inflateFrame = async (frame: ConnectFrame): Promise<Uint8Array> => {
  if ((frame.flag & CONNECT_FLAG_COMPRESSED) === 0) return frame.payload;

  try {
    return await gunzip(frame.payload);
  } catch (error) {
    if (error instanceof ConnectFrameError) throw error;
    throw new ConnectFrameError(
      `decompress gzip connect frame: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
