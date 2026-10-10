/**
 * Meta (Muse Code) login: RFC 8628 device flow followed by minting an LLM API key from the DCA token.
 *
 * Go source: auth_files_provider_oauth.go (`RequestMetaToken`, `buildMetaAuthRecord`), internal/auth/meta/meta.go
 * (`StartDeviceFlow`, `WaitForAuthorization`, `MintAPIKey`, `CreateTokenStorage`, `MetaTokenStorage.SaveTokenToFile`,
 * `CredentialFileName`). Docs: config-management-oauth.md §3.2.5.
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { META_DEFAULT_BASE_URL, metaMintUrl } from "../../credentials/refresh/meta.ts";
import type { JsonObject } from "../../json/index.ts";
import { sha256Hex } from "../encoding.ts";
import { call, clipBody, parseJsonObject, rfc3339, seconds, str, tryCall } from "./http.ts";
import { type DeviceFlow, flowFailure } from "./types.ts";

export const META_DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";

export const META_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";

export const META_CLIENT_ID = "1031625952748946";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const USER_AGENT = "muse-code/1.0.2";

const MAX_POLL_MS = 15 * 60_000;

const DEFAULT_INTERVAL_MS = 5_000;

const MAX_ERROR_TEXT = 512;

/** `CredentialFileName`: sanitised email + hash of the original, else a hash of the identity, else `meta-oauth`. */
export const metaFileName = async (email: string, sub: string): Promise<string> => {
  const clean = email.trim();

  if (clean !== "") {
    const sanitized = clean.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

    return `meta-${sanitized}-${await sha256Hex(clean, 8)}.json`;
  }

  const cleanSub = sub.trim();

  return cleanSub === "" ? "meta-oauth.json" : `meta-${await sha256Hex(cleanSub, 8)}.json`;
};

const formPost = (url: string, params: Record<string, string>) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": USER_AGENT }),
    HttpClientRequest.bodyUrlParams(params),
  );

/** `MintAPIKey`; failures are advisory (the DCA token is stored without a key). */
const mintApiKey = (dcaToken: string, mintUrl: string | undefined) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(metaMintUrl(mintUrl)).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${dcaToken}`,
        "user-agent": USER_AGENT,
        accept: "application/json",
      }),
      HttpClientRequest.bodyJsonUnsafe({ dca_token: dcaToken }),
    );

    const reply = yield* tryCall(request);

    if (reply === undefined || reply.status < 200 || reply.status >= 300) return undefined;
    const minted = parseJsonObject(reply.text);

    return minted !== undefined && str(minted.api_key) !== "" ? minted : undefined;
  });

export const metaFlow = (mintUrl?: string): DeviceFlow => ({
  kind: "device",
  provider: "meta",
  expiredMessage:
    "Authentication failed: meta auth: authorization timed out or canceled: context deadline exceeded",
  saveMessage: "Failed to save token to file",
  startFailureMessage: "failed to start device authorization flow",
  start: () =>
    Effect.gen(function* () {
      const reply = yield* call(
        formPost(META_DEVICE_AUTHORIZATION_URL, { client_id: META_CLIENT_ID }),
      );

      const device =
        reply.status >= 200 && reply.status < 300 ? parseJsonObject(reply.text) : undefined;

      const deviceCode = str(device?.device_code);
      const userCode = str(device?.user_code);

      if (device === undefined || deviceCode === "" || userCode === "") {
        return yield* flowFailure(
          "meta device flow: response missing required device_code or user_code",
        );
      }

      const url = str(device.verification_uri_complete) || str(device.verification_uri);
      const interval = Math.trunc(seconds(device.interval));
      const expiresIn = Math.trunc(seconds(device.expires_in));
      const intervalMs = interval > 0 ? interval * 1000 : DEFAULT_INTERVAL_MS;

      return {
        url,
        userCode,
        expiresIn: expiresIn > 0 ? expiresIn : MAX_POLL_MS / 1000,
        data: { device_code: deviceCode } satisfies JsonObject,
        intervalMs,
        // Go polls from a ticker: the first attempt happens after one interval.
        firstPollDelayMs: intervalMs,
        windowMs: expiresIn > 0 ? Math.min(MAX_POLL_MS, expiresIn * 1000) : MAX_POLL_MS,
      };
    }),
  poll: ({ data, now, intervalMs }) =>
    Effect.gen(function* () {
      const reply = yield* tryCall(
        formPost(META_TOKEN_URL, {
          grant_type: DEVICE_GRANT,
          device_code: str(data.device_code),
          client_id: META_CLIENT_ID,
        }),
      );

      // Network and read errors are retried silently, like Go.
      if (reply === undefined) return { _tag: "pending" as const };

      if (reply.status !== 200) {
        const failure = parseJsonObject(reply.text) ?? {};
        const error = str(failure.error);

        switch (error) {
          case "authorization_pending":
            return { _tag: "pending" as const };
          case "slow_down":
            return { _tag: "pending" as const, intervalMs: intervalMs + DEFAULT_INTERVAL_MS };
          case "access_denied":
            return yield* flowFailure(
              "Authentication failed: meta auth: access was denied by user",
            );
          case "expired_token":
            return yield* flowFailure("Authentication failed: meta auth: device code has expired");
          case "":
            return { _tag: "pending" as const };
          default:
            return yield* flowFailure(
              `Authentication failed: meta auth: error from authorization server: ${error}: ${clipBody(str(failure.error_description)).slice(0, MAX_ERROR_TEXT)}`,
            );
        }
      }

      const token = parseJsonObject(reply.text);

      if (token === undefined) {
        return yield* flowFailure("Authentication failed: meta auth: parse token response failed");
      }

      const dcaToken = str(token.access_token);

      if (dcaToken === "")
        return yield* flowFailure(
          "Authentication failed: meta auth: response missing access_token",
        );

      const expiresIn = Math.trunc(seconds(token.expires_in));
      const dcaExpiresAt = expiresIn > 0 ? Math.floor(now / 1000) + expiresIn : 0;
      const dcaExpired = dcaExpiresAt > 0 ? rfc3339(dcaExpiresAt * 1000) : "";
      const minted = yield* mintApiKey(dcaToken, mintUrl);
      const apiKey = str(minted?.api_key);
      const email = str(minted?.user_email);
      const name = str(minted?.user_full_name);

      // `MetaTokenStorage.SaveTokenToFile` omits empty values; the minted key is the usable credential.
      const metadata: JsonObject = {
        type: "meta",
        auth_kind: "oauth",
        access_token: apiKey === "" ? dcaToken : apiKey,
      };

      metadata.dca_token = dcaToken;

      if (apiKey !== "") metadata.api_key = apiKey;

      if (str(token.token_type) !== "") metadata.token_type = str(token.token_type);

      if (expiresIn > 0) metadata.expires_in = expiresIn;

      // With a minted key `expired` stays empty so the selector does not block the credential on the DCA timer.
      if (apiKey === "" && dcaExpired !== "") metadata.expired = dcaExpired;

      if (dcaExpired !== "") metadata.dca_expired = dcaExpired;

      if (dcaExpiresAt > 0) metadata.dca_expires_at = dcaExpiresAt;
      metadata.last_refresh = rfc3339(now);
      metadata.base_url = str(minted?.base_url) || META_DEFAULT_BASE_URL;

      if (email !== "") metadata.email = email;

      if (name !== "") metadata.name = name;

      if (minted !== undefined) {
        metadata.subs_tier_name = str(minted.subs_tier_name);
        metadata.subs_tier_id = str(minted.subs_tier_id);
        metadata.is_subs_active = minted.is_subs_active === true;
        metadata.has_payment_method = minted.has_payment_method === true;
      }

      // The management handler passes the DCA token as the `sub` argument of the file name.
      const fileName = yield* Effect.promise(() => metaFileName(email, dcaToken));

      return { _tag: "done" as const, record: { fileName, metadata } };
    }),
});
