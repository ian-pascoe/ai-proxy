// Quota windows of an account, read from the upstream rate-limit headers the Worker last observed for it
// (`quota.signals`, src/credentials/cooldown/quota-signals.ts) and from its cooldowns. Pure: no DOM, tested in
// test/web-quota.test.ts.
import type { CredentialEntry } from "#contract/credentials.ts";

export type QuotaLevel = "ok" | "near" | "out";

export interface QuotaWindow {
  /** "5-hour", "Weekly", "Daily", ... */
  readonly label: string;
  /** Share of the window's allowance used, 0–100. */
  readonly usedPercent: number;
  /** When the window's allowance resets (epoch ms), when the provider says. */
  readonly resetsAt: number | undefined;
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
      },
    ];
  });

/** Providers whose responses carry quota figures the panel can read. */
export const reportsQuota = (provider: string): boolean =>
  provider === "claude" || provider === "codex" || provider === "devin";

/** The account's quota windows, shortest first; empty when the provider reported none. */
export const quotaWindows = (entry: CredentialEntry): ReadonlyArray<QuotaWindow> => {
  const { signals } = entry.quota;

  const observedAt =
    entry.quota.observed_at === undefined ? undefined : Date.parse(entry.quota.observed_at);

  switch (entry.provider) {
    case "claude":
      return claudeWindows(signals);
    case "codex":
      return codexWindows(signals, Number.isNaN(observedAt) ? undefined : observedAt);
    case "devin":
      return devinWindows(signals);
    default:
      return [];
  }
};

export const windowLevel = (window: QuotaWindow): QuotaLevel => {
  if (window.usedPercent >= 100) return "out";

  return window.usedPercent >= NEAR_LIMIT_PERCENT ? "near" : "ok";
};

/** The earliest time the account can serve requests again when it is cut off (credential-wide cooldown). */
export const cutOffUntil = (entry: CredentialEntry): number | undefined => {
  const credentialWide = entry.cooldowns.find((cooldown) => cooldown.scope === "credential");

  if (credentialWide === undefined) return undefined;
  const at = Date.parse(credentialWide.retry_at);

  return Number.isNaN(at) ? undefined : at;
};

export interface AccountStanding {
  readonly level: QuotaLevel;
  readonly windows: ReadonlyArray<QuotaWindow>;
  /** Cut off until this time (credential-wide cooldown). */
  readonly cutOffUntil: number | undefined;
  /** The reset the operator waits for: the cooldown's end, else the fullest window's reset, else the soonest known. */
  readonly nextReset: number | undefined;
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

  const earliestReset = windows
    .flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]))
    .reduce<number | undefined>(
      (soonest, at) => (soonest === undefined || at < soonest ? at : soonest),
      undefined,
    );

  return {
    level,
    windows,
    cutOffUntil: until,
    nextReset: until ?? fullest?.resetsAt ?? earliestReset,
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
