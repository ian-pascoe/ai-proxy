/**
 * `POST /v8/management/requests/api-call`: the panel's generic upstream probe (provider quota endpoints).
 *
 * Go source: internal/api/handlers/management/api_tools.go (`APICall`). `$TOKEN$` in header values and in `data` is
 * replaced with the credential's token (refreshed first when needed; JSON-escaped inside JSON bodies). The request is
 * bounded to 60 s like Go (explicit exception to "no timeouts after connect", see AGENTS.md). Differences: Workers
 * `fetch` cannot route through a proxy (`proxy_url` is validated but ignored) and cannot override the `Host` header
 * (ignored). The token never appears in logs.
 *
 * Security: the route is admin-only (Access admin gate, which also refuses cross-site requests) and `$TOKEN$` is only
 * substituted for `https:` URLs (Workers deviation). The target host is not restricted to the credential's provider
 * (the panel probes several provider hosts and admins can download credential files anyway); it is an outbound
 * request from the Worker to any public host, see docs/ACCESS.md "Management API security".
 */
import { Effect, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { isValidJson } from "../http/json-text.ts";
import { isJsonObject, type Json } from "../json/index.ts";
import { bodyJson, controlPlane, handled, jsonReply, replyError } from "./http.ts";

const TIMEOUT = "60 seconds";

const TOKEN_PLACEHOLDER = "$TOKEN$";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** JSON-escapes a token for insertion between the quotes of a JSON string. */
const jsonEscape = (token: string): string => JSON.stringify(token).slice(1, -1);

const validProxy = (value: string): boolean => {
  if (["direct", "none"].includes(value.toLowerCase())) return true;

  try {
    return ["http:", "https:", "socks5:", "socks5h:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const apiCall = Effect.gen(function* () {
  const body = yield* bodyJson;

  if (!isJsonObject(body)) return yield* replyError(400, "invalid body");
  const method = text(body.method).toUpperCase();

  if (method === "") return yield* replyError(400, "missing method");
  const urlText = text(body.url);

  if (urlText === "") return yield* replyError(400, "missing url");

  const url = yield* Effect.try({
    try: () => new URL(urlText),
    catch: () => replyError(400, "invalid url"),
  });

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
    return yield* replyError(400, "invalid url");
  }

  const proxy = text(body.proxy_url);

  if (proxy !== "" && !validProxy(proxy)) return yield* replyError(400, "invalid proxy_url");
  const authIndex = text(body.auth_index) || text(body.authIndex) || text(body.AuthIndex);

  const headers: Record<string, string> = {};

  if (isJsonObject(body.header)) {
    for (const [key, value] of Object.entries(body.header))
      if (typeof value === "string") headers[key] = value;
  }

  let data = typeof body.data === "string" ? body.data : "";

  let token: string | undefined;

  const resolveToken = Effect.gen(function* () {
    if (token !== undefined) return token;

    // Workers deviation: a credential token is never sent in clear text.
    if (url.protocol !== "https:")
      return yield* replyError(400, "auth token requires an https url");

    if (authIndex === "") return yield* replyError(400, "auth token not found");

    const result = yield* controlPlane("resolveApiCallToken", (stub) =>
      stub.resolveApiCallToken(authIndex),
    );

    if (result.ok) {
      token = result.token;

      return token;
    }

    if (result.error === "not_found")
      return yield* replyError(400, "auth credential not found for auth_index");

    return yield* replyError(
      400,
      result.error === "refresh_failed" ? "auth token refresh failed" : "auth token not found",
    );
  });

  for (const [key, value] of Object.entries(headers)) {
    if (value.includes(TOKEN_PLACEHOLDER))
      headers[key] = value.replaceAll(TOKEN_PLACEHOLDER, yield* resolveToken);
  }

  if (data.includes(TOKEN_PLACEHOLDER)) {
    const resolved = yield* resolveToken;
    data = data.replaceAll(TOKEN_PLACEHOLDER, isValidJson(data) ? jsonEscape(resolved) : resolved);
  }

  // SAFETY: method is one of the supported HTTP verbs validated earlier; the client accepts the whole verb union.
  let request = HttpClientRequest.make(method as "GET")(url);

  for (const [key, value] of Object.entries(headers)) {
    // `Host` cannot be overridden from a Worker.
    if (key.toLowerCase() !== "host") request = HttpClientRequest.setHeader(request, key, value);
  }

  if (data !== "" && method !== "GET" && method !== "HEAD")
    request = HttpClientRequest.bodyText(request, data);

  const client = yield* HttpClient.HttpClient;

  const outcome = yield* Effect.gen(function* () {
    const response = yield* client.execute(request).pipe(Effect.timeout(TIMEOUT));
    const responseBody = yield* response.text.pipe(Effect.timeout(TIMEOUT));

    return { response, responseBody };
  }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.result);

  if (Result.isFailure(outcome)) {
    yield* Effect.logDebug("management api-call request failed");

    return yield* replyError(502, "request failed");
  }

  const { response, responseBody } = outcome.success;
  const header: Record<string, string[]> = {};

  for (const [key, value] of Object.entries(response.headers)) header[key] = [value];

  return jsonReply(200, { status_code: response.status, header, body: responseBody });
});

export const apiCallHandler = handled(apiCall);
