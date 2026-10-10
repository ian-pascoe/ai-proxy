/**
 * Meta (Muse) subscription usage (`POST https://api.meta.ai/muse-code/key`, authorised with the credential's
 * `dca_token`) as quota windows and plan.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/meta/requests.ts
 * (`createMetaQuotaFetcher`: headers, `dca:` token check) and src/services/api/metaQuota.ts
 * (`parseMetaQuotaPayload`).
 *
 * The response can echo the minted `api_key` and personal data: only the fields below are read, and the body is never
 * logged, stored or used in an error message. A valid object without `subs_usage` is a successful check with no
 * windows. Ids: `window` (the rolling window, labelled from `window_duration_mins`, "Session" without a length) and
 * `weekly`.
 */
import { isJsonObject, type Json } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";
import { WEEK, num, quotaWindow, record, str, unixIso, windowLabel } from "./window.ts";

export const META_QUOTA_URL = "https://api.meta.ai/muse-code/key";

export const META_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "x-api-version": "1.0.0",
} as const;

/** Only a `dca:` token authorises the usage endpoint (never the minted LLM key). */
export const isDcaToken = (token: string): boolean => /^dca:\S+$/.test(token);

export interface MetaUsage {
  readonly plan?: string;
  readonly windows: QuotaWindow[];
}

/** Windows and plan of a `muse-code/key` payload (`undefined` when it is not a JSON object). */
export const parseMetaUsage = (payload: Json): MetaUsage | undefined => {
  if (!isJsonObject(payload)) return undefined;
  const root = payload;
  const usage = record(root.subs_usage);
  const plan = str(root.subs_tier_name) ?? str(usage.tier);
  const windows: QuotaWindow[] = [];
  const rolling = record(usage.window);
  const rollingUsed = num(rolling.used_percent);

  if (rollingUsed !== undefined) {
    const minutes = num(rolling.window_duration_mins);
    const seconds = minutes === undefined || minutes <= 0 ? undefined : minutes * 60;

    windows.push(
      quotaWindow(
        "window",
        seconds === undefined ? "Session" : windowLabel(seconds),
        rollingUsed,
        unixIso(rolling.resets_at),
        seconds,
      ),
    );
  }

  const weekly = record(usage.weekly);
  const weeklyUsed = num(weekly.used_percent);

  if (weeklyUsed !== undefined)
    windows.push(quotaWindow("weekly", "Weekly", weeklyUsed, unixIso(weekly.resets_at), WEEK));

  return { ...(plan === undefined ? {} : { plan }), windows };
};
