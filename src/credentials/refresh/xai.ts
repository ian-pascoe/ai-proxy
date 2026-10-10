/**
 * xAI OAuth refresh.
 *
 * Go source: internal/auth/xai/xai.go (`Discover`, `ValidateOAuthEndpoint`, `RefreshTokens`, `postTokenForm`,
 * `parseJWTIdentity`), internal/runtime/executor/xai_executor_auth.go (`Refresh`). Docs: providers-other.md §1.3.
 * Deviation: a cached `token_endpoint` that is not an https x.ai URL is ignored and rediscovered (Go trusts it).
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import type { JsonObject } from "../../json/index.ts";
import { decodeJwtClaims } from "../expiry.ts";
import { refreshError } from "./error.ts";
import { parseJsonObject, rfc3339, send, seconds, statusFailure, str } from "./http.ts";
import type { RefreshContext, RefreshEffect, RefreshProtocolEffect } from "./types.ts";

export const XAI_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";

/** `ValidateOAuthEndpoint`: https and a host on x.ai. */
export const isXaiOAuthEndpoint = (raw: string): boolean => {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase();

    return url.protocol === "https:" && (host === "x.ai" || host.endsWith(".x.ai"));
  } catch {
    return false;
  }
};

const discoverTokenEndpoint = (): RefreshEffect<string> =>
  Effect.gen(function* () {
    const reply = yield* send(
      HttpClientRequest.get(XAI_DISCOVERY_URL).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
    );

    if (reply.status !== 200) return yield* Effect.fail(statusFailure("xai discovery", reply));
    const endpoint = str(parseJsonObject(reply.text)?.token_endpoint);

    if (!isXaiOAuthEndpoint(endpoint)) {
      return yield* Effect.fail(
        refreshError({
          message: "xai discovery token_endpoint is missing or not an https x.ai URL",
        }),
      );
    }

    return endpoint;
  });

export const refreshXai = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata };
    const refreshToken = str(metadata.refresh_token);

    if (refreshToken === "") return metadata;

    const cached = str(metadata.token_endpoint);
    const tokenEndpoint = isXaiOAuthEndpoint(cached) ? cached : yield* discoverTokenEndpoint();

    const request = HttpClientRequest.post(tokenEndpoint).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyUrlParams({
        grant_type: "refresh_token",
        client_id: XAI_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    );

    const reply = yield* send(request);

    if (reply.status !== 200) return yield* Effect.fail(statusFailure("xai token request", reply));
    const body = parseJsonObject(reply.text);

    if (body === undefined)
      return yield* Effect.fail(refreshError({ message: "xai token response: parse body failed" }));
    const accessToken = str(body.access_token);

    if (accessToken === "")
      return yield* Effect.fail(
        refreshError({ message: "xai token response missing access_token" }),
      );

    const idToken = str(body.id_token);
    const claims = idToken === "" ? undefined : decodeJwtClaims(idToken);
    const expiresIn = Math.trunc(seconds(body.expires_in));

    metadata.type = "xai";
    metadata.auth_kind = "oauth";
    metadata.access_token = accessToken;
    const rotated = str(body.refresh_token);

    if (rotated !== "") metadata.refresh_token = rotated;

    if (idToken !== "") metadata.id_token = idToken;

    if (str(body.token_type) !== "") metadata.token_type = str(body.token_type);

    if (expiresIn > 0) {
      metadata.expires_in = expiresIn;
      metadata.expired = rfc3339(context.now + expiresIn * 1000);
    }

    if (str(claims?.email) !== "") metadata.email = str(claims?.email);

    if (str(claims?.sub) !== "") metadata.sub = str(claims?.sub);
    metadata.token_endpoint = tokenEndpoint;

    if (str(metadata.base_url) === "") metadata.base_url = XAI_DEFAULT_BASE_URL;
    metadata.last_refresh = rfc3339(context.now);

    return metadata;
  });
