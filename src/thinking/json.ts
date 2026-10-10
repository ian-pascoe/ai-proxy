/**
 * Small helpers over `src/json` shared by the thinking modules.
 *
 * Go ignores sjson errors (`result, _ := sjson.SetBytes(...)`); the safe wrappers do the same for path errors so a
 * body of an unexpected shape (e.g. an array root) is left unchanged instead of throwing.
 */
import {
  asString,
  del,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  JsonPathError,
  set,
} from "../json/index.ts";

export const setPath = (root: Json | undefined, path: string, value: Json): Json | undefined => {
  try {
    return set(root, path, value);
  } catch (error) {
    if (error instanceof JsonPathError) return root;
    throw error;
  }
};

export const delPath = (root: Json | undefined, path: string): Json | undefined => {
  try {
    return del(root, path);
  } catch (error) {
    if (error instanceof JsonPathError) return root;
    throw error;
  }
};

export const delPaths = (root: Json | undefined, paths: readonly string[]): Json | undefined => {
  let result = root;

  for (const path of paths) result = delPath(result, path);

  return result;
};

/** `len(body) == 0 || !gjson.ValidBytes(body)` → `{}`. */
export const ensureBody = (body: Json | undefined): Json => (body === undefined ? {} : body);

/** gjson `Result.IsObject() && len(Map()) == 0`. */
export const isEmptyObject = (value: Json | undefined): boolean =>
  isJsonObject(value) && Object.keys(value).length === 0;

/** Removes `path` when it holds an empty object (the "avoid leaving an empty container" idiom). */
export const delIfEmptyObject = (root: Json | undefined, path: string): Json | undefined =>
  isEmptyObject(get(root, path)) ? delPath(root, path) : root;

/** gjson `Get(path).String()`. */
export const getString = (root: Json | undefined, path: string): string =>
  asString(get(root, path));

/** The first path that exists (JSON `null` counts as existing, unlike `??`). */
export const getFirst = (root: Json | undefined, paths: readonly string[]): Json | undefined => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return value;
  }

  return undefined;
};

/** `value.Type == gjson.String` guard returning the string, else undefined. */
export const getStringValue = (root: Json | undefined, path: string): string | undefined => {
  const value = get(root, path);

  return typeof value === "string" ? value : undefined;
};

export const getBool = (root: Json | undefined, path: string): boolean | undefined => {
  const value = get(root, path);

  return typeof value === "boolean" ? value : undefined;
};

export type { JsonObject };

/** Go `strings.ToLower(strings.TrimSpace(s))`. */
export const normalize = (value: string): string => value.trim().toLowerCase();

/** Go `strings.EqualFold`. */
export const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
