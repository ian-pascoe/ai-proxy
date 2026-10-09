/**
 * Credential lookups and result types of the management RPCs of the ControlPlane Durable Object.
 *
 * Go source: internal/api/handlers/management/auth_files.go (`matchesAuthFileLookup`, `lookupAuthFile`),
 * api_tools.go (`tokenValueFromMetadata`, `tokenValueForAuth`). Everything here is plain data so it can cross the
 * Durable Object RPC boundary.
 */
import type { Schema } from "effect"
import type { Credential } from "../credentials/model.ts"
import type { RefreshTarget } from "../credentials/pool.ts"
import { authIndexOf } from "./auth-index.ts"

/** A credential reference as the panel sends it: file name (or id) and/or `auth_index`. */
export interface CredentialRef {
  readonly name?: string
  readonly authIndex?: string
}

/** `matchesAuthFileLookup`: both given criteria must match; a reference without criteria matches nothing. */
export const findCredential = (
  entries: ReadonlyArray<RefreshTarget>,
  ref: CredentialRef
): RefreshTarget | undefined => {
  const name = ref.name?.trim() ?? ""
  const authIndex = ref.authIndex?.trim() ?? ""
  if (name === "" && authIndex === "") return undefined
  return entries.find(
    (entry) =>
      (name === "" || entry.credential.id === name) &&
      (authIndex === "" || authIndexOf(entry.credential.id) === authIndex)
  )
}

export type RefreshOneResult =
  | { readonly ok: true; readonly refreshed: boolean; readonly entry: Record<string, Schema.MutableJson> }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "refresh_failed"; readonly message: string }

export interface RefreshAllItem {
  readonly id: string
  readonly success: boolean
  readonly error?: string
}

export type ApiCallTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: "not_found" | "refresh_failed" | "token_not_found" }

export type CredentialMutation =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: "not_found" | "invalid"; readonly message: string }

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** `tokenValueFromMetadata` + `tokenValueForAuth`: the value `$TOKEN$` stands for. */
export const apiCallToken = (credential: Pick<Credential, "metadata" | "attributes">): string => {
  const { metadata } = credential
  const direct = text(metadata.accessToken) || text(metadata.access_token)
  if (direct !== "") return direct
  const nested = metadata.token
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const value = text(nested.access_token) || text(nested.accessToken)
    if (value !== "") return value
  }
  return (
    text(metadata.token) ||
    text(metadata.id_token) ||
    text(metadata.api_key) ||
    text(metadata.session_token) ||
    text(metadata.cookie) ||
    text(credential.attributes.api_key) ||
    text(credential.attributes.session_token)
  )
}
