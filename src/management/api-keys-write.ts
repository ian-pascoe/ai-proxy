/**
 * Pure edits of the stored config document behind the API keys page writes (`PUT|DELETE /api-keys/groups`) and the
 * per-key disable toggle (`PATCH /credentials/status`). They work on a private copy of the JSON document
 * (`config-document.ts` conventions) and never see a secret the caller did not already hold:
 *
 * - a key in a written group is `auth_index` (keep the stored secret) and/or `api-key` (new secret);
 * - settings the panel never sees (`proxy-url`, `experimental-cch-signing`) and header values it only knows as
 *   `[redacted]…` placeholders are restored from the stored entry, so a write is lossless;
 * - an unknown `auth_index` is a conflict (the key changed identity or is gone since the list was read).
 *
 * The config normaliser drops groups and keys silently (codex without base-url, duplicates, ...); `checkSurvival`
 * compares the normalised result with what was asked for so the write can be refused with the reason instead.
 */
import { isJsonObject, jsonEquals, type Json, type JsonObject } from "../json/index.ts";
import { authIndexOf } from "./auth-index.ts";
import type { ConfigKeyIds, GroupKeyIds } from "./config-document.ts";
import { type ApiKeyFamily, REDACTED_PREFIX } from "./contract/api-keys.ts";

export interface EditFailure {
  readonly ok: false;
  readonly status: 404 | 409 | 422;
  /** The error text answered to the panel (the reason for a 422). */
  readonly error: string;
}

export type Edit<A> = { readonly ok: true; readonly value: A } | EditFailure;

const fail = (status: EditFailure["status"], error: string): EditFailure => ({
  ok: false,
  status,
  error,
});

const succeed = <A>(value: A): Edit<A> => ({ ok: true, value });

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** Settings of a key that do nothing on Workers and are never shown: carried over when a write omits them. */
const HIDDEN_KEY_FIELDS: Readonly<Record<"standard" | "compat", ReadonlyArray<string>>> = {
  standard: ["proxy-url", "experimental-cch-signing"],
  compat: ["proxy-url"],
};

const HIDDEN_GROUP_FIELDS: Readonly<Record<"standard" | "compat", ReadonlyArray<string>>> = {
  standard: ["proxy-url"],
  compat: [],
};

const groupsOf = (document: JsonObject, family: ApiKeyFamily): JsonObject[] => {
  const apiKeys = document["api-keys"];
  const groups = isJsonObject(apiKeys) ? apiKeys[family] : undefined;

  return Array.isArray(groups) ? groups.filter(isJsonObject) : [];
};

const keysOf = (group: JsonObject): JsonObject[] =>
  Array.isArray(group.keys) ? group.keys.filter(isJsonObject) : [];

interface StoredKey {
  readonly group: JsonObject;
  readonly key: JsonObject;
}

/** The stored key whose credential has `authIndex` (searched through the whole family). */
const findStoredKey = (
  groups: ReadonlyArray<JsonObject>,
  ids: ReadonlyArray<GroupKeyIds>,
  authIndex: string,
): StoredKey | undefined => {
  for (const [groupIndex, group] of groups.entries()) {
    for (const [keyIndex, key] of keysOf(group).entries()) {
      const id = ids[groupIndex]?.keys[keyIndex];

      if (id !== undefined && authIndexOf(id) === authIndex) return { group, key };
    }
  }

  return undefined;
};

/** Header values that are still the masked placeholder take the stored value of the same header. */
const restoreHeaders = (
  headers: Json | undefined,
  stored: Json | undefined,
): Edit<Json | undefined> => {
  if (!isJsonObject(headers)) return succeed(headers);
  const out: JsonObject = {};

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.startsWith(REDACTED_PREFIX)) {
      const original = isJsonObject(stored) ? stored[name] : undefined;

      if (typeof original !== "string")
        return fail(422, `header ${name} carries a masked value and no stored value to keep`);
      out[name] = original;
    } else {
      out[name] = value;
    }
  }

  return succeed(out);
};

const carryOver = (
  out: JsonObject,
  input: JsonObject,
  stored: JsonObject | undefined,
  fields: ReadonlyArray<string>,
): void => {
  if (stored === undefined) return;

  for (const field of fields) {
    const value = stored[field];

    if (!Object.hasOwn(input, field) && value !== undefined) out[field] = value;
  }
};

const resolveKey = (
  input: JsonObject,
  compat: boolean,
  groups: ReadonlyArray<JsonObject>,
  ids: ReadonlyArray<GroupKeyIds>,
): Edit<JsonObject> => {
  const authIndex = text(input.auth_index);
  const stored = authIndex === "" ? undefined : findStoredKey(groups, ids, authIndex);

  if (authIndex !== "" && stored === undefined) return fail(409, "unknown_auth_index");
  const supplied = input["api-key"];

  if (typeof supplied !== "string" && stored === undefined)
    return fail(422, "every key needs an api-key or an auth_index");

  const { auth_index: _authIndex, "api-key": _apiKey, ...rest } = input;
  const secret = typeof supplied === "string" ? supplied : (stored?.key["api-key"] ?? "");
  const out: JsonObject = { "api-key": secret, ...rest };
  carryOver(out, input, stored?.key, HIDDEN_KEY_FIELDS[compat ? "compat" : "standard"]);
  const headers = restoreHeaders(out.headers, stored?.key.headers);

  if (!headers.ok) return headers;

  if (headers.value !== undefined) out.headers = headers.value;

  return succeed(out);
};

const resolveGroup = (
  document: JsonObject,
  ids: ReadonlyArray<GroupKeyIds>,
  family: ApiKeyFamily,
  index: number | undefined,
  input: JsonObject,
): Edit<JsonObject> => {
  const groups = groupsOf(document, family);
  const existing = index === undefined ? undefined : groups[index];

  if (index !== undefined && existing === undefined) return fail(404, "group not found");
  const compat = family === "openai-compatibility";
  const { keys, ...rest } = input;
  const out: JsonObject = { ...rest };
  carryOver(out, input, existing, HIDDEN_GROUP_FIELDS[compat ? "compat" : "standard"]);
  const headers = restoreHeaders(out.headers, existing?.headers);

  if (!headers.ok) return headers;

  if (headers.value !== undefined) out.headers = headers.value;
  const resolved: JsonObject[] = [];

  for (const key of Array.isArray(keys) ? keys : []) {
    if (!isJsonObject(key)) return fail(422, "every key must be an object");
    const result = resolveKey(key, compat, groups, ids);

    if (!result.ok) return result;
    resolved.push(result.value);
  }

  out.keys = resolved;

  return succeed(out);
};

/** Copy of `document` with `family`'s group list replaced by `groups`. */
const withGroups = (
  document: JsonObject,
  family: ApiKeyFamily,
  groups: ReadonlyArray<JsonObject>,
): JsonObject => {
  const out = structuredClone(document);
  const existing = out["api-keys"];
  const apiKeys: JsonObject = isJsonObject(existing) ? existing : {};
  apiKeys[family] = [...groups];
  out["api-keys"] = apiKeys;

  return out;
};

/**
 * `document` with `group` written at `index` (appended without one), and the group as stored. `ids` are the
 * credential ids of `document`'s keys (`configKeyIds(config, { includeDisabledGroups: true })`), which `auth_index`
 * entries are resolved against.
 */
export const applyGroupWrite = (
  document: JsonObject,
  ids: ConfigKeyIds,
  request: { readonly family: ApiKeyFamily; readonly index?: number; readonly group: JsonObject },
): Edit<{ readonly document: JsonObject; readonly group: JsonObject }> => {
  const resolved = resolveGroup(
    document,
    ids[request.family],
    request.family,
    request.index,
    request.group,
  );

  if (!resolved.ok) return resolved;
  const groups = groupsOf(document, request.family);

  return succeed({
    group: resolved.value,
    document: withGroups(
      document,
      request.family,
      request.index === undefined
        ? [...groups, resolved.value]
        : groups.map((group, position) => (position === request.index ? resolved.value : group)),
    ),
  });
};

/** `document` without the group at `index`. */
export const removeGroup = (
  document: JsonObject,
  family: ApiKeyFamily,
  index: number,
): Edit<JsonObject> => {
  const groups = groupsOf(document, family);

  if (groups[index] === undefined) return fail(404, "group not found");

  return succeed(
    withGroups(
      document,
      family,
      groups.filter((_, position) => position !== index),
    ),
  );
};

/** Why the config normaliser would drop `group` (or some of its keys); a generic duplicate hint when none applies. */
export const dropReason = (family: ApiKeyFamily, group: JsonObject): string => {
  const keys = keysOf(group);
  const baseUrl = text(group["base-url"]);
  const secrets = keys.map((key) => text(key["api-key"]));

  if (
    (family === "codex" || family === "xai" || family === "openai-compatibility") &&
    baseUrl === ""
  )
    return `${family} endpoints need a base-url`;

  if (family === "meta" && secrets.some((secret) => secret === "" || secret.startsWith("dca:")))
    return "meta keys must not be empty or start with dca:";

  if (family === "vertex" && secrets.some((secret) => secret === ""))
    return "vertex keys need an api-key";

  if ((family === "gemini" || family === "interactions") && baseUrl === "" && secrets.includes(""))
    return `a ${family} key without an api-key needs a base-url`;

  if (keys.length === 0 && family !== "openai-compatibility") return "add at least one key";

  return "duplicate key: the same api-key, base-url, proxy-url, prefix and headers already exist";
};

/**
 * Compares the key count of every group of the family after normalisation (`after`) with what the write asked for:
 * `before` are the counts of the stored groups, `index` the group replaced (appended when undefined) and `input`
 * the group as written. A mismatch is refused with the reason, so a write never "succeeds" by losing the key.
 */
export const checkSurvival = (
  family: ApiKeyFamily,
  before: ReadonlyArray<number>,
  after: ReadonlyArray<number>,
  index: number | undefined,
  input: JsonObject,
): Edit<null> => {
  const written = keysOf(input).length;
  const target = index ?? before.length;

  const expected =
    index === undefined
      ? [...before, written]
      : before.map((count, position) => (position === index ? written : count));

  const mismatch = expected.findIndex((count, position) => after[position] !== count);

  if (mismatch < 0 && after.length === expected.length) return succeed(null);

  if (mismatch === target || mismatch < 0) return fail(422, dropReason(family, input));

  return fail(
    422,
    `this change would remove keys from another ${family} group: a key duplicates one in the group you edit`,
  );
};

/** Where in the config a credential id sits: family, group index, key index. */
export interface KeyPosition {
  readonly family: ApiKeyFamily;
  readonly group: number;
  readonly key: number;
}

export const locateKey = (ids: ConfigKeyIds, id: string): KeyPosition | undefined => {
  for (const [family, groups] of Object.entries(ids)) {
    for (const [group, entry] of groups.entries()) {
      const key = entry.keys.indexOf(id);

      if (key < 0) continue;

      // SAFETY: the keys of `ConfigKeyIds` are exactly the `ApiKeyFamily` literals.
      return { family: family as ApiKeyFamily, group, key };
    }
  }

  return undefined;
};

const patterns = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const isDisablingPattern = (pattern: string): boolean => pattern.trim() === "*";

/**
 * `setConfigAPIKeyExcludedAll` (internal/api/handlers/management/config_apikey_disable.go): adds or removes `*` in the
 * key's `excluded-models`, which disables the key without changing its identity (`excluded-models` is not in the
 * credential id). A key's own list replaces the group's, so a key without one starts from the group's list.
 */
export const setKeyExcludedAll = (
  document: JsonObject,
  position: KeyPosition,
  disable: boolean,
): Edit<JsonObject> => {
  const out = structuredClone(document);
  const group = groupsOf(out, position.family)[position.group];
  const key = group === undefined ? undefined : keysOf(group)[position.key];

  if (group === undefined || key === undefined) return fail(404, "config api key entry not found");

  const inherited = patterns(group["excluded-models"]);

  const effective = Array.isArray(key["excluded-models"])
    ? patterns(key["excluded-models"])
    : inherited;

  const next = disable
    ? effective.some(isDisablingPattern)
      ? effective
      : [...effective, "*"]
    : effective.filter((pattern) => !isDisablingPattern(pattern));

  if (jsonEquals(next, inherited)) delete key["excluded-models"];
  else key["excluded-models"] = next;

  return succeed(out);
};
