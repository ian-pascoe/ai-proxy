// The Usage page's ranges, breakdowns and filters, and the bars of its chart, over the D1 usage history
// (`GET /observability/usage/summary|series|records`). Pure: no DOM, tested in test/web-usage.test.ts.
import { Effect, flow, Option, Schema } from "effect";
import type { UsageGroupBy, UsagePoint } from "#contract/usage.ts";
import { dailyHistory, type HistoryBar } from "./history.ts";

const HOUR_MS = 3_600_000;

export type RangeId = "day" | "week" | "month";

export interface Range {
  readonly id: RangeId;
  readonly label: string;
  /** What one bar of the chart covers. */
  readonly bar: "hour" | "day";
  /** How many bars, the one in progress last. */
  readonly bars: number;
}

export const RANGES: ReadonlyArray<Range> = [
  { id: "day", label: "24 hours", bar: "hour", bars: 24 },
  { id: "week", label: "7 days", bar: "day", bars: 7 },
  { id: "month", label: "30 days", bar: "day", bars: 30 },
];

export const DEFAULT_RANGE: Range = { id: "day", label: "24 hours", bar: "hour", bars: 24 };

export const rangeOf = (id: string | undefined): Range =>
  RANGES.find((range) => range.id === id) ?? DEFAULT_RANGE;

/** Bars per clock hour for the last `hours` hours, the hour in progress last. */
export const hourlyHistory = (
  points: ReadonlyArray<UsagePoint>,
  hours: number,
  now: number,
): ReadonlyArray<HistoryBar> => {
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;

  return Array.from({ length: hours }, (_, index) => {
    const start = current - (hours - 1 - index) * HOUR_MS;
    const end = start + HOUR_MS;
    const inside = points.filter((point) => point.start >= start && point.start < end);

    return {
      start,
      end,
      current: index === hours - 1,
      tokens: inside.reduce((sum, point) => sum + point.total_tokens, 0),
      requests: inside.reduce((sum, point) => sum + point.requests, 0),
    };
  });
};

/** The chart's bars for a range: hours for the last day, local days otherwise. */
export const rangeBars = (
  range: Range,
  points: ReadonlyArray<UsagePoint>,
  now: number,
): ReadonlyArray<HistoryBar> =>
  range.bar === "hour"
    ? hourlyHistory(points, range.bars, now)
    : dailyHistory(points, range.bars, now);

/**
 * Where a range starts (epoch ms), the start of its first bar, so the totals, the breakdown and the chart cover the
 * same time.
 */
export const rangeStart = (range: Range, now: number): number =>
  rangeBars(range, [], now)[0]?.start ?? now;

/** Every series' points summed per bucket start, in time order. */
export const mergePoints = (
  series: ReadonlyArray<{ readonly points: ReadonlyArray<UsagePoint> }>,
): ReadonlyArray<UsagePoint> => {
  const byStart = new Map<number, UsagePoint>();

  for (const point of series.flatMap((entry) => entry.points)) {
    const seen = byStart.get(point.start);

    byStart.set(
      point.start,
      seen === undefined
        ? point
        : {
            start: point.start,
            requests: seen.requests + point.requests,
            failed: seen.failed + point.failed,
            total_tokens: seen.total_tokens + point.total_tokens,
          },
    );
  }

  return [...byStart.values()].toSorted((a, b) => a.start - b.start);
};

/** What the usage is narrowed to; every page part (totals, chart, breakdown, log) applies the same filters. */
export interface UsageFilters {
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  /** A credential id. */
  readonly account?: string | undefined;
  /** An Access principal. */
  readonly user?: string | undefined;
}

export type FilterKey = keyof UsageFilters;

export interface Breakdown {
  readonly id: Exclude<UsageGroupBy, "day">;
  readonly label: string;
  /** The column heading. */
  readonly noun: string;
  /** The filter a row narrows to; endpoints cannot be filtered. */
  readonly filter: FilterKey | undefined;
}

export const BREAKDOWNS: ReadonlyArray<Breakdown> = [
  { id: "model", label: "Model", noun: "Model", filter: "model" },
  { id: "auth", label: "Account", noun: "Account", filter: "account" },
  { id: "provider", label: "Provider", noun: "Provider", filter: "provider" },
  { id: "principal", label: "User", noun: "User", filter: "user" },
  { id: "endpoint", label: "Endpoint", noun: "Endpoint", filter: undefined },
];

export const DEFAULT_BREAKDOWN: Breakdown = {
  id: "model",
  label: "Model",
  noun: "Model",
  filter: "model",
};

export const breakdownOf = (id: string | undefined): Breakdown =>
  BREAKDOWNS.find((breakdown) => breakdown.id === id) ?? DEFAULT_BREAKDOWN;

export const FILTER_LABELS: Readonly<Record<FilterKey, string>> = {
  model: "Model",
  account: "Account",
  provider: "Provider",
  user: "User",
};

/** The filters as management API query parameters. */
export const filterQuery = (filters: UsageFilters) => ({
  ...(filters.model === undefined ? {} : { model: filters.model }),
  ...(filters.provider === undefined ? {} : { provider: filters.provider }),
  ...(filters.account === undefined ? {} : { auth_id: filters.account }),
  ...(filters.user === undefined ? {} : { principal: filters.user }),
});

/** The filters that are set, in a fixed order. */
export const activeFilters = (
  filters: UsageFilters,
): ReadonlyArray<{ readonly key: FilterKey; readonly value: string }> =>
  (["model", "account", "provider", "user"] as const).flatMap((key) => {
    const value = filters[key];

    return value === undefined ? [] : [{ key, value }];
  });

/** A parameter that is dropped, rather than failing the whole address, when its value is malformed. */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

/**
 * The page's address: `/usage?range=week&by=auth&model=…&account=…&provider=…&user=…&failed=true`. A malformed
 * parameter is dropped on its own; the others still apply.
 */
export const UsageSearch = Schema.Struct({
  range: lenient(Schema.Literals(["day", "week", "month"])),
  by: lenient(Schema.Literals(["model", "auth", "provider", "principal", "endpoint"])),
  model: lenient(Schema.String),
  provider: lenient(Schema.String),
  account: lenient(Schema.String),
  user: lenient(Schema.String),
  failed: lenient(Schema.Boolean),
});

export type UsageSearch = typeof UsageSearch.Type;

/** The router's search parameters as the page reads them; anything but an object reads as no parameters. */
export const readUsageSearch = flow(
  Schema.decodeUnknownOption(UsageSearch),
  Option.getOrElse((): UsageSearch => ({})),
);
