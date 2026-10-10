/**
 * Claude OAuth refresh.
 *
 * Go source: internal/auth/claude/anthropic_auth.go (`RefreshTokens`, `refreshTokensSingleFlight`,
 * `RefreshTokensWithRetry`, `FetchOAuthProfile`), internal/runtime/executor/claude_executor_auth.go (`Refresh`).
 * Docs: credentials.md §9.4. Refresh tokens are single-use: only HTTP >= 500 is retried (a transport failure may have
 * consumed the token) and HTTP 429 blocks the credential for `Retry-After` (the manager keeps the block).
 * The uTLS/Axios header order of Go cannot be reproduced with `fetch`; `Accept`, `Content-Type` and `User-Agent` are kept.
 */
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { isJsonObject, type JsonObject } from "../../json/index.ts";
import { refreshError } from "./error.ts";
import {
  parseJsonObject,
  rfc3339,
  send,
  seconds,
  statusFailure,
  str,
  type HttpReply,
} from "./http.ts";
import { withRetries } from "./retry.ts";
import type { RefreshContext, RefreshEffect, RefreshProtocolEffect } from "./types.ts";

export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const CLAUDE_OAUTH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const MIN_BLOCK_MS = 5_000;

const MAX_BLOCK_MS = 300_000;

const MAX_ATTEMPTS = 3;

const AXIOS_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  "user-agent": "axios/1.15.2",
} as const;

const clampBlock = (ms: number): number => Math.min(MAX_BLOCK_MS, Math.max(MIN_BLOCK_MS, ms));

/** `parseClaudeRetryAfter`: `Retry-After` seconds or HTTP date, then `Retry-After-Ms`; default 5 s; clamped 5 s..5 min. */
export const parseRetryAfterMs = (reply: Pick<HttpReply, "header">, now: number): number => {
  const raw = reply.header("retry-after")?.trim();

  if (raw !== undefined && raw !== "") {
    if (/^\d+(\.\d+)?$/.test(raw)) return clampBlock(Number(raw) * 1000);
    const when = Date.parse(raw);

    if (!Number.isNaN(when)) return clampBlock(when - now);
  }

  const ms = reply.header("retry-after-ms")?.trim();

  if (ms !== undefined && /^\d+(\.\d+)?$/.test(ms)) return clampBlock(Number(ms));

  return MIN_BLOCK_MS;
};

interface TokenData {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expired: string;
}

const requestTokens = (refreshToken: string, now: number): RefreshEffect<TokenData> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(CLAUDE_TOKEN_URL).pipe(
      HttpClientRequest.setHeaders(AXIOS_HEADERS),
      HttpClientRequest.bodyJsonUnsafe({
        client_id: CLAUDE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: CLAUDE_OAUTH_SCOPE,
      }),
    );

    const reply = yield* send(request);

    if (reply.status !== 200) {
      if (reply.status === 429) {
        return yield* Effect.fail(
          refreshError({
            message: `token refresh failed with status 429: ${reply.text.trim().slice(0, 512)}`,
            status: 429,
            retryable: false,
            blockMs: parseRetryAfterMs(reply, now),
          }),
        );
      }

      return yield* Effect.fail(statusFailure("token refresh", reply, reply.status >= 500));
    }

    const body = parseJsonObject(reply.text);

    if (body === undefined)
      return yield* Effect.fail(refreshError({ message: "failed to parse token response" }));

    return {
      accessToken: str(body.access_token),
      refreshToken: str(body.refresh_token) || refreshToken,
      expired: rfc3339(now + seconds(body.expires_in) * 1000),
    };
  });

interface Profile {
  readonly email: string;
  readonly accountUuid: string;
  readonly organizationUuid: string;
  readonly organizationName: string;
}

const field = (value: unknown, key: string): string => (isJsonObject(value) ? str(value[key]) : "");

/** Best-effort `GET /api/oauth/profile`: any failure yields `undefined` and never blanks stored identity. */
export const fetchClaudeProfile = (accessToken: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(CLAUDE_PROFILE_URL).pipe(
      HttpClientRequest.setHeaders({
        ...AXIOS_HEADERS,
        authorization: `Bearer ${accessToken}`,
        "cache-control": "no-cache",
      }),
    );

    const reply = yield* send(request);

    if (reply.status < 200 || reply.status >= 300) return undefined;
    const body = parseJsonObject(reply.text);

    if (body === undefined) return undefined;
    const accountUuid = field(body.account, "uuid");

    if (accountUuid === "") return undefined;

    return {
      email: field(body.account, "email"),
      accountUuid,
      organizationUuid: field(body.organization, "uuid"),
      organizationName: field(body.organization, "name"),
    } satisfies Profile;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const setIfPresent = (target: JsonObject, key: string, value: string): void => {
  if (value !== "") target[key] = value;
};

export const refreshClaude = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata };
    const refreshToken = str(metadata.refresh_token) || str(metadata.refreshToken);

    // Go returns the auth unchanged when there is nothing to refresh.
    if (refreshToken === "") return metadata;

    const tokens = yield* withRetries(requestTokens(refreshToken, context.now), {
      attempts: MAX_ATTEMPTS,
      retryable: (error) => error.retryable === true,
      delayMs: context.retryDelayMs,
    });

    const profile = yield* fetchClaudeProfile(tokens.accessToken);

    metadata.access_token = tokens.accessToken;
    setIfPresent(metadata, "refresh_token", tokens.refreshToken);

    if (profile !== undefined) {
      setIfPresent(metadata, "email", profile.email);
      setIfPresent(metadata, "account_uuid", profile.accountUuid);
      setIfPresent(metadata, "organization_uuid", profile.organizationUuid);
      setIfPresent(metadata, "organization_name", profile.organizationName);
    }

    metadata.expired = tokens.expired;
    metadata.type = "claude";
    metadata.last_refresh = rfc3339(context.now);

    return metadata;
  });
