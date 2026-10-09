// api-call, latest-version, model definitions, log stubs and the control panel page.
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { authIndexOf } from "../src/management/auth-index.ts"
import { NOT_INSTALLED } from "../src/management/panel.ts"
import { claudeFile, controlPlane, jsonInit, makeHarness, resetControlPlane, token } from "./support/management.ts"

let release: () => { status?: number; body?: unknown; transportError?: boolean } = () => ({
  body: { tag_name: "v8.1.0" }
})

const PANEL_HTML = "<!doctype html><title>panel</title>"
const panelAssets = (found: boolean) =>
  ({
    fetch: async (request: Request) =>
      found && new URL(request.url).pathname === "/management.html"
        ? new Response(PANEL_HTML, { headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"' } })
        : new Response("not found", { status: 404 })
  }) as unknown as Fetcher

const harness = makeHarness(
  (request) => {
    if (request.url.startsWith("https://api.github.com/")) return release()
    if (request.url === "https://offline.example/x") return { transportError: true }
    return {
      status: 201,
      headers: { "x-upstream": "yes" },
      body: { method: request.method, url: request.url, headers: request.headers, body: request.body }
    }
  },
  { ASSETS: panelAssets(true) }
)
afterAll(harness.dispose)
beforeEach(async () => {
  release = () => ({ body: { tag_name: "v8.1.0" } })
  harness.requests.length = 0
  await resetControlPlane()
})
const { call, json } = harness

const apiCall = (body: unknown) => json("/v8/management/requests/api-call", jsonInit("POST", body))

describe("api-call", () => {
  it("validates the request", async () => {
    expect((await json("/v8/management/requests/api-call", { method: "POST", body: "x" })).body).toEqual({
      error: "invalid body"
    })
    expect((await apiCall({ url: "https://a.example" })).body).toEqual({ error: "missing method" })
    expect((await apiCall({ method: "GET" })).body).toEqual({ error: "missing url" })
    expect((await apiCall({ method: "GET", url: "/relative" })).body).toEqual({ error: "invalid url" })
    expect((await apiCall({ method: "GET", url: "ftp://a.example/x" })).body).toEqual({ error: "invalid url" })
    expect((await apiCall({ method: "GET", url: "https://a.example", proxy_url: "ftp://p" })).body).toEqual({
      error: "invalid proxy_url"
    })
    expect(harness.requests).toHaveLength(0)
  })

  it("forwards the request and returns status, headers and body", async () => {
    const result = await apiCall({
      method: "post",
      url: "https://api.example.com/v1/ping?x=1",
      header: { "X-Test": "1", Host: "ignored.example" },
      data: '{"a":1}',
      proxy_url: "direct"
    })
    expect(result.status).toBe(200)
    const body = result.body as { status_code: number; header: Record<string, string[]>; body: string }
    expect(body.status_code).toBe(201)
    expect(body.header["x-upstream"]).toEqual(["yes"])
    const echoed = JSON.parse(body.body) as {
      method: string
      url: string
      headers: Record<string, string>
      body: string
    }
    // The mock transport records the URL without its query (the HTTP client keeps parameters separately).
    expect(echoed).toMatchObject({ method: "POST", url: "https://api.example.com/v1/ping", body: '{"a":1}' })
    expect(echoed.headers["x-test"]).toBe("1")
    expect(echoed.headers).not.toHaveProperty("host")
  })

  it("replaces $TOKEN$ with the credential token in headers and (JSON-escaped) data", async () => {
    await controlPlane().importAuthFile("x.json", claudeFile({ access_token: 'tok"en\\1' }))
    const authIndex = authIndexOf("x.json")
    const result = await apiCall({
      auth_index: authIndex,
      method: "POST",
      url: "https://api.example.com/q",
      header: { Authorization: "Bearer $TOKEN$" },
      data: '{"t":"$TOKEN$"}'
    })
    const echoed = JSON.parse((result.body as { body: string }).body) as {
      headers: Record<string, string>
      body: string
    }
    expect(echoed.headers.authorization).toBe('Bearer tok"en\\1')
    expect(JSON.parse(echoed.body)).toEqual({ t: 'tok"en\\1' })

    const plain = await apiCall({
      authIndex,
      method: "POST",
      url: "https://api.example.com/q",
      data: "raw $TOKEN$ text"
    })
    expect(JSON.parse((plain.body as { body: string }).body).body).toBe('raw tok"en\\1 text')
  })

  it("uses the API key of config credentials and reports token problems", async () => {
    await controlPlane().putConfig("api-keys:\n  claude:\n    - keys: [{ api-key: sk-ant-config }]\n")
    const config = (await json("/v8/management/config/api-keys/claude")).body as Array<{
      keys: Array<{ auth_index: string }>
    }>
    const result = await apiCall({
      auth_index: config[0]!.keys[0]!.auth_index,
      method: "GET",
      url: "https://api.example.com/q",
      header: { "x-api-key": "$TOKEN$" }
    })
    expect(JSON.parse((result.body as { body: string }).body).headers["x-api-key"]).toBe("sk-ant-config")

    const base = { method: "GET", url: "https://api.example.com/q", header: { Authorization: "Bearer $TOKEN$" } }
    expect((await apiCall(base)).body).toEqual({ error: "auth token not found" })
    expect((await apiCall({ ...base, auth_index: "ffffffffffffffff" })).body).toEqual({
      error: "auth credential not found for auth_index"
    })
    await controlPlane().importAuthFile("empty.json", { type: "claude", email: "e@x.com" })
    expect((await apiCall({ ...base, auth_index: authIndexOf("empty.json") })).body).toEqual({
      error: "auth token not found"
    })
    expect(harness.requests.filter((request) => request.url.includes("api.example.com"))).toHaveLength(1)
  })

  it("answers 502 when the upstream is unreachable", async () => {
    expect(await apiCall({ method: "GET", url: "https://offline.example/x" })).toMatchObject({
      status: 502,
      body: { error: "request failed" }
    })
  })
})

describe("server information", () => {
  it("reports the latest release tag and the failure modes", async () => {
    expect(await json("/v8/management/server/latest-version")).toMatchObject({
      status: 200,
      body: { "latest-version": "v8.1.0" }
    })
    expect(harness.requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest"
    })
    expect(harness.requests[0]?.headers.accept).toBe("application/vnd.github+json")

    release = () => ({ status: 500, body: {} })
    expect(await json("/v8/management/server/latest-version")).toMatchObject({
      status: 502,
      body: { error: "unexpected_status" }
    })
    release = () => ({ body: { name: "fallback-name" } })
    expect(await json("/v8/management/server/latest-version")).toMatchObject({
      body: { "latest-version": "fallback-name" }
    })
    release = () => ({ body: {} })
    expect((await json("/v8/management/server/latest-version")).body).toMatchObject({ error: "invalid_response" })
    release = () => ({ transportError: true })
    expect((await json("/v8/management/server/latest-version")).body).toMatchObject({ error: "request_failed" })
  })

  it("serves static model definitions per channel", async () => {
    const claude = await json("/v8/management/routing/model-definitions/Claude")
    expect(claude.status).toBe(200)
    const body = claude.body as {
      channel: string
      models: Array<{ id: string; object: string; owned_by: string; type: string; created: number }>
    }
    expect(body.channel).toBe("claude")
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models[0]).toMatchObject({
      id: expect.any(String),
      object: "model",
      owned_by: "anthropic",
      type: "claude"
    })
    expect(body.models[0]).toHaveProperty("created")
    expect(body.models[0]).not.toHaveProperty("displayName")

    for (const channel of ["codex", "gemini", "xai", "grok", "kimi", "antigravity", "meta", "devin"]) {
      const result = await json(`/v8/management/routing/model-definitions/${channel}`)
      expect(result.status, channel).toBe(200)
      expect((result.body as { models: unknown[] }).models.length, channel).toBeGreaterThan(0)
    }
    expect(await json("/v8/management/routing/model-definitions/nope")).toMatchObject({
      status: 400,
      body: { error: "unknown channel", channel: "nope" }
    })
    expect(await json("/v8/management/routing/model-definitions")).toMatchObject({
      status: 400,
      body: { error: "channel is required" }
    })
    expect((await json("/v8/management/routing/model-definitions?channel=claude")).status).toBe(200)
  })

  it("answers the file-log routes like Go with file logging disabled", async () => {
    expect(await json("/v8/management/observability/logs")).toMatchObject({
      status: 400,
      body: { error: "logging to file disabled" }
    })
    expect((await json("/v8/management/observability/logs", { method: "DELETE" })).status).toBe(400)
    expect(await json("/v8/management/observability/logs/errors")).toMatchObject({ status: 200, body: { files: [] } })
    expect((await json("/v8/management/observability/logs/errors/error-1.log")).status).toBe(404)
    expect((await json("/v8/management/observability/logs/requests/abc")).status).toBe(404)
  })

  it("leaves plugin routes unported", async () => {
    for (const path of ["/v8/management/plugins"]) {
      expect((await call(path)).status, path).toBe(404)
    }
    // Unknown management paths still need the admin gate.
    expect((await call("/v8/management/plugins", { auth: false })).status).toBe(401)
  })
})

describe("control panel page", () => {
  it("serves management.html to administrators only", async () => {
    const page = await call("/management.html")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(page.headers.get("etag")).toBe('"abc"')
    expect(await page.text()).toBe(PANEL_HTML)

    expect((await call("/management.html", { auth: false })).status).toBe(401)
    expect((await call("/Management.HTML", { auth: false })).status).toBe(401)
    expect((await call("/management.html", { auth: await token("other@example.com") })).status).toBe(403)
  })

  it("explains how to install the panel when the asset is missing", async () => {
    const missing = makeHarness(undefined, { ASSETS: panelAssets(false) })
    try {
      expect(await missing.json("/management.html")).toMatchObject({ status: 404, body: { error: NOT_INSTALLED } })
    } finally {
      await missing.dispose()
    }
  })
})
