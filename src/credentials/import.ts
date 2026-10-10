/**
 * Import of Go auth JSON files.
 *
 * Go source: sdk/cliproxy/auth/metadata_keys.go (`NormalizeCredentialMetadata`), internal/watcher/synthesizer/file.go
 * (`synthesizeFileAuths`: skipped files, provider type), sdk/auth/filestore.go. Docs: credentials.md §2-3.
 * A file is one flat JSON object that is kept verbatim as credential metadata (unknown keys are preserved).
 */
import { isJsonObject, type JsonObject } from "../json/index.ts";
import { parseWeightValue } from "./weight.ts";

/** Legacy dashed spellings -> canonical snake_case (`CanonicalCredentialMetadataKey`). */
const KEY_ALIASES = new Map<string, string>([
  ["api-key", "api_key"],
  ["base-url", "base_url"],
  ["disable-cooling", "disable_cooling"],
  ["excluded-models", "excluded_models"],
  ["fingerprint-profile", "fingerprint_profile"],
  ["model-aliases", "model_aliases"],
  ["proxy-url", "proxy_url"],
  ["request-retry", "request_retry"],
  ["request-scoped-errors", "request_scoped_errors"],
  ["tool-prefix-disabled", "tool_prefix_disabled"],
]);

export const canonicalMetadataKey = (key: string): string => KEY_ALIASES.get(key) ?? key;

/** Renames legacy keys in place; an explicitly present canonical key wins. */
export const normalizeCredentialMetadata = (metadata: JsonObject): void => {
  for (const key of Object.keys(metadata)) {
    const canonical = canonicalMetadataKey(key);

    if (canonical === key) continue;

    const value = metadata[key];

    if (value !== undefined && !Object.hasOwn(metadata, canonical)) metadata[canonical] = value;
    delete metadata[key];
  }
};

export type ImportFailureReason =
  | "invalid_name"
  | "invalid_json"
  | "not_object"
  | "empty"
  | "missing_type"
  | "unsupported_type"
  | "invalid_weight";

export type ParsedAuthFile =
  | {
      readonly ok: true;
      readonly id: string;
      readonly provider: string;
      readonly metadata: JsonObject;
    }
  | { readonly ok: false; readonly reason: ImportFailureReason; readonly message: string };

/** Gemini-CLI OAuth was removed upstream: such files are ignored entirely. */
const IGNORED_TYPES = new Set(["gemini", "gemini-cli"]);

const MAX_ID_LENGTH = 256;

/** Credential ids for files are relative paths: no traversal, no empty segments. */
export const normalizeCredentialId = (name: string): string | undefined => {
  const cleaned = name.trim().replace(/\\/g, "/").replace(/^\/+/, "");

  if (cleaned === "" || cleaned.length > MAX_ID_LENGTH) return undefined;
  const segments = cleaned.split("/");

  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return undefined;

  // Control characters would corrupt logs and management output.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) return undefined;

  return cleaned;
};

/**
 * Parses and validates one auth file (`name` is the relative file name, `content` the JSON text or parsed object).
 * Mirrors the Go loader: empty/unparsable files, files without `type` and legacy Gemini files are skipped, and a
 * file with an invalid `weight` is rejected.
 */
export const parseAuthFile = (name: string, content: string | JsonObject): ParsedAuthFile => {
  const id = normalizeCredentialId(name);

  if (id === undefined)
    return { ok: false, reason: "invalid_name", message: "invalid credential file name" };

  let parsed: unknown = content;

  if (typeof content === "string") {
    if (content.trim() === "") return { ok: false, reason: "empty", message: "auth file is empty" };

    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, reason: "invalid_json", message: "auth file is not valid JSON" };
    }
  }

  if (!isJsonObject(parsed))
    return { ok: false, reason: "not_object", message: "auth file must be a JSON object" };
  const metadata = structuredClone(parsed);

  if (Object.keys(metadata).length === 0)
    return { ok: false, reason: "empty", message: "auth file is empty" };
  normalizeCredentialMetadata(metadata);

  if (Object.hasOwn(metadata, "weight")) {
    const weight = parseWeightValue(metadata.weight);

    if (!weight.ok)
      return { ok: false, reason: "invalid_weight", message: `invalid weight: ${weight.message}` };
  }

  const type = typeof metadata.type === "string" ? metadata.type.trim().toLowerCase() : "";

  if (type === "") return { ok: false, reason: "missing_type", message: 'auth file has no "type"' };

  if (IGNORED_TYPES.has(type)) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: `auth type "${type}" is no longer supported`,
    };
  }

  return { ok: true, id, provider: type, metadata };
};
