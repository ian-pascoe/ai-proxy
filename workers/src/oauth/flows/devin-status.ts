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

/** `BuildGetUserStatusRequest` with a random device fingerprint (Go: random per request when no seed is given). */
export const buildUserStatusRequest = (sessionToken: string): Uint8Array => {
  const inner = Uint8Array.from([
    ...text(1, "chisel"),
    ...text(2, "3000.10.21"),
    ...text(3, sessionToken),
    ...text(4, "en"),
    ...text(5, "linux"),
    ...text(7, "3000.10.21"),
    ...text(12, "chisel"),
    ...text(31, randomHex(FINGERPRINT_BYTES))
  ])
  return Uint8Array.from(field(1, inner))
}

interface Field {
  readonly number: number
  readonly wire: number
  readonly bytes?: Uint8Array
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
      if (readVarint() === undefined) break
      out.push({ number, wire })
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

/** `ParseGetUserStatusResponse`. */
export const parseUserStatus = (data: Uint8Array): DevinUserStatus | undefined => {
  if (data.length === 0) return undefined
  const status: DevinUserStatus = { email: "", userName: "", userId: "", orgId: "", plan: "" }
  for (const top of fields(data)) {
    if (top.number !== 1 || top.wire !== 2 || top.bytes === undefined) continue
    for (const entry of fields(top.bytes)) {
      if (entry.wire !== 2) continue
      switch (entry.number) {
        case 3:
          status.userName = stringField(entry.bytes)
          break
        case 7:
          status.email = stringField(entry.bytes)
          break
        case 36:
          status.userId = stringField(entry.bytes)
          break
        case 13:
          for (const planStatus of fields(entry.bytes ?? new Uint8Array())) {
            if (planStatus.number !== 1 || planStatus.wire !== 2) continue
            for (const info of fields(planStatus.bytes ?? new Uint8Array())) {
              if (info.wire !== 2) continue
              if (info.number === 2) status.plan = stringField(info.bytes)
              if (info.number === 33) {
                for (const org of fields(info.bytes ?? new Uint8Array())) {
                  if (org.number === 4 && org.wire === 2) status.orgId = stringField(org.bytes)
                }
              }
            }
          }
          break
        default:
          break
      }
    }
  }
  return status
}
