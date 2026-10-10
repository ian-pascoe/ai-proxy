/**
 * Antigravity quota buckets (`POST …/v1internal:retrieveUserQuotaSummary`, body `{"project": …}`) as quota windows.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/antigravity/data.ts
 * (`fetchAntigravityQuota`: host order, 403/404 priority), src/utils/quota/builders.ts
 * (`buildAntigravityQuotaGroups`), src/utils/quota/constants.ts (`ANTIGRAVITY_QUOTA_URLS`,
 * `ANTIGRAVITY_REQUEST_HEADERS`).
 *
 * Differences from the panel: groups are flattened; a bucket's label is its display name, prefixed with the group's
 * display name when it does not already contain it ("Gemini Pro · 5h"); `used_percent` is
 * `(1 - remainingFraction) * 100`. The subscription tier (`loadCodeAssist`) is not requested.
 */
import type { Json } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";
import {
  FIVE_HOURS,
  WEEK,
  fraction,
  isoInstant,
  quotaWindow,
  record,
  slug,
  str,
  uniqueIds,
} from "./window.ts";

/** Tried in order; the first 2xx answer wins. */
export const ANTIGRAVITY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;

/** `ANTIGRAVITY_REQUEST_HEADERS` without the bearer token. */
export const ANTIGRAVITY_HEADERS = {
  "content-type": "application/json",
  "user-agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
} as const;

/** `antigravityPeriodHours`: the bucket's explicit `window`. */
const secondsOf = (window: string | undefined): number | undefined => {
  switch (window?.toLowerCase()) {
    case "5h":
    case "five-hour":
    case "five_hour":
      return FIVE_HOURS;
    case "weekly":
    case "week":
      return WEEK;
    default:
      return undefined;
  }
};

/** Windows of a `retrieveUserQuotaSummary` payload (`undefined` when it has no `groups` array). */
export const parseAntigravityQuota = (payload: Json): QuotaWindow[] | undefined => {
  const groups = record(payload).groups;

  if (!Array.isArray(groups)) return undefined;
  const windows: QuotaWindow[] = [];

  groups.forEach((rawGroup, groupIndex) => {
    const group = record(rawGroup);
    const groupLabel = str(group.displayName ?? group.display_name);
    const groupId = slug(groupLabel ?? "") || `group_${groupIndex + 1}`;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];

    buckets.forEach((rawBucket, bucketIndex) => {
      const bucket = record(rawBucket);
      const remaining = fraction(bucket.remainingFraction ?? bucket.remaining_fraction);

      if (remaining === undefined) return;
      const window = str(bucket.window);

      const id =
        str(bucket.bucketId ?? bucket.bucket_id) ??
        `${groupId}_${window ?? "bucket"}_${bucketIndex + 1}`;

      const name =
        str(bucket.displayName ?? bucket.display_name) ?? str(bucket.description) ?? window ?? id;

      const label =
        groupLabel === undefined || name.toLowerCase().includes(groupLabel.toLowerCase())
          ? name
          : `${groupLabel} · ${name}`;

      windows.push(
        quotaWindow(
          id,
          label,
          (1 - remaining) * 100,
          isoInstant(bucket.resetTime ?? bucket.reset_time),
          secondsOf(window),
        ),
      );
    });
  });

  return uniqueIds(windows);
};
