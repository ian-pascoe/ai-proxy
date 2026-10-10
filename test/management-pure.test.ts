// Pure helpers of the management API: config document edits, credential entries, field patches, cooldown reset.
import { describe, expect, it } from "vitest"
import { resetCooldownState } from "../src/credentials/cooldown-reset.ts"
import { applyFieldPatch } from "../src/credentials/field-patch.ts"
import { emptyQuota, emptyState, type CredentialState } from "../src/credentials/model.ts"
import { classifyPath } from "../src/access/routes.ts"
import {
  deleteAtPath,
  getAtPath,
  mergePatch,
  parseConfigPath,
  stripAuthIndexes,
  writeAtPath
} from "../src/management/config-document.ts"
import { buildCredentialEntry, cooldownSnapshot } from "../src/management/credential-entry.ts"
import { cred, cooling, state } from "./support/credentials.ts"

const NOW = 1_800_000_000_000

const unsignedJwt = (claims: object) =>
  `x.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.y`

describe("config document paths", () => {
  it("parses paths", () => {
    expect(parseConfigPath("")).toEqual([])
    expect(parseConfigPath("/")).toEqual([])
    expect(parseConfigPath("/a/b%20c/")).toEqual(["a", "b c"])
    expect(parseConfigPath("/a//b")).toBeUndefined()
  })

  it("reads, writes and deletes without mutating the input", () => {
    const doc = { a: { b: 1, list: [1, 2] }, c: null }
    expect(getAtPath(doc, ["a", "list"])).toEqual([1, 2])
    expect(getAtPath(doc, ["c"])).toBeNull()
    expect(getAtPath(doc, ["a", "b", "x"])).toBeUndefined()
    expect(getAtPath(doc, [])).toBe(doc)

    expect(writeAtPath(doc, ["a", "new", "deep"], 5, "put")).toEqual({
      a: { b: 1, list: [1, 2], new: { deep: 5 } },
      c: null
    })
    expect(writeAtPath(doc, ["a", "b", "x"], 5, "put")).toBe("invalid_path")
    expect(writeAtPath(doc, ["a", "list"], [9], "patch")).toEqual({ a: { b: 1, list: [9] }, c: null })
    expect(doc).toEqual({ a: { b: 1, list: [1, 2] }, c: null })

    expect(deleteAtPath(doc, ["a", "b"])).toEqual({ a: { list: [1, 2] }, c: null })
    expect(deleteAtPath({ a: { b: { c: 1 } }, d: 2 }, ["a", "b", "c"])).toEqual({ d: 2 })
    expect(deleteAtPath(doc, ["a", "zzz"])).toBeUndefined()
    expect(deleteAtPath(doc, ["a", "b", "c"])).toBeUndefined()
    expect(deleteAtPath(doc, [])).toBeUndefined()
  })

  it("merges patches like mergeConfigV8Patch (null kept, lists and scalars replaced)", () => {
    expect(mergePatch({ a: { x: 1, y: 2 }, l: [1] }, { a: { y: null, z: 3 }, l: [2, 3] })).toEqual({
      a: { x: 1, y: null, z: 3 },
      l: [2, 3]
    })
    expect(mergePatch(1, { a: 1 })).toEqual({ a: 1 })
    expect(mergePatch({ a: 1 }, 5)).toBe(5)
  })

  it("strips auth_index from api-key groups and keys only", () => {
    const doc = {
      "api-keys": { claude: [{ auth_index: "g", "auth-index": "g", keys: [{ auth_index: "k", "api-key": "x" }] }] },
      other: { auth_index: "keep" }
    }

    expect(stripAuthIndexes(doc)).toEqual({
      "api-keys": { claude: [{ keys: [{ "api-key": "x" }] }] },
      other: { auth_index: "keep" }
    })
  })
})

describe("credential entries", () => {
  it("describes a healthy file credential without secrets", () => {
    const credential = cred("codex.json", {
      provider: "codex",
      label: "me@x.com",
      priority: 2,
      weight: 3,
      createdAt: NOW - 1000,
      updatedAt: NOW,
      attributes: { websockets: "true" },
      metadata: {
        type: "codex",
        email: "me@x.com",
        access_token: "secret-access",
        id_token: unsignedJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc",
            chatgpt_plan_type: "plus",
            chatgpt_subscription_active_until: "2030-01-01"
          }
        }),
        weight: 3,
        priority: "2",
        note: " n ",
        project_id: "p1",
        request_retry: 4,
        last_refresh: "2026-01-01T00:00:00Z"
      }
    })

    const entry = buildCredentialEntry(credential, state({ success: 5, failed: 1 }), NOW)
    expect(entry).toMatchObject({
      id: "codex.json",
      name: "codex.json",
      type: "codex",
      status: "active",
      unavailable: false,
      source: "file",
      email: "me@x.com",
      account: "me@x.com",
      account_type: "oauth",
      project_id: "p1",
      success: 5,
      failed: 1,
      priority: 2,
      note: "n",
      weight: 3,
      websockets: true,
      request_retry: 4,
      last_refresh: "2026-01-01T00:00:00Z",
      id_token: { chatgpt_account_id: "acc", plan_type: "plus", chatgpt_subscription_active_until: "2030-01-01" },
      modtime: new Date(NOW).toISOString(),
      cooldowns: []
    })
    expect(JSON.stringify(entry)).not.toContain("secret-access")
    const buckets = entry.recent_requests as Array<{ time: string }>
    expect(buckets).toHaveLength(20)
    // Buckets are contiguous ten-minute windows.
    expect(buckets[19]?.time.split("-")[0]).toBe(
      new Date(Math.floor(NOW / 600_000) * 600_000).toISOString().slice(11, 16)
    )
  })

  it("shows cooldowns and the derived status", () => {
    const next = NOW + 90_500
    const credential = cred("a.json")

    const cooling429: CredentialState = state({
      modelStates: {
        "gpt-5": { ...cooling(next, true), lastError: { message: "limit", retryable: true, httpStatus: 429 } }
      }
    })

    expect(cooldownSnapshot(cooling429, NOW)).toEqual([
      expect.objectContaining({ scope: "model", model_key: "gpt-5", reason: "unknown", remaining_seconds: 91 })
    ])

    const credentialWide = state({
      unavailable: true,
      nextRetryAfter: NOW + 5000,
      lastError: { message: "x", retryable: true, httpStatus: 503 }
    })

    const entry = buildCredentialEntry(credential, credentialWide, NOW)
    expect(entry).toMatchObject({
      unavailable: true,
      status: "error",
      next_retry_after: new Date(NOW + 5000).toISOString()
    })
    expect(entry.cooldowns).toEqual([
      expect.objectContaining({ scope: "credential", retry_at: new Date(NOW + 5000).toISOString(), http_status: 503 })
    ])
    // Expired timers disappear.
    expect(cooldownSnapshot(state({ unavailable: true, nextRetryAfter: NOW - 1 }), NOW)).toEqual([])
    expect(buildCredentialEntry(cred("d.json", { disabled: true }), emptyState(), NOW)).toMatchObject({
      disabled: true,
      status: "disabled"
    })

    const quota = cooldownSnapshot(
      state({
        quota: {
          ...emptyQuota(),
          exceeded: true,
          reason: "credential_quota",
          nextRecoverAt: NOW + 1000,
          backoffLevel: 2
        }
      }),
      NOW
    )

    expect(quota).toEqual([expect.objectContaining({ scope: "credential", reason: "credential_quota" })])
  })
})

describe("field patch", () => {
  const meta = { type: "claude", access_token: "t", headers: { A: "1" }, keep: true }

  it("does not mutate the input and applies nested paths", () => {
    const result = applyFieldPatch(meta, { "a.b.c": 1, "excluded-models": ["x"], "model-aliases": [] })
    expect(result).toEqual({
      ok: true,
      metadata: { ...meta, a: { b: { c: 1 } }, excluded_models: ["x"], model_aliases: [] }
    })
    expect(meta).toEqual({ type: "claude", access_token: "t", headers: { A: "1" }, keep: true })
  })

  it("rejects duplicate spellings and empty names", () => {
    expect(applyFieldPatch(meta, { "api-key": "1", api_key: "2" })).toMatchObject({ ok: false })
    expect(applyFieldPatch(meta, { " ": 1 })).toEqual({ ok: false, message: "field name is required" })
    expect(applyFieldPatch(meta, { request_retry: -1 })).toEqual({ ok: true, metadata: meta })
  })

  it("replaces non-string-map headers and drops them when emptied", () => {
    expect(applyFieldPatch(meta, { headers: { A: "" } })).toEqual({
      ok: true,
      metadata: { type: "claude", access_token: "t", keep: true }
    })
    expect(applyFieldPatch(meta, { headers: null })).toMatchObject({ ok: true })
    expect(applyFieldPatch(meta, { headers: { A: 1 } })).toMatchObject({ ok: true, metadata: { headers: { A: 1 } } })
  })
})

describe("cooldown reset", () => {
  it("clears timers and errors, keeps counters, and keeps terminal 401 failures", () => {
    const blocked = state({
      status: "error",
      statusMessage: "cooling",
      unavailable: true,
      nextRetryAfter: NOW + 1000,
      success: 3,
      failed: 2,
      quota: { ...emptyQuota(), exceeded: true, nextRecoverAt: NOW + 1000 },
      lastError: { message: "limit", retryable: true, httpStatus: 429 },
      modelStates: { "m-a": cooling(NOW + 1000), "  ": cooling(NOW + 1000) }
    })

    const reset = resetCooldownState(blocked, NOW)
    expect(reset.models).toEqual(["m-a"])
    expect(reset.state).toMatchObject({
      status: "active",
      unavailable: false,
      nextRetryAfter: 0,
      success: 3,
      failed: 2,
      modelStates: {},
      updatedAt: NOW
    })
    expect(reset.state.lastError).toBeUndefined()
    expect(reset.state.statusMessage).toBeUndefined()
    expect(reset.state.quota).toEqual(emptyQuota())

    const terminal = resetCooldownState(
      state({ status: "error", lastError: { message: "unauthorized", retryable: false, httpStatus: 401 } }),
      NOW
    )

    expect(terminal.state).toMatchObject({ status: "error", lastError: { httpStatus: 401 } })
  })
})

describe("access classification of the panel page", () => {
  it("treats /management.html like the management API", () => {
    expect(classifyPath("https://x.test/management.html")).toBe("management")
    expect(classifyPath("https://x.test//Management.HTML")).toBe("management")
    expect(classifyPath("https://x.test/%6danagement.html")).toBe("management")
    expect(classifyPath("https://x.test/other.html")).toBe("public")
  })
})
