/**
 * Devin seat-management `GetUserStatus` (Connect-RPC, protobuf) as far as the login needs it: the account e-mail,
 * plan and ids. Quota/plan-period fields are runtime signals of the Devin executor slice, not part of the auth file.
 *
 * Go source: internal/auth/devin/user_status.go (`BuildGetUserStatusRequest`, `ParseGetUserStatusResponse`,
 * `parseUserStatus`, `parsePlanStatus`, `parsePlanInfo`, `parsePlanInfoOrg`, `GenerateDeviceFingerprint`).
 */
import { randomHex } from "../encoding.ts"

export interface DevinUserStatus {
  email: string
  userName: string
  userId: string
  orgId: string
  plan: string
  teamId: string
  orgName: string
  /** Remaining quota in percent (`daily_quota_remaining_percent`, `weekly_quota_remaining_percent`). */
  dailyQuotaRemainingPercent: number
  weeklyQuotaRemainingPercent: number
  /** Unix seconds; 0 = not reported. */
  dailyQuotaResetAt: number
  weeklyQuotaResetAt: number
  planStart: number
  planEnd: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const FINGERPRINT_BYTES = 366 // 732 hex characters

const varint = (value: number): number[] => {
  const out: number[] = []
  let rest = value
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

/** Field `number` with wire type 2 (length-delimited). */
const field = (number: number, value: Uint8Array): number[] => [
  ...varint(number * 8 + 2),
  ...varint(value.length),
  ...value
]

const text = (number: number, value: string): number[] => field(number, encoder.encode(value))

/**
 * `BuildGetUserStatusRequest`. Without a fingerprint a random one is generated per request (Go: `GenerateDeviceFingerprint("")`);
 * the refresh passes the one derived from the credential's device seed.
 */
export const buildUserStatusRequest = (sessionToken: string, fingerprint?: string): Uint8Array => {
  const inner = Uint8Array.from([
    ...text(1, "chisel"),
    ...text(2, "3000.10.21"),
    ...text(3, sessionToken),
    ...text(4, "en"),
    ...text(5, "linux"),
    ...text(7, "3000.10.21"),
    ...text(12, "chisel"),
    ...text(31, fingerprint ?? randomHex(FINGERPRINT_BYTES))
  ])
  return Uint8Array.from(field(1, inner))
}

interface Field {
  readonly number: number
  readonly wire: number
  readonly bytes?: Uint8Array
  /** Varint value. */
  readonly value?: number
}

/** Reads the fields of one message; stops at the first malformed field (Go's parsers do the same). */
const fields = (data: Uint8Array): Field[] => {
  const out: Field[] = []
  let at = 0
  const readVarint = (): number | undefined => {
    let value = 0
    let scale = 1
    for (let index = 0; index < 10; index++) {
      const byte = data[at++]
      if (byte === undefined) return undefined
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) return value
      scale *= 128
    }
    return undefined
  }
  while (at < data.length) {
    const tag = readVarint()
    if (tag === undefined) break
    const wire = tag % 8
    const number = Math.floor(tag / 8)
    if (wire === 2) {
      const length = readVarint()
      if (length === undefined || at + length > data.length) break
      out.push({ number, wire, bytes: data.subarray(at, at + length) })
      at += length
    } else if (wire === 0) {
      const value = readVarint()
      if (value === undefined) break
      out.push({ number, wire, value })
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      out.push({ number, wire })
    } else {
      break
    }
  }
  return out
}

const stringField = (bytes: Uint8Array | undefined): string => (bytes === undefined ? "" : decoder.decode(bytes))

const EMPTY = new Uint8Array()

/** `parseSecondsSubfield`: the first varint of field 1 (a protobuf `Timestamp.seconds`), 0 when absent. */
const secondsSubfield = (data: Uint8Array): number => {
  for (const entry of fields(data)) if (entry.wire === 0 && entry.number === 1) return entry.value ?? 0
  return 0
}

/** `parsePlanInfo` / `parsePlanInfoOrg`. */
const parsePlanInfo = (data: Uint8Array, status: DevinUserStatus): void => {
  for (const info of fields(data)) {
    if (info.wire !== 2) continue
    if (info.number === 2) status.plan = stringField(info.bytes)
    if (info.number === 33) {
      for (const org of fields(info.bytes ?? EMPTY)) {
        if (org.wire !== 2) continue
        if (org.number === 4) status.orgId = stringField(org.bytes)
        if (org.number === 8) status.orgName = stringField(org.bytes)
      }
    }
  }
}

/** `parsePlanStatus`: plan info, plan period and the quota varints. */
const parsePlanStatus = (data: Uint8Array, status: DevinUserStatus): void => {
  for (const entry of fields(data)) {
    if (entry.wire === 2) {
      if (entry.number === 1) parsePlanInfo(entry.bytes ?? EMPTY, status)
      else if (entry.number === 2) status.planStart = secondsSubfield(entry.bytes ?? EMPTY)
      else if (entry.number === 3) status.planEnd = secondsSubfield(entry.bytes ?? EMPTY)
    } else if (entry.wire === 0) {
      const value = entry.value ?? 0
      if (entry.number === 14) status.dailyQuotaRemainingPercent = value
      else if (entry.number === 15) status.weeklyQuotaRemainingPercent = value
      else if (entry.number === 17 && value > 0) status.dailyQuotaResetAt = value
      else if (entry.number === 18 && value > 0) status.weeklyQuotaResetAt = value
    }
  }
}

export const emptyUserStatus = (): DevinUserStatus => ({
  email: "",
  userName: "",
  userId: "",
  orgId: "",
  plan: "",
  teamId: "",
  orgName: "",
  dailyQuotaRemainingPercent: 0,
  weeklyQuotaRemainingPercent: 0,
  dailyQuotaResetAt: 0,
  weeklyQuotaResetAt: 0,
  planStart: 0,
  planEnd: 0
})

/** `ParseGetUserStatusResponse`. */
export const parseUserStatus = (data: Uint8Array): DevinUserStatus | undefined => {
  if (data.length === 0) return undefined
  const status = emptyUserStatus()
  for (const top of fields(data)) {
    if (top.number !== 1 || top.wire !== 2 || top.bytes === undefined) continue
    for (const entry of fields(top.bytes)) {
      if (entry.wire !== 2) continue
      switch (entry.number) {
        case 3:
          status.userName = stringField(entry.bytes)
          break
        case 5:
          status.teamId = stringField(entry.bytes)
          break
        case 7:
          status.email = stringField(entry.bytes)
          break
        case 13:
          parsePlanStatus(entry.bytes ?? EMPTY, status)
          break
        case 36:
          status.userId = stringField(entry.bytes)
          break
        default:
          break
      }
    }
  }
  return status
}
