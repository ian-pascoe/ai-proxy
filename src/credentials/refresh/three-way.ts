/**
 * Three-way merge of refreshed auth metadata.
 *
 * Go source: sdk/cliproxy/auth/metadata_merge.go (`mergeAuthContent`, metadata part) and conductor_lifecycle.go
 * (`updateInternal`, refresh mode). A refresh runs for seconds while users may edit the credential (priority, prefix,
 * notes, disabled, ...). `base` is the metadata the refresh started from, `current` the stored metadata at commit
 * time and `updated` what the protocol returned. Executor changes win unless the user changed the same key
 * concurrently; token lifecycle keys always take the refreshed value. `proxy_url` is not honoured on Workers.
 */
import { jsonEquals, type JsonObject } from "../../json/index.ts"
import { isTokenPayloadKey } from "../merge.ts"

const SKIPPED_KEY = "proxy_url"

export const mergeRefreshedMetadata = (
  base: Readonly<JsonObject>,
  current: Readonly<JsonObject>,
  updated: Readonly<JsonObject>
): JsonObject => {
  const merged: JsonObject = structuredClone(current) as JsonObject

  for (const [key, value] of Object.entries(updated)) {
    if (key.trim().toLowerCase() === SKIPPED_KEY) continue
    const hadInBase = Object.hasOwn(base, key)
    const hadInCurrent = Object.hasOwn(current, key)
    const changedByExecutor = !hadInBase || !jsonEquals(base[key], value)
    const changedByUser = hadInBase !== hadInCurrent || (hadInBase && !jsonEquals(base[key], current[key]))

    if (changedByExecutor && (!changedByUser || isTokenPayloadKey(key))) merged[key] = structuredClone(value)
  }

  // Deletions by the executor apply only when the user did not touch the key.
  for (const [key, baseValue] of Object.entries(base)) {
    if (key.trim().toLowerCase() === SKIPPED_KEY || Object.hasOwn(updated, key)) continue

    if (Object.hasOwn(current, key) && jsonEquals(baseValue, current[key])) delete merged[key]
  }

  return merged
}
