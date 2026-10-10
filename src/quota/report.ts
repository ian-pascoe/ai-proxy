/**
 * The per-credential quota report (`QuotaReport` of the management contract): which providers can be checked, the
 * result of one check, and how it is merged into the stored report.
 *
 * Semantics (contract, src/management/contract/credentials.ts): `checked_at` is the last attempt and `refreshed_at`
 * the last success; `windows` and `plan` come from the last success and survive a later failure; `error` is the last
 * attempt's failure and is absent after a success. A success without a plan (Claude's profile call failed, a provider
 * without plans) keeps the previously known plan.
 *
 * Workers deviation: Go has no server-side usage probing (the upstream panel calls the provider usage endpoints from
 * the browser through `POST /requests/api-call`); see docs/ARCHITECTURE.md "Quota check".
 */
import type { JsonObject } from "../json/index.ts";
import type { QuotaReport, QuotaWindow } from "../management/contract/credentials.ts";

/** Executor keys (`executorKey`) with a usage endpoint. */
export const QUOTA_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "meta",
  "devin",
] as const;

export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];

const SUPPORTED: ReadonlySet<string> = new Set(QUOTA_PROVIDERS);

export const isQuotaProvider = (provider: string): provider is QuotaProvider =>
  SUPPORTED.has(provider);

/** The result of one check: the windows (and plan) the provider reported, or why the check failed (no secrets). */
export type QuotaOutcome =
  | { readonly ok: true; readonly plan?: string; readonly windows: ReadonlyArray<QuotaWindow> }
  | { readonly ok: false; readonly error: string };

/** Applies one check made at `checkedAt` (ISO) to the stored report. */
export const mergeQuotaReport = (
  previous: QuotaReport | undefined,
  outcome: QuotaOutcome,
  checkedAt: string,
): QuotaReport => {
  if (outcome.ok) {
    const plan = outcome.plan ?? previous?.plan;

    return {
      checked_at: checkedAt,
      refreshed_at: checkedAt,
      ...(plan === undefined ? {} : { plan }),
      windows: [...outcome.windows],
    };
  }

  return {
    checked_at: checkedAt,
    ...(previous?.refreshed_at === undefined ? {} : { refreshed_at: previous.refreshed_at }),
    ...(previous?.plan === undefined ? {} : { plan: previous.plan }),
    windows: [...(previous?.windows ?? [])],
    error: outcome.error,
  };
};

const windowJson = (window: QuotaWindow): JsonObject => ({
  id: window.id,
  label: window.label,
  used_percent: window.used_percent,
  ...(window.resets_at === undefined ? {} : { resets_at: window.resets_at }),
  ...(window.window_seconds === undefined ? {} : { window_seconds: window.window_seconds }),
});

/** The report as a plain JSON object (credential list entries are `JsonObject`s). */
export const quotaReportJson = (report: QuotaReport): JsonObject => ({
  checked_at: report.checked_at,
  ...(report.refreshed_at === undefined ? {} : { refreshed_at: report.refreshed_at }),
  ...(report.plan === undefined ? {} : { plan: report.plan }),
  windows: report.windows.map(windowJson),
  ...(report.error === undefined ? {} : { error: report.error }),
});
