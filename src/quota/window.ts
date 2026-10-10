/**
 * Shared pieces of the provider usage parsers (`src/quota/*.ts`): number/string/instant readers over parsed JSON and
 * the window labels and ids derived from a window length.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/utils/quota/parsers.ts (`normalizeNumberValue`,
 * `normalizeStringValue`, `normalizeQuotaFraction`) and src/utils/quota/resetInstants.ts (`resolveResetMs`,
 * `parseUnixToMs`, `parseOffsetSecondsToMs`). The panel keeps windows without a percentage (rendered as "-"); the
 * server report drops them because `used_percent` is required by the contract.
 */
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import type { QuotaWindow } from "../management/contract/credentials.ts";

export const FIVE_HOURS = 18_000;

export const DAY = 86_400;

export const WEEK = 604_800;

const MONTH_MIN = 28 * DAY;

const MONTH_MAX = 31 * DAY;

/** Object member of a JSON value (`{}` for anything else), so nested reads never throw. */
export const record = (value: Json | undefined): JsonObject => (isJsonObject(value) ? value : {});

/** `normalizeNumberValue`: finite numbers and numeric strings. */
export const num = (value: Json | undefined): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value.trim());

  return Number.isFinite(parsed) ? parsed : undefined;
};

/** `normalizeStringValue`: trimmed non-empty strings (numbers are stringified). */
export const str = (value: Json | undefined): string | undefined => {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();

  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
};

/** `normalizeQuotaFraction`: a 0–1 fraction as a number, a numeric string or `"40%"`. */
export const fraction = (value: Json | undefined): number | undefined => {
  const direct = num(value);

  if (direct !== undefined) return direct;
  const text = str(value);

  if (text === undefined || !text.endsWith("%")) return undefined;
  const parsed = Number(text.slice(0, -1));

  return Number.isFinite(parsed) ? parsed / 100 : undefined;
};

/** Percentages are clamped to 0–100 and rounded to two decimals. */
export const percent = (value: number): number =>
  Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;

const isoFromMs = (ms: number): string | undefined =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;

/** `parseUnixToMs`: seconds or milliseconds since the epoch, told apart by magnitude. */
export const unixIso = (value: Json | undefined): string | undefined => {
  const numeric = num(value);

  if (numeric === undefined || numeric <= 0) return undefined;

  return isoFromMs(numeric < 1e11 ? numeric * 1000 : numeric);
};

/** `parseIsoToMs`: an ISO-8601 instant, tolerating more than millisecond precision. */
export const isoInstant = (value: Json | undefined): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;

  return isoFromMs(Date.parse(value.trim().replace(/(\.\d{3})\d+/, "$1")));
};

/** `resolveResetMs`: the first candidate that parses as an ISO instant or a Unix timestamp. */
export const resetIso = (candidates: ReadonlyArray<Json | undefined>): string | undefined => {
  for (const candidate of candidates) {
    const instant = isoInstant(candidate) ?? unixIso(candidate);

    if (instant !== undefined) return instant;
  }

  return undefined;
};

/** `parseOffsetSecondsToMs`: a positive seconds-from-now value as an instant. */
export const offsetIso = (value: Json | undefined, nowMs: number): string | undefined => {
  const seconds = num(value);

  return seconds === undefined || seconds <= 0 ? undefined : isoFromMs(nowMs + seconds * 1000);
};

const isMonthly = (seconds: number): boolean => seconds >= MONTH_MIN && seconds <= MONTH_MAX;

const plural = (count: number, unit: string): string => `${count}-${unit}`;

/** Operator-facing name of a window of `seconds`: "5-hour", "Daily", "Weekly", "Monthly", else "3-day"/"90-minute". */
export const windowLabel = (seconds: number): string => {
  if (seconds === FIVE_HOURS) return "5-hour";

  if (seconds === DAY) return "Daily";

  if (seconds === WEEK) return "Weekly";

  if (isMonthly(seconds)) return "Monthly";

  if (seconds % DAY === 0) return plural(seconds / DAY, "day");

  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");

  return seconds % 60 === 0 ? plural(seconds / 60, "minute") : plural(seconds, "second");
};

/** Stable window id for a length: `five_hour`, `daily`, `weekly`, `monthly`, else `<n>h`/`<n>m`/`<n>s`. */
export const windowId = (seconds: number): string => {
  if (seconds === FIVE_HOURS) return "five_hour";

  if (seconds === DAY) return "daily";

  if (seconds === WEEK) return "weekly";

  if (isMonthly(seconds)) return "monthly";

  if (seconds % 3600 === 0) return `${seconds / 3600}h`;

  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
};

/** Lower-case id fragment of a free-form name (`"GPT-5 Codex"` → `gpt_5_codex`). */
export const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Builds a window, leaving out absent optional members. */
export const quotaWindow = (
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: string | undefined,
  windowSeconds: number | undefined,
): QuotaWindow => ({
  id,
  label,
  used_percent: percent(usedPercent),
  ...(resetsAt === undefined ? {} : { resets_at: resetsAt }),
  ...(windowSeconds === undefined || windowSeconds <= 0 ? {} : { window_seconds: windowSeconds }),
});

/** Appends `_2`, `_3`, … to ids that are already taken, so ids stay unique within one report. */
export const uniqueIds = (windows: ReadonlyArray<QuotaWindow>): QuotaWindow[] => {
  const seen = new Map<string, number>();

  return windows.map((window) => {
    const count = (seen.get(window.id) ?? 0) + 1;
    seen.set(window.id, count);

    return count === 1 ? window : { ...window, id: `${window.id}_${count}` };
  });
};
