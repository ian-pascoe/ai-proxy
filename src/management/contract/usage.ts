/**
 * `GET /v8/management/observability/usage/summary` (token totals) and `/series` (totals per time bucket) from the D1
 * usage history (`../usage-routes.ts`, `src/usage/d1.ts` `summarizeUsage` / `summarizeUsageSeries`). Shared with
 * the browser: imports `effect` only.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** Keys a summary can be grouped by (`src/usage/d1.ts` `GROUP_BY`; a contract test keeps them equal). */
export const UsageGroupBy = Schema.Literals([
  "model",
  "provider",
  "principal",
  "auth",
  "endpoint",
  "day",
]);

export type UsageGroupBy = typeof UsageGroupBy.Type;

const usageTotalsFields = {
  requests: Schema.Number,
  failed: Schema.Number,
  input_tokens: Schema.Number,
  uncached_input_tokens: Schema.Number,
  cache_read_tokens: Schema.Number,
  cache_write_tokens: Schema.Number,
  output_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  unclassified_tokens: Schema.Number,
  total_tokens: Schema.Number,
  avg_latency_ms: Schema.Number,
  avg_ttft_ms: Schema.NullOr(Schema.Number),
};

export const UsageTotals = Schema.Struct(usageTotalsFields);

export type UsageTotals = typeof UsageTotals.Type;

export const UsageGroup = Schema.Struct({ key: Schema.String, ...usageTotalsFields });

export type UsageGroup = typeof UsageGroup.Type;

export const UsageSummary = Schema.Struct({
  group_by: UsageGroupBy,
  totals: UsageTotals,
  groups: Schema.Array(UsageGroup),
});

export type UsageSummary = typeof UsageSummary.Type;

/** Filters: `since` inclusive and `until` exclusive (epoch milliseconds); `auth_id` is a credential id. */
export const UsageSummaryQuery = Schema.Struct({
  group_by: optional(UsageGroupBy),
  since: optional(Schema.Number),
  until: optional(Schema.Number),
  provider: optional(Schema.String),
  model: optional(Schema.String),
  principal: optional(Schema.String),
  auth_id: optional(Schema.String),
  failed: optional(Schema.Literals(["true", "false"])),
  limit: optional(Schema.Number),
});

/** Series buckets: UTC hours or UTC days, each point keyed by its start (epoch milliseconds). */
export const UsageBucket = Schema.Literals(["hour", "day"]);

export type UsageBucket = typeof UsageBucket.Type;

/** Keys a series can be split by: one series per credential, model or provider. */
export const UsageSeriesGroupBy = Schema.Literals(["auth", "model", "provider"]);

export const UsagePoint = Schema.Struct({
  start: Schema.Number,
  requests: Schema.Number,
  failed: Schema.Number,
  total_tokens: Schema.Number,
});

export type UsagePoint = typeof UsagePoint.Type;

/** `points` are in time order and hold only buckets with requests. */
export const UsageSeries = Schema.Struct({
  bucket: UsageBucket,
  group_by: UsageSeriesGroupBy,
  series: Schema.Array(Schema.Struct({ key: Schema.String, points: Schema.Array(UsagePoint) })),
});

export type UsageSeries = typeof UsageSeries.Type;

/** `since` is required (epoch milliseconds, inclusive); `until` is exclusive and defaults to now. */
export const UsageSeriesQuery = Schema.Struct({
  since: Schema.Number,
  until: optional(Schema.Number),
  bucket: optional(UsageBucket),
  group_by: optional(UsageSeriesGroupBy),
  provider: optional(Schema.String),
  model: optional(Schema.String),
  auth_id: optional(Schema.String),
});

export class UsageGroupApi extends HttpApiGroup.make("usage").add(
  HttpApiEndpoint.get("summary", "/observability/usage/summary", {
    query: UsageSummaryQuery,
    success: UsageSummary,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("series", "/observability/usage/series", {
    query: UsageSeriesQuery,
    success: UsageSeries,
    error: managementErrors,
  }),
) {}
