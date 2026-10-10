/**
 * Devin `GetUserStatus` quota/profile refresh (cron task `devin-user-status`).
 *
 * Go source: internal/runtime/executor/devin_executor.go (`DevinExecutor.Refresh`), internal/auth/devin/user_status.go
 * (`FetchUserStatus`). Devin session tokens are permanent (no token refresh lead), so Go only calls `Refresh` for the quota
 * and profile signals; on Workers a Cron Trigger walks every stored Devin credential. A failing credential keeps its
 * stored data (Go returns the unchanged auth with the error). Tokens never appear in logs or errors.
 */
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { devinCredentials } from "../executor/devin/credentials.ts";
import { generateDeviceFingerprint } from "../executor/devin/wire.ts";
import type { JsonObject } from "../json/index.ts";
import {
  buildUserStatusRequest,
  type DevinUserStatus,
  parseUserStatus,
} from "../oauth/flows/devin-status.ts";
import type { CredentialPool } from "./pool.ts";
import { rfc3339 } from "./refresh/http.ts";
import type { CredentialState } from "./model.ts";

const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

const MAX_RESPONSE_BYTES = 4 << 20;

const REQUEST_TIMEOUT = "30 seconds";

/** `FetchUserStatus`: `undefined` with a reason when the call fails (no body text: it may echo credentials). */
export const fetchDevinUserStatus = (input: {
  readonly sessionToken: string;
  readonly baseUrl: string;
  readonly deviceSeed: string;
}): Effect.Effect<DevinUserStatus, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const token = input.sessionToken.trim();

    const request = HttpClientRequest.post(
      `${input.baseUrl.replace(/\/+$/, "")}${GET_USER_STATUS_PATH}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Basic ${token}-${token}`,
        "connect-protocol-version": "1",
        "content-type": "application/proto",
        accept: "*/*",
        "user-agent": "",
      }),
      HttpClientRequest.bodyUint8Array(
        buildUserStatusRequest(token, generateDeviceFingerprint(input.deviceSeed)),
        "application/proto",
      ),
    );

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => "devin user status request failed"));

    const bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.mapError(() => "devin user status response unreadable"),
      ),
    );

    if (response.status !== 200)
      return yield* Effect.fail(`devin seat management error (status ${response.status})`);
    const status = parseUserStatus(bytes.subarray(0, MAX_RESPONSE_BYTES));

    return status === undefined ? yield* Effect.fail("empty response data") : status;
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail("devin user status request timed out"),
    }),
  );

/** The metadata keys `Refresh` writes (non-empty values only). */
const PROFILE_KEYS = [
  ["email", "email"],
  ["user_name", "userName"],
  ["user_id", "userId"],
  ["team_id", "teamId"],
  ["plan", "plan"],
  ["org_id", "orgId"],
  ["org_name", "orgName"],
] as const;

/** `Quota.Signals` of `Refresh` (percentages as `N%`, timestamps RFC3339 UTC). */
export const devinQuotaSignals = (status: DevinUserStatus): Record<string, string> => {
  const signals: Record<string, string> = {};

  if (status.plan !== "") signals["plan"] = status.plan;
  signals["daily_quota_remaining_percent"] = `${status.dailyQuotaRemainingPercent}%`;
  signals["weekly_quota_remaining_percent"] = `${status.weeklyQuotaRemainingPercent}%`;
  const time = (seconds: number) => rfc3339(seconds * 1000);

  if (status.dailyQuotaResetAt > 0)
    signals["daily_quota_reset_at"] = time(status.dailyQuotaResetAt);

  if (status.weeklyQuotaResetAt > 0)
    signals["weekly_quota_reset_at"] = time(status.weeklyQuotaResetAt);

  if (status.planStart > 0) signals["plan_start"] = time(status.planStart);

  if (status.planEnd > 0) signals["plan_end"] = time(status.planEnd);

  return signals;
};

/** Applies a status to the stored metadata and runtime state (Go `updated` auth of `Refresh`). */
export const applyDevinStatus = (
  metadata: JsonObject,
  state: CredentialState,
  status: DevinUserStatus,
  nowMs: number,
): { readonly metadata: JsonObject; readonly state: CredentialState } => {
  const next: JsonObject = { ...metadata };

  for (const [key, field] of PROFILE_KEYS) if (status[field] !== "") next[key] = status[field];
  next["last_refresh"] = rfc3339(nowMs);

  return {
    metadata: next,
    state: {
      ...state,
      quota: {
        ...state.quota,
        signals: { ...state.quota.signals, ...devinQuotaSignals(status) },
        observedAt: nowMs,
      },
    },
  };
};

export interface DevinStatusSummary {
  readonly refreshed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Refreshes every stored Devin credential; failures are counted, never thrown. */
export const refreshDevinStatuses = (
  pool: Pick<CredentialPool, "entries" | "commitRefresh">,
  nowMs: () => number = Date.now,
): Effect.Effect<DevinStatusSummary, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    let refreshed = 0;
    let failed = 0;
    let skipped = 0;

    for (const { credential, state } of pool.entries()) {
      if (
        credential.source !== "file" ||
        credential.provider.trim().toLowerCase() !== "devin" ||
        credential.disabled
      ) {
        continue;
      }

      const { apiKey, baseUrl, deviceSeed } = devinCredentials({
        id: credential.id,
        provider: credential.provider,
        kind: "oauth",
        attributes: credential.attributes,
        metadata: credential.metadata,
      });

      if (apiKey === "") {
        skipped += 1;
        continue;
      }

      const result = yield* Effect.result(
        fetchDevinUserStatus({ sessionToken: apiKey, baseUrl, deviceSeed }),
      );

      if (result._tag === "Failure") {
        failed += 1;
        yield* Effect.logWarning(
          `devin executor: failed to refresh user status for ${credential.id}: ${result.failure}`,
        );
        continue;
      }

      const updated = applyDevinStatus(credential.metadata, state, result.success, nowMs());
      pool.commitRefresh(credential.id, updated);
      refreshed += 1;
    }

    return { refreshed, failed, skipped };
  });
