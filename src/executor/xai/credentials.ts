/**
 * xAI credential access and base-URL routing.
 *
 * Go source: internal/runtime/executor/xai_executor_request.go (xaiCreds, xaiUsingAPI, xaiChatBaseURL,
 * xaiCompactBaseURL, xaiSpeechRequestURL, xaiIsDefaultAPIBaseURL, xaiIsCLIChatProxyBaseURL),
 * internal/auth/xai/types.go (DefaultAPIBaseURL, CLIChatProxyBaseURL).
 *
 * OAuth (Grok CLI login) credentials talk to the CLI chat proxy unless `using_api` says otherwise; API keys always use
 * the official API. `/responses/compact` and `/tts` never go to the chat proxy (it answers 404 and a 404 would cool
 * the whole credential pool down).
 */
import type { Json } from "../../json/index.ts";
import type { CredentialSnapshot } from "../picker.ts";

export const XAI_PROVIDER = "xai";

export const XAI_DEFAULT_API_BASE_URL = "https://api.x.ai/v1";

export const XAI_CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** `xaiCreds`: bearer token (attribute API key, else OAuth access token) and configured base URL. */
export const xaiCreds = (credential: CredentialSnapshot) => {
  let token = text(credential.attributes["api_key"]);
  let baseURL = text(credential.attributes["base_url"]);

  if (token === "") token = text(credential.metadata["access_token"]);

  if (baseURL === "") baseURL = text(credential.metadata["base_url"]);

  return { token, baseURL };
};

/** `strconv.ParseBool`. */
const parseBool = (raw: string): boolean | undefined => {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(raw)) return true;

  if (["0", "f", "F", "FALSE", "false", "False"].includes(raw)) return false;

  return undefined;
};

/** `xaiUsingAPI`: official API path for chat and media; OAuth defaults to the Grok Build proxy. */
export const xaiUsingAPI = (credential: CredentialSnapshot): boolean => {
  const attribute = text(credential.attributes["using_api"]);

  if (attribute !== "") {
    const parsed = parseBool(attribute);

    if (parsed !== undefined) return parsed;
  }

  const raw = credential.metadata["using_api"];

  if (typeof raw === "boolean") return raw;

  if (typeof raw === "string") {
    const parsed = parseBool(raw.trim());

    if (parsed !== undefined) return parsed;
  }

  const kind = text(credential.attributes["auth_kind"]);

  if (kind !== "") return kind.toLowerCase() !== "oauth";

  return text(credential.metadata["auth_kind"]).toLowerCase() !== "oauth";
};

const normalizeBaseUrl = (baseURL: string): string => baseURL.trim().replace(/\/+$/, "");

export const isDefaultApiBaseUrl = (baseURL: string): boolean =>
  normalizeBaseUrl(baseURL) === normalizeBaseUrl(XAI_DEFAULT_API_BASE_URL);

export const isCliChatProxyBaseUrl = (baseURL: string): boolean =>
  normalizeBaseUrl(baseURL) === normalizeBaseUrl(XAI_CLI_CHAT_PROXY_BASE_URL);

/** `xaiChatBaseURL`: HTTP chat and media (image/video) requests. */
export const xaiChatBaseUrl = (credential: CredentialSnapshot): string => {
  const { baseURL } = xaiCreds(credential);

  if (xaiUsingAPI(credential)) return baseURL === "" ? XAI_DEFAULT_API_BASE_URL : baseURL;

  if (baseURL !== "" && !isDefaultApiBaseUrl(baseURL)) return baseURL;

  return XAI_CLI_CHAT_PROXY_BASE_URL;
};

/** `xaiCompactBaseURL`: `/responses/compact` and `/tts` stay on the official API (or an explicit custom base URL). */
export const xaiCompactBaseUrl = (credential: CredentialSnapshot): string => {
  const { baseURL } = xaiCreds(credential);

  return baseURL === "" || isCliChatProxyBaseUrl(baseURL) ? XAI_DEFAULT_API_BASE_URL : baseURL;
};

/** `xaiSpeechRequestURL`. */
export const xaiSpeechUrl = (credential: CredentialSnapshot): string =>
  `${xaiCompactBaseUrl(credential).replace(/\/+$/, "")}/tts`;

export const joinUrl = (baseURL: string, path: string): string =>
  `${baseURL.replace(/\/+$/, "")}${path}`;
