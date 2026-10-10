// The Usage page's model (web/src/lib/usage.ts): ranges and their bars, merged series, filters as query parameters,
// and the page address read one parameter at a time.
import { describe, expect, it } from "vitest";
import type { UsagePoint } from "#contract/usage.ts";
import { formatLatency } from "../web/src/lib/format.ts";
import {
  activeFilters,
  breakdownOf,
  filterQuery,
  hourlyHistory,
  mergePoints,
  rangeBars,
  rangeOf,
  rangeStart,
  readUsageSearch,
} from "../web/src/lib/usage.ts";

const HOUR = 3_600_000;

const point = (start: number, tokens: number, requests = 1, failed = 0): UsagePoint => ({
  start,
  requests,
  failed,
  total_tokens: tokens,
});

const NOW = Date.parse("2026-10-10T12:30:00.000Z");

const HOUR_START = Date.parse("2026-10-10T12:00:00.000Z");

describe("hourlyHistory", () => {
  it("sums points per clock hour, the hour in progress last", () => {
    const bars = hourlyHistory(
      [point(HOUR_START, 5), point(HOUR_START + 10 * 60_000, 7), point(HOUR_START - HOUR, 3)],
      3,
      NOW,
    );

    expect(bars.map((bar) => [bar.start, bar.tokens, bar.requests, bar.current])).toEqual([
      [HOUR_START - 2 * HOUR, 0, 0, false],
      [HOUR_START - HOUR, 3, 1, false],
      [HOUR_START, 12, 2, true],
    ]);
  });
});

describe("ranges", () => {
  it("falls back to the last 24 hours for an unknown range", () => {
    expect(rangeOf(undefined).id).toBe("day");
    expect(rangeOf("year").id).toBe("day");
    expect(rangeOf("month").bars).toBe(30);
  });

  it("starts a range at its first bar", () => {
    expect(rangeStart(rangeOf("day"), NOW)).toBe(HOUR_START - 23 * HOUR);
    const week = rangeBars(rangeOf("week"), [], NOW);

    expect(week).toHaveLength(7);
    expect(rangeStart(rangeOf("week"), NOW)).toBe(week[0]?.start);
  });
});

describe("mergePoints", () => {
  it("sums every series per bucket, in time order", () => {
    expect(
      mergePoints([
        { points: [point(2 * HOUR, 10, 1, 1), point(HOUR, 4)] },
        { points: [point(2 * HOUR, 5, 2)] },
      ]),
    ).toEqual([point(HOUR, 4), point(2 * HOUR, 15, 3, 1)]);
  });
});

describe("filters", () => {
  it("maps filters to management API query parameters", () => {
    expect(
      filterQuery({ model: "gpt-5", account: "codex-a.json", user: "ian@example.com" }),
    ).toEqual({ model: "gpt-5", auth_id: "codex-a.json", principal: "ian@example.com" });
    expect(filterQuery({})).toEqual({});
  });

  it("lists the filters that are set in a fixed order", () => {
    expect(activeFilters({ user: "u", model: "m", provider: undefined })).toEqual([
      { key: "model", value: "m" },
      { key: "user", value: "u" },
    ]);
  });

  it("knows which breakdowns narrow the page", () => {
    expect(breakdownOf("auth").filter).toBe("account");
    expect(breakdownOf("endpoint").filter).toBeUndefined();
    expect(breakdownOf("nonsense").id).toBe("model");
  });
});

describe("readUsageSearch", () => {
  it("keeps the valid parameters and drops the rest", () => {
    expect(
      readUsageSearch({
        range: "week",
        by: "everything",
        model: "gpt-5",
        account: "codex-a.json",
        failed: true,
        extra: "x",
      }),
    ).toEqual({ range: "week", model: "gpt-5", account: "codex-a.json", failed: true });
  });

  it("drops a malformed value instead of failing", () => {
    expect(readUsageSearch({ failed: "yes", range: 3 })).toEqual({});
  });

  it("removes a parameter set to undefined", () => {
    expect(readUsageSearch({ range: "month", model: undefined })).toEqual({ range: "month" });
  });
});

describe("formatLatency", () => {
  it("reads milliseconds, seconds and minutes", () => {
    expect(formatLatency(840)).toBe("840 ms");
    expect(formatLatency(2_440)).toBe("2.4 s");
    expect(formatLatency(72_000)).toBe("1 min 12 s");
  });
});
