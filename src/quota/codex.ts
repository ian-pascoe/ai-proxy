/**
 * Codex (ChatGPT) usage (`GET https://chatgpt.com/backend-api/wham/usage`) as quota windows and plan.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/codex/data.ts
 * (`buildCodexQuotaWindows`, `fetchCodexQuota`), src/utils/quota/constants.ts (`CODEX_REQUEST_HEADERS`).
 *
 * Differences from the panel: windows keep the payload's primary/secondary order (ids `primary`, `secondary`,
 * `code_review_primary`, `code_review_secondary`, `<limit>_primary`, `<limit>_secondary`) and are labelled from
 * `limit_window_seconds` ("5-hour", "Weekly", "Monthly" for 28–31 days, else a duration); a window without a length
 * is labelled "Primary"/"Secondary". The panel's optional subscription and reset-credit calls are not made.
 */
import type { Json, JsonObject } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";
import {
  num,
  offsetIso,
  quotaWindow,
  record,
  resetIso,
  slug,
  str,
  uniqueIds,
  windowLabel,
} from "./window.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** `CODEX_REQUEST_HEADERS` without the bearer token (`Chatgpt-Account-Id` is added per credential). */
export const CODEX_HEADERS = {
  "content-type": "application/json",
  "user-agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
} as const;

export interface CodexUsage {
  readonly plan?: string;
  readonly windows: QuotaWindow[];
}

/** Reads `snake_case` and its camelCase twin. */
const pick = (source: JsonObject, snake: string, camel: string): Json | undefined =>
  source[snake] ?? source[camel];

const windowOf = (
  id: string,
  prefix: string,
  fallback: string,
  raw: Json | undefined,
  limitReached: boolean,
  nowMs: number,
): QuotaWindow | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const window = record(raw);
  const seconds = num(pick(window, "limit_window_seconds", "limitWindowSeconds"));

  const resetsAt =
    resetIso([pick(window, "reset_at", "resetAt")]) ??
    offsetIso(pick(window, "reset_after_seconds", "resetAfterSeconds"), nowMs);

  // The panel shows a reached limit with an upcoming reset as fully used when no percentage is given.
  const used =
    num(pick(window, "used_percent", "usedPercent")) ??
    (limitReached && resetsAt !== undefined ? 100 : undefined);

  if (used === undefined) return undefined;
  const name = seconds === undefined || seconds <= 0 ? fallback : windowLabel(seconds);

  return quotaWindow(id, prefix === "" ? name : `${prefix} ${name}`, used, resetsAt, seconds);
};

/** Primary and secondary window of one `rate_limit` object. */
const rateLimitWindows = (
  idPrefix: string,
  labelPrefix: string,
  raw: Json | undefined,
  nowMs: number,
): QuotaWindow[] => {
  if (raw === undefined || raw === null) return [];
  const info = record(raw);
  const reached = pick(info, "limit_reached", "limitReached") === true || info.allowed === false;

  const primary = windowOf(
    `${idPrefix}primary`,
    labelPrefix,
    "Primary",
    pick(info, "primary_window", "primaryWindow"),
    reached,
    nowMs,
  );

  const secondary = windowOf(
    `${idPrefix}secondary`,
    labelPrefix,
    "Secondary",
    pick(info, "secondary_window", "secondaryWindow"),
    reached,
    nowMs,
  );

  return [primary, secondary].filter((window) => window !== undefined);
};

/** Windows and plan of a `/wham/usage` payload; `nowMs` resolves relative reset offsets. */
export const parseCodexUsage = (payload: Json, nowMs: number): CodexUsage => {
  const root = record(payload);

  const windows = [
    ...rateLimitWindows("", "", pick(root, "rate_limit", "rateLimit"), nowMs),
    ...rateLimitWindows(
      "code_review_",
      "Code review",
      pick(root, "code_review_rate_limit", "codeReviewRateLimit"),
      nowMs,
    ),
  ];

  const additional = pick(root, "additional_rate_limits", "additionalRateLimits");

  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      const limit = record(item);

      const name =
        str(pick(limit, "limit_name", "limitName")) ??
        str(pick(limit, "metered_feature", "meteredFeature")) ??
        `Additional ${index + 1}`;

      windows.push(
        ...rateLimitWindows(
          `${slug(name) || `additional_${index + 1}`}_`,
          name,
          pick(limit, "rate_limit", "rateLimit"),
          nowMs,
        ),
      );
    });
  }

  const plan = str(pick(root, "plan_type", "planType"))?.toLowerCase();

  return { ...(plan === undefined ? {} : { plan }), windows: uniqueIds(windows) };
};
