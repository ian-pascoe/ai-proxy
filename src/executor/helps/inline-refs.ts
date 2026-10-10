/**
 * Local `$ref` inlining for JSON schemas.
 *
 * Go source: internal/util/gemini_schema.go (InlineLocalRefs, resolveLocalRefs, resolveJSONPointer,
 * cyclicRefFallback, mergeHint). References are resolved against the original schema before definition containers
 * are stripped. Each expansion receives its own copy, sibling keywords override the referenced definition and cycles
 * end as a typed hint instead of recursing. Unlike Go (`json.Marshal` sorts map keys) key order is preserved.
 */
import { isJsonArray, isJsonObject, type Json, type JsonObject } from "../../json/index.ts";

const resolvePointer = (root: Json, ref: string): Json | undefined => {
  let current: Json | undefined = root;

  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");

    if (isJsonObject(current)) {
      if (!Object.hasOwn(current, part)) return undefined;
      current = current[part];
    } else if (isJsonArray(current)) {
      const index = /^-?\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN;

      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      return undefined;
    }
  }

  return current;
};

const refName = (ref: string): string => {
  const index = ref.lastIndexOf("/");

  return index >= 0 && index + 1 < ref.length
    ? ref
        .slice(index + 1)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~")
    : ref;
};

const mergeHint = (existing: string, hint: string): string => {
  if (existing === "") return hint;

  if (existing === hint || existing.startsWith(`${hint} (`) || existing.includes(`(${hint})`))
    return existing;

  return `${existing} (${hint})`;
};

const cyclicFallback = (node: JsonObject, target: Json, ref: string): JsonObject => {
  const out: JsonObject = {};

  if (isJsonObject(target)) {
    for (const key of ["type", "nullable", "description"])
      if (Object.hasOwn(target, key)) out[key] = target[key] as Json;
  }

  for (const [key, value] of Object.entries(node)) if (key !== "$ref") out[key] = value;
  const hint = `See: ${refName(ref)}`;
  out["description"] =
    typeof out["description"] === "string" && out["description"] !== ""
      ? mergeHint(out["description"], hint)
      : hint;

  return out;
};

const resolve = (root: Json, value: Json, active: Set<string>): Json => {
  if (isJsonArray(value)) return value.map((item) => resolve(root, item, active));

  if (!isJsonObject(value)) return value;
  const ref = value["$ref"];

  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = resolvePointer(root, ref);

    if (target !== undefined) {
      if (active.has(ref)) return cyclicFallback(value, target, ref);
      active.add(ref);
      const resolvedTarget = resolve(root, target, active);
      active.delete(ref);

      if (isJsonObject(resolvedTarget)) {
        const out: JsonObject = { ...resolvedTarget };

        for (const [key, item] of Object.entries(value))
          if (key !== "$ref") out[key] = resolve(root, item, active);

        return out;
      }
    }
  }

  const out: JsonObject = {};

  for (const [key, item] of Object.entries(value)) out[key] = resolve(root, item, active);

  return out;
};

/** `InlineLocalRefs`: returns `schema` itself when it contains no `$ref`. */
export const inlineLocalRefs = (schema: Json): Json =>
  JSON.stringify(schema).includes('"$ref"') ? resolve(schema, schema, new Set()) : schema;
