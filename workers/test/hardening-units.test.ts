// Small hardening helpers: config keys that do nothing on Workers, log-safe cause summaries, shared hashing.
import { createHash } from "node:crypto"
import { Cause } from "effect"
import { describe, expect, it } from "vitest"
import { notAppliedSettings } from "../src/config/not-applied.ts"
import { ConfigStore } from "../src/config/store.ts"
import { sha256Hex } from "../src/hash.ts"
import { causeSummary, redactUrls } from "../src/observability/cause.ts"
import { sha256Hex as oauthSha256Hex } from "../src/oauth/encoding.ts"
import { loadConfig } from "./support/pipeline.ts"

const GO_CONFIG = `
access:
  api-keys: [legacy-key]
requests:
  nonstream-keepalive-interval: 15
upstream:
  codex:
    response-steering: true
  claude:
    header-defaults:
      stabilize-device-profile: true
api-keys:
  claude:
    - keys:
        - api-key: sk-ant
          experimental-cch-signing: true
observability:
  logs:
    request-log: true
  usage:
    usage-statistics-enabled: true
    redis-usage-queue-retention-seconds: 120
`

describe("notAppliedSettings", () => {
  it("names the accepted keys that have no effect on Workers", async () => {
    expect(notAppliedSettings(await loadConfig(GO_CONFIG))).toEqual([
      "access.api-keys",
      "upstream.codex.response-steering",
      "api-keys.claude[].keys[].experimental-cch-signing",
      "observability.logs.request-log",
      "observability.usage.usage-statistics-enabled",
      "observability.usage.redis-usage-queue-retention-seconds"
    ])
    expect(notAppliedSettings(await loadConfig("routing:\n  strategy: fill-first\n"))).toEqual([])
  })

  it("is reported by the config store on write", async () => {
    const rows: unknown[] = []
    // Minimal SqlStorage stand-in: the store only needs `exec` for its single-row table.
    const sql = {
      exec: (query: string, ...bindings: unknown[]) => {
        if (query.startsWith("INSERT"))
          rows[0] = { version: bindings[0], document: bindings[1], updated_at: bindings[2] }
        return { toArray: () => (query.startsWith("SELECT") ? rows : []) }
      }
    } as unknown as SqlStorage
    const result = new ConfigStore(sql, () => 1).put(GO_CONFIG)
    expect(result.ok && result.notApplied).toContain("upstream.codex.response-steering")
  })
})

describe("causeSummary", () => {
  it("keeps the tag and message but drops stacks and URL queries", () => {
    const error = new Error("GET https://cloudcode-pa.googleapis.com/v1:fetch?key=SECRET&alt=json failed")
    const summary = causeSummary(Cause.fail(error))
    expect(summary).toBe("Error: GET https://cloudcode-pa.googleapis.com/v1:fetch?… failed")
    expect(summary).not.toContain("SECRET")
    expect(summary).not.toContain("at ")
    expect(causeSummary(Cause.fail({ _tag: "CatalogError", message: "bad" }))).toBe("CatalogError: bad")
    expect(causeSummary(Cause.interrupt())).toBe("interrupted")
    expect(causeSummary(Cause.die("x".repeat(500))).length).toBeLessThanOrEqual(301)
    expect(redactUrls("see http://a.test/p#frag and https://b.test/q")).toBe(
      "see http://a.test/p?… and https://b.test/q"
    )
  })
})

describe("sha256Hex", () => {
  it("is shared by the sync and async callers", async () => {
    const expected = createHash("sha256").update("héllo", "utf8").digest("hex")
    expect(sha256Hex("héllo")).toBe(expected)
    expect(await oauthSha256Hex("héllo")).toBe(expected)
    expect(await oauthSha256Hex("héllo", 8)).toBe(expected.slice(0, 16))
  })
})
