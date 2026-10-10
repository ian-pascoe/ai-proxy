/**
 * Claude credential helpers, first-party detection, fingerprint and wire policies.
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (claudeCreds, isClaudeOAuthToken,
 * claudeCredentialUsesOAuth, isAnthropicUpstreamBase), internal/runtime/executor/helps/claude_upstream.go,
 * claude_fingerprint_policy.go (resolveClaudeFingerprintPolicy), claude_executor_cloaking.go (getCloakConfigFromAuth,
 * resolveClaudeWirePolicy), claude_signing.go (resolveClaudeKeyConfig).
 */
import type { ApiKeyEntry, ApiKeyGroup, Config } from "../../config/schema.ts"
import type { CredentialSnapshot } from "../picker.ts"

export const DEFAULT_BASE_URL = "https://api.anthropic.com"

export const FINGERPRINT_PROFILE_CLAUDE_CODE_CLI = "claude-code-cli"

/** `isClaudeOAuthToken`. */
export const isClaudeOAuthToken = (apiKey: string): boolean => apiKey.includes("sk-ant-oat")

/** `IsAnthropicUpstreamURL`: https, `api.anthropic.com`, no userinfo, default port. */
export const isAnthropicUpstreamURL = (url: URL): boolean =>
  url.username === "" &&
  url.password === "" &&
  url.protocol === "https:" &&
  url.hostname.toLowerCase() === "api.anthropic.com" &&
  (url.port === "" || url.port === "443")

export const isAnthropicUpstreamBase = (baseURL: string): boolean => {
  try {
    return isAnthropicUpstreamURL(new URL(baseURL.trim()))
  } catch {
    return false
  }
}

const metadataString = (credential: CredentialSnapshot, key: string): string => {
  const value = credential.metadata[key]

  return typeof value === "string" ? value.trim() : ""
}

/** `claudeCreds`: attributes first (`api_key`, `base_url`), then the OAuth access token. */
export const claudeCreds = (credential: CredentialSnapshot): { apiKey: string; baseURL: string } => {
  const apiKey = credential.attributes["api_key"] ?? ""

  return {
    apiKey: apiKey !== "" ? apiKey : metadataString(credential, "access_token"),
    baseURL: credential.attributes["base_url"] ?? ""
  }
}

/** `claudeCredentialUsesOAuth`: OAuth token -> Bearer; API-key credentials use `x-api-key` on first-party hosts. */
export const claudeCredentialUsesOAuth = (credential: CredentialSnapshot, apiKey: string): boolean => {
  if (isClaudeOAuthToken(apiKey)) return true

  if (credential.kind === "apikey") return false

  return (credential.attributes["api_key"] ?? "").trim() === ""
}

/** `resolveClaudeKeyConfig`: the `api-keys.claude` entry matching the credential's key (and base URL). */
export const resolveClaudeKeyConfig = (
  config: Config,
  credential: CredentialSnapshot
): { readonly entry: ApiKeyEntry; readonly group: ApiKeyGroup; readonly baseUrl: string } | undefined => {
  const { apiKey, baseURL } = claudeCreds(credential)

  if (apiKey === "") return undefined

  for (const group of config["api-keys"].claude) {
    const groupBase = (group["base-url"] ?? "").trim()

    for (const entry of group.keys) {
      if (entry["api-key"].trim().toLowerCase() !== apiKey.toLowerCase()) continue

      if (baseURL !== "" && groupBase !== "" && groupBase.toLowerCase() !== baseURL.toLowerCase()) continue

      return { entry, group, baseUrl: groupBase }
    }
  }

  return undefined
}

/** Attribute first, then credential metadata (Go `lookupCloakAttr`). */
const lookupAttr = (credential: CredentialSnapshot, key: string): string => {
  const attribute = (credential.attributes[key] ?? "").trim()

  return attribute !== "" ? attribute : metadataString(credential, key)
}

export interface FingerprintPolicy {
  readonly authIsOAuthToken: boolean
  readonly profileClaudeCodeCLI: boolean
  readonly useOAuthBetas: boolean
  readonly applyCLIIdentity: boolean
  readonly synthesizeIdentity: boolean
  readonly mcpAlias: boolean
  readonly injectDiagnostics: boolean
}

/** `resolveClaudeFingerprintPolicy`. */
export const resolveFingerprintPolicy = (
  config: Config,
  credential: CredentialSnapshot,
  apiKey: string
): FingerprintPolicy => {
  const authIsOAuth = isClaudeOAuthToken(apiKey)
  let profile = lookupAttr(credential, "fingerprint_profile") || lookupAttr(credential, "fingerprint-profile")

  if (profile === "") profile = resolveClaudeKeyConfig(config, credential)?.entry["fingerprint-profile"] ?? ""
  const cli = authIsOAuth || profile.trim().toLowerCase() === FINGERPRINT_PROFILE_CLAUDE_CODE_CLI

  return {
    authIsOAuthToken: authIsOAuth,
    profileClaudeCodeCLI: cli,
    useOAuthBetas: cli,
    applyCLIIdentity: cli,
    synthesizeIdentity: cli && !authIsOAuth,
    mcpAlias: cli,
    injectDiagnostics: cli
  }
}

export interface WirePolicy {
  readonly oauth: boolean
  readonly profileClaudeCodeCLI: boolean
  readonly confirmedClaudeCode: boolean
  readonly cloak: boolean
}

export interface CloakSettings {
  readonly strictMode: boolean
  readonly sensitiveWords: ReadonlyArray<string>
  readonly cacheUserID: boolean
}

/** `resolveClaudeWirePolicy`: whether the request is cloaked as Claude Code CLI traffic. */
export const resolveWirePolicy = (
  config: Config,
  credential: CredentialSnapshot,
  apiKey: string,
  confirmedClaudeCode: boolean
): { readonly policy: WirePolicy; readonly settings: CloakSettings } => {
  const cloakCfg = resolveClaudeKeyConfig(config, credential)?.entry.cloak
  const attrMode = lookupAttr(credential, "cloak_mode")
  const attrStrict = lookupAttr(credential, "cloak_strict_mode").toLowerCase() === "true"
  const wordsText = lookupAttr(credential, "cloak_sensitive_words")
  const attrWords = wordsText === "" ? [] : wordsText.split(",").map((word) => word.trim())
  const attrCache = lookupAttr(credential, "cloak_cache_user_id").toLowerCase() === "true"

  let cloakMode = config.upstream.claude["disable-claude-cloak-mode"] ? "never" : "auto"
  let strictMode = attrStrict
  let sensitiveWords: ReadonlyArray<string> = attrWords
  let cacheUserID = attrCache

  if (attrMode !== "") cloakMode = attrMode

  if (cloakCfg !== undefined) {
    const mode = (cloakCfg.mode ?? "").trim()

    if (mode !== "") cloakMode = mode

    if (cloakCfg["strict-mode"] === true) strictMode = true

    if ((cloakCfg["sensitive-words"]?.length ?? 0) > 0) sensitiveWords = cloakCfg["sensitive-words"] ?? []

    if (cloakCfg["cache-user-id"] !== undefined) cacheUserID = cloakCfg["cache-user-id"]
  }

  const fp = resolveFingerprintPolicy(config, credential, apiKey)
  const cloakConfigured = cloakCfg !== undefined || attrMode !== "" || attrStrict || attrWords.length > 0 || attrCache
  let cloak = (fp.profileClaudeCodeCLI || cloakConfigured) && !confirmedClaudeCode

  if (!confirmedClaudeCode) {
    const mode = cloakMode.trim().toLowerCase()

    if (mode === "always") cloak = true
    else if (mode === "never") cloak = false
  }

  return {
    policy: { oauth: fp.authIsOAuthToken, profileClaudeCodeCLI: fp.profileClaudeCodeCLI, confirmedClaudeCode, cloak },
    settings: { strictMode, sensitiveWords, cacheUserID }
  }
}
