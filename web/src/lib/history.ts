// Tokens an account used in its past quota windows, summed from the hourly usage series
// (`GET /observability/usage/series`). Windows are counted back from the current window's reset in steps of its
// length; a provider whose window starts with the first request (Claude's 5-hour window) does not keep that grid, so
// those bars are an approximation, which the page says. Pure: no DOM, tested in test/web-history.test.ts.
import type { UsagePoint } from "#contract/usage.ts";

export interface HistoryBar {
  /** Epoch ms, inclusive. */
  readonly start: number;
  /** Epoch ms, exclusive. */
  readonly end: number;
  readonly tokens: number;
  readonly requests: number;
  /** The window in progress. */
  readonly current: boolean;
}

/** At most this many bars per chart. */
export const MAX_BARS = 28;

const HOUR_MS = 3_600_000;

const DAY_MS = 24 * HOUR_MS;

/** How far back the series is read: hour buckets may span 31 days (src/usage/d1.ts). */
export const HISTORY_SPAN_MS = 30 * DAY_MS;

const sum = (points: ReadonlyArray<UsagePoint>, start: number, end: number) =>
  points.reduce(
    (total, point) =>
      point.start >= start && point.start < end
        ? { tokens: total.tokens + point.total_tokens, requests: total.requests + point.requests }
        : total,
    { tokens: 0, requests: 0 },
  );

/**
 * Bars for the windows of length `seconds` ending at `resetsAt`, oldest first, the current window last. Windows that
 * began before `since` (outside the series) are left out. A reset already past is rolled forward to the window in
 * progress at `now`.
 */
export const windowHistory = (
  points: ReadonlyArray<UsagePoint>,
  window: { readonly resetsAt: number; readonly seconds: number },
  since: number,
  now: number,
): ReadonlyArray<HistoryBar> => {
  const length = window.seconds * 1000;

  if (!(length > 0)) return [];

  let end = window.resetsAt;

  if (end <= now) end += Math.ceil((now - end + 1) / length) * length;

  const bars: HistoryBar[] = [];

  for (let index = 0; index < MAX_BARS; index += 1) {
    const barEnd = end - index * length;
    const barStart = barEnd - length;

    if (barStart < since && index > 0) break;
    bars.push({
      start: barStart,
      end: barEnd,
      current: index === 0,
      ...sum(points, barStart, barEnd),
    });
  }

  return bars.toReversed();
};

/** Bars per local day for the last `days` days, today last (accounts without known windows). */
export const dailyHistory = (
  points: ReadonlyArray<UsagePoint>,
  days: number,
  now: number,
): ReadonlyArray<HistoryBar> => {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  return Array.from({ length: days }, (_, index) => {
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1 - index));
    const end = new Date(start);
    end.setDate(start.getDate() + 1);

    return {
      start: start.getTime(),
      end: end.getTime(),
      current: index === days - 1,
      ...sum(points, start.getTime(), end.getTime()),
    };
  });
};
