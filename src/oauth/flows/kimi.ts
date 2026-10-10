/**
 * Kimi / Kimi.ai login: RFC 8628 device flow.
 *
 * Go source: auth_files_provider_oauth.go (`RequestKimiToken`, `requestKimiTokenWithDomain`), internal/auth/kimi/
 * kimi.go (`RequestDeviceCode`, `PollForToken`, `exchangeDeviceCode`, `CreateTokenStorage`) and token.go.
 * Docs: config-management-oauth.md §3.2.6. The device headers are constants (no hostname/OS on Workers).
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { KIMI_CLIENT_ID } from "../../credentials/refresh/kimi.ts";
import type { JsonObject } from "../../json/index.ts";
import { call, clipBody, parseJsonObject, rfc3339, seconds, str, tryCall } from "./http.ts";
import { type DeviceFlow, flowFailure } from "./types.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const MIN_INTERVAL_MS = 5_000;

const MAX_POLL_MS = 15 * 60_000;

const MAX_ERROR_TEXT = 512;

export interface KimiDomain {
  readonly provider: "kimi" | "kimi-ai";
  readonly domain: "kimi.com" | "kimi.ai";
  readonly displayName: string;
  readonly oauthHost: string;
  readonly baseUrl: string;
  readonly statePrefix: string;
}

const KIMI_COM: KimiDomain = {
  provider: "kimi",
  domain: "kimi.com",
  displayName: "Kimi",
  oauthHost: "https://auth.kimi.com",
  baseUrl: "https://api.kimi.com/coding",
  statePrefix: "kmi",
};

const KIMI_AI: KimiDomain = {
  provider: "kimi-ai",
  domain: "kimi.ai",
  displayName: "Kimi.ai",
  oauthHost: "https://auth.kimi.ai",
  baseUrl: "https://api.kimi.ai/coding",
  statePrefix: "kmi-ai",
};

/** `IsKimiAIDomain`. */
export const isKimiAiDomain = (domain: string): boolean => {
  const value = domain.trim().toLowerCase();

  return value === "kimi.ai" || value === "ai" || value === "kimi-ai" || value.endsWith(".kimi.ai");
};

export const kimiDomain = (domain: string): KimiDomain =>
  isKimiAiDomain(domain) ? KIMI_AI : KIMI_COM;

const deviceHeaders = (deviceId: string) => ({
  accept: "application/json",
  "x-msh-platform": "CLIProxyAPI",
  "x-msh-version": "cliproxy-workers",
  "x-msh-device-name": "cliproxy-workers",
  "x-msh-device-model": "Cloudflare Workers",
  "x-msh-device-id": deviceId,
});

export const kimiFlow = (target: KimiDomain): DeviceFlow => ({
  kind: "device",
  provider: target.provider,
  expiredMessage: "Authentication failed: kimi: device code expired",
  saveMessage: "Failed to save authentication tokens",
  startFailureMessage: "failed to generate authorization url",
  start: () =>
    Effect.gen(function* () {
      const deviceId = crypto.randomUUID();

      const request = HttpClientRequest.post(
        `${target.oauthHost}/api/oauth/device_authorization`,
      ).pipe(
        HttpClientRequest.setHeaders(deviceHeaders(deviceId)),
        HttpClientRequest.bodyUrlParams({ client_id: KIMI_CLIENT_ID }),
      );

      const reply = yield* call(request);
      const device = reply.status === 200 ? parseJsonObject(reply.text) : undefined;

      if (device === undefined) {
        return yield* flowFailure(`kimi: device code request failed with status ${reply.status}`);
      }

      const expiresIn = Math.trunc(seconds(device.expires_in));
      const intervalMs = Math.max(Math.trunc(seconds(device.interval)) * 1000, MIN_INTERVAL_MS);

      return {
        url: str(device.verification_uri_complete) || str(device.verification_uri),
        ...(str(device.user_code) === "" ? {} : { userCode: str(device.user_code) }),
        ...(expiresIn > 0 ? { expiresIn } : {}),
        data: { device_code: str(device.device_code), device_id: deviceId } satisfies JsonObject,
        intervalMs,
        firstPollDelayMs: intervalMs,
        windowMs: expiresIn > 0 ? Math.min(MAX_POLL_MS, expiresIn * 1000) : MAX_POLL_MS,
      };
    }),
  poll: ({ data, now }) =>
    Effect.gen(function* () {
      const deviceId = str(data.device_id);

      const reply = yield* tryCall(
        HttpClientRequest.post(`${target.oauthHost}/api/oauth/token`).pipe(
          HttpClientRequest.setHeaders(deviceHeaders(deviceId)),
          HttpClientRequest.bodyUrlParams({
            client_id: KIMI_CLIENT_ID,
            device_code: str(data.device_code),
            grant_type: DEVICE_GRANT,
          }),
        ),
      );

      if (reply === undefined || reply.status >= 500) return { _tag: "pending" as const };
      // Kimi answers 200 for both success and pending states.
      const payload = parseJsonObject(reply.text);

      if (payload === undefined)
        return yield* flowFailure("Authentication failed: kimi: failed to parse token response");
      const error = str(payload.error);

      if (error !== "") {
        switch (error) {
          // `slow_down` keeps the interval (Go does not increase it).
          case "authorization_pending":
          case "slow_down":
            return { _tag: "pending" as const };
          case "expired_token":
            return yield* flowFailure("Authentication failed: kimi: device code expired");
          case "access_denied":
            return yield* flowFailure("Authentication failed: kimi: access denied by user");
          default:
            return yield* flowFailure(
              `Authentication failed: kimi: OAuth error: ${error} - ${clipBody(str(payload.error_description)).slice(0, MAX_ERROR_TEXT)}`,
            );
        }
      }

      const accessToken = str(payload.access_token);

      if (accessToken === "")
        return yield* flowFailure("Authentication failed: kimi: empty access token in response");

      const expiresIn = seconds(payload.expires_in);

      const metadata: JsonObject = {
        type: target.provider,
        access_token: accessToken,
        refresh_token: str(payload.refresh_token),
        token_type: str(payload.token_type),
        scope: str(payload.scope),
        timestamp: now,
        domain: target.domain,
        base_url: target.baseUrl,
      };

      if (expiresIn > 0)
        metadata.expired = rfc3339((Math.floor(now / 1000) + Math.trunc(expiresIn)) * 1000);

      if (deviceId !== "") metadata.device_id = deviceId;
      const prefix = target.provider === "kimi-ai" ? "kimi-ai" : "kimi";

      return { _tag: "done" as const, record: { fileName: `${prefix}-${now}.json`, metadata } };
    }),
});

export const kimiStatePrefix = (target: KimiDomain): string => target.statePrefix;
