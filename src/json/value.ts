/**
 * JSON value model shared by the path engine, translators, thinking appliers and payload rules.
 *
 * Values are plain `JSON.parse` output. Go works on raw bytes (tidwall/gjson + sjson); the Workers port
 * works on the parsed tree instead. Known differences:
 *  - object key order is insertion order, except that integer-like keys ("0", "12") are always enumerated first
 *    in ascending order by the JS engine;
 *  - numbers are IEEE doubles (integers beyond 2^53 lose precision) and raw number text such as `1.0` is not kept.
 */
export type JsonPrimitive = null | boolean | number | string
export type JsonArray = Json[]
export interface JsonObject {
  [key: string]: Json
}
export type Json = JsonPrimitive | JsonArray | JsonObject

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isJsonArray = (value: unknown): value is JsonArray => Array.isArray(value)

export const isJsonContainer = (value: unknown): value is JsonObject | JsonArray =>
  typeof value === "object" && value !== null

/** Deep copy of a JSON value (use before inserting shared values such as config params into a payload). */
export const cloneJson = <T extends Json>(value: T): T => structuredClone(value)

/** Structural equality with JSON semantics (key order is irrelevant, numbers compare by value). */
export const jsonEquals = (a: Json | undefined, b: Json | undefined): boolean => {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonEquals(item, b[index]))
  }
  if (isJsonObject(a)) {
    if (!isJsonObject(b)) return false
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => Object.hasOwn(b, key) && jsonEquals(a[key], b[key]))
  }
  return false
}

/** Sets an own property, also for the `__proto__` key which plain assignment would turn into a prototype change. */
export const setOwn = (target: JsonObject, key: string, value: Json): void => {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    target[key] = value
  }
}

/** Parses JSON text, returning `undefined` when it is not valid JSON (gjson.Valid semantics). */
export const tryParseJson = (text: string): Json | undefined => {
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}
