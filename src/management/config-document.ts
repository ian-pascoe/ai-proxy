/**
 * Path-addressed edits of the config document served by `/v8/management/config[/*path]`.
 *
 * Go source: internal/api/handlers/management/config_v8.go (`configV8Node`, `deleteConfigV8Path`,
 * `mergeConfigV8Patch`, the write path of `ConfigV8`) and config_auth_index.go (auth_index injection).
 * Paths address mapping keys, never array indexes; lists and scalars are replaced whole, `PATCH` deep-merges objects
 * (explicit `null` is kept: DELETE is the removal operation). The Go read-only Home revision paths do not exist in
 * the Workers config schema, so there is nothing to protect. All functions work on a private copy of the document.
 */
import type { ApiKeyFamily, Config } from "../config/schema.ts"
import { API_KEY_FAMILIES } from "../config/schema.ts"
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts"
import { synthesizeConfigCredentials } from "../credentials/synthesize.ts"
import { authIndexOf } from "./auth-index.ts"

/** `/a/b/c` (percent-decoded segments) -> `["a","b","c"]`; `undefined` for an empty segment in the middle. */
export const parseConfigPath = (rest: string): ReadonlyArray<string> | undefined => {
  const trimmed = rest.replace(/^\/+|\/+$/g, "")

  if (trimmed === "") return []

  const parts = trimmed.split("/").map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })

  return parts.some((part) => part === "") ? undefined : parts
}

/** Value at `parts`, or `undefined` when a key is missing or a non-object is traversed. */
export const getAtPath = (root: Json, parts: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = root

  for (const part of parts) {
    if (!isJsonObject(current) || !Object.hasOwn(current, part)) return undefined
    current = current[part]
  }

  return current
}

/** `mergeConfigV8Patch`: objects merge recursively, everything else is replaced by the patch. */
export const mergePatch = (target: Json | undefined, patch: Json): Json => {
  if (!isJsonObject(target) || !isJsonObject(patch)) return structuredClone(patch)
  const out: JsonObject = { ...target }

  for (const [key, value] of Object.entries(patch)) {
    out[key] = Object.hasOwn(out, key) ? mergePatch(out[key], value) : structuredClone(value)
  }

  return out
}

export type WriteMode = "put" | "patch"

/**
 * Returns a copy of `document` with `value` written at `parts` (intermediate objects are created).
 * `"invalid_path"` when an intermediate value exists and is not an object.
 */
export const writeAtPath = (
  document: JsonObject,
  parts: ReadonlyArray<string>,
  value: Json,
  mode: WriteMode
): JsonObject | "invalid_path" => {
  if (parts.length === 0) return (mode === "patch" ? mergePatch(document, value) : structuredClone(value)) as JsonObject
  const root = structuredClone(document)
  let parent: JsonObject = root

  for (const part of parts.slice(0, -1)) {
    const next = parent[part]

    if (next === undefined) {
      const created: JsonObject = {}
      parent[part] = created
      parent = created
    } else if (isJsonObject(next)) {
      parent = next
    } else {
      return "invalid_path"
    }
  }

  const leaf = parts[parts.length - 1] as string
  parent[leaf] = mode === "patch" ? mergePatch(parent[leaf], value) : structuredClone(value)

  return root
}

const removeAt = (node: JsonObject, rest: ReadonlyArray<string>): boolean => {
  const [head, ...tail] = rest as [string, ...string[]]

  if (!Object.hasOwn(node, head)) return false

  if (tail.length > 0) {
    const child = node[head]

    if (!isJsonObject(child) || !removeAt(child, tail)) return false

    if (Object.keys(child).length > 0) return true
  }

  delete node[head]

  return true
}

/** `deleteConfigV8Path`: removes the key and prunes parents that became empty; `undefined` when it does not exist. */
export const deleteAtPath = (document: JsonObject, parts: ReadonlyArray<string>): JsonObject | undefined => {
  if (parts.length === 0) return undefined
  const root = structuredClone(document)

  return removeAt(root, parts) ? root : undefined
}

// --- auth_index injection ---------------------------------------------------------------------------------------

const FAMILY_PROVIDERS: Readonly<Record<Exclude<ApiKeyFamily, "openai-compatibility">, string>> = {
  gemini: "gemini",
  interactions: "gemini-interactions",
  vertex: "vertex",
  codex: "codex",
  claude: "claude",
  xai: "xai",
  meta: "meta"
}

/**
 * Adds `auth_index` to every `api-keys.<family>[].keys[]` entry (and to key-less OpenAI-compatibility groups), the
 * way the Go server does, so the panel can address those credentials (`/requests/api-call`, cooldown reset).
 * `document` must be the JSON form of `config`; the result is a modified copy. Positions are matched through the
 * synthesised credentials (`attributes.config_index`), the same order the credential pool uses.
 */
export const injectAuthIndexes = (document: JsonObject, config: Pick<Config, "api-keys">): JsonObject => {
  const credentials = synthesizeConfigCredentials(config, 0)
  const byPosition = new Map<string, string>()
  const compat = new Map<string, string[]>()

  for (const credential of credentials) {
    const index = credential.attributes.config_index

    if (index === undefined) continue

    if (credential.attributes.compat_name !== undefined) {
      const list = compat.get(index) ?? []
      list.push(credential.id)
      compat.set(index, list)
    } else {
      byPosition.set(`${credential.provider}:${index}`, credential.id)
    }
  }

  const out = structuredClone(document)
  const apiKeys = out["api-keys"]

  if (!isJsonObject(apiKeys)) return out

  for (const family of API_KEY_FAMILIES) {
    const groups = apiKeys[family]

    if (!Array.isArray(groups)) continue

    if (family === "openai-compatibility") {
      groups.forEach((group, groupIndex) => {
        if (!isJsonObject(group)) return
        const ids = compat.get(String(groupIndex)) ?? []
        const keys = group.keys

        if (Array.isArray(keys) && keys.length > 0) {
          keys.forEach((key, keyIndex) => {
            const id = ids[keyIndex]

            if (isJsonObject(key) && id !== undefined) key.auth_index = authIndexOf(id)
          })
        } else if (ids[0] !== undefined) {
          group.auth_index = authIndexOf(ids[0])
        }
      })
      continue
    }

    const provider = FAMILY_PROVIDERS[family]
    let position = 0

    for (const group of groups) {
      const keys = isJsonObject(group) ? group.keys : undefined

      if (!Array.isArray(keys)) continue

      for (const key of keys) {
        const id = byPosition.get(`${provider}:${position}`)
        position += 1

        if (isJsonObject(key) && id !== undefined) key.auth_index = authIndexOf(id)
      }
    }
  }

  return out
}

const stripNode = (node: Json | undefined): void => {
  if (!isJsonObject(node)) return
  delete node.auth_index
  delete node["auth-index"]
}

/** `stripAPIKeysAuthIndexesFromRoot`: `auth_index` is derived data and must never be stored. */
export const stripAuthIndexes = (document: JsonObject): JsonObject => {
  const out = structuredClone(document)
  const apiKeys = out["api-keys"]

  if (!isJsonObject(apiKeys)) return out

  for (const groups of Object.values(apiKeys)) {
    if (!Array.isArray(groups)) continue

    for (const group of groups) {
      stripNode(group)
      const keys = isJsonObject(group) ? group.keys : undefined

      if (Array.isArray(keys)) keys.forEach(stripNode)
    }
  }

  return out
}
