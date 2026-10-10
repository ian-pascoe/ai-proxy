/**
 * `GET /v8/management/observability/usage/summary`: token totals from the D1 usage history (`../usage-routes.ts`,
 * `src/usage/d1.ts` `summarizeUsage`). Shared with the browser: imports `effect` only.
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

export class UsageGroupApi extends HttpApiGroup.make("usage").add(
  HttpApiEndpoint.get("summary", "/observability/usage/summary", {
    query: UsageSummaryQuery,
    success: UsageSummary,
    error: managementErrors,
  }),
) {}
