/**
 * Payload rules over the Devin protobuf business fields.
 *
 * Go source: internal/runtime/executor/helps/devin_payload.go (`devinPayloadFields`, `FinalizeDevinPayload`,
 * `decodeDevinPayload`, `encodeDevinPayload`). The built-in request is decoded to a JSON view of the business fields
 * (system prompt, prompts, completion config, tools, cascade id, model), the user rules run on that view (the last
 * mutation), and only those fields are re-encoded; credentials, device metadata, thread ordinals and flags stay opaque.
 */
import {
  asBool,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  jsonEquals,
  cloneJson,
  parseJsonOrText,
} from "../../json/index.ts";
import {
  fieldDouble,
  fieldText,
  ProtoError,
  ProtoWriter,
  readFields,
  WireType,
  type WireTypeValue,
} from "./protobuf.ts";

interface PayloadField {
  readonly name: string;
  readonly kind: WireTypeValue;
  readonly repeated?: boolean;
  /** Bytes shown as base64. */
  readonly binary?: boolean;
  /** Bytes that hold JSON text (tool parameters). */
  readonly jsonValue?: boolean;
  readonly children?: ReadonlyMap<number, PayloadField>;
}

const fields = (
  entries: ReadonlyArray<readonly [number, PayloadField]>,
): ReadonlyMap<number, PayloadField> => new Map(entries);

const TOOL_CALL_FIELDS = fields([
  [1, { name: "id", kind: WireType.Bytes }],
  [2, { name: "name", kind: WireType.Bytes }],
  [3, { name: "arguments", kind: WireType.Bytes }],
]);

const IMAGE_FIELDS = fields([
  [1, { name: "data", kind: WireType.Bytes }],
  [2, { name: "mime_type", kind: WireType.Bytes }],
]);

const PROMPT_FIELDS = fields([
  [1, { name: "id", kind: WireType.Bytes }],
  [2, { name: "source", kind: WireType.Varint }],
  [3, { name: "content", kind: WireType.Bytes }],
  [6, { name: "tool_calls", kind: WireType.Bytes, repeated: true, children: TOOL_CALL_FIELDS }],
  [7, { name: "tool_call_id", kind: WireType.Bytes }],
  [10, { name: "images", kind: WireType.Bytes, repeated: true, children: IMAGE_FIELDS }],
  [11, { name: "thinking", kind: WireType.Bytes }],
  [12, { name: "signature", kind: WireType.Bytes, binary: true }],
  [18, { name: "signature_type", kind: WireType.Bytes }],
]);

const COMPLETION_FIELDS = fields([
  [1, { name: "enabled", kind: WireType.Varint }],
  [2, { name: "max_tokens", kind: WireType.Varint }],
  [3, { name: "parameter_3", kind: WireType.Varint }],
  [5, { name: "temperature", kind: WireType.Fixed64 }],
  [7, { name: "top_k", kind: WireType.Varint }],
  [8, { name: "top_p", kind: WireType.Fixed64 }],
]);

const TOOL_FIELDS = fields([
  [1, { name: "name", kind: WireType.Bytes }],
  [2, { name: "description", kind: WireType.Bytes }],
  [3, { name: "parameters", kind: WireType.Bytes, jsonValue: true }],
]);

export const DEVIN_PAYLOAD_FIELDS: ReadonlyMap<number, PayloadField> = fields([
  [2, { name: "system_prompt", kind: WireType.Bytes }],
  [3, { name: "prompts", kind: WireType.Bytes, repeated: true, children: PROMPT_FIELDS }],
  [8, { name: "completion_config", kind: WireType.Bytes, children: COMPLETION_FIELDS }],
  [10, { name: "tools", kind: WireType.Bytes, repeated: true, children: TOOL_FIELDS }],
  [16, { name: "cascade_id", kind: WireType.Bytes }],
  [21, { name: "model", kind: WireType.Bytes }],
]);

const toBase64 = (data: Uint8Array): string => {
  let binary = "";

  for (const byte of data) binary += String.fromCharCode(byte);

  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch (cause) {
    throw new ProtoError(`invalid base64: ${String(cause)}`);
  }
};

const sortedObject = (entries: ReadonlyMap<string, Json>): JsonObject => {
  const out: JsonObject = {};

  for (const key of [...entries.keys()].toSorted()) {
    const value = entries.get(key);

    if (value !== undefined) out[key] = value;
  }

  return out;
};

const decode = (wire: Uint8Array, schema: ReadonlyMap<number, PayloadField>): JsonObject => {
  const values = new Map<string, Json>();

  for (const field of readFields(wire)) {
    const known = schema.get(field.num);

    if (known === undefined) continue;
    let value: Json;

    if (field.wire === WireType.Bytes) {
      if (known.children !== undefined) value = decode(field.bytes, known.children);
      else if (known.binary === true) value = toBase64(field.bytes);
      else {
        const text = fieldText(field);

        if (known.jsonValue === true) {
          value = parseJsonOrText(text);
        } else {
          value = text;
        }
      }
    } else if (field.wire === WireType.Varint) {
      value = field.varint;
    } else if (field.wire === WireType.Fixed64) {
      value = fieldDouble(field);
    } else {
      continue;
    }

    if (known.repeated === true) {
      const existing = values.get(known.name);

      if (isJsonArray(existing)) existing.push(value);
      else values.set(known.name, [value]);
    } else {
      values.set(known.name, value);
    }
  }

  return sortedObject(values);
};

const textOf = (item: Json): string =>
  typeof item === "string" ? item : item === null ? "" : JSON.stringify(item);

const encode = (
  writer: ProtoWriter,
  body: Json | undefined,
  schema: ReadonlyMap<number, PayloadField>,
): void => {
  for (let num = 1; num <= 21; num++) {
    const field = schema.get(num);

    if (field === undefined) continue;
    const value = get(body, field.name);

    if (value === undefined || value === null) continue;
    const items = field.repeated === true ? (isJsonArray(value) ? value : []) : [value];

    for (const item of items) {
      switch (field.kind) {
        case WireType.Bytes: {
          if (field.children !== undefined) {
            const child = new ProtoWriter();
            encode(child, item, field.children);
            writer.bytes(num, child.toBytes());
          } else if (field.binary === true) {
            writer.bytes(num, fromBase64(textOf(item)));
          } else if (field.jsonValue === true) {
            writer.bytes(num, new TextEncoder().encode(JSON.stringify(item)));
          } else {
            writer.string(num, textOf(item));
          }

          break;
        }

        case WireType.Varint: {
          const numeric = typeof item === "number" ? item : asBool(item) ? 1 : Number(item);
          writer.varint(num, Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : 0);
          break;
        }

        case WireType.Fixed64:
          writer.double(num, Number(item));
      }
    }
  }
};

/** The JSON view of the business fields of an encoded `GetChatMessageRequest`. */
export const devinPayloadView = (wire: Uint8Array): JsonObject =>
  decode(wire, DEVIN_PAYLOAD_FIELDS);

export interface FinalizedDevinPayload {
  readonly wire: Uint8Array;
  readonly view: Json;
}

/**
 * `FinalizeDevinPayload`: `finalize` receives the view and returns the configured one (mutating in place is fine);
 * an unchanged view keeps the original bytes, otherwise only the business fields are replaced.
 */
export const finalizeDevinPayload = (
  wire: Uint8Array,
  finalize: (view: JsonObject) => Json,
): FinalizedDevinPayload => {
  const view = devinPayloadView(wire);
  const configured = finalize(cloneJson(view));

  if (jsonEquals(configured, view)) return { wire, view: configured };
  const writer = new ProtoWriter();

  // Credentials, device metadata, thread ordinals and protocol flags stay opaque.
  for (const field of readFields(wire))
    if (!DEVIN_PAYLOAD_FIELDS.has(field.num)) writer.raw(field.encoded);
  encode(writer, isJsonObject(configured) ? configured : {}, DEVIN_PAYLOAD_FIELDS);

  return { wire: writer.toBytes(), view: configured };
};

const DEFAULTS_SOURCES: ReadonlyArray<readonly [target: string, sources: ReadonlyArray<string>]> = [
  ["model", ["model"]],
  ["system_prompt", ["system_instruction", "systemInstruction"]],
  ["prompts", ["input"]],
  ["tools", ["tools"]],
  ["cascade_id", ["session_id", "sessionId", "conversation_id", "previous_interaction_id"]],
  [
    "completion_config.max_tokens",
    ["generation_config.max_output_tokens", "generationConfig.max_output_tokens"],
  ],
  [
    "completion_config.temperature",
    ["generation_config.temperature", "generationConfig.temperature", "temperature"],
  ],
  ["completion_config.top_k", ["generation_config.top_k", "generationConfig.top_k"]],
  ["completion_config.top_p", ["generation_config.top_p", "generationConfig.top_p"]],
];

/**
 * `DevinPayloadDefaultsSource`: maps the caller's field presence to the business view so `default` rules can replace
 * built-in values without replacing caller values.
 */
export const devinPayloadDefaultsSource = (native: Json, interactions: Json): JsonObject => {
  const out: JsonObject = {};

  for (const [target, sources] of DEFAULTS_SOURCES) {
    let value: Json | undefined;

    for (const source of sources) {
      value = get(interactions, source);

      if (value !== undefined) break;
    }

    if (value === undefined) continue;

    if (target === "prompts" || target === "tools") value = get(native, target);

    if (value !== undefined) setPath(out, target, cloneJson(value));
  }

  return out;
};

const setPath = (root: JsonObject, path: string, value: Json): void => {
  const parts = path.split(".");
  let node = root;

  for (const part of parts.slice(0, -1)) {
    const next = node[part];

    if (isJsonObject(next)) node = next;
    else {
      const created: JsonObject = {};
      node[part] = created;
      node = created;
    }
  }

  const last = parts.at(-1);

  if (last !== undefined) node[last] = value;
};
