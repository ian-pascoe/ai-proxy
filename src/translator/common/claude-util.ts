/**
 * Claude naming/schema helpers.
 *
 * Go source: internal/util/claude_tool_id.go, internal/util/claude_schema.go,
 * internal/translator/common/request.go (GenerateClaudeToolCallID), internal/translator/common/file_data.go.
 */
import { createHash } from "node:crypto";
import { type Json, type JsonObject } from "../../json/index.ts";
import { isArr, isObj } from "./gjson.ts";

/** `SanitizeClaudeFunctionName`: `^[a-zA-Z0-9_-]{1,64}$` (non-conforming characters become `_`). */
export const sanitizeClaudeFunctionName = (name: string): string => {
  if (name === "") return "";
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/gu, "_");

  if (sanitized.length > 64) sanitized = sanitized.slice(0, 64);

  return sanitized === "" ? "_" : sanitized;
};

const EMPTY_INPUT_SCHEMA = (): JsonObject => ({ type: "object", properties: {} });

const sortedObject = (value: JsonObject): JsonObject => {
  const out: JsonObject = {};

  for (const key of Object.keys(value).toSorted())
    Object.defineProperty(out, key, {
      value: value[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });

  return out;
};

const schemaObject = (value: Json | undefined): JsonObject => (isObj(value) ? { ...value } : {});

const canBeObject = (schema: JsonObject): boolean => {
  if (!Object.hasOwn(schema, "type")) return true;
  const type = schema.type;

  if (typeof type === "string") return type === "object";

  if (!isArr(type) || !type.every((item) => typeof item === "string")) return false;

  return type.includes("object");
};

const mergeRequired = (root: JsonObject, branchRequired: Json | undefined): void => {
  if (!isArr(branchRequired) || !branchRequired.every((item) => typeof item === "string")) return;
  let required: string[] = [];

  if (isArr(root.required) && root.required.every((item) => typeof item === "string"))
    required = [...root.required];
  const seen = new Set(required);

  for (const name of branchRequired) {
    if (seen.has(name)) continue;
    required.push(name);
    seen.add(name);
  }

  if (required.length > 0) root.required = required;
};

/**
 * `NormalizeClaudeToolInputSchema`: Claude needs an object schema without root-level unions. Go marshals through
 * `map[string]json.RawMessage`, so the root and `properties` keys come out sorted.
 */
export const normalizeClaudeToolInputSchema = (schema: Json | undefined): JsonObject => {
  if (!isObj(schema)) return EMPTY_INPUT_SCHEMA();
  const root: JsonObject = { ...schema };
  const properties = schemaObject(root.properties);

  for (const unionName of ["anyOf", "oneOf", "allOf"]) {
    if (!Object.hasOwn(root, unionName)) continue;
    const union = root[unionName];
    delete root[unionName];

    if (!isArr(union)) continue;

    for (const branch of union) {
      if (!isObj(branch) || !canBeObject(branch)) continue;

      for (const [name, property] of Object.entries(schemaObject(branch.properties))) {
        if (!Object.hasOwn(properties, name)) properties[name] = property;
      }

      if (unionName === "allOf") mergeRequired(root, branch.required);
    }
  }

  root.type = "object";
  root.properties = sortedObject(properties);

  return sortedObject(root);
};

const UNICODE_ESCAPES = new Map([
  ["<", "\\u003c"],
  [">", "\\u003e"],
  ["&", "\\u0026"],
  ["\u2028", "\\u2028"],
  ["\u2029", "\\u2029"],
]);

/** Go `json.Marshal` of a decoded value: sorted object keys and HTML-safe escapes. */
export const goMarshal = (value: Json): string => {
  if (isArr(value)) return `[${value.map(goMarshal).join(",")}]`;

  if (isObj(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${goMarshal(key)}:${goMarshal(value[key] ?? null)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (ch) => UNICODE_ESCAPES.get(ch) ?? ch,
  );
};

const GEMINI_CLAUDE_TOOL_USE_ID_PREFIX = "cpa_gemini_";

/** `GeminiClaudeToolUseID`: stable Claude-facing id for a provider-native Gemini function call. */
export const geminiClaudeToolUseID = (callId: string, name: string, argsRaw: string): string => {
  const call = callId.trim();
  const fn = name.trim();

  if (call === "" || fn === "") return "";
  let args = argsRaw;

  if (args.trim() !== "") {
    try {
      args = goMarshal(JSON.parse(args));
    } catch {
      args = args.trim();
    }
  }

  const digest = createHash("sha256").update([call, fn, args].join("\u0000")).digest("hex");

  return GEMINI_CLAUDE_TOOL_USE_ID_PREFIX + digest.slice(0, 32);
};

/** `IsGeminiClaudeToolUseID`. */
export const isGeminiClaudeToolUseID = (id: string): boolean => {
  const trimmedId = id.trim();

  return (
    trimmedId.startsWith(GEMINI_CLAUDE_TOOL_USE_ID_PREFIX) &&
    /^[0-9a-fA-F]{32}$/.test(trimmedId.slice(GEMINI_CLAUDE_TOOL_USE_ID_PREFIX.length))
  );
};
