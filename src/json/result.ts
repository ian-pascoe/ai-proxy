/**
 * gjson `Result` coercions (`String()`, `Int()`, `Float()`, `Bool()`) over parsed values, plus path-key escaping.
 * `undefined` (missing) and `null` behave like gjson's empty/null results.
 */
import type { Json } from "./value.ts";

/** gjson Result.String(): strings as-is, numbers/bools formatted, objects/arrays as JSON, null/missing as "". */
export const asString = (value: Json | undefined): string => {
  if (value === undefined || value === null) return "";

  if (typeof value === "string") return value;

  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";

  if (typeof value === "boolean") return value ? "true" : "false";

  return JSON.stringify(value);
};

/** gjson Result.Float(). */
export const asFloat = (value: Json | undefined): number => {
  if (value === true) return 1;

  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const n = Number.parseFloat(value);

    return Number.isNaN(n) ? 0 : n;
  }

  return 0;
};

/** gjson Result.Int(): numbers are truncated toward zero, strings are parsed as integers (0 on failure). */
export const asInt = (value: Json | undefined): number => {
  if (value === true) return 1;

  if (typeof value === "number") return Math.trunc(value);

  if (typeof value === "string")
    return /^[+-]?\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : 0;

  return 0;
};

/** gjson Result.Bool(): true, non-zero numbers and strings accepted by strconv.ParseBool. */
export const asBool = (value: Json | undefined): boolean => {
  if (value === true) return true;

  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") return ["1", "t", "true"].includes(value.toLowerCase());

  return false;
};

/**
 * gjson.Escape: escapes a single path component so that keys containing `.`, `*`, `?`, `|`, `#`, `@` and so on
 * address themselves literally. Usable for both get and set paths.
 */
export const escapePathKey = (key: string): string => {
  let out = "";

  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0;

    const safe =
      (code >= 97 && code <= 122) || // a-z
      (code >= 65 && code <= 90) || // A-Z
      (code >= 48 && code <= 58) || // 0-9 and ':'
      code <= 32 ||
      code > 126 ||
      ch === "_" ||
      ch === "-";

    out += safe ? ch : `\\${ch}`;
  }

  return out;
};
