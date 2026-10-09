/**
 * Codex upstream request headers and credential access.
 *
 * Go source: internal/runtime/executor/codex_executor_request.go (applyCodexHeadersFromSources, applyCodexRoutingHint,
 * applyCodexCloakingHeaders, isCodexCloakingDisabled, applyCodexDirectImageHeaders, applyModelHeaderOverrides),
 * codex_executor_auth.go (codexCreds), codex_websockets_request.go (codexHeaderDefaults, codexAuthUsesAPIKey,
 * ensureHeaderWithConfigPrecedence), internal/util/codex.go (IsCodexResponsesLiteRequest).
 * TLS fingerprinting (uTLS) cannot be reproduced on Workers; the official client headers are the only mitigation.
 */
import type { Config } from "../../config/schema.ts"
import { get, type Json } from "../../json/index.ts"
import { applyCustomHeaders, customHeaders } from "../helps/custom-headers.ts"
import type { CredentialSnapshot } from "../picker.ts"

export const CODEX_USER_AGENT = "codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)"
export const CODEX_ORIGINATOR = "codex-tui"
export const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const ROUTING_HINT_HEADER = "x-codex-routing-hint"

/** `codexCreds`: API key (or OAuth access token) and the configured base URL. */
export const codexCreds = (credential: CredentialSnapshot): { readonly apiKey: string; readonly baseURL: string } => {
  let apiKey = credential.attributes["api_key"] ?? ""
  if (apiKey === "") {
    const token = credential.metadata["access_token"]
    if (typeof token === "string") apiKey = token
  }
  return { apiKey, baseURL: credential.attributes["base_url"] ?? "" }
}

/** `codexAuthUsesAPIKey`. */
export const codexUsesApiKey = (credential: CredentialSnapshot): boolean =>
  credential.kind === "apikey" || (credential.attributes["api_key"] ?? "").trim() !== ""

/** Base URL without a trailing slash, defaulting to the ChatGPT backend. */
export const codexBaseUrl = (credential: CredentialSnapshot): string => {
  const { baseURL } = codexCreds(credential)
  return (baseURL === "" ? CODEX_DEFAULT_BASE_URL : baseURL).replace(/\/+$/, "")
}

/** `IsCodexResponsesLiteRequest`: the native header or its websocket metadata mirror. */
export const isCodexResponsesLiteRequest = (body: Json | undefined, headers: Headers): boolean => {
  if ((headers.get("x-openai-internal-codex-responses-lite") ?? "").trim().toLowerCase() === "true") return true
  const value = get(body, "client_metadata.ws_request_header_x_openai_internal_codex_responses_lite")
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true")
}

/** `IsNativeCodexRequest`: Codex/Responses client talking the native dialect (lite requests only). */
export const isNativeCodexRequest = (
  body: Json | undefined,
  headers: Headers,
  sourceFormat: string,
  responseFormat: string
): boolean => {
  const native = (format: string) => ["codex", "openai-response"].includes(format.trim().toLowerCase())
  return native(sourceFormat) && native(responseFormat) && isCodexResponsesLiteRequest(body, headers)
}

/** `isCodexCloakingDisabled`. */
export const isCodexCloakingDisabled = (config: Config, credential: CredentialSnapshot): boolean => {
  const attribute = (credential.attributes["disable_codex_cloaking"] ?? "").trim().toLowerCase()
  if (["1", "t", "true"].includes(attribute)) return true
  if (["0", "f", "false"].includes(attribute)) return false
  return config.upstream.codex["disable-codex-cloaking"]
}

const clientHeader = (headers: Headers, name: string): string => (headers.get(name) ?? "").trim()

export interface CodexHeaderInput {
  readonly credential: CredentialSnapshot
  readonly config: Config
  /** Inbound client headers. */
  readonly clientHeaders: Headers
  readonly stream: boolean
  /** Prompt cache id (`Session-Id`), when derived. */
  readonly sessionHeader?: string
  /** Final upstream body: the routing hint reads `service_tier` from it. */
  readonly body?: Json
  readonly baseModel: string
  readonly sessionId?: string
  /** Direct `/images/*` calls do not forward the client User-Agent (avoids Cloudflare 1010 blocks). */
  readonly omitClientUserAgent?: boolean
  /** models.json `config.override_header` of the model (model registry slice), applied last. */
  readonly modelHeaderOverrides?: Readonly<Record<string, string>>
  /** Adds the routing hint (Responses requests only). */
  readonly routingHint?: boolean
}

/** `applyCodexHeadersFromSources` + routing hint + model overrides. Names are lower case. */
export const buildCodexHeaders = (input: CodexHeaderInput): Record<string, string> => {
  const { credential, config, clientHeaders } = input
  const { apiKey } = codexCreds(credential)
  const isApiKey = codexUsesApiKey(credential)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (apiKey.trim() !== "") headers["authorization"] = `Bearer ${apiKey}`
  if (input.sessionHeader !== undefined && input.sessionHeader !== "") headers["session-id"] = input.sessionHeader

  const beta = clientHeader(clientHeaders, "x-codex-beta-features")
  if (beta !== "") headers["x-codex-beta-features"] = beta
  // misc.EnsureHeader: the client's value wins over what is already set.
  for (const name of [
    "version",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-client-request-id",
    "x-codex-window-id",
    "thread-id",
    "session-id",
    "x-openai-internal-codex-responses-lite"
  ]) {
    const value = clientHeader(clientHeaders, name)
    if (value !== "") headers[name] = value
  }

  // ensureHeaderWithConfigPrecedence: configured default (OAuth only), then the client's value, then the fixed one.
  const configUserAgent = isApiKey ? "" : config.oauth.providers.codex["header-defaults"]["user-agent"].trim()
  const clientUserAgent = input.omitClientUserAgent === true ? "" : clientHeader(clientHeaders, "user-agent")
  headers["user-agent"] =
    configUserAgent !== "" ? configUserAgent : clientUserAgent !== "" ? clientUserAgent : CODEX_USER_AGENT

  headers["accept"] = input.stream ? "text/event-stream" : "application/json"
  headers["connection"] = "Keep-Alive"

  const originator = clientHeader(clientHeaders, "originator")
  if (originator !== "") headers["originator"] = originator
  else if (!isApiKey) headers["originator"] = CODEX_ORIGINATOR
  if (!isApiKey) {
    const accountId = credential.metadata["account_id"]
    if (typeof accountId === "string") headers["chatgpt-account-id"] = accountId
  }
  applyCustomHeaders(headers, credential, clientHeaders, input.sessionId)
  if (!isCodexCloakingDisabled(config, credential)) {
    headers["user-agent"] = CODEX_USER_AGENT
    headers["originator"] = CODEX_ORIGINATOR
  }

  if (input.routingHint === true && !isApiKey) applyRoutingHint(headers, input, clientHeaders)
  for (const [name, value] of Object.entries(input.modelHeaderOverrides ?? {})) headers[name.toLowerCase()] = value
  if (
    input.modelHeaderOverrides !== undefined &&
    Object.keys(input.modelHeaderOverrides).length > 0 &&
    (headers["user-agent"] ?? "").includes("Mac OS") &&
    !["session-id", "session_id"].some((name) => (headers[name] ?? "").trim() !== "")
  ) {
    headers["session_id"] = crypto.randomUUID()
  }
  // Names are case-insensitive upstream; keep one entry per lower-case name (later writes win).
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value
  return out
}

/**
 * `applyCodexRoutingHint`: `model=<slug>[;tier=<service_tier>]`. An operator `header:` rule that resolves to a value
 * wins; API-key requests get no hint (native Codex sends none to API-key providers).
 */
const applyRoutingHint = (headers: Record<string, string>, input: CodexHeaderInput, clientHeaders: Headers): void => {
  delete headers[ROUTING_HINT_HEADER]
  const operator = customHeaders(input.credential, clientHeaders, input.sessionId)
    .filter(([name]) => name.toLowerCase() === ROUTING_HINT_HEADER)
    .map(([, value]) => value.trim())
    .find((value) => value !== "")
  if (operator !== undefined) {
    headers[ROUTING_HINT_HEADER] = operator
    return
  }
  const model = input.baseModel.trim()
  if (model === "") return
  let hint = `model=${model}`
  const tier = get(input.body, "service_tier")
  if (typeof tier === "string" && tier.trim() !== "") hint += `;tier=${tier.trim()}`
  headers[ROUTING_HINT_HEADER] = hint
}

export const CODEX_WEBSOCKET_BETA = "responses_websockets=2026-02-06"

export interface CodexWebsocketHeaderInput {
  readonly credential: CredentialSnapshot
  readonly config: Config
  readonly clientHeaders: Headers
  /** Prompt cache id: sent as `session_id` and `Conversation_id`. */
  readonly cacheId: string
  /** Native Codex client (lite requests). */
  readonly nativeRequest: boolean
  /** Final upstream body: the routing hint reads `service_tier` from it. */
  readonly body?: Json
  readonly baseModel: string
  readonly sessionId?: string
  readonly modelHeaderOverrides?: Readonly<Record<string, string>>
}

const SESSION_HEADERS = ["session-id", "session_id"]

/**
 * `applyCodexWebsocketHeaders` + routing hint + model overrides (Go `codex_websockets_request.go`). Names are lower
 * case. The handshake carries no `Content-Type`/`Accept`; the beta header selects the Responses WebSocket protocol.
 */
export const buildCodexWebsocketHeaders = (input: CodexWebsocketHeaderInput): Record<string, string> => {
  const { credential, config, clientHeaders } = input
  const { apiKey } = codexCreds(credential)
  const isApiKey = codexUsesApiKey(credential)
  const headers: Record<string, string> = {}
  if (input.cacheId !== "") {
    headers["session_id"] = input.cacheId
    headers["conversation_id"] = input.cacheId
  }
  if (apiKey.trim() !== "") headers["authorization"] = `Bearer ${apiKey}`

  // ensureHeaderWithPriority: what is set wins, then the client's value, then the configured default.
  const defaults = config.oauth.providers.codex["header-defaults"]
  const betaFeatures = clientHeader(clientHeaders, "x-codex-beta-features")
  const configBeta = isApiKey ? "" : defaults["beta-features"].trim()
  if (betaFeatures !== "") headers["x-codex-beta-features"] = betaFeatures
  else if (configBeta !== "") headers["x-codex-beta-features"] = configBeta
  const passthrough = [
    "x-codex-turn-state",
    "x-codex-turn-metadata",
    "x-client-request-id",
    "x-responsesapi-include-timing-metrics",
    "version"
  ]
  if (input.nativeRequest) passthrough.push("x-openai-internal-codex-responses-lite")
  for (const name of passthrough) {
    const value = clientHeader(clientHeaders, name)
    if (value !== "") headers[name] = value
  }

  // API keys only forward the client's User-Agent; OAuth credentials: configured default, client, fixed Codex value.
  const clientUserAgent = clientHeader(clientHeaders, "user-agent")
  const configUserAgent = isApiKey ? "" : defaults["user-agent"].trim()
  if (isApiKey) {
    if (clientUserAgent !== "") headers["user-agent"] = clientUserAgent
  } else {
    headers["user-agent"] =
      configUserAgent !== "" ? configUserAgent : clientUserAgent !== "" ? clientUserAgent : CODEX_USER_AGENT
  }

  const clientBeta = clientHeader(clientHeaders, "openai-beta")
  headers["openai-beta"] = clientBeta.includes("responses_websockets=") ? clientBeta : CODEX_WEBSOCKET_BETA

  // ensureCodexWebsocketSessionHeader: cache id, then the client's session header, then (Mac OS UA) a random id.
  let session = headers["session_id"] ?? ""
  for (const name of SESSION_HEADERS) {
    if (session === "") session = clientHeader(clientHeaders, name)
  }
  if (session === "" && (headers["user-agent"] ?? "").includes("Mac OS")) session = crypto.randomUUID()
  if (session !== "") headers["session_id"] = session
  delete headers["session-id"]

  if (input.nativeRequest && isCodexCloakingDisabled(config, credential)) {
    delete headers["session_id"]
    delete headers["conversation_id"]
    for (const name of [
      "session-id",
      "session_id",
      "conversation_id",
      "thread-id",
      "x-codex-routing-hint",
      "x-codex-window-id"
    ]) {
      const value = clientHeader(clientHeaders, name)
      if (value !== "") headers[name] = value
    }
  }

  const originator = clientHeader(clientHeaders, "originator")
  if (originator !== "") headers["originator"] = originator
  else if (!isApiKey) headers["originator"] = CODEX_ORIGINATOR
  if (!isApiKey) {
    const accountId = credential.metadata["account_id"]
    if (typeof accountId === "string" && accountId.trim() !== "") headers["chatgpt-account-id"] = accountId.trim()
  }
  applyCustomHeaders(headers, credential, clientHeaders, input.sessionId)
  if (!isCodexCloakingDisabled(config, credential)) {
    headers["user-agent"] = CODEX_USER_AGENT
    headers["originator"] = CODEX_ORIGINATOR
  }

  if (!isApiKey) {
    applyRoutingHint(
      headers,
      {
        credential,
        config,
        clientHeaders,
        stream: true,
        baseModel: input.baseModel,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {})
      },
      clientHeaders
    )
  }
  for (const [name, value] of Object.entries(input.modelHeaderOverrides ?? {})) headers[name.toLowerCase()] = value
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value
  return out
}
