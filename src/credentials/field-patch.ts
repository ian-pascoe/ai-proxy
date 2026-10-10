/**
 * Dotted-path edits of an auth file (`PATCH /v8/management/credentials/fields`).
 *
 * Go source: internal/api/handlers/management/auth_files_fields.go (`PatchAuthFileFields`,
 * `normalizeAuthFilePatchFields`, `decodeAuthFileRequestRetryPatch`, `setAuthFileMetadataValue`,
 * `applyAuthFileHeadersPatch`). The patch is applied to a copy of the stored metadata; `null` deletes a field.
 * Differences: token lifecycle keys, `type` and `disabled` are rejected (they have dedicated endpoints and must not
 * be forged through a settings editor).
 */
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import { canonicalMetadataKey } from "./import.ts";
import { isTokenPayloadKey } from "./merge.ts";
import { parseWeightValue } from "./weight.ts";

export type FieldPatchResult =
  | { readonly ok: true; readonly metadata: JsonObject }
  | { readonly ok: false; readonly message: string };

const PROTECTED_ROOTS = new Set([
  "type",
  "disabled",
  "api_key",
  "dca_token",
  "dca_expired",
  "dca_expires_at",
]);

const rootOf = (path: string): string => {
  const dot = path.indexOf(".");

  return (dot < 0 ? path : path.slice(0, dot)).trim();
};

/** Canonical (snake_case) spelling of the root segment; every segment is trimmed. */
const normalizePath = (key: string): string => {
  const parts = key
    .trim()
    .split(".")
    .map((part) => part.trim());

  parts[0] = canonicalMetadataKey(parts[0] ?? "");

  return parts.join(".");
};

const setAt = (metadata: JsonObject, path: string, value: Json): string | undefined => {
  const parts = path.split(".").map((part) => part.trim());

  if (parts.some((part) => part === "")) return `invalid field path: ${path}`;
  let current = metadata;

  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      if (value === null) delete current[part];
      else current[part] = value;

      return undefined;
    }

    const next = current[part];

    if (isJsonObject(next)) {
      current = next;
    } else {
      if (value === null) return undefined;
      const created: JsonObject = {};
      current[part] = created;
      current = created;
    }
  }

  return undefined;
};

/** `applyAuthFileHeadersPatch`: a string map merges (empty values delete); anything else replaces. */
const patchHeaders = (metadata: JsonObject, value: Json): void => {
  if (!isJsonObject(value) || !Object.values(value).every((item) => typeof item === "string")) {
    if (value === null) delete metadata.headers;
    else metadata.headers = value;

    return;
  }

  const next: Record<string, string> = {};

  if (isJsonObject(metadata.headers)) {
    for (const [key, item] of Object.entries(metadata.headers)) {
      if (typeof item === "string" && key.trim() !== "" && item.trim() !== "")
        next[key.trim()] = item.trim();
    }
  }

  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();

    if (name === "" || typeof item !== "string") continue;

    if (item.trim() === "") delete next[name];
    else next[name] = item.trim();
  }

  if (Object.keys(next).length === 0) delete metadata.headers;
  else metadata.headers = next;
};

/**
 * Applies `fields` (request body without `name`) to `existing` and returns the new metadata.
 * Validation messages are the Go error strings.
 */
export const applyFieldPatch = (
  existing: JsonObject,
  fields: Readonly<Record<string, Json>>,
): FieldPatchResult => {
  const metadata = structuredClone(existing);
  const normalized = new Map<string, Json>();
  const spelled = new Map<string, string>();

  for (const [key, value] of Object.entries(fields)) {
    if (key.trim() === "") return { ok: false, message: "field name is required" };
    const path = normalizePath(key);
    const previous = spelled.get(path);

    if (previous !== undefined) {
      return {
        ok: false,
        message: `auth file fields "${previous}" and "${key}" refer to the same field`,
      };
    }

    spelled.set(path, key);
    normalized.set(path, value);
  }

  if (normalized.size === 0) return { ok: false, message: "no fields to update" };

  for (const [path, value] of normalized) {
    const root = rootOf(path);

    if (PROTECTED_ROOTS.has(root) || isTokenPayloadKey(root))
      return { ok: false, message: `invalid field ${path}` };

    if (root === "request_retry") {
      if (path !== root)
        return { ok: false, message: "request_retry does not support nested fields" };

      if (value === null) {
        delete metadata.request_retry;
      } else if (typeof value === "number" && Number.isSafeInteger(value)) {
        // Negative values mean "no override" in Go.
        if (value < 0) delete metadata.request_retry;
        else metadata.request_retry = value;
      } else {
        return { ok: false, message: "request_retry must be an integer or null" };
      }
    } else if (path === "weight") {
      if (value === null) {
        delete metadata.weight;
      } else {
        if (typeof value !== "number") return { ok: false, message: "weight must be an integer" };
        const weight = parseWeightValue(value);

        if (!weight.ok) return { ok: false, message: weight.message };
        metadata.weight = weight.value;
      }
    } else if (root === "weight") {
      return { ok: false, message: "weight does not support nested fields" };
    } else if (path === "headers") {
      patchHeaders(metadata, value);
    } else {
      const error = setAt(metadata, path, value);

      if (error !== undefined) return { ok: false, message: error };
    }
  }

  return { ok: true, metadata };
};
