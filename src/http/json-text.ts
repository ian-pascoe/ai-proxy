/**
 * JSON text helpers reproducing Go `encoding/json` output where clients can observe it (error bodies, SSE frames).
 *
 * Go source: encoding/json (Marshal HTML-escapes `<`, `>`, `&`, U+2028 and U+2029, and sorts map keys; Compact only
 * strips insignificant whitespace and keeps number text verbatim).
 */

import { isJsonArray, isJsonObject, type Json, type JsonObject } from "../json/index.ts";

/** `json.Valid`. */
export const isValidJson = (text: string): boolean => {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
};

const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["<", "\\u003c"],
  [">", "\\u003e"],
  ["&", "\\u0026"],
  ["\u2028", "\\u2028"],
  ["\u2029", "\\u2029"],
]);

/**
 * Applies Go's HTML-safe escaping to JSON text produced by `JSON.stringify`. The escaped characters can only occur
 * inside string literals, so a global replacement is safe.
 */
export const htmlEscapeJson = (json: string): string =>
  json.replace(/[<>&\u2028\u2029]/g, (ch) => HTML_ESCAPES.get(ch) ?? ch);

/** `json.Marshal` of a struct-like value: field order as given, HTML-safe escaping. */
export const goMarshal = (value: Json): string => htmlEscapeJson(JSON.stringify(value));

export const sortKeys = (value: Json): Json => {
  if (isJsonArray(value)) return value.map(sortKeys);

  if (isJsonObject(value)) {
    const out: JsonObject = {};

    for (const key of Object.keys(value).toSorted()) {
      Object.defineProperty(out, key, {
        value: sortKeys(value[key] ?? null),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return out;
  }

  return value;
};

/** `json.Marshal` of `map[string]any` values: object keys sorted (recursively), HTML-safe escaping. */
export const goMarshalSorted = (value: Json): string => goMarshal(sortKeys(value));

/** `json.Compact`: removes whitespace outside string literals, leaving everything else (numbers, escapes) intact. */
export const compactJson = (text: string): string => {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);

    if (inString) {
      out += ch;

      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      out += ch;
    }
  }

  return out;
};

/**
 * `strconv.FormatFloat(value, 'g', -1, 64)` as used by `fmt` for `%v`: the shortest digits, in exponent form when the
 * decimal exponent is below -4 or at least 6 (`1e+06`, `1.5e-07`), otherwise plain (`123456`, `0.0001`).
 */
const goFloat = (value: number): string => {
  if (Number.isNaN(value)) return "NaN";

  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";

  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa = "", exponentText = "0"] = value.toExponential().split("e");
  const exponent = Number(exponentText);

  if (exponent < -4 || exponent >= 6) {
    const sign = exponent < 0 ? "-" : "+";

    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }

  return String(value);
};

/**
 * `fmt.Sprint` of a value decoded by `encoding/json` into `any`: strings verbatim, `<nil>`, float64 numbers, slices as
 * `[a b]` and maps as `map[k:v]` with sorted keys.
 */
export const goSprint = (value: Json): string => {
  if (value === null) return "<nil>";

  if (typeof value === "string") return value;

  if (typeof value === "number") return goFloat(value);

  if (typeof value === "boolean") return value ? "true" : "false";

  if (isJsonArray(value)) return `[${value.map(goSprint).join(" ")}]`;

  const entries = Object.keys(value)
    .toSorted()
    .map((key) => `${key}:${goSprint(value[key] ?? null)}`);

  return `map[${entries.join(" ")}]`;
};
