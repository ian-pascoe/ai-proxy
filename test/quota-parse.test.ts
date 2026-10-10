// Provider usage payloads → quota windows (src/quota/*.ts), and how a check merges into the stored report.
import { assert, describe, it } from "@effect/vitest";
import { parseAntigravityQuota } from "../src/quota/antigravity.ts";
import { parseClaudePlan, parseClaudeUsage } from "../src/quota/claude.ts";
import { parseCodexUsage } from "../src/quota/codex.ts";
import { devinUsage } from "../src/quota/devin.ts";
import {
  KIMI_AI_USAGE_URL,
  KIMI_USAGE_URL,
  kimiUsageUrl,
  parseKimiUsage,
} from "../src/quota/kimi.ts";
import { isDcaToken, parseMetaUsage } from "../src/quota/meta.ts";
import { isQuotaProvider, mergeQuotaReport, quotaReportJson } from "../src/quota/report.ts";
import { DAY, uniqueIds, windowId, windowLabel } from "../src/quota/window.ts";
import { parseXaiMonthly, parseXaiWeekly } from "../src/quota/xai.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const unixIso = (seconds: number): string => new Date(seconds * 1000).toISOString();

describe("claude usage", () => {
  it("lists the known windows in order, skips empty and dollar pools, adds scoped limits", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 12.5, resets_at: "2026-10-10T15:00:00.123456+00:00" },
      seven_day: { utilization: 40, resets_at: "2026-10-14T00:00:00Z" },
      seven_day_oauth_apps: null,
      seven_day_opus: { utilization: 0, resets_at: null },
      seven_day_cowork: { utilization: 10, limit_dollars: 50, used_dollars: 5 },
      iguana_necktie: { utilization: 5, resets_at: "2026-10-14T00:00:00Z" },
      extra_usage: { is_enabled: false, monthly_limit: null, utilization: null },
      seven_day_haiku: { utilization: "3", resets_at: "2026-10-15T00:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Fable" } },
          percent: 33,
          resets_at: "2026-10-16T00:00:00Z",
          is_active: true,
        },
        { kind: "session", percent: 90 },
      ],
    });

    assert.deepStrictEqual(windows, [
      {
        id: "five_hour",
        label: "5-hour",
        used_percent: 12.5,
        resets_at: "2026-10-10T15:00:00.123Z",
        window_seconds: 18_000,
      },
      {
        id: "seven_day",
        label: "Weekly",
        used_percent: 40,
        resets_at: "2026-10-14T00:00:00.000Z",
        window_seconds: 604_800,
      },
      { id: "seven_day_opus", label: "Weekly Opus", used_percent: 0, window_seconds: 604_800 },
      {
        id: "seven_day_haiku",
        label: "Weekly Haiku",
        used_percent: 3,
        resets_at: "2026-10-15T00:00:00.000Z",
        window_seconds: 604_800,
      },
      {
        id: "seven_day_fable",
        label: "Weekly Fable",
        used_percent: 33,
        resets_at: "2026-10-16T00:00:00.000Z",
        window_seconds: 604_800,
      },
    ]);
  });

  it("keeps the legacy Fable key without a scoped limit and clamps percentages", () => {
    const windows = parseClaudeUsage({ iguana_necktie: { utilization: 120 } });

    assert.deepStrictEqual(windows, [
      { id: "iguana_necktie", label: "Weekly Fable", used_percent: 100, window_seconds: 604_800 },
    ]);
  });

  it("derives the plan from the profile", () => {
    assert.strictEqual(
      parseClaudePlan({
        organization: { organization_type: "claude_team", subscription_status: "active" },
        account: { has_claude_max: true },
      }),
      "team",
    );
    assert.strictEqual(parseClaudePlan({ account: { has_claude_max: "true" } }), "max");
    assert.strictEqual(
      parseClaudePlan({ account: { has_claude_max: false, has_claude_pro: true } }),
      "pro",
    );
    assert.strictEqual(
      parseClaudePlan({ account: { has_claude_max: false, has_claude_pro: false } }),
      "free",
    );
    assert.strictEqual(parseClaudePlan({ account: {} }), undefined);
  });
});

describe("codex usage", () => {
  it("maps rate limits, code review and additional limits", () => {
    const usage = parseCodexUsage(
      {
        plan_type: "Plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3600,
            reset_at: 1_791_648_000,
          },
          secondary_window: {
            used_percent: 7,
            limit_window_seconds: 604_800,
            reset_after_seconds: 86_400,
          },
        },
        code_review_rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 604_800 },
          secondary_window: null,
        },
        additional_rate_limits: [
          {
            limit_name: "GPT-5 Codex Spark",
            rate_limit: { primary_window: { usedPercent: 10, limitWindowSeconds: 2_592_000 } },
          },
        ],
      },
      NOW,
    );

    assert.strictEqual(usage.plan, "plus");
    assert.deepStrictEqual(usage.windows, [
      {
        id: "primary",
        label: "5-hour",
        used_percent: 42,
        resets_at: unixIso(1_791_648_000),
        window_seconds: 18_000,
      },
      {
        id: "secondary",
        label: "Weekly",
        used_percent: 7,
        resets_at: new Date(NOW + DAY * 1000).toISOString(),
        window_seconds: 604_800,
      },
      {
        id: "code_review_primary",
        label: "Code review Weekly",
        used_percent: 0,
        window_seconds: 604_800,
      },
      {
        id: "gpt_5_codex_spark_primary",
        label: "GPT-5 Codex Spark Monthly",
        used_percent: 10,
        window_seconds: 2_592_000,
      },
    ]);
  });

  it("shows a reached limit with an upcoming reset as fully used", () => {
    const usage = parseCodexUsage(
      { rate_limit: { limit_reached: true, primary_window: { reset_after_seconds: 60 } } },
      NOW,
    );

    assert.deepStrictEqual(usage.windows, [
      {
        id: "primary",
        label: "Primary",
        used_percent: 100,
        resets_at: new Date(NOW + 60_000).toISOString(),
      },
    ]);
    assert.isUndefined(usage.plan);
  });
});

describe("antigravity quota", () => {
  it("flattens groups into buckets with remaining fractions", () => {
    const windows = parseAntigravityQuota({
      groups: [
        {
          displayName: "Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-pro-5h",
              displayName: "5h",
              window: "5h",
              remainingFraction: 0.75,
              resetTime: "2026-10-10T18:00:00Z",
            },
            {
              bucketId: "gemini-pro-weekly",
              displayName: "Gemini Pro weekly",
              window: "weekly",
              remainingFraction: "40%",
            },
            { bucketId: "no-fraction", displayName: "Unknown" },
          ],
        },
      ],
    });

    assert.deepStrictEqual(windows, [
      {
        id: "gemini-pro-5h",
        label: "Gemini Pro · 5h",
        used_percent: 25,
        resets_at: "2026-10-10T18:00:00.000Z",
        window_seconds: 18_000,
      },
      {
        id: "gemini-pro-weekly",
        label: "Gemini Pro weekly",
        used_percent: 60,
        window_seconds: 604_800,
      },
    ]);
  });

  it("is undefined without groups", () => {
    assert.isUndefined(parseAntigravityQuota({ error: "nope" }));
  });
});

describe("kimi usage", () => {
  it("reads limits and the weekly summary", () => {
    const windows = parseKimiUsage(
      {
        usage: { limit: "100", used: "25", remaining: "75", resetTime: "2026-10-17T00:00:00Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "90", resetTime: "2026-10-10T17:00:00Z" },
          },
          { detail: { limit: 0, used: 0 } },
        ],
      },
      NOW,
    );

    assert.deepStrictEqual(windows, [
      {
        id: "five_hour",
        label: "5-hour",
        used_percent: 10,
        resets_at: "2026-10-10T17:00:00.000Z",
        window_seconds: 18_000,
      },
      {
        id: "weekly",
        label: "Weekly",
        used_percent: 25,
        resets_at: "2026-10-17T00:00:00.000Z",
        window_seconds: 604_800,
      },
    ]);
  });

  it("only ever uses the two official hosts", () => {
    assert.strictEqual(kimiUsageUrl("kimi", {}), KIMI_USAGE_URL);
    assert.strictEqual(kimiUsageUrl("kimi.ai", {}), KIMI_AI_USAGE_URL);
    assert.strictEqual(
      kimiUsageUrl("kimi", { base_url: "https://api.kimi.ai/coding" }),
      KIMI_AI_USAGE_URL,
    );
    assert.strictEqual(kimiUsageUrl("kimi", { domain: "evil.example" }), KIMI_USAGE_URL);
    assert.strictEqual(kimiUsageUrl("kimi", { base_url: "https://evil.example" }), KIMI_USAGE_URL);
  });
});

describe("xai billing", () => {
  it("reads weekly credits and the monthly allowance", () => {
    assert.deepStrictEqual(
      parseXaiWeekly({
        config: {
          creditUsagePercent: 37.5,
          currentPeriod: { start: "2026-10-06T00:00:00Z", end: "2026-10-13T00:00:00Z" },
        },
      }),
      {
        id: "weekly",
        label: "Weekly credits",
        used_percent: 37.5,
        resets_at: "2026-10-13T00:00:00.000Z",
        window_seconds: 604_800,
      },
    );
    assert.deepStrictEqual(
      parseXaiMonthly({
        config: {
          monthlyLimit: { val: "5000" },
          used: { val: 1250 },
          billingPeriodStart: "2026-10-01T00:00:00Z",
          billingPeriodEnd: "2026-11-01T00:00:00Z",
        },
      }),
      {
        id: "monthly",
        label: "Monthly",
        used_percent: 25,
        resets_at: "2026-11-01T00:00:00.000Z",
        window_seconds: 31 * DAY,
      },
    );
    assert.isUndefined(parseXaiWeekly({ config: {} }));
    assert.isUndefined(parseXaiMonthly({ config: { monthlyLimit: 0, used: 10 } }));
  });
});

describe("meta usage", () => {
  it("reads the rolling and weekly windows and ignores everything else", () => {
    assert.deepStrictEqual(
      parseMetaUsage({
        api_key: "secret-minted-key",
        subs_tier_name: "Pro",
        subs_usage: {
          window: { used_percent: 20, window_duration_mins: 300, resets_at: 1_791_648_000 },
          weekly: { used_percent: 5.5, resets_at: 1_792_000_000 },
        },
      }),
      {
        plan: "Pro",
        windows: [
          {
            id: "window",
            label: "5-hour",
            used_percent: 20,
            resets_at: unixIso(1_791_648_000),
            window_seconds: 18_000,
          },
          {
            id: "weekly",
            label: "Weekly",
            used_percent: 5.5,
            resets_at: unixIso(1_792_000_000),
            window_seconds: 604_800,
          },
        ],
      },
    );
    assert.deepStrictEqual(parseMetaUsage({}), { windows: [] });
    assert.isUndefined(parseMetaUsage([1]));
    assert.isTrue(isDcaToken("dca:abc"));
    assert.isFalse(isDcaToken("sk-meta-key"));
  });
});

describe("devin status", () => {
  it("turns remaining percentages into used ones", () => {
    assert.deepStrictEqual(
      devinUsage({
        email: "",
        userName: "",
        userId: "",
        orgId: "",
        plan: "Teams",
        teamId: "",
        orgName: "",
        dailyQuotaRemainingPercent: 70,
        weeklyQuotaRemainingPercent: 100,
        dailyQuotaResetAt: 1_791_648_000,
        weeklyQuotaResetAt: 0,
        planStart: 0,
        planEnd: 0,
      }),
      {
        plan: "Teams",
        windows: [
          {
            id: "daily",
            label: "Daily",
            used_percent: 30,
            resets_at: unixIso(1_791_648_000),
            window_seconds: DAY,
          },
          { id: "weekly", label: "Weekly", used_percent: 0, window_seconds: 604_800 },
        ],
      },
    );
  });
});

describe("window helpers", () => {
  it("labels and identifies window lengths", () => {
    assert.deepStrictEqual(
      [18_000, DAY, 604_800, 30 * DAY, 3 * DAY, 7200, 5400, 90].map(windowLabel),
      ["5-hour", "Daily", "Weekly", "Monthly", "3-day", "2-hour", "90-minute", "90-second"],
    );
    assert.deepStrictEqual([18_000, DAY, 604_800, 30 * DAY, 7200, 5400, 90].map(windowId), [
      "five_hour",
      "daily",
      "weekly",
      "monthly",
      "2h",
      "90m",
      "90s",
    ]);
    assert.deepStrictEqual(
      uniqueIds([
        { id: "a", label: "A", used_percent: 1 },
        { id: "a", label: "A", used_percent: 2 },
      ]).map((window) => window.id),
      ["a", "a_2"],
    );
  });
});

describe("report merge", () => {
  const window = { id: "five_hour", label: "5-hour", used_percent: 10 };

  it("keeps windows, plan and refreshed_at across a failure and clears the error on success", () => {
    const first = mergeQuotaReport(undefined, { ok: true, plan: "max", windows: [window] }, "t1");

    assert.deepStrictEqual(first, {
      checked_at: "t1",
      refreshed_at: "t1",
      plan: "max",
      windows: [window],
    });

    const failed = mergeQuotaReport(
      first,
      { ok: false, error: "usage endpoint answered 500" },
      "t2",
    );

    assert.deepStrictEqual(failed, {
      checked_at: "t2",
      refreshed_at: "t1",
      plan: "max",
      windows: [window],
      error: "usage endpoint answered 500",
    });

    const recovered = mergeQuotaReport(failed, { ok: true, windows: [] }, "t3");

    assert.deepStrictEqual(recovered, {
      checked_at: "t3",
      refreshed_at: "t3",
      plan: "max",
      windows: [],
    });
    assert.deepStrictEqual(quotaReportJson(failed), { ...failed, windows: [{ ...window }] });
  });

  it("a first failure has no windows", () => {
    assert.deepStrictEqual(mergeQuotaReport(undefined, { ok: false, error: "x" }, "t1"), {
      checked_at: "t1",
      windows: [],
      error: "x",
    });
  });

  it("knows the supported providers", () => {
    assert.isTrue(isQuotaProvider("claude"));
    assert.isTrue(isQuotaProvider("kimi-ai"));
    assert.isFalse(isQuotaProvider("gemini"));
    assert.isFalse(isQuotaProvider("openai-compatible-x"));
  });
});
