// D1 persistence of usage records: schema, sink (ctx.waitUntil), export queue, listing, summary and retention.
import { env } from "cloudflare:workers"
import { Effect, Logger, References } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, describe, expect, it } from "vitest"
import { WorkerEnv, WorkerExecutionContext } from "../src/platform/env.ts"
import { scheduledTasks } from "../src/scheduled.ts"
import {
  insertUsageRecord,
  listUsageRecords,
  popUsageQueue,
  pruneUsageRecords,
  recordToRow,
  rowToPayload,
  summarizeUsage,
  type UsageRow
} from "../src/usage/d1.ts"
import { D1UsageSink } from "../src/usage/d1-sink.ts"
import { ensureTokenBreakdown } from "../src/usage/accounting.ts"
import { parseClaudeUsage } from "../src/usage/parsers.ts"
import { pruneExpiredUsage, retentionDays } from "../src/usage/retention.ts"
import { UsageSink } from "../src/usage/sink.ts"
import { resetUsageDb, sampleRecord } from "./support/usage.ts"

let db: D1Database
beforeEach(async () => {
  db = await resetUsageDb()
})

const rows = async () =>
  (await db.prepare("SELECT * FROM usage_records ORDER BY requested_at, request_id").all<UsageRow>()).results

describe("D1 usage sink", () => {
  it("persists the record through ctx.waitUntil without blocking the caller", async () => {
    const pending: Array<Promise<unknown>> = []
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) } as unknown as ExecutionContext
    const record = sampleRecord({ stream: true, ttftMs: 40, responseModel: "gpt-5-2025", reasoningEffort: "high" })
    await Effect.gen(function* () {
      const sink = yield* UsageSink
      yield* sink.publish(record)
    }).pipe(
      Effect.provide(D1UsageSink),
      Effect.provideService(WorkerEnv, env),
      Effect.provideService(WorkerExecutionContext, ctx),
      Effect.runPromise
    )
    expect(pending).toHaveLength(1)
    await Promise.all(pending)
    const [row] = await rows()
    expect(row).toMatchObject({
      request_id: record.requestId,
      trace_id: "trace-1",
      requested_at: 1_700_000_000_000,
      latency_ms: 120,
      ttft_ms: 40,
      provider: "codex",
      model: "gpt-5",
      response_model: "gpt-5-2025",
      endpoint: "POST /v1/responses",
      principal_id: "user:dev@example.com",
      stream: 1,
      failed: 0,
      fail_status: null,
      reasoning_effort: "high",
      input_tokens: 100,
      output_tokens: 30,
      reasoning_tokens: 12,
      cache_read_tokens: 40,
      total_tokens: 130,
      accounting_version: 2,
      acct_quality: "complete",
      acct_input_tokens: 100,
      acct_input_uncached_tokens: 60,
      acct_cache_read_tokens: 40,
      acct_output_tokens: 30,
      acct_output_non_reasoning_tokens: 18,
      acct_output_reasoning_tokens: 12,
      exported_at: null
    })
  })

  it("stores failures with a bounded body and is idempotent per request id", async () => {
    const record = sampleRecord({ failed: true, fail: { statusCode: 429, body: "x".repeat(10_000) } })
    await insertUsageRecord(db, record)
    await insertUsageRecord(db, record)
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ failed: 1, fail_status: 429 })
    expect(stored[0]?.fail_body).toHaveLength(2048)
  })

  it("never fails the request when the write fails and does nothing without a binding", async () => {
    const warnings: Array<{ message: unknown; annotations: Record<string, unknown> }> = []
    const capture = Logger.layer([
      Logger.make((options) => {
        warnings.push({
          message: options.message,
          annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) } as Record<string, unknown>
        })
      })
    ])
    const pending: Array<Promise<unknown>> = []
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) } as unknown as ExecutionContext
    const broken = {
      ...env,
      USAGE: { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }) }
    } as unknown as Env
    const record = sampleRecord()
    const publish = (bindings: Env) =>
      Effect.gen(function* () {
        yield* (yield* UsageSink).publish(record)
      }).pipe(
        Effect.provide(D1UsageSink),
        Effect.provide(capture),
        Effect.provideService(WorkerEnv, bindings),
        Effect.provideService(WorkerExecutionContext, ctx),
        Effect.runPromise
      )
    await publish(broken)
    await Promise.all(pending)
    expect(warnings).toEqual([
      { message: ["usage record write failed"], annotations: { requestId: record.requestId, error: "D1 down" } }
    ])
    await publish({ ...env, USAGE: undefined } as unknown as Env)
    expect(pending).toHaveLength(1)
  })

  it("falls back to awaiting the write when waitUntil is unavailable", async () => {
    const ctx = {
      waitUntil: () => {
        throw new Error("invocation finished")
      }
    } as unknown as ExecutionContext
    await Effect.gen(function* () {
      yield* (yield* UsageSink).publish(sampleRecord())
    }).pipe(
      Effect.provide(D1UsageSink),
      Effect.provideService(WorkerEnv, env),
      Effect.provideService(WorkerExecutionContext, ctx),
      Effect.runPromise
    )
    expect(await rows()).toHaveLength(1)
  })

  it("persists the Claude independent breakdown parsed from the upstream usage", async () => {
    const detail = parseClaudeUsage(
      '{"usage":{"input_tokens":2,"cache_creation_input_tokens":831,"cache_read_input_tokens":44225,"output_tokens":244,"output_tokens_details":{"thinking_tokens":40}}}'
    )
    await insertUsageRecord(db, sampleRecord({ provider: "claude", executorType: "claude", detail }))
    expect((await rows())[0]).toMatchObject({
      total_tokens: 45302,
      acct_quality: "complete",
      acct_total_tokens: 45302,
      acct_input_tokens: 45058,
      acct_input_uncached_tokens: 2,
      acct_cache_read_tokens: 44225,
      acct_cache_write_tokens: 831,
      acct_output_non_reasoning_tokens: 204,
      acct_output_reasoning_tokens: 40
    })
  })

  it("derives a breakdown for records that only carry raw buckets", () => {
    const raw = { ...sampleRecord().detail, totalTokens: 0 }
    const row = recordToRow(sampleRecord({ provider: "gemini", executorType: "gemini", detail: raw }))
    // Gemini: reasoning is separate from the candidates count, so it adds to the output.
    expect(row).toMatchObject({ total_tokens: 142, acct_total_tokens: 142, acct_output_tokens: 42 })
    const inconsistent = recordToRow(sampleRecord({ provider: "gemini", executorType: "gemini" }))
    expect(inconsistent).toMatchObject({ acct_quality: "inconsistent", acct_unclassified_tokens: 130 })
    expect(ensureTokenBreakdown(sampleRecord().detail, "codex", "codex").tokenBreakdown?.totalTokens).toBe(130)
  })
})

describe("export queue (GET /observability/usage/queue)", () => {
  it("pops the oldest unexported records exactly once, in order", async () => {
    for (let index = 0; index < 5; index += 1) {
      await insertUsageRecord(db, sampleRecord({ requestId: `r${index}`, requestedAt: 1000 + index }))
    }
    const first = await popUsageQueue(db, 2, 5000)
    expect(first.map((row) => row.request_id)).toEqual(["r0", "r1"])
    expect(first.every((row) => row.exported_at === 5000)).toBe(true)
    const second = await popUsageQueue(db, 10, 6000)
    expect(second.map((row) => row.request_id)).toEqual(["r2", "r3", "r4"])
    expect(await popUsageQueue(db, 1, 7000)).toEqual([])
    // Exported records stay available for the listing endpoints.
    expect(await rows()).toHaveLength(5)
  })

  it("renders the Go queue payload shape", async () => {
    await insertUsageRecord(db, sampleRecord({ requestId: "r1", ttftMs: 15, stream: true }))
    const [row] = await popUsageQueue(db, 1, 1)
    const payload = rowToPayload(row as UsageRow)
    expect(payload).toMatchObject({
      timestamp: "2023-11-14T22:13:20.000Z",
      latency_ms: 120,
      ttft_ms: 15,
      source: "dev@example.com",
      tokens: {
        input_tokens: 100,
        output_tokens: 30,
        reasoning_tokens: 12,
        cached_tokens: 40,
        cache_read_tokens: 40,
        cache_read_tokens_present: true,
        cache_creation_tokens: 0,
        total_tokens: 130
      },
      failed: false,
      generate: true,
      stream: true,
      fail: { status_code: 200, body: "" },
      accounting_version: 2,
      token_breakdown: {
        schema_version: 2,
        quality: "complete",
        total_tokens: 130,
        input: { total_tokens: 100, uncached_tokens: 60, cache_read_tokens: 40, cache_write_tokens: 0 },
        output: { total_tokens: 30, non_reasoning_tokens: 18, reasoning_tokens: 12 },
        unclassified_tokens: 0
      },
      provider: "codex",
      executor_type: "codex",
      model: "gpt-5",
      alias: "gpt-5",
      endpoint: "POST /v1/responses",
      auth_type: "oauth",
      api_key: "user:dev@example.com",
      request_id: "r1",
      trace_id: "trace-1",
      reasoning_effort: "",
      service_tier: "auto"
    })
    expect(payload["auth_index"]).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("listing and summary", () => {
  const seed = async () => {
    const base = 1_700_000_000_000
    const day = 86_400_000
    const records = [
      sampleRecord({ requestId: "a", requestedAt: base, model: "gpt-5", principalId: "user:a" }),
      sampleRecord({ requestId: "b", requestedAt: base + 1000, model: "gpt-5", principalId: "user:b" }),
      sampleRecord({
        requestId: "c",
        requestedAt: base + day,
        model: "gpt-4",
        principalId: "user:a",
        failed: true,
        fail: { statusCode: 500, body: "boom" },
        detail: {
          ...sampleRecord().detail,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0
        }
      })
    ]
    for (const record of records) await insertUsageRecord(db, record)
    return { base, day }
  }

  it("lists newest first with keyset pagination and filters", async () => {
    const { base } = await seed()
    const page1 = await listUsageRecords(db, { limit: 2 })
    expect(page1.rows.map((row) => row.request_id)).toEqual(["c", "b"])
    expect(page1.nextBefore).toBeDefined()
    const page2 = await listUsageRecords(db, { limit: 2, before: page1.nextBefore as string })
    expect(page2.rows.map((row) => row.request_id)).toEqual(["a"])
    expect(page2.nextBefore).toBeUndefined()
    expect((await listUsageRecords(db, { model: "gpt-5" })).rows.map((row) => row.request_id)).toEqual(["b", "a"])
    expect(
      (await listUsageRecords(db, { principal: "user:a", failed: true })).rows.map((row) => row.request_id)
    ).toEqual(["c"])
    expect(
      (await listUsageRecords(db, { since: base + 500, until: base + 2000 })).rows.map((row) => row.request_id)
    ).toEqual(["b"])
  })

  it("summarises the v2 buckets overall and per group", async () => {
    await seed()
    const byModel = await summarizeUsage(db, { groupBy: "model" })
    expect(byModel.totals).toMatchObject({
      requests: 3,
      failed: 1,
      input_tokens: 200,
      uncached_input_tokens: 120,
      cache_read_tokens: 80,
      output_tokens: 60,
      reasoning_tokens: 24,
      total_tokens: 260
    })
    expect(byModel.groups.map((group) => [group.key, group.requests, group.total_tokens])).toEqual([
      ["gpt-5", 2, 260],
      ["gpt-4", 1, 0]
    ])
    const byDay = await summarizeUsage(db, { groupBy: "day" })
    expect(byDay.groups.map((group) => group.key)).toEqual(["2023-11-15", "2023-11-14"])
    const empty = await summarizeUsage(db, { groupBy: "provider", since: 0, until: 1 })
    expect(empty.totals.requests).toBe(0)
    expect(empty.groups).toEqual([])
  })
})

describe("retention", () => {
  it("prunes records older than the cutoff", async () => {
    for (const at of [1000, 2000, 3000]) await insertUsageRecord(db, sampleRecord({ requestedAt: at }))
    expect(await pruneUsageRecords(db, 2500)).toBe(2)
    expect((await rows()).map((row) => row.requested_at)).toEqual([3000])
  })

  it("the cron task deletes records older than USAGE_RETENTION_DAYS using the Effect clock", async () => {
    const day = 86_400_000
    const now = 100 * day
    await insertUsageRecord(db, sampleRecord({ requestId: "old", requestedAt: now - 31 * day }))
    await insertUsageRecord(db, sampleRecord({ requestId: "recent", requestedAt: now - 29 * day }))
    const run = (bindings: Env) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        return yield* pruneExpiredUsage
      }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(WorkerEnv, bindings), Effect.runPromise)
    expect(await run({ ...env, USAGE_RETENTION_DAYS: "0" })).toBe(0)
    expect(await rows()).toHaveLength(2)
    expect(await run({ ...env, USAGE_RETENTION_DAYS: "30" })).toBe(1)
    expect((await rows()).map((row) => row.request_id)).toEqual(["recent"])
  })

  it("parses the retention variable and is registered as a cron task", () => {
    expect([
      retentionDays(undefined),
      retentionDays(""),
      retentionDays("abc"),
      retentionDays("7"),
      retentionDays("-1")
    ]).toEqual([30, 30, 30, 7, 0])
    expect(scheduledTasks.map((task) => task.name)).toContain("usage-retention")
  })
})
