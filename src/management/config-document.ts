/**
 * Path-addressed edits of the config document served by `/v8/management/config[/*path]`.
 *
 * Go source: internal/api/handlers/management/config_v8.go (`configV8Node`, `deleteConfigV8Path`,
 * `mergeConfigV8Patch`, the write path of `ConfigV8`) and config_auth_index.go (auth_index injection).
 * Paths address mapping keys, never array indexes; lists and scalars are replaced whole, `PATCH` deep-merges objects
 * (explicit `null` is kept: DELETE is the removal operation). The Go read-only Home revision paths do not exist in
 * the Workers config schema, so there is nothing to protect. All functions work on a private copy of the document.
 */
import type { ApiKeyFamily, Config } from "../config/schema.ts";
import { API_KEY_FAMILIES } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import { synthesizeConfigCredentials } from "../credentials/synthesize.ts";
import { authIndexOf } from "./auth-index.ts";

/** `/a/b/c` (percent-decoded segments) -> `["a","b","c"]`; `undefined` for an empty segment in the middle. */
export const parseConfigPath = (rest: string): ReadonlyArray<string> | undefined => {
  const trimmed = rest.replace(/^\/+|\/+$/g, "");

  if (trimmed === "") return [];

  const parts = trimmed.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  return parts.some((part) => part === "") ? undefined : parts;
};

/** Value at `parts`, or `undefined` when a key is missing or a non-object is traversed. */
export const getAtPath = (root: Json, parts: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = root;

  for (const part of parts) {
    if (!isJsonObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }

  return current;
};

/** `mergeConfigV8Patch`: objects merge recursively, everything else is replaced by the patch. */
export const mergePatch = (target: Json | undefined, patch: Json): Json => {
  if (!isJsonObject(target) || !isJsonObject(patch)) return structuredClone(patch);
  const out: JsonObject = { ...target };

  for (const [key, value] of Object.entries(patch)) {
    out[key] = Object.hasOwn(out, key) ? mergePatch(out[key], value) : structuredClone(value);
  }

  return out;
};

export type WriteMode = "put" | "patch";

/**
 * Returns a copy of `document` with `value` written at `parts` (intermediate objects are created).
 * `"invalid_path"` when an intermediate value exists and is not an object.
 */
export const writeAtPath = (
  document: JsonObject,
  parts: ReadonlyArray<string>,
  value: Json,
  mode: WriteMode,
): JsonObject | "invalid_path" => {
  if (parts.length === 0)
    // SAFETY: an empty path replaces or patches the root, which callers only pass as an object.
    return (mode === "patch" ? mergePatch(document, value) : structuredClone(value)) as JsonObject;
  const root = structuredClone(document);
  let parent: JsonObject = root;

  for (const part of parts.slice(0, -1)) {
    const next = parent[part];

    if (next === undefined) {
      const created: JsonObject = {};
      parent[part] = created;
      parent = created;
    } else if (isJsonObject(next)) {
      parent = next;
    } else {
      return "invalid_path";
    }
  }

  // SAFETY: parts is non-empty: the empty path returned above.
  const leaf = parts[parts.length - 1] as string;
  parent[leaf] = mode === "patch" ? mergePatch(parent[leaf], value) : structuredClone(value);

  return root;
};

const removeAt = (node: JsonObject, rest: ReadonlyArray<string>): boolean => {
  // SAFETY: removeAt is only called with a non-empty path.
  const [head, ...tail] = rest as [string, ...string[]];

  if (!Object.hasOwn(node, head)) return false;

  if (tail.length > 0) {
    const child = node[head];

    if (!isJsonObject(child) || !removeAt(child, tail)) return false;

    if (Object.keys(child).length > 0) return true;
  }

  delete node[head];

  return true;
};

/** `deleteConfigV8Path`: removes the key and prunes parents that became empty; `undefined` when it does not exist. */
export const deleteAtPath = (
  document: JsonObject,
  parts: ReadonlyArray<string>,
): JsonObject | undefined => {
  if (parts.length === 0) return undefined;
  const root = structuredClone(document);

  return removeAt(root, parts) ? root : undefined;
};

// --- auth_index injection ---------------------------------------------------------------------------------------

const FAMILY_PROVIDERS: Readonly<Record<Exclude<ApiKeyFamily, "openai-compatibility">, string>> = {
  gemini: "gemini",
  interactions: "gemini-interactions",
  vertex: "vertex",
  codex: "codex",
  claude: "claude",
  xai: "xai",
  meta: "meta",
};

/** Credential ids of one group: one per key (`undefined` when the key produced no credential). */
export interface GroupKeyIds {
  readonly keys: ReadonlyArray<string | undefined>;
  /** A key-less OpenAI-compatibility group still produces one credential: its id. */
  readonly group?: string;
}

/** Per family and group index: the ids of the credentials `synthesizeConfigCredentials` made for them. */
export type ConfigKeyIds = Readonly<Record<ApiKeyFamily, ReadonlyArray<GroupKeyIds>>>;

export interface ConfigKeyIdsOptions {
  /**
   * Also give the keys of a disabled OpenAI-compatibility group an id (as if the group were enabled), so the panel
   * can still address them. Off for `auth_index` injection: a disabled group has no credentials (as in Go).
   */
  readonly includeDisabledGroups?: boolean;
}

/**
 * Maps every position in `config["api-keys"]` (family, group, key) to the id of the credential it produced, through
 * the synthesised credentials (`attributes.config_index`), the same order the credential pool uses. Shared by
 * `injectAuthIndexes` and the API keys view/writes, so both agree on which key an `auth_index` names.
 */
export const configKeyIds = (
  config: Pick<Config, "api-keys">,
  options: ConfigKeyIdsOptions = {},
): ConfigKeyIds => {
  const apiKeys = config["api-keys"];

  const synthesised: Pick<Config, "api-keys"> =
    options.includeDisabledGroups === true
      ? {
          "api-keys": {
            ...apiKeys,
            "openai-compatibility": apiKeys["openai-compatibility"].map((group) =>
              group.disabled === true ? { ...group, disabled: false } : group,
            ),
          },
        }
      : config;

  const byPosition = new Map<string, string>();
  const compat = new Map<string, string[]>();

  for (const credential of synthesizeConfigCredentials(synthesised, 0)) {
    const index = credential.attributes.config_index;

    if (index === undefined) continue;

    if (credential.attributes.compat_name !== undefined) {
      const list = compat.get(index) ?? [];
      list.push(credential.id);
      compat.set(index, list);
    } else {
      byPosition.set(`${credential.provider}:${index}`, credential.id);
    }
  }

  const grouped = (family: Exclude<ApiKeyFamily, "openai-compatibility">): GroupKeyIds[] => {
    const provider = FAMILY_PROVIDERS[family];
    let position = 0;

    return apiKeys[family].map((group) => ({
      keys: group.keys.map(() => {
        const id = byPosition.get(`${provider}:${position}`);
        position += 1;

        return id;
      }),
    }));
  };

  return {
    gemini: grouped("gemini"),
    interactions: grouped("interactions"),
    vertex: grouped("vertex"),
    codex: grouped("codex"),
    claude: grouped("claude"),
    xai: grouped("xai"),
    meta: grouped("meta"),
    "openai-compatibility": apiKeys["openai-compatibility"].map((group, index) => {
      const ids = compat.get(String(index)) ?? [];

      return {
        keys: group.keys.map((_, keyIndex) => ids[keyIndex]),
        ...(group.keys.length === 0 && ids[0] !== undefined ? { group: ids[0] } : {}),
      };
    }),
  };
};

/**
 * Adds `auth_index` to every `api-keys.<family>[].keys[]` entry (and to key-less OpenAI-compatibility groups), the
 * way the Go server does, so the panel can address those credentials (`/requests/api-call`, cooldown reset).
 * `document` must be the JSON form of `config`; the result is a modified copy. Positions come from
 * {@link configKeyIds}.
 */
export const injectAuthIndexes = (
  document: JsonObject,
  config: Pick<Config, "api-keys">,
): JsonObject => {
  const ids = configKeyIds(config);
  const out = structuredClone(document);
  const apiKeys = out["api-keys"];

  if (!isJsonObject(apiKeys)) return out;

  for (const family of API_KEY_FAMILIES) {
    const groups = apiKeys[family];

    if (!Array.isArray(groups)) continue;

    groups.forEach((group, groupIndex) => {
      if (!isJsonObject(group)) return;
      const groupIds = ids[family][groupIndex];

      if (groupIds === undefined) return;

      if (Array.isArray(group.keys)) {
        group.keys.forEach((key, keyIndex) => {
          const id = groupIds.keys[keyIndex];

          if (isJsonObject(key) && id !== undefined) key.auth_index = authIndexOf(id);
        });
      }

      if (groupIds.group !== undefined) group.auth_index = authIndexOf(groupIds.group);
    });
  }

  return out;
};

const stripNode = (node: Json | undefined): void => {
  if (!isJsonObject(node)) return;
  delete node.auth_index;
  delete node["auth-index"];
};

/** `stripAPIKeysAuthIndexesFromRoot`: `auth_index` is derived data and must never be stored. */
export const stripAuthIndexes = (document: JsonObject): JsonObject => {
  const out = structuredClone(document);
  const apiKeys = out["api-keys"];

  if (!isJsonObject(apiKeys)) return out;

  for (const groups of Object.values(apiKeys)) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      stripNode(group);
      const keys = isJsonObject(group) ? group.keys : undefined;

      if (Array.isArray(keys)) keys.forEach(stripNode);
    }
  }

  return out;
};
