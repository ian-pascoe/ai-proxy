/**
 * Kimi coding-plan usage (`GET https://api.kimi.com/coding/v1/usages` or `https://api.kimi.ai/coding/v1/usages`) as
 * quota windows.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/services/api/kimiQuota.ts (`parseKimiQuotaUrl`:
 * domain from `domain`, then the `base_url` host, then the provider), src/utils/quota/builders.ts
 * (`buildKimiQuotaRows`), src/utils/quota/constants.ts (`KIMI_USAGE_URL`, `KIMI_AI_USAGE_URL`).
 *
 * Differences from the panel: rows become windows with `used_percent = used / limit * 100` (rows without a positive
 * limit are dropped); ids are `five_hour`/`weekly`/… for `limits[]` entries with a window length (else `limit_<n>`),
 * `weekly` for the `usage` summary and `monthly` for `usages.limit_month_total`.
 */
import type { Json, JsonObject } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";
import {
  DAY,
  WEEK,
  num,
  offsetIso,
  quotaWindow,
  record,
  resetIso,
  str,
  uniqueIds,
  windowId,
  windowLabel,
} from "./window.ts";

export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

export const KIMI_AI_USAGE_URL = "https://api.kimi.ai/coding/v1/usages";

const isAiHost = (host: string): boolean => host === "kimi.ai" || host.endsWith(".kimi.ai");

const isComHost = (host: string): boolean => host === "kimi.com" || host.endsWith(".kimi.com");

const domainOf = (value: string): "ai" | "com" | undefined => {
  const domain = value.trim().toLowerCase();

  if (["ai", "kimi-ai", "kimi.ai"].includes(domain) || domain.endsWith(".kimi.ai")) return "ai";

  return ["com", "kimi", "kimi.com"].includes(domain) || domain.endsWith(".kimi.com")
    ? "com"
    : undefined;
};

const hostDomain = (baseUrl: string): "ai" | "com" | undefined => {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();

    if (isAiHost(host)) return "ai";

    return isComHost(host) ? "com" : undefined;
  } catch {
    return undefined;
  }
};

/** `parseKimiQuotaUrl`: only the two official hosts are ever used, whatever the file says. */
export const kimiUsageUrl = (provider: string, metadata: JsonObject): string => {
  const explicit = str(metadata.domain);

  const baseUrl = str(
    Object.hasOwn(metadata, "base_url") ? metadata.base_url : metadata["base-url"],
  );

  const domain =
    (explicit === undefined ? undefined : (domainOf(explicit) ?? "com")) ??
    (baseUrl === undefined ? undefined : hostDomain(baseUrl)) ??
    domainOf(str(metadata.type) ?? "") ??
    domainOf(provider.replace(/_/g, "-")) ??
    "com";

  return domain === "ai" ? KIMI_AI_USAGE_URL : KIMI_USAGE_URL;
};

/** `normalizeKimiTimeUnit` + duration: seconds of a `{duration, timeUnit}` window (minutes when the unit is absent). */
const durationSeconds = (
  duration: number | undefined,
  unit: Json | undefined,
): number | undefined => {
  if (duration === undefined || duration <= 0) return undefined;

  const name = (typeof unit === "string" ? unit : "")
    .trim()
    .toUpperCase()
    .replace(/^TIME_UNIT_/, "");

  if (name === "SECOND" || name === "SECONDS") return duration;

  if (name === "" || name === "MINUTE" || name === "MINUTES") return duration * 60;

  if (name === "HOUR" || name === "HOURS") return duration * 3600;

  if (name === "DAY" || name === "DAYS") return duration * DAY;

  return name === "WEEK" || name === "WEEKS" ? duration * WEEK : undefined;
};

/** Used percentage and reset of one usage row (`limit`, `used` or `remaining`, reset fields). */
const usageOf = (
  data: JsonObject,
  nowMs: number,
): { readonly used: number; readonly resetsAt: string | undefined } | undefined => {
  const limit = num(data.limit);
  const remaining = num(data.remaining);

  const used =
    num(data.used) ??
    (remaining !== undefined && limit !== undefined ? limit - remaining : undefined);

  if (limit === undefined || limit <= 0 || used === undefined) return undefined;

  const resetsAt =
    resetIso([data.reset_at, data.resetAt, data.reset_time, data.resetTime]) ??
    offsetIso(data.reset_in ?? data.resetIn ?? data.ttl, nowMs);

  return { used: (used / limit) * 100, resetsAt };
};

const explicitName = (...sources: JsonObject[]): string | undefined => {
  for (const key of ["name", "title", "scope"]) {
    for (const source of sources) {
      const value = str(source[key]);

      if (value !== undefined && typeof source[key] === "string") return value;
    }
  }

  return undefined;
};

/** Windows of a `/coding/v1/usages` payload; `nowMs` resolves relative reset offsets. */
export const parseKimiUsage = (payload: Json, nowMs: number): QuotaWindow[] => {
  const root = record(payload);
  const windows: QuotaWindow[] = [];
  const limits = Array.isArray(root.limits) ? root.limits : [];

  limits.forEach((rawItem, index) => {
    const item = record(rawItem);
    const detail = Object.keys(record(item.detail)).length > 0 ? record(item.detail) : item;
    const window = record(item.window);
    const usage = usageOf(detail, nowMs);

    if (usage === undefined) return;

    const seconds = durationSeconds(
      num(window.duration) ?? num(item.duration) ?? num(detail.duration),
      window.timeUnit ?? item.timeUnit ?? detail.timeUnit,
    );

    const name = explicitName(item, detail);
    const id = seconds === undefined ? `limit_${index + 1}` : windowId(seconds);
    const label = name ?? (seconds === undefined ? `Limit ${index + 1}` : windowLabel(seconds));
    windows.push(quotaWindow(id, label, usage.used, usage.resetsAt, seconds));
  });

  const summary = usageOf(record(root.usage), nowMs);

  if (summary !== undefined)
    windows.push(quotaWindow("weekly", "Weekly", summary.used, summary.resetsAt, WEEK));
  const monthly = record(record(root.usages).limit_month_total);
  const ratio = num(monthly.used_ratio);

  if (ratio !== undefined) {
    windows.push(
      quotaWindow("monthly", "Monthly", ratio * 100, resetIso([monthly.reset_time]), 30 * DAY),
    );
  }

  return uniqueIds(windows);
};
