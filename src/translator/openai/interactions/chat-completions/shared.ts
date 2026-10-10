/**
 * Helpers shared by the Interactions <-> OpenAI Chat Completions translators.
 *
 * Go sources: internal/translator/openai/interactions/chat-completions/{interactions_openai_request.go,
 * interactions_openai_response.go,openai_interactions_request.go} (helper functions).
 */
import {
  cloneJson,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
} from "../../../../json/index.ts";
import { antigravityToolNameToUpstream } from "../../common/antigravity-tools.ts";
import { getStr, isArr, raw, str } from "../../common/read.ts";

/** `firstNonEmpty`: the first value whose trimmed text is not empty (returned untrimmed). */
export const firstNonEmpty = (...values: readonly string[]): string => {
  for (const value of values) if (value.trim() !== "") return value;

  return "";
};

/** `firstExisting`. */
export const firstExisting = (...values: ReadonlyArray<Json | undefined>): Json | undefined => {
  for (const value of values) if (value !== undefined) return value;

  return undefined;
};

/** `jsonStringValue`: strings as-is, other JSON as its raw text, `fallback` when missing. */
export const jsonStringValue = (value: Json | undefined, fallback: string): string => {
  if (value === undefined) return fallback;

  return typeof value === "string" ? value : raw(value);
};

/** `isAntigravityModel`. */
export const isAntigravityModel = (model: string): boolean =>
  model.toLowerCase().includes("antigravity");

/** `interactionsText`. */
export const interactionsText = (value: Json | undefined): string => {
  if (value === undefined) return "";

  if (typeof value === "string") return value;
  const text = get(value, "text");

  if (text !== undefined) return str(text);

  for (const path of ["content", "parts"]) {
    const parts = get(value, path);

    if (!isArr(parts)) continue;
    let out = "";

    for (const part of parts)
      out += firstNonEmpty(getStr(part, "text"), getStr(part, "content.text"));

    return out;
  }

  return "";
};

/** `openAIReasoningTexts`. */
export const openAIReasoningTexts = (reasoning: Json | undefined): string[] => {
  if (typeof reasoning === "string") return reasoning === "" ? [] : [reasoning];
  const texts: string[] = [];

  if (isArr(reasoning)) {
    for (const item of reasoning) {
      const text = firstNonEmpty(getStr(item, "text"), getStr(item, "content"));

      if (text !== "") texts.push(text);
    }
  }

  return texts;
};

/** `interactionsTextStep`. */
export const interactionsTextStep = (stepType: string, text: string): JsonObject => ({
  type: stepType,
  content: [{ type: "text", text }],
});

/**
 * `setRawJSONValue`: `value` as a JSON value: JSON strings holding valid JSON are parsed, other strings stay strings,
 * missing values become `fallback`.
 */
export const rawJsonValue = (value: Json | undefined, fallback: Json): Json => {
  if (value === undefined) return cloneJson(fallback);

  if (typeof value === "string") {
    try {
      return JSON.parse(value.trim());
    } catch {
      return value;
    }
  }

  return cloneJson(value);
};

/** `openAIToolCallToInteractionsStep`. */
export const openAIToolCallToInteractionsStep = (
  toolCall: Json,
  forAntigravity: boolean,
): JsonObject | undefined => {
  const toolType = getStr(toolCall, "type");

  if (toolType !== "" && toolType !== "function") return undefined;
  const fn = get(toolCall, "function");

  if (fn === undefined) return undefined;
  const step: JsonObject = { type: "function_call", name: "", arguments: {} };
  const id = getStr(toolCall, "id");

  if (id !== "") step.id = id;
  let name = getStr(fn, "name");

  if (forAntigravity) name = antigravityToolNameToUpstream(name);
  step.name = name;
  step.arguments = rawJsonValue(get(fn, "arguments"), {});

  return step;
};

/** `setInteractionsUsageFromOpenAIChat` (mutates `out`; `path` is a top-level key or `interaction.usage`). */
export const setInteractionsUsageFromOpenAIChat = (
  out: JsonObject,
  path: string,
  usage: Json | undefined,
): JsonObject => {
  if (usage === undefined) return out;

  const target = (): JsonObject => {
    let node = out;

    for (const part of path.split(".")) {
      const next = node[part];

      if (isJsonObject(next)) node = next;
      else {
        const created: JsonObject = {};
        node[part] = created;
        node = created;
      }
    }

    return node;
  };

  const setInt = (key: string, value: Json | undefined, ...extra: string[]): void => {
    if (value === undefined) return;
    const n = typeof value === "number" ? Math.trunc(value) : intOf(value);
    const t = target();
    t[key] = n;

    for (const e of extra) t[e] = n;
  };

  setInt("input_tokens", get(usage, "prompt_tokens"), "total_input_tokens");
  setInt("output_tokens", get(usage, "completion_tokens"), "total_output_tokens");
  setInt("total_tokens", get(usage, "total_tokens"));
  setInt("cached_tokens", get(usage, "prompt_tokens_details.cached_tokens"), "total_cached_tokens");
  setInt(
    "reasoning_tokens",
    get(usage, "completion_tokens_details.reasoning_tokens"),
    "total_thought_tokens",
  );

  return out;
};

const intOf = (value: Json): number => {
  if (value === true) return 1;

  if (typeof value === "string")
    return /^[+-]?\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : 0;

  return 0;
};

/** `openAIChatSSEPayload` / `openAIChatInteractionsPayload`: the data payload of one stream line. */
export const ssePayloadOf = (rawLine: string): string => {
  const trimmed = rawLine.trim();

  if (trimmed === "" || trimmed === "[DONE]") return trimmed;

  if (trimmed.startsWith("data:")) return trimmed.slice("data:".length).trim();
  const dataLines: string[] = [];

  for (const line of trimmed.split("\n")) {
    const t = line.trim();

    if (t.startsWith("data:")) dataLines.push(t.slice("data:".length).trim());
  }

  return dataLines.length > 0 ? dataLines.join("\n") : trimmed;
};

/** Parses JSON text; invalid text becomes `undefined` (gjson `Exists()` false for the root). */
export const parseJsonOrUndefined = (text: string): Json | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const openAIInputAudioFormatFromMime = (mimeType: string): string => {
  switch (mimeType.trim().toLowerCase()) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/opus":
    case "audio/ogg":
      return "opus";
    case "audio/pcm":
    case "audio/l16":
      return "pcm16";
    default:
      return "mp3";
  }
};

/** `openAIFileNameFromMIME` of the Interactions package (suffix based names). */
export const interactionsFileNameFromMime = (mimeType: string): string => {
  switch (mimeType.trim().toLowerCase()) {
    case "application/pdf":
      return "document.pdf";
    case "text/plain":
      return "document.txt";
    case "text/csv":
      return "document.csv";
    case "application/json":
      return "document.json";
    default: {
      const slash = mimeType.indexOf("/");

      if (slash >= 0 && slash + 1 < mimeType.length)
        return `document.${mimeType.slice(slash + 1).replaceAll("+", ".")}`;

      return "document.bin";
    }
  }
};

export const openAIInputAudioMimeType = (format: string): string => {
  switch (format.trim().toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/opus";
    case "pcm16":
      return "audio/pcm";
    default:
      return "audio/mpeg";
  }
};
