/**
 * Meta (Muse, `api.meta.ai`) credential resolution.
 *
 * Go source: internal/runtime/executor/meta_executor.go (`metaCreds`, `extractDCAToken`, `ensureAuth`). The DCA ->
 * API-key mint itself runs in the ControlPlane (`ensureFresh`, credentials/refresh/meta.ts); the conductor wraps every
 * attempt with it, so the executor only reads the minted key. A `dca:` value is never used as a bearer token.
 */
import { ExecutionError } from "../errors.ts"
import type { CredentialSnapshot } from "../picker.ts"

export const META_DEFAULT_BASE_URL = "https://api.meta.ai/v1"

export const META_USER_AGENT =
  "muse-build/1.3.0 (interactive; macos-aarch64; build ac7280f2aca67769d1455a8847bb502b617d50f6)"

export const META_CLIENT_ID = "tbh:tui"

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

const usableToken = (value: unknown): string => {
  const token = text(value)

  return token !== "" && !token.startsWith("dca:") ? token : ""
}

/** `metaCreds`: base URL (attributes, then metadata) and bearer token (attributes, then metadata). */
export const metaCreds = (credential: CredentialSnapshot): { readonly baseUrl: string; readonly token: string } => {
  const { attributes, metadata } = credential
  let baseUrl = text(attributes["base_url"]) || META_DEFAULT_BASE_URL
  const token = usableToken(attributes["api_key"]) || usableToken(attributes["access_token"])

  if (baseUrl === META_DEFAULT_BASE_URL) {
    baseUrl = text(metadata["base_url"]) || text(metadata["api_base_url"]) || baseUrl
  }

  return { baseUrl, token: token || usableToken(metadata["api_key"]) || usableToken(metadata["access_token"]) }
}

/** The credential's token or the Go 401 `ensureAuth` failure (config keys cannot mint from a DCA token). */
export const requireMetaToken = (
  credential: CredentialSnapshot
): { readonly baseUrl: string; readonly token: string } => {
  const creds = metaCreds(credential)

  if (creds.token !== "") return creds

  const message =
    credential.kind === "apikey"
      ? "meta executor: meta-api-key requires a valid API key (DCA tokens require OAuth storage)"
      : "meta executor: missing API key or access token"

  throw new ExecutionError({ status: 401, message })
}
