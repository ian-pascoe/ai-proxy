/**
 * Metadata merge semantics.
 *
 * Go source: sdk/cliproxy/auth/metadata_merge.go (`IsAuthTokenPayloadKey`, `MergeExistingAuthMetadata`,
 * `CredentialsChanged` in conductor_refresh.go). Docs: credentials.md §11.
 * A re-login (or re-import) overwrites the token material but keeps the user's settings from the previous file.
 */
import type { JsonObject } from "../json/index.ts"
import { canonicalMetadataKey } from "./import.ts"

const TOKEN_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "session_id",
  "expired",
  "last_refresh",
  "expires_in",
  "timestamp",
  "token_type",
  "user_code",
  "verification_uri",
  "verification_uri_complete"
])

const META_SECRET_KEYS = new Set(["api_key", "dca_token", "dca_expired", "dca_expires_at"])

/** Token lifecycle fields that must not be carried over from an old file. */
export const isTokenPayloadKey = (key: string): boolean => TOKEN_KEYS.has(key.trim().toLowerCase())

/**
 * `MergeExistingAuthMetadata`: returns `incoming` plus every non-token key of `existing` that `incoming` does not
 * define. `disabled` is carried over like any other user setting unless `incoming` sets it. Meta additionally never inherits `api_key`/`dca_*`.
 */
export const mergeExistingMetadata = (provider: string, incoming: JsonObject, existing: JsonObject): JsonObject => {
  const merged: JsonObject = { ...incoming }
  const isMeta = provider.trim().toLowerCase() === "meta"

  for (const [key, value] of Object.entries(existing)) {
    if (isTokenPayloadKey(key)) continue

    if (isMeta && META_SECRET_KEYS.has(canonicalMetadataKey(key))) continue

    if (!Object.hasOwn(merged, key)) merged[key] = value
  }

  return merged
}

const stringOf = (meta: JsonObject, key: string): string => {
  const value = meta[key]

  return typeof value === "string" ? value.trim() : ""
}

const firstString = (meta: JsonObject, ...keys: string[]): string => {
  for (const key of keys) {
    const value = stringOf(meta, key)

    if (value !== "") return value
  }

  return ""
}

/** `CredentialsChanged`: token or API-key material differs (bumps the credential version). */
export const credentialsChanged = (before: JsonObject, after: JsonObject): boolean =>
  (
    [["access_token", "accessToken"], ["refresh_token", "refreshToken"], ["id_token", "idToken"], ["api_key"]] as const
  ).some((keys) => firstString(before, ...keys) !== firstString(after, ...keys))
