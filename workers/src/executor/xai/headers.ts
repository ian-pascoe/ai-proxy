/**
 * xAI upstream request headers.
 *
 * Go source: internal/runtime/executor/xai_executor_request.go (applyXAIHeaders, applyXAIDefaultHeaders,
 * applyXAIChatHeaders, applyXAICustomHeaders) and xai_executor.go (CLI identity constants).
 * Names are lower case. Custom `header:<Name>` attributes are applied last and override built-in values.
 */
import { applyCustomHeaders } from "../helps/custom-headers.ts"
import type { CredentialSnapshot } from "../picker.ts"
import { isCliChatProxyBaseUrl, xaiChatBaseUrl, xaiCreds, xaiUsingAPI } from "./credentials.ts"

export const XAI_TOKEN_AUTH_VALUE = "xai-grok-cli"
export const XAI_CLIENT_IDENTIFIER = "grok-shell"
export const XAI_AUTHENTICATE_RESPONSE = "authenticate-response"

export interface XaiHeaderInput {
  readonly credential: CredentialSnapshot
  readonly clientHeaders: Headers
  readonly stream: boolean
  /** `x-grok-conv-id` (also the prompt cache key), when known. */
  readonly convId?: string
  /** Session identity for `$CPA-SESSION-ID` custom headers. */
  readonly sessionId?: string
}

/** `applyXAIDefaultHeaders`. */
const defaultHeaders = (input: XaiHeaderInput): Record<string, string> => {
  const { token } = xaiCreds(input.credential)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token.trim() !== "") headers["authorization"] = `Bearer ${token}`
  headers["accept"] = input.stream ? "text/event-stream" : "application/json"
  headers["connection"] = "Keep-Alive"
  if (input.convId !== undefined && input.convId !== "") headers["x-grok-conv-id"] = input.convId
  return headers
}

const withCustom = (headers: Record<string, string>, input: XaiHeaderInput): Record<string, string> => {
  applyCustomHeaders(headers, input.credential, input.clientHeaders, input.sessionId)
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value
  return out
}

/** `applyXAIHeaders`: images, videos, speech and compaction (no CLI identity, even for OAuth). */
export const buildXaiHeaders = (input: XaiHeaderInput): Record<string, string> =>
  withCustom(defaultHeaders(input), input)

/** `applyXAIChatHeaders`: `POST /responses`; adds the Grok CLI identity when talking to the chat proxy. */
export const buildXaiChatHeaders = (
  input: XaiHeaderInput & { readonly clientVersion: string }
): Record<string, string> => {
  if (xaiUsingAPI(input.credential)) return buildXaiHeaders(input)
  const headers = defaultHeaders(input)
  if (isCliChatProxyBaseUrl(xaiChatBaseUrl(input.credential))) {
    headers["x-xai-token-auth"] = XAI_TOKEN_AUTH_VALUE
    headers["x-grok-client-version"] = input.clientVersion
    headers["user-agent"] = `xai-grok-workspace/${input.clientVersion}`
    headers["x-grok-client-identifier"] = XAI_CLIENT_IDENTIFIER
    headers["x-authenticateresponse"] = XAI_AUTHENTICATE_RESPONSE
  }
  return withCustom(headers, input)
}

/**
 * `applyXAIWebsocketHeaders`: JSON content type, bearer token, `x-grok-conv-id` and the custom headers. No CLI identity
 * headers (the chat proxy does not serve WebSocket upgrades).
 */
export const buildXaiWebsocketHeaders = (input: XaiHeaderInput): Record<string, string> => {
  const { token } = xaiCreds(input.credential)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token.trim() !== "") headers["authorization"] = `Bearer ${token}`
  if (input.convId !== undefined && input.convId !== "") headers["x-grok-conv-id"] = input.convId
  return withCustom(headers, input)
}
