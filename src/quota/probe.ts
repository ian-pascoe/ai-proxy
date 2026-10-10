/**
 * The upstream calls of the quota check: one provider usage endpoint (plus Claude's profile) per credential, made from
 * the Worker with the token the ControlPlane resolved (src/quota/target.ts). Parsing is in the per-provider modules.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/{claude,codex,antigravity,
 * kimi,xai,meta,devin}/ (requests, headers and which failures are fatal). Every upstream call is bounded to 15 s (an
 * explicit exception to "no timeouts after connect": a probe that hangs must not hold the route or the cron).
 *
 * Failures become `{ ok: false, error }` with a fixed message and the upstream status only: response bodies are never
 * logged or copied into errors (the Meta endpoint can echo an API key), and tokens only travel in request headers
 * (Devin: in the request body, as `devin-user-status` does).
 */
import { Clock, Effect, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { fetchDevinUserStatus } from "../credentials/devin-status.ts";
import { type Json, tryParseJson } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";
import {
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_QUOTA_URLS,
  parseAntigravityQuota,
} from "./antigravity.ts";
import {
  CLAUDE_HEADERS,
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  parseClaudePlan,
  parseClaudeUsage,
} from "./claude.ts";
import { CODEX_HEADERS, CODEX_USAGE_URL, parseCodexUsage } from "./codex.ts";
import { devinUsage } from "./devin.ts";
import { parseKimiUsage } from "./kimi.ts";
import { META_HEADERS, META_QUOTA_URL, parseMetaUsage } from "./meta.ts";
import type { QuotaOutcome } from "./report.ts";
import type { QuotaProbeTarget } from "./target.ts";
import {
  XAI_BILLING_MONTHLY_URL,
  XAI_BILLING_WEEKLY_URL,
  XAI_HEADERS,
  parseXaiMonthly,
  parseXaiWeekly,
} from "./xai.ts";

const TIMEOUT = "15 seconds";

/** An answered upstream call: status and the body parsed as JSON (`undefined` when it is not JSON). */
interface Answer {
  readonly status: number;
  readonly body: Json | undefined;
}

/** A failed check: a message safe to store and show (no body, no token) and the upstream status when there was one. */
interface ProbeFailure {
  readonly message: string;
  readonly status?: number;
}

const failure = (message: string, status?: number): ProbeFailure =>
  status === undefined ? { message } : { message, status };

const ok = (answer: Answer): boolean => answer.status >= 200 && answer.status < 300;

const bearer = (token: string): string => `Bearer ${token}`;

/** One upstream call with the 15 s bound; transport errors and timeouts fail with a fixed message. */
const send = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Answer, ProbeFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const text = yield* response.text;

    return { status: response.status, body: tryParseJson(text) };
  }).pipe(
    Effect.mapError(() => failure("usage request failed")),
    Effect.timeoutOrElse({
      duration: TIMEOUT,
      orElse: () => Effect.fail(failure("usage request timed out")),
    }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  );

/** A 2xx answer's body, else the status as the failure. */
const expectOk = (answer: Answer): Effect.Effect<Json | undefined, ProbeFailure> =>
  ok(answer)
    ? Effect.succeed(answer.body)
    : Effect.fail(failure(`usage endpoint answered ${answer.status}`, answer.status));

const get = (url: string, headers: Record<string, string>) =>
  send(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)));

const invalid = failure("invalid usage response");

interface Usage {
  readonly plan?: string;
  readonly windows: ReadonlyArray<QuotaWindow>;
}

const claude = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const headers = { ...CLAUDE_HEADERS, authorization: bearer(target.token) };

  // The profile only adds the plan: its failure is tolerated (panel behaviour).
  const [usage, profile] = yield* Effect.all(
    [get(CLAUDE_USAGE_URL, headers), Effect.result(get(CLAUDE_PROFILE_URL, headers))],
    { concurrency: 2 },
  );

  const body = yield* expectOk(usage);

  if (body === undefined) return yield* Effect.fail(invalid);

  const plan =
    Result.isSuccess(profile) && ok(profile.success) && profile.success.body !== undefined
      ? parseClaudePlan(profile.success.body)
      : undefined;

  return {
    ...(plan === undefined ? {} : { plan }),
    windows: parseClaudeUsage(body),
  } satisfies Usage;
});

const codex = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const headers = {
    ...CODEX_HEADERS,
    authorization: bearer(target.token),
    ...(target.accountId === undefined ? {} : { "chatgpt-account-id": target.accountId }),
  };

  const body = yield* expectOk(yield* get(CODEX_USAGE_URL, headers));

  if (body === undefined) return yield* Effect.fail(invalid);

  return parseCodexUsage(body, yield* Clock.currentTimeMillis) satisfies Usage;
});

/** Hosts in order; the first 2xx with a `groups` array wins, a 403/404 is the reported failure before others. */
const antigravity = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const headers = { ...ANTIGRAVITY_HEADERS, authorization: bearer(target.token) };
  let priority: ProbeFailure | undefined;
  let last: ProbeFailure = failure("usage request failed");
  let answered = false;

  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(
        JSON.stringify({ project: target.projectId ?? "" }),
        "application/json",
      ),
    );

    const result = yield* Effect.result(Effect.flatMap(send(request), expectOk));

    if (Result.isFailure(result)) {
      last = result.failure;

      if (result.failure.status === 403 || result.failure.status === 404)
        priority ??= result.failure;
      continue;
    }

    answered = true;

    const windows =
      result.success === undefined ? undefined : parseAntigravityQuota(result.success);

    if (windows !== undefined && windows.length > 0) return { windows } satisfies Usage;
  }

  // A host answered but without buckets: a successful check with no windows (panel behaviour).
  if (answered) return { windows: [] } satisfies Usage;

  return yield* Effect.fail(priority ?? last);
});

const kimi = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const body = yield* expectOk(
    yield* get(target.usageUrl ?? "", { authorization: bearer(target.token) }),
  );

  if (body === undefined) return yield* Effect.fail(invalid);

  return { windows: parseKimiUsage(body, yield* Clock.currentTimeMillis) } satisfies Usage;
});

/** Weekly credits and the monthly allowance; either endpoint may carry either figure (panel `mergeXaiBillingSummaries`). */
const xai = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const headers = {
    ...XAI_HEADERS,
    authorization: bearer(target.token),
    ...(target.userId === undefined ? {} : { "x-userid": target.userId }),
  };

  const [weekly, monthly] = yield* Effect.all(
    [
      Effect.result(Effect.flatMap(get(XAI_BILLING_WEEKLY_URL, headers), expectOk)),
      Effect.result(Effect.flatMap(get(XAI_BILLING_MONTHLY_URL, headers), expectOk)),
    ],
    { concurrency: 2 },
  );

  if (Result.isFailure(weekly) && Result.isFailure(monthly))
    return yield* Effect.fail(weekly.failure);

  const bodies = [weekly, monthly].map((result) =>
    Result.isSuccess(result) && result.success !== undefined ? result.success : null,
  );

  const [weeklyBody, monthlyBody] = bodies;

  const windows = [
    parseXaiWeekly(weeklyBody ?? null) ?? parseXaiWeekly(monthlyBody ?? null),
    parseXaiMonthly(monthlyBody ?? null) ?? parseXaiMonthly(weeklyBody ?? null),
  ].filter((window) => window !== undefined);

  if (windows.length === 0) return yield* Effect.fail(failure("billing response has no usage"));

  return { windows } satisfies Usage;
});

const meta = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const request = HttpClientRequest.post(META_QUOTA_URL).pipe(
    HttpClientRequest.setHeaders({ ...META_HEADERS, authorization: bearer(target.token) }),
    HttpClientRequest.bodyText("{}", "application/json"),
  );

  const body = yield* expectOk(yield* send(request));
  const usage = body === undefined ? undefined : parseMetaUsage(body);

  return usage === undefined ? yield* Effect.fail(invalid) : (usage satisfies Usage);
});

const devin = Effect.fnUntraced(function* (target: QuotaProbeTarget) {
  const status = yield* fetchDevinUserStatus({
    sessionToken: target.token,
    baseUrl: target.baseUrl ?? "",
    deviceSeed: target.deviceSeed ?? "",
  }).pipe(
    Effect.mapError((message) => failure(message)),
    Effect.timeoutOrElse({
      duration: TIMEOUT,
      orElse: () => Effect.fail(failure("usage request timed out")),
    }),
  );

  return devinUsage(status) satisfies Usage;
});

const probes: Record<
  QuotaProbeTarget["provider"],
  (target: QuotaProbeTarget) => Effect.Effect<Usage, ProbeFailure, HttpClient.HttpClient>
> = {
  claude,
  codex,
  antigravity,
  kimi,
  "kimi-ai": kimi,
  xai,
  meta,
  devin,
};

/** Calls the provider's usage endpoint for `target`; never fails (a failed check is an outcome). */
export const probeQuota = (
  target: QuotaProbeTarget,
): Effect.Effect<QuotaOutcome, never, HttpClient.HttpClient> =>
  probes[target.provider](target).pipe(
    Effect.map((usage): QuotaOutcome => ({ ok: true, ...usage })),
    Effect.catch((error) =>
      Effect.logWarning(
        `quota check for ${target.id} (${target.provider}) failed: ${error.message}`,
      ).pipe(Effect.as<QuotaOutcome>({ ok: false, error: error.message })),
    ),
  );
