/**
 * Codex (ChatGPT) login: authorization code + PKCE with the pasted `localhost:1455` redirect URL, and the OpenAI
 * device-code flow (the Workers-friendly alternative, no localhost redirect).
 *
 * Go source: auth_files_provider_oauth.go (`RequestCodexToken`), internal/auth/codex/openai_auth.go
 * (`GenerateAuthURL`, `ExchangeCodeForTokensWithRedirect`, `CreateTokenStorage`), jwt_parser.go, filename.go,
 * sdk/auth/codex_device.go (device flow, `buildAuthRecord`). Docs: config-management-oauth.md §3.2.2.
 */
import { Effect } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import type { Json, JsonObject } from "../../json/index.ts";
import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  codexIdentity,
} from "../../credentials/refresh/codex.ts";
import { encodeQuery, generatePkce, sha256Hex } from "../encoding.ts";
import { call, clipBody, parseJsonObject, rfc3339, scrub, seconds, str } from "./http.ts";
import {
  type CallbackFlow,
  type CredentialRecord,
  type DeviceFlow,
  type FlowFailure,
  flowFailure,
} from "./types.ts";

export const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize";

export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";

export const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";

export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";

export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";

export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

const DEFAULT_PLAN = "free";

const DEVICE_WINDOW_MS = 15 * 60_000;

const DEVICE_DEFAULT_INTERVAL_MS = 5_000;

const MAX_ERROR_TEXT = 512;

const EXCHANGE_FAILED = "Failed to exchange authorization code for tokens";

/** `CredentialFileName(email, plan, hash, true)`: plan lowercased, non-alphanumeric runs become `-`. */
export const codexFileName = (email: string, planType: string, hashAccountId: string): string => {
  const plan = planType
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase())
    .join("-");

  const cleanEmail = email.trim();
  const hash = hashAccountId.trim();

  if (hash !== "")
    return plan === ""
      ? `codex-${hash}-${cleanEmail}.json`
      : `codex-${hash}-${cleanEmail}-${plan}.json`;

  return plan === "" ? `codex-${cleanEmail}.json` : `codex-${cleanEmail}-${plan}.json`;
};

interface ExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly now: number;
  /** Prepended to every failure (`Authentication failed: ` in the device flow). */
  readonly prefix?: string;
  /** The device flow refuses accounts without an email (`buildAuthRecord`). */
  readonly requireEmail?: boolean;
}

/** `ExchangeCodeForTokensWithRedirect` + `CreateTokenStorage` + the handler's file naming. */
const exchangeCode = (
  input: ExchangeInput,
): Effect.Effect<CredentialRecord, FlowFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const failure = `${input.prefix ?? ""}${EXCHANGE_FAILED}`;

    const request = HttpClientRequest.post(CODEX_TOKEN_URL).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: input.code,
        redirect_uri: input.redirectUri.trim(),
        code_verifier: input.codeVerifier,
      }),
    );

    const reply = yield* call(request).pipe(
      Effect.mapError((error) => flowFailure(`${failure}: ${error.message}`)),
    );

    if (reply.status !== 200) {
      const detail = scrub(clipBody(reply.text).slice(0, MAX_ERROR_TEXT), [
        input.code,
        input.codeVerifier,
      ]);

      return yield* flowFailure(
        `${failure}: token exchange failed with status ${reply.status}: ${detail}`,
      );
    }

    const body = parseJsonObject(reply.text);
    const accessToken = str(body?.access_token);

    if (body === undefined || accessToken === "") {
      return yield* flowFailure(`${failure}: failed to parse token response`);
    }

    const idToken = str(body.id_token);
    const identity = idToken === "" ? undefined : codexIdentity(idToken);
    const email = identity?.email ?? "";

    if (input.requireEmail === true && email === "") {
      return yield* flowFailure(
        `${input.prefix ?? ""}codex token storage missing account information`,
      );
    }

    const accountId = identity?.accountId ?? "";
    const planType = identity?.planType ?? DEFAULT_PLAN;

    const hashAccountId =
      accountId === "" ? "" : yield* Effect.promise(() => sha256Hex(accountId, 4));

    const metadata: JsonObject = {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: str(body.refresh_token),
      account_id: accountId,
      last_refresh: rfc3339(input.now),
      email,
      type: "codex",
      expired: rfc3339(input.now + seconds(body.expires_in) * 1000),
      plan_type: planType,
    };

    return { fileName: codexFileName(email, planType, hashAccountId), metadata };
  });

export const codexFlow = (): CallbackFlow => ({
  kind: "callback",
  provider: "codex",
  timeoutMessage: "Timeout waiting for OAuth callback",
  deniedMessage: "Bad Request",
  saveMessage: "Failed to save authentication tokens",
  start: ({ state }) =>
    Effect.promise(async () => {
      const pkce = await generatePkce(96);

      const query = encodeQuery({
        client_id: CODEX_CLIENT_ID,
        response_type: "code",
        redirect_uri: CODEX_REDIRECT_URI,
        scope: "openid email profile offline_access",
        state,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: "S256",
        prompt: "login",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
      });

      return {
        url: `${CODEX_AUTH_URL}?${query}`,
        data: { code_verifier: pkce.codeVerifier } satisfies JsonObject,
      };
    }),
  complete: ({ code, data, now }) =>
    exchangeCode({
      code,
      codeVerifier: str(data.code_verifier),
      redirectUri: CODEX_REDIRECT_URI,
      now,
    }),
});

/** `parseCodexDevicePollInterval`: seconds as a string or a number, 5 s by default. */
const parseInterval = (value: Json | undefined): number => {
  let parsed = Number.NaN;

  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") parsed = Number(value.trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed * 1000 : DEVICE_DEFAULT_INTERVAL_MS;
};

export const codexDeviceFlow = (): DeviceFlow => ({
  kind: "device",
  provider: "codex",
  expiredMessage: "Authentication failed: codex device authentication timed out after 15 minutes",
  saveMessage: "Failed to save authentication tokens",
  startFailureMessage: "failed to start device authorization flow",
  start: () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(CODEX_DEVICE_USERCODE_URL).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({ client_id: CODEX_CLIENT_ID }),
      );

      const reply = yield* call(request);

      if (reply.status < 200 || reply.status >= 300) {
        return yield* flowFailure(`codex device code request failed with status ${reply.status}`);
      }

      const body = parseJsonObject(reply.text);
      const userCode = str(body?.user_code) || str(body?.usercode);
      const deviceAuthId = str(body?.device_auth_id);

      if (body === undefined || userCode === "" || deviceAuthId === "") {
        return yield* flowFailure("codex device flow did not return required fields");
      }

      const intervalMs = parseInterval(body.interval);

      return {
        url: CODEX_DEVICE_VERIFICATION_URL,
        userCode,
        expiresIn: DEVICE_WINDOW_MS / 1000,
        data: { device_auth_id: deviceAuthId, user_code: userCode } satisfies JsonObject,
        intervalMs,
        firstPollDelayMs: intervalMs,
        windowMs: DEVICE_WINDOW_MS,
      };
    }),
  poll: ({ data, now }) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(CODEX_DEVICE_TOKEN_URL).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({
          device_auth_id: str(data.device_auth_id),
          user_code: str(data.user_code),
        }),
      );

      const reply = yield* call(request).pipe(
        Effect.mapError((error) => flowFailure(`Authentication failed: ${error.message}`)),
      );

      // 403/404 while the user has not approved yet.
      if (reply.status === 403 || reply.status === 404) return { _tag: "pending" as const };

      if (reply.status < 200 || reply.status >= 300) {
        return yield* flowFailure(
          `Authentication failed: codex device token polling failed with status ${reply.status}: ${clipBody(reply.text).slice(0, MAX_ERROR_TEXT)}`,
        );
      }

      const body = parseJsonObject(reply.text);
      const authorizationCode = str(body?.authorization_code);
      const codeVerifier = str(body?.code_verifier);
      const codeChallenge = str(body?.code_challenge);

      if (authorizationCode === "" || codeVerifier === "" || codeChallenge === "") {
        return yield* flowFailure(
          "Authentication failed: codex device flow token response missing required fields",
        );
      }

      const record = yield* exchangeCode({
        code: authorizationCode,
        codeVerifier,
        redirectUri: CODEX_DEVICE_REDIRECT_URI,
        now,
        prefix: "Authentication failed: ",
        requireEmail: true,
      });

      return { _tag: "done" as const, record };
    }),
});
