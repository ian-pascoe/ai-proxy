/**
 * Small gjson-style readers used by the OpenAI-compatible translators (gjson `Result` helpers over parsed JSON). The
 * helpers shared with the other translators are re-exported from `translator/common/gjson.ts`.
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "../../../json/index.ts";
import { eachValue, isArr, isObj, isStr, str, toArray, trimmed } from "../../common/gjson.ts";

// The shared readers live in `translator/common/gjson.ts`; OpenAI-side modules import them from here too.
export { eachValue, isArr, isObj, isStr, str, toArray, trimmed };

/** `root.Get(path).String()`. */
export const getStr = (root: Json | undefined, path: string): string => asString(get(root, path));

/** `Result.Raw`: the JSON text of a value. */
export const raw = (value: Json | undefined): string =>
  value === undefined ? "" : JSON.stringify(value);

/** `Result.Exists() && Type != Null`. */
export const present = (value: Json | undefined): value is Exclude<Json, null> =>
  value !== undefined && value !== null;

/** `Result.ForEach` over an object: `[key, value]` pairs (arrays yield index keys). */
export const eachEntry = (value: Json | undefined): Array<[string, Json]> => {
  if (isJsonObject(value)) return Object.entries(value);

  if (isJsonArray(value)) return value.map((item, index): [string, Json] => [String(index), item]);

  return [];
};

/** `gjson.Result.Int()` for a path. */
export { asBool, asFloat, asInt } from "../../../json/index.ts";
