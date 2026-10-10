/**
 * xAI (Grok CLI) billing as quota windows: weekly credits (`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`)
 * and the monthly allowance (`GET https://cli-chat-proxy.grok.com/v1/billing`).
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/xai/data.ts
 * (`fetchXaiQuota`, `buildXaiRequestHeaders`), src/utils/quota/builders.ts (`buildXaiBillingSummary`,
 * `mergeXaiBillingSummaries`), src/utils/quota/constants.ts (`XAI_REQUEST_HEADERS`).
 *
 * Differences from the panel: only the two billing endpoints are called. The panel's paid-account fallback
 * (`GET https://api.x.ai/v1/me` plus a real `POST /v1/chat/completions` "ping") is never made, because it spends a
 * request; the plan lookups (`/v1/user`, `/v1/settings`) are skipped too. The weekly window is `creditUsagePercent` of
 * the current period; the monthly one is the included usage (`used` capped at `monthlyLimit`, in cents) over
 * `monthlyLimit`.
 */
import type { Json, JsonObject } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";
import { isoInstant, num, quotaWindow, record } from "./window.ts";

export const XAI_BILLING_WEEKLY_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export const XAI_BILLING_MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";

/** `XAI_REQUEST_HEADERS` without the bearer token (`x-userid` is added when the file has a subject). */
export const XAI_HEADERS = {
  "x-xai-token-auth": "xai-grok-cli",
  "x-grok-client-version": "0.2.91",
  accept: "*/*",
  "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)",
} as const;

const pick = (source: JsonObject, camel: string, snake: string): Json | undefined =>
  source[camel] ?? source[snake];

/** `normalizeXaiCentValue`: a number, a numeric string or `{val}`. */
const cents = (value: Json | undefined): number | undefined => {
  const nested = record(value);

  return Object.hasOwn(nested, "val") ? num(nested.val) : num(value);
};

/** Window length from a period's start → end span. */
const spanSeconds = (start: string | undefined, end: string | undefined): number | undefined => {
  if (start === undefined || end === undefined) return undefined;
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);

  return seconds > 0 ? seconds : undefined;
};

/** The weekly credits window of a billing payload (`config.creditUsagePercent`). */
export const parseXaiWeekly = (payload: Json): QuotaWindow | undefined => {
  const config = record(record(payload).config);
  const used = num(pick(config, "creditUsagePercent", "credit_usage_percent"));

  if (used === undefined) return undefined;
  const period = record(pick(config, "currentPeriod", "current_period"));

  const start =
    isoInstant(period.start) ??
    isoInstant(pick(config, "billingPeriodStart", "billing_period_start"));

  const end =
    isoInstant(period.end) ?? isoInstant(pick(config, "billingPeriodEnd", "billing_period_end"));

  return quotaWindow("weekly", "Weekly credits", used, end, spanSeconds(start, end));
};

/** The monthly allowance window of a billing payload (`config.used` over `config.monthlyLimit`). */
export const parseXaiMonthly = (payload: Json): QuotaWindow | undefined => {
  const config = record(record(payload).config);
  const limit = cents(pick(config, "monthlyLimit", "monthly_limit"));
  const used = cents(config.used);

  if (limit === undefined || limit <= 0 || used === undefined) return undefined;
  const start = isoInstant(pick(config, "billingPeriodStart", "billing_period_start"));
  const end = isoInstant(pick(config, "billingPeriodEnd", "billing_period_end"));

  return quotaWindow(
    "monthly",
    "Monthly",
    (Math.min(used, limit) / limit) * 100,
    end,
    spanSeconds(start, end),
  );
};
