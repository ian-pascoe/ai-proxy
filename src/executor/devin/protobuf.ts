/**
 * Minimal protobuf wire codec for the Devin Connect-RPC messages.
 *
 * Go source: google.golang.org/protobuf/encoding/protowire as used by internal/runtime/executor/helps/devin_wire.go and
 * devin_payload.go. Only what the Devin messages need: varints (non-negative integers up to 2^53), length-delimited
 * bytes/strings, fixed32/fixed64 and field skipping. Unknown fields are skipped by callers, never rejected; groups
 * (wire types 3 and 4) are malformed like in protowire's `ConsumeFieldValue` use here.
 */

export const WireType = { Varint: 0, Fixed64: 1, Bytes: 2, Fixed32: 5 } as const;

export type WireTypeValue = (typeof WireType)[keyof typeof WireType];

export class ProtoError extends Error {
  override readonly name = "ProtoError";
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** Append-only byte buffer with protobuf field writers. */
export class ProtoWriter {
  #buffer = new Uint8Array(256);
  #length = 0;

  #reserve(extra: number): void {
    if (this.#length + extra <= this.#buffer.length) return;
    let size = this.#buffer.length * 2;

    while (size < this.#length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = next;
  }

  #rawVarint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ProtoError(`varint out of range: ${value}`);
    this.#reserve(10);
    let rest = value;

    while (rest >= 0x80) {
      this.#buffer[this.#length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }

    this.#buffer[this.#length++] = rest;
  }

  #tag(field: number, wire: WireTypeValue): void {
    this.#rawVarint(field * 8 + wire);
  }

  #rawBytes(data: Uint8Array): void {
    this.#reserve(data.length);
    this.#buffer.set(data, this.#length);
    this.#length += data.length;
  }

  varint(field: number, value: number): this {
    this.#tag(field, WireType.Varint);
    this.#rawVarint(value);

    return this;
  }

  bytes(field: number, data: Uint8Array): this {
    this.#tag(field, WireType.Bytes);
    this.#rawVarint(data.length);
    this.#rawBytes(data);

    return this;
  }

  string(field: number, text: string): this {
    return this.bytes(field, encoder.encode(text));
  }

  /** `protowire.AppendFixed64(math.Float64bits(value))`. */
  double(field: number, value: number): this {
    this.#tag(field, WireType.Fixed64);
    this.#reserve(8);
    new DataView(this.#buffer.buffer).setFloat64(this.#length, value, true);
    this.#length += 8;

    return this;
  }

  /** Raw fixed32 (used by tests that build `Token Usage` metric messages). */
  float(field: number, value: number): this {
    this.#tag(field, WireType.Fixed32);
    this.#reserve(4);
    new DataView(this.#buffer.buffer).setFloat32(this.#length, value, true);
    this.#length += 4;

    return this;
  }

  /** Copies already encoded fields (opaque pass-through). */
  raw(data: Uint8Array): this {
    this.#rawBytes(data);

    return this;
  }

  toBytes(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

export interface ProtoField {
  readonly num: number;
  readonly wire: WireTypeValue;
  /** Varint value (wire type 0). */
  readonly varint: number;
  /** Payload of length-delimited fields (wire type 2); fixed-width values for 1 and 5. */
  readonly bytes: Uint8Array;
  /** The whole encoded field (tag included), for pass-through. */
  readonly encoded: Uint8Array;
}

interface Varint {
  readonly value: number;
  readonly next: number;
}

const isWireType = (value: number): value is WireTypeValue =>
  value === WireType.Varint ||
  value === WireType.Fixed64 ||
  value === WireType.Bytes ||
  value === WireType.Fixed32;

const readVarint = (data: Uint8Array, start: number): Varint => {
  let value = 0;
  let scale = 1;
  let position = start;

  for (let index = 0; index < 10; index++) {
    const byte = data[position++];

    if (byte === undefined) throw new ProtoError(`truncated varint at offset ${start}`);
    value += (byte & 0x7f) * scale;

    if ((byte & 0x80) === 0) return { value, next: position };
    scale *= 0x80;
  }

  throw new ProtoError(`varint overflow at offset ${start}`);
};

/** Iterates the fields of one message; throws {@link ProtoError} on malformed input. */
export function* readFields(data: Uint8Array): Generator<ProtoField> {
  let position = 0;

  while (position < data.length) {
    const fieldStart = position;
    const tag = readVarint(data, position);
    position = tag.next;
    const num = Math.floor(tag.value / 8);
    const rawWire = tag.value % 8;

    if (num === 0) throw new ProtoError(`invalid field number 0 at offset ${fieldStart}`);

    if (!isWireType(rawWire))
      throw new ProtoError(`unsupported wire type ${String(rawWire)} at offset ${position}`);
    const wire = rawWire;
    let varint = 0;
    let bytes: Uint8Array = new Uint8Array(0);

    switch (wire) {
      case WireType.Varint: {
        const parsed = readVarint(data, position);
        varint = parsed.value;
        position = parsed.next;
        break;
      }

      case WireType.Fixed64:
      case WireType.Fixed32: {
        const size = wire === WireType.Fixed64 ? 8 : 4;

        if (position + size > data.length)
          throw new ProtoError(`truncated fixed value at offset ${position}`);
        bytes = data.subarray(position, position + size);
        position += size;
        break;
      }

      case WireType.Bytes: {
        const length = readVarint(data, position);
        position = length.next;

        if (position + length.value > data.length)
          throw new ProtoError(`truncated bytes at offset ${position}`);
        bytes = data.subarray(position, position + length.value);
        position += length.value;
        break;
      }
    }

    yield { num, wire, varint, bytes, encoded: data.subarray(fieldStart, position) };
  }
}

/** UTF-8 text of a length-delimited field (invalid sequences become U+FFFD like Go's `string(bytes)` on output). */
export const fieldText = (field: ProtoField): string => decoder.decode(field.bytes);

export const fieldDouble = (field: ProtoField): number =>
  new DataView(field.bytes.buffer, field.bytes.byteOffset, 8).getFloat64(0, true);

export const fieldFloat = (field: ProtoField): number =>
  new DataView(field.bytes.buffer, field.bytes.byteOffset, 4).getFloat32(0, true);

export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text);
