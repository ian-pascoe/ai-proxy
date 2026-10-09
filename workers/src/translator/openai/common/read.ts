/**
 * Small gjson-style readers shared by the OpenAI-compatible translators (gjson `Result` helpers over parsed JSON).
 */
import { asString, get, isJsonArray, isJsonObject, type Json, type JsonArray, type JsonObject } from "../../../json/index.ts"

/** `Result.String()` of a path (or of a value). */
export const str = (value: Json | undefined): string => asString(value)

/** `strings.TrimSpace(Result.String())`. */
export const trimmed = (value: Json | undefined): string => asString(value).trim()

/** `root.Get(path).String()`. */
export const getStr = (root: Json | undefined, path: string): string => asString(get(root, path))

/** `Result.Raw`: the JSON text of a value. */
export const raw = (value: Json | undefined): string => (value === undefined ? "" : JSON.stringify(value))

export const isStr = (value: Json | undefined): value is string => typeof value === "string"
export const isObj = (value: Json | undefined): value is JsonObject => isJsonObject(value)
export const isArr = (value: Json | undefined): value is JsonArray => isJsonArray(value)

/** `Result.Exists() && Type != Null`. */
export const present = (value: Json | undefined): value is Exclude<Json, null> => value !== undefined && value !== null

/** `Result.ForEach` values: array items, or object values for objects. */
export const eachValue = (value: Json | undefined): Json[] => {
  if (isJsonArray(value)) return value
  if (isJsonObject(value)) return Object.values(value)
  return []
}

/** `Result.ForEach` over an object: `[key, value]` pairs (arrays yield index keys). */
export const eachEntry = (value: Json | undefined): Array<[string, Json]> => {
  if (isJsonObject(value)) return Object.entries(value)
  if (isJsonArray(value)) return value.map((item, index) => [String(index), item] as [string, Json])
  return []
}

/** `Result.Array()`: array items; a scalar/object becomes one item; missing/null becomes empty. */
export const toArray = (value: Json | undefined): Json[] => {
  if (value === undefined || value === null) return []
  return isJsonArray(value) ? value : [value]
}

/** `gjson.Result.Int()` for a path. */
export { asBool, asFloat, asInt } from "../../../json/index.ts"
