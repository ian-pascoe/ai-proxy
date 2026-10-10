// /v8/management/observability/usage/*: api-keys (ControlPlane counters), queue, records and summary (D1).
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { insertUsageRecord } from "../src/usage/d1.ts"
import { controlPlane, makeHarness, resetControlPlane, token } from "./support/management.ts"
import { resetUsageDb, sampleRecord } from "./support/usage.ts"

const harness = makeHarness()
afterAll(harness.dispose)
const { json } = harness
const BASE = "/v8/management/observability/usage"

let db: D1Database
beforeEach(async () => {
  db = await resetUsageDb()
  await resetControlPlane()
})

const seed = async () => {
  await insertUsageRecord(db, sampleRecord({ requestId: "r1", requestedAt: 1_700_000_000_000, model: "gpt-5" }))
  await insertUsageRecord(
    db,
    sampleRecord({ requestId: "r2", requestedAt: 1_700_000_001_000, model: "gpt-5", principalId: "user:b" })
  )
  await insertUsageRecord(
    db,
    sampleRecord({
      requestId: "r3",
      requestedAt: 1_700_000_002_000,
      model: "gpt-4",
      failed: true,
      fail: { statusCode: 502, body: "bad gateway" }
    })
  )
}

describe("access", () => {
  it("requires an admin principal", async () => {
    expect((await harness.call(`${BASE}/queue`, { auth: false })).status).toBe(401)
    expect((await harness.call(`${BASE}/queue`, { auth: await token("someone@example.com") })).status).toBe(403)
  })
})

describe("GET /queue", () => {
  it("pops one record by default, then the requested count, oldest first", async () => {
    await seed()
    const first = await json(`${BASE}/queue`)
    expect(first.status).toBe(200)
    expect((first.body as Array<{ request_id: string }>).map((item) => item.request_id)).toEqual(["r1"])
    const rest = await json(`${BASE}/queue?count=5`)
    expect((rest.body as Array<{ request_id: string }>).map((item) => item.request_id)).toEqual(["r2", "r3"])
    expect((await json(`${BASE}/queue`)).body).toEqual([])
  })

  it("rejects an invalid count", async () => {
    for (const count of ["0", "-1", "abc", "1.5"]) {
      const response = await json(`${BASE}/queue?count=${count}`)
      expect(response).toMatchObject({ status: 400, body: { error: "count must be a positive integer" } })
    }
  })

  it("answers 503 without the D1 binding", async () => {
    const detached = makeHarness(undefined, { USAGE: undefined } as unknown as Partial<Env>)
    try {
      expect(await detached.json(`${BASE}/queue`)).toMatchObject({
        status: 503,
        body: { error: "usage store unavailable" }
      })
    } finally {
      await detached.dispose()
    }
  })
})

describe("GET /records and /summary", () => {
  it("lists with filters and a continuation cursor", async () => {
    await seed()
    const page = await json(`${BASE}/records?limit=2`)
    const body = page.body as { records: Array<{ request_id: string }>; next_before: string }
    expect(body.records.map((item) => item.request_id)).toEqual(["r3", "r2"])
    const next = await json(`${BASE}/records?limit=2&before=${encodeURIComponent(body.next_before)}`)
    expect((next.body as { records: Array<{ request_id: string }> }).records.map((item) => item.request_id)).toEqual([
      "r1"
    ])
    expect((next.body as { next_before?: string }).next_before).toBeUndefined()
    const failed = await json(`${BASE}/records?failed=true`)
    expect((failed.body as { records: Array<{ fail: unknown }> }).records).toMatchObject([
      { fail: { status_code: 502, body: "bad gateway" } }
    ])
    const since = await json(`${BASE}/records?since=${new Date(1_700_000_001_000).toISOString()}&model=gpt-5`)
    expect((since.body as { records: Array<{ request_id: string }> }).records.map((item) => item.request_id)).toEqual([
      "r2"
    ])
  })

  it("validates the query", async () => {
    expect((await json(`${BASE}/records?since=yesterday-ish`)).status).toBe(400)
    expect((await json(`${BASE}/records?failed=maybe`)).status).toBe(400)
    expect((await json(`${BASE}/records?limit=0`)).status).toBe(400)
    expect((await json(`${BASE}/summary?group_by=secret`)).body).toMatchObject({
      error: expect.stringContaining("group_by must be one of")
    })
  })

  it("summarises token buckets per group", async () => {
    await seed()
    const response = await json(`${BASE}/summary?group_by=principal`)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      group_by: "principal",
      totals: { requests: 3, failed: 1, input_tokens: 300, total_tokens: 390 },
      groups: [
        { key: "user:dev@example.com", requests: 2, total_tokens: 260 },
        { key: "user:b", requests: 1, total_tokens: 130 }
      ]
    })
    const byModel = await json(`${BASE}/summary`)
    expect((byModel.body as { group_by: string }).group_by).toBe("model")
  })
})

describe("GET /api-keys", () => {
  it("groups API-key credentials by provider and base_url|key with the recent-request ring", async () => {
    const stub = controlPlane()
    await stub.putConfig("api-keys:\n  claude:\n    - keys: [{ api-key: sk-ant-secret-key-1234 }]\n")
    const request = { providers: ["claude"], model: "claude-sonnet-4-5" }
    for (const success of [true, true, false]) {
      const picked = await stub.pick(request)
      if (!picked.ok) throw new Error("pick failed")
      await stub.report(
        picked.lease,
        success
          ? { success: true }
          : { success: false, httpStatus: 500, error: { message: "boom", retryable: true, httpStatus: 500 } }
      )
    }
    const response = await json(`${BASE}/api-keys`)
    expect(response.status).toBe(200)
    const body = response.body as Record<
      string,
      Record<string, { success: number; failed: number; recent_requests: unknown[] }>
    >
    expect(Object.keys(body)).toEqual(["claude"])
    const entries = Object.entries(body["claude"] ?? {})
    expect(entries).toHaveLength(1)
    const [key, entry] = entries[0] as [string, (typeof entries)[number][1]]
    expect(key.split("|")[1]).toContain("[redacted]")
    expect(key).not.toContain("sk-ant-secret-key-1234")
    expect(key.endsWith("1234")).toBe(true)
    expect(entry).toMatchObject({ success: 2, failed: 1 })
    expect(entry.recent_requests).toHaveLength(20)
    const last = entry.recent_requests[19] as { time: string; success: number; failed: number }
    expect(last).toMatchObject({ success: 2, failed: 1 })
    expect(last.time).toMatch(/^\d\d:\d\d-\d\d:\d\d$/)
  })

  it("is empty without API-key credentials", async () => {
    expect((await json(`${BASE}/api-keys`)).body).toEqual({})
  })
})
