/**
 * Access-token expiry detection.
 *
 * Go source: sdk/cliproxy/auth/types.go (`ExpirationTime`, `AccessTokenExpirationTime`, `expirationFromMap`,
 * `parseJWTExp`, `parseTimeValue`, `normaliseUnix`), conductor_refresh.go (`authAccessToken`).
 * Rules (docs/research/credentials.md §2.1): a JWT `exp` claim outranks every metadata key; then the
 * first parseable of `expired, expire, expires_at, expiresAt, expiry, expires`; then `expires_in` + `timestamp`;
 * then the same inside a nested `token`/`Token` object. A token the upstream rejected counts as expired at epoch 0.
 */
import { isJsonObject, type JsonObject } from "../json/index.ts"

const EXPIRE_KEYS = ["expired", "expire", "expires_at", "expiresAt", "expiry", "expires"] as const

const RELATIVE_KEYS = ["expires_in", "expiresIn"] as const

const TIMESTAMP_KEYS = ["timestamp", "issued_at", "issuedAt"] as const

/** Unix seconds, or milliseconds when above 1e12. Non-positive values are "unset". */
const normaliseUnix = (raw: number): number | undefined => {
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  const whole = Math.trunc(raw)

  return whole > 1_000_000_000_000 ? whole : whole * 1000
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/

/** Go `parseTimeValue`: RFC3339 (+nano), `YYYY-MM-DD HH:MM[:SS]` (UTC), unix s/ms as number or numeric string. */
export const parseTimeValue = (value: unknown): number | undefined => {
  if (typeof value === "number") return normaliseUnix(value)

  if (typeof value !== "string") return undefined
  const text = value.trim()

  if (text === "") return undefined

  if (RFC3339.test(text)) {
    const parsed = Date.parse(text)

    return Number.isNaN(parsed) ? undefined : parsed
  }

  const local = LOCAL_DATE_TIME.exec(text)

  if (local !== null) {
    const parsed = Date.parse(`${local[1]}T${local[2]}:${local[3] ?? "00"}Z`)

    return Number.isNaN(parsed) ? undefined : parsed
  }

  if (/^[+-]?\d+$/.test(text)) return normaliseUnix(Number(text))

  return undefined
}

const base64UrlDecode = (segment: string): string | undefined => {
  try {
    const padded = segment
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(segment.length / 4) * 4, "=")

    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))

    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** Unverified JWT payload (claims) of a three-part token, or `undefined`. */
export const decodeJwtClaims = (token: string): JsonObject | undefined => {
  const parts = token.trim().split(".")

  if (parts.length !== 3) return undefined
  const text = base64UrlDecode(parts[1] as string)

  if (text === undefined) return undefined

  try {
    const claims: unknown = JSON.parse(text)

    return isJsonObject(claims) ? claims : undefined
  } catch {
    return undefined
  }
}

/** JWT `exp` claim in epoch milliseconds. */
export const parseJwtExp = (token: string): number | undefined => {
  const exp = decodeJwtClaims(token)?.exp

  if (typeof exp === "number") return exp > 0 ? normaliseUnix(exp) : undefined

  if (typeof exp === "string" && /^\s*\d+\s*$/.test(exp)) return normaliseUnix(Number(exp))

  return undefined
}

const relativeSeconds = (meta: JsonObject): number | undefined => {
  for (const key of RELATIVE_KEYS) {
    const value = meta[key]
    const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN

    if (Number.isFinite(seconds) && Math.trunc(seconds) > 0) return Math.trunc(seconds)
  }

  return undefined
}

const issuedAt = (meta: JsonObject): number | undefined => {
  for (const key of TIMESTAMP_KEYS) {
    const parsed = parseTimeValue(meta[key])

    if (parsed !== undefined) return parsed
  }

  return undefined
}

/** `expirationFromMap`: expiry from absolute keys, `expires_in` + `timestamp`, or a nested token object. */
export const expirationFromMetadata = (meta: JsonObject): number | undefined => {
  for (const key of EXPIRE_KEYS) {
    const parsed = parseTimeValue(meta[key])

    if (parsed !== undefined) return parsed
  }

  const seconds = relativeSeconds(meta)

  if (seconds !== undefined) {
    const issued = issuedAt(meta)

    if (issued !== undefined) return issued + seconds * 1000
  }

  for (const nestedKey of ["token", "Token"]) {
    const nested = meta[nestedKey]

    if (isJsonObject(nested)) {
      const parsed = expirationFromMetadata(nested)

      if (parsed !== undefined) return parsed
    }
  }

  return undefined
}

const stringValue = (meta: JsonObject, key: string): string => {
  const value = meta[key]

  return typeof value === "string" ? value.trim() : ""
}

/** `authAccessToken`: `access_token`, falling back to `accessToken`. */
export const accessTokenOf = (meta: JsonObject): string =>
  stringValue(meta, "access_token") || stringValue(meta, "accessToken")

/**
 * `AccessTokenExpirationTime`: expiry (epoch ms) of the credential's access token, or `undefined` when it has no
 * token or no known expiry. `rejectedAccessToken` (the token upstream answered 401 for) counts as expired at epoch 0.
 */
export const accessTokenExpiry = (meta: JsonObject, rejectedAccessToken?: string): number | undefined => {
  const token = accessTokenOf(meta)

  if (token === "") return undefined

  if (rejectedAccessToken !== undefined && rejectedAccessToken !== "" && rejectedAccessToken === token) return 0

  return parseJwtExp(token) ?? expirationFromMetadata(meta)
}
