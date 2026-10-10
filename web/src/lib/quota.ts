// Quota windows of an account: from the server's quota check (`quota_report`, src/quota/) or from the upstream
// rate-limit headers the Worker last observed for it (`quota.signals`, src/credentials/cooldown/quota-signals.ts),
// whichever is fresher, and from its cooldowns. Pure: no DOM, tested in test/web-quota.test.ts.
import type { CredentialEntry } from "#contract/credentials.ts";

export type QuotaLevel = "ok" | "near" | "out";

export interface QuotaWindow {
  /** "5-hour", "Weekly", "Daily", ... */
  readonly label: string;
  /** Share of the window's allowance used, 0–100. */
  readonly usedPercent: number;
  /** When the window's allowance resets (epoch ms), when the provider says. */
  readonly resetsAt: number | undefined;
  /** The window's length in seconds, when known (the history counts past windows with it). */
  readonly seconds: number | undefined;
}

/** From this share on a window is "near its limit" (amber). */
export const NEAR_LIMIT_PERCENT = 80;

type Signals = Readonly<Record<string, string>>;

/** Header values are stored under canonical names (`Anthropic-Ratelimit-Unified-5h-Utilization`); match any case. */
const signal = (signals: Signals, name: string): string | undefined => {
  const wanted = name.toLowerCase();

  for (const [key, value] of Object.entries(signals)) {
    if (key.toLowerCase() === wanted) return value.trim();
  }

  return undefined;
};

const finite = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw.replace(/%$/, ""));

  return Number.isFinite(value) ? value : undefined;
};

/** Unix seconds or an RFC 3339 time, as epoch ms. */
const instant = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const seconds = finite(raw);

  if (seconds !== undefined) return seconds > 0 ? seconds * 1000 : undefined;
  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? undefined : parsed;
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** A window length in minutes as a label: 300 is "5-hour", 10080 "Weekly". */
export const windowLabel = (minutes: number): string => {
  if (minutes === 10_080) return "Weekly";

  if (minutes === 1440) return "Daily";

  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;

  if (minutes % 60 === 0) return `${minutes / 60}-hour`;

  return `${minutes}-minute`;
};

const HOUR_SECONDS = 3600;

const DAY_SECONDS = 24 * HOUR_SECONDS;

const WEEK_SECONDS = 7 * DAY_SECONDS;

const claudeWindows = (signals: Signals): QuotaWindow[] =>
  (
    [
      ["5h", "5-hour"],
      ["7d", "Weekly"],
    ] as const
  ).flatMap(([key, label]) => {
    const utilization = finite(signal(signals, `anthropic-ratelimit-unified-${key}-utilization`));

    if (utilization === undefined) return [];

    return [
      {
        label,
        // Anthropic reports a fraction (0.69 is 69%).
        usedPercent: clampPercent(utilization * 100),
        resetsAt: instant(signal(signals, `anthropic-ratelimit-unified-${key}-reset`)),
        seconds: key === "5h" ? 5 * HOUR_SECONDS : WEEK_SECONDS,
      },
    ];
  });

const codexWindows = (signals: Signals, observedAt: number | undefined): QuotaWindow[] =>
  (["primary", "secondary"] as const).flatMap((which) => {
    const used = finite(signal(signals, `x-codex-${which}-used-percent`));

    if (used === undefined) return [];
    const minutes = finite(signal(signals, `x-codex-${which}-window-minutes`));
    const after = finite(signal(signals, `x-codex-${which}-reset-after-seconds`));
    const at = instant(signal(signals, `x-codex-${which}-reset-at`));

    return [
      {
        label:
          minutes === undefined ? (which === "primary" ? "Short" : "Long") : windowLabel(minutes),
        usedPercent: clampPercent(used),
        resetsAt:
          at ??
          (after === undefined || observedAt === undefined ? undefined : observedAt + after * 1000),
        seconds: minutes === undefined ? undefined : minutes * 60,
      },
    ];
  });

const devinWindows = (signals: Signals): QuotaWindow[] =>
  (
    [
      ["daily", "Daily"],
      ["weekly", "Weekly"],
    ] as const
  ).flatMap(([key, label]) => {
    const remaining = finite(signal(signals, `${key}_quota_remaining_percent`));

    if (remaining === undefined) return [];

    return [
      {
        label,
        usedPercent: clampPercent(100 - remaining),
        resetsAt: instant(signal(signals, `${key}_quota_reset_at`)),
        seconds: key === "daily" ? DAY_SECONDS : WEEK_SECONDS,
      },
    ];
  });

/** Providers the server's quota check can ask for figures (src/quota/). */
const CHECKED_PROVIDERS = new Set([
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "meta",
  "devin",
]);

export const checksQuota = (provider: string): boolean => CHECKED_PROVIDERS.has(provider);

const parsedTime = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const at = Date.parse(raw);

  return Number.isNaN(at) ? undefined : at;
};

const headerWindows = (entry: CredentialEntry): QuotaWindow[] => {
  const { signals } = entry.quota;
  const observedAt = parsedTime(entry.quota.observed_at);

  switch (entry.provider) {
    case "claude":
      return claudeWindows(signals);
    case "codex":
      return codexWindows(signals, observedAt);
    case "devin":
      return devinWindows(signals);
    default:
      return [];
  }
};

const reportWindows = (entry: CredentialEntry): QuotaWindow[] =>
  (entry.quota_report?.windows ?? []).map((window) => ({
    label: window.label,
    usedPercent: clampPercent(window.used_percent),
    resetsAt: parsedTime(window.resets_at),
    seconds: window.window_seconds,
  }));

export interface QuotaReading {
  readonly windows: ReadonlyArray<QuotaWindow>;
  /** Where the figures come from: the server's quota check or the headers of the last response; none without figures. */
  readonly source: "check" | "response" | undefined;
  /** When the figures were read (epoch ms). */
  readonly readAt: number | undefined;
}

/** The account's freshest figures: the last successful quota check, or the last response's headers when newer. */
export const quotaReading = (entry: CredentialEntry): QuotaReading => {
  const fromHeaders = headerWindows(entry);
  const headersAt = parsedTime(entry.quota.observed_at);
  const fromCheck = reportWindows(entry);
  const checkedAt = parsedTime(entry.quota_report?.refreshed_at);

  const checkIsFresher =
    fromCheck.length > 0 &&
    (fromHeaders.length === 0 ||
      headersAt === undefined ||
      (checkedAt !== undefined && checkedAt >= headersAt));

  if (checkIsFresher) return { windows: fromCheck, source: "check", readAt: checkedAt };

  if (fromHeaders.length > 0)
    return { windows: fromHeaders, source: "response", readAt: headersAt };

  return { windows: [], source: undefined, readAt: undefined };
};

/** The account's quota windows (shortest first for header figures, the provider's order for checked ones). */
export const quotaWindows = (entry: CredentialEntry): ReadonlyArray<QuotaWindow> =>
  quotaReading(entry).windows;

export const windowLevel = (window: QuotaWindow): QuotaLevel => {
  if (window.usedPercent >= 100) return "out";

  return window.usedPercent >= NEAR_LIMIT_PERCENT ? "near" : "ok";
};

/** The earliest time the account can serve requests again when it is cut off (credential-wide cooldown). */
export const cutOffUntil = (entry: CredentialEntry): number | undefined => {
  const credentialWide = entry.cooldowns.find((cooldown) => cooldown.scope === "credential");

  return credentialWide === undefined ? undefined : parsedTime(credentialWide.retry_at);
};

export interface AccountStanding {
  readonly level: QuotaLevel;
  readonly windows: ReadonlyArray<QuotaWindow>;
  /** Cut off until this time (credential-wide cooldown). */
  readonly cutOffUntil: number | undefined;
  /** The reset the operator waits for: the cooldown's end, else the fullest window's reset, else the soonest known. */
  readonly nextReset: number | undefined;
  /** The window `nextReset` belongs to ("5-hour"); `undefined` when it is the cooldown's end. */
  readonly nextResetWindow: string | undefined;
  /** The fullest window's share, 0–100 (`undefined` without quota data). */
  readonly peakPercent: number | undefined;
}

export const accountStanding = (entry: CredentialEntry): AccountStanding => {
  const windows = quotaWindows(entry);
  const until = cutOffUntil(entry);

  const fullest = windows.reduce<QuotaWindow | undefined>(
    (best, window) => (best === undefined || window.usedPercent > best.usedPercent ? window : best),
    undefined,
  );

  const level: QuotaLevel =
    until !== undefined || entry.status === "error"
      ? "out"
      : fullest === undefined
        ? "ok"
        : windowLevel(fullest);

  const soonest = windows
    .filter((window) => window.resetsAt !== undefined)
    .reduce<QuotaWindow | undefined>(
      (best, window) =>
        best === undefined || (window.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity)
          ? window
          : best,
      undefined,
    );

  const waitedFor = fullest?.resetsAt === undefined ? soonest : fullest;

  return {
    level,
    windows,
    cutOffUntil: until,
    nextReset: until ?? waitedFor?.resetsAt,
    nextResetWindow: until === undefined ? waitedFor?.label : undefined,
    peakPercent: fullest?.usedPercent,
  };
};

const LEVEL_RANK: Readonly<Record<QuotaLevel, number>> = { out: 0, near: 1, ok: 2 };

/**
 * Urgency order of the overview: cut off first, then nearest to a limit, accounts without quota data after those
 * with it, disabled accounts last; ties by name.
 */
export const byUrgency = (a: CredentialEntry, b: CredentialEntry): number => {
  if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
  const left = accountStanding(a);
  const right = accountStanding(b);
  const rank = LEVEL_RANK[left.level] - LEVEL_RANK[right.level];

  if (rank !== 0) return rank;
  const peak = (right.peakPercent ?? -1) - (left.peakPercent ?? -1);

  if (peak !== 0) return peak;

  return a.name.localeCompare(b.name);
};
