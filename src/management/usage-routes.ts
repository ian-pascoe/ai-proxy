/**
 * Usage observability routes (`/v8/management/observability/usage/*`).
 *
 * Go source: internal/api/server_management_v8.go (route table), internal/api/handlers/management/usage.go
 * (`GetUsageQueue`) and api_key_usage.go (`GetAPIKeyUsage`). Records are read from D1 (`src/usage/d1.ts`) instead of
 * the in-process RESP queue. `records` and `summary` are Workers additions that expose the persisted history.
 *
 * Deviations: `api-keys` keys use the masked API key the ControlPlane exposes (`<base_url>|[redacted]…abcd`) rather
 * than the raw key, so keys that share their last four characters and base URL are merged; `queue` pops from the
 * records not yet exported (at most 1000 per call) and the export payload carries the Access principal as `api_key`.
 */
import { Clock, Effect } from "effect";
import { HttpRouter } from "effect/http";
import type { CredentialSummary } from "../credentials/summary.ts";
import { WorkerEnv } from "../platform/env.ts";
import {
  GROUP_BY,
  type GroupBy,
  listUsageRecords,
  MAX_QUEUE_COUNT,
  popUsageQueue,
  rowToPayload,
  summarizeUsage,
  type UsageFilter,
} from "../usage/d1.ts";
import { recentRequestBuckets } from "./credential-entry.ts";
import { controlPlane, handled, jsonReply, queryParams, replyError } from "./http.ts";

const BASE = "/v8/management/observability/usage";

/** The D1 database, or a 503 when the `USAGE` binding is missing. */
const usageDb = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const db: D1Database | undefined = env.USAGE;

  if (db === undefined) return yield* replyError(503, "usage store unavailable");

  return db;
});

/** D1 failures are logged without details and answered with a generic 502. */
const query = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause.message : "unknown error"),
  }).pipe(
    Effect.catch((message) =>
      Effect.logError(`usage ${label} failed: ${message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "usage store unavailable"))),
      ),
    ),
  );

// --- api-keys ------------------------------------------------------------------------------------------------------

interface RecentBucketJson {
  time: string;
  success: number;
  failed: number;
}

interface ApiKeyUsageEntry {
  success: number;
  failed: number;
  recent_requests: RecentBucketJson[];
}

const providerKey = (summary: CredentialSummary): string => {
  const compat = (summary.attributes["compat_name"] ?? "").trim().toLowerCase();
  const provider = compat !== "" ? compat : summary.provider.trim().toLowerCase();

  return provider === "" ? "unknown" : provider;
};

const isApiKey = (summary: CredentialSummary): boolean =>
  (summary.authKind === "apikey" || summary.authKind === undefined) &&
  (summary.attributes["api_key"] ?? "") !== "";

/** `mergeRecentRequestBuckets` for buckets of the same window. */
const mergeBuckets = (into: RecentBucketJson[], from: ReadonlyArray<RecentBucketJson>): void => {
  const count = Math.min(into.length, from.length);

  for (let index = 0; index < count; index += 1) {
    const target = into[index];
    const source = from[index];

    if (target === undefined || source === undefined) continue;
    target.success += source.success;
    target.failed += source.failed;
  }
};

/** `GetAPIKeyUsage`: per provider, per `base_url|api_key`, the success/failure counters and the recent-request ring. */
const apiKeyUsage = Effect.gen(function* () {
  const summaries = yield* controlPlane("listCredentials", (stub) => stub.listCredentials());
  const now = yield* Clock.currentTimeMillis;
  const out: Record<string, Record<string, ApiKeyUsageEntry>> = {};

  for (const summary of summaries) {
    if (!isApiKey(summary)) continue;
    const baseUrl = (summary.attributes["base_url"] ?? summary.attributes["base-url"] ?? "").trim();
    const key = `${baseUrl}|${(summary.attributes["api_key"] ?? "").trim()}`;
    const recent = recentRequestBuckets(summary.recentRequests, now);
    const bucket = (out[providerKey(summary)] ??= {});
    const existing = bucket[key];

    if (existing === undefined) {
      bucket[key] = { success: summary.success, failed: summary.failed, recent_requests: recent };
      continue;
    }

    existing.success += summary.success;
    existing.failed += summary.failed;
    mergeBuckets(existing.recent_requests, recent);
  }

  return jsonReply(200, out);
});

// --- queue ---------------------------------------------------------------------------------------------------------

/** `parseUsageQueueCount`: empty means 1; anything but a positive integer is a 400. */
const parseCount = (raw: string | null): number | undefined => {
  const value = (raw ?? "").trim();

  if (value === "") return 1;

  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const count = Number(value);

  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
};

/** `GetUsageQueue`: pops the oldest unexported records. */
const usageQueue = Effect.gen(function* () {
  const params = yield* queryParams;
  const count = parseCount(params.get("count"));

  if (count === undefined) return yield* replyError(400, "count must be a positive integer");
  const db = yield* usageDb;
  const now = yield* Clock.currentTimeMillis;

  const rows = yield* query("queue", () =>
    popUsageQueue(db, Math.min(count, MAX_QUEUE_COUNT), now),
  );

  return jsonReply(200, rows.map(rowToPayload));
});

// --- records and summary -------------------------------------------------------------------------------------------

/** Epoch milliseconds or an ISO 8601 date/time. */
const parseTime = (raw: string): number | undefined => {
  const value = raw.trim();

  if (/^\d+$/.test(value)) {
    const ms = Number(value);

    return Number.isSafeInteger(ms) ? ms : undefined;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
};

const optional = (params: URLSearchParams, name: string): string | undefined => {
  const value = params.get(name)?.trim() ?? "";

  return value === "" ? undefined : value;
};

const parseFilter = (params: URLSearchParams) =>
  Effect.gen(function* () {
    const filter: { -readonly [K in keyof UsageFilter]: UsageFilter[K] } = {};

    for (const name of ["since", "until"] as const) {
      const raw = optional(params, name);

      if (raw === undefined) continue;
      const time = parseTime(raw);

      if (time === undefined)
        return yield* replyError(400, `${name} must be epoch milliseconds or an ISO 8601 time`);
      filter[name] = time;
    }

    const provider = optional(params, "provider");
    const model = optional(params, "model");
    const principal = optional(params, "principal");
    const authId = optional(params, "auth_id");

    if (provider !== undefined) filter.provider = provider.toLowerCase();

    if (model !== undefined) filter.model = model;

    if (principal !== undefined) filter.principal = principal;

    if (authId !== undefined) filter.authId = authId;
    const failed = optional(params, "failed");

    if (failed !== undefined) {
      if (failed !== "true" && failed !== "false")
        return yield* replyError(400, "failed must be true or false");
      filter.failed = failed === "true";
    }

    return filter;
  });

const parseLimit = (params: URLSearchParams) =>
  Effect.gen(function* () {
    const raw = optional(params, "limit");

    if (raw === undefined) return undefined;
    const limit = Number(raw);

    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit <= 0) {
      return yield* replyError(400, "limit must be a positive integer");
    }

    return limit;
  });

/** `GET /records`: newest first, `before` continues from `next_before`. */
const usageRecords = Effect.gen(function* () {
  const params = yield* queryParams;
  const filter = yield* parseFilter(params);
  const limit = yield* parseLimit(params);
  const before = optional(params, "before");
  const db = yield* usageDb;

  const page = yield* query("records", () =>
    listUsageRecords(db, {
      ...filter,
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
    }),
  );

  return jsonReply(200, {
    records: page.rows.map(rowToPayload),
    ...(page.nextBefore === undefined ? {} : { next_before: page.nextBefore }),
  });
});

/** `GET /summary`: token totals (v2 breakdown buckets) overall and per `group_by`. */
const usageSummary = Effect.gen(function* () {
  const params = yield* queryParams;
  const filter = yield* parseFilter(params);
  const limit = yield* parseLimit(params);
  const groupBy = optional(params, "group_by") ?? "model";

  // SAFETY: widening the literal tuple to string for the membership test; it is only read.
  if (!(GROUP_BY as ReadonlyArray<string>).includes(groupBy)) {
    return yield* replyError(400, `group_by must be one of ${GROUP_BY.join(", ")}`);
  }

  const db = yield* usageDb;

  const summary = yield* query("summary", () =>
    summarizeUsage(db, {
      ...filter,
      // SAFETY: groupBy was checked against GROUP_BY above.
      groupBy: groupBy as GroupBy,
      ...(limit === undefined ? {} : { limit }),
    }),
  );

  return jsonReply(200, { group_by: groupBy, totals: summary.totals, groups: summary.groups });
});

export const usageRoutes = [
  HttpRouter.route("GET", `${BASE}/api-keys`, handled(apiKeyUsage)),
  HttpRouter.route("GET", `${BASE}/queue`, handled(usageQueue)),
  HttpRouter.route("GET", `${BASE}/records`, handled(usageRecords)),
  HttpRouter.route("GET", `${BASE}/summary`, handled(usageSummary)),
];
