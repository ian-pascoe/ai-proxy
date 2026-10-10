/**
 * Kimi model naming and endpoints.
 *
 * Go source: internal/runtime/executor/kimi_executor.go (`normalizeKimiUpstreamModel`, `stripKimiPrefix`),
 * internal/runtime/executor/helps/kimi_responses.go (`ResolveKimiBaseURL`, `ResolveKimiChatURL`,
 * `ResolveKimiResponsesURL`, `ResolveKimiClaudeBaseURL`), internal/auth/kimi/kimi.go (domain defaults).
 */
import { parseSuffix } from "../suffix.ts"
import type { CredentialSnapshot } from "../picker.ts"

export const KIMI_COM_BASE_URL = "https://api.kimi.com/coding"

export const KIMI_AI_BASE_URL = "https://api.kimi.ai/coding"

const FOR_CODING = new Set([
  "kimi-k2.8",
  "k2.8",
  "kimi-k2.8-code",
  "k2.8-code",
  "kimi-k2.8-preview",
  "k2.8-preview",
  "kimi-k2.7-code",
  "k2.7-code",
  "kimi-for-coding",
  "for-coding"
])

const FOR_CODING_HIGHSPEED = new Set([
  "kimi-k2.7-code-highspeed",
  "k2.7-code-highspeed",
  "kimi-for-coding-highspeed",
  "for-coding-highspeed"
])

/**
 * `normalizeKimiUpstreamModel`: the canonical upstream model id. Strips the `kimi-` prefix and a Claude Code `[1m]`
 * suffix, maps the K2.7/K2.8 code aliases, and keeps a trailing thinking suffix (`k3(1024)`).
 */
export const normalizeKimiUpstreamModel = (model: string): string => {
  const parsed = parseSuffix(model.trim())
  let base = parsed.modelName.trim().toLowerCase()

  if (base.endsWith("[1m]")) base = base.slice(0, -"[1m]".length)
  let normalized: string

  if (FOR_CODING.has(base)) normalized = "kimi-for-coding"
  else if (FOR_CODING_HIGHSPEED.has(base)) normalized = "kimi-for-coding-highspeed"
  else normalized = base.toLowerCase().startsWith("kimi-") ? base.slice("kimi-".length) : base

  return parsed.hasSuffix ? `${normalized}(${parsed.rawSuffix})` : normalized
}

/** `ResolveKimiBaseURL`: `base_url` attribute/metadata, else the domain default (`attributes.domain` is derived). */
export const kimiBaseUrl = (credential: CredentialSnapshot): string => {
  const fromAttribute = (credential.attributes["base_url"] ?? "").trim().replace(/\/+$/, "")

  if (fromAttribute !== "") return fromAttribute
  const fromMetadata = credential.metadata["base_url"]

  if (typeof fromMetadata === "string" && fromMetadata.trim() !== "") return fromMetadata.trim().replace(/\/+$/, "")

  return credential.attributes["domain"] === "kimi.ai" || credential.provider === "kimi-ai"
    ? KIMI_AI_BASE_URL
    : KIMI_COM_BASE_URL
}

const endpoint = (credential: CredentialSnapshot, path: string): string => {
  const base = kimiBaseUrl(credential)

  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`
}

export const kimiChatUrl = (credential: CredentialSnapshot): string => endpoint(credential, "/chat/completions")

export const kimiResponsesUrl = (credential: CredentialSnapshot): string => endpoint(credential, "/responses")

/** `ResolveKimiClaudeBaseURL`: the Messages base (no trailing `/v1`). */
export const kimiClaudeBaseUrl = (credential: CredentialSnapshot): string => {
  const base = kimiBaseUrl(credential)

  return base.endsWith("/v1") ? base.slice(0, -3) : base
}

/** `kimiCreds`: `access_token` metadata first, then the attribute forms. */
export const kimiToken = (credential: CredentialSnapshot): string => {
  const metadataToken = credential.metadata["access_token"]

  if (typeof metadataToken === "string" && metadataToken.trim() !== "") return metadataToken

  return credential.attributes["access_token"] || credential.attributes["api_key"] || ""
}
