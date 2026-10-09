// Meta (Muse) executor against a mocked `/responses` upstream: request shaping, SSE aggregation, error rules and
// credential resolution.
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { metaCreds, requireMetaToken } from "../src/executor/meta/credentials.ts"
import {
  isMetaSubscriptionQuota,
  META_NOT_FOUND_COOLDOWN_MS,
  metaStreamEventError,
  parseMetaRetryAfterMs,
  wrapMetaUpstreamError
} from "../src/executor/meta/errors.ts"
import { makeMetaExecutor } from "../src/executor/meta/executor.ts"
import { sanitizeMetaWebSearchTools } from "../src/executor/meta/request.ts"
import type { Json } from "../src/json/index.ts"
import { collectStream, credential, execute, harness, json, options, runFail } from "./support/executor-run.ts"

const executor = makeMetaExecutor()
const metaKey = () =>
  credential("meta", { kind: "apikey", attributes: { api_key: "meta-key-1", base_url: "https://meta.test/v1" } })

const sse = (events: ReadonlyArray<unknown>): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })

const completed = (output: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "muse-spark",
    output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    ...extra
  }
})

const message = (text: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }]
})

const responsesRequest = (extra: Record<string, unknown> = {}) => ({
  model: "muse-spark",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  ...extra
})

const responsesOptions = (stream = false) =>
  options({
    stream,
    sourceFormat: "openai-response",
    metadata: { ...options().metadata, requestPath: "/v1/responses" }
  })

describe("credentials", () => {
  it("never uses a DCA token as the bearer token", () => {
    expect(metaCreds(credential("meta", { metadata: { access_token: "dca:abc", dca_token: "dca:abc" } })).token).toBe(
      ""
    )
    expect(metaCreds(credential("meta", { metadata: { api_key: "key", access_token: "dca:abc" } })).token).toBe("key")
    expect(metaCreds(credential("meta", { attributes: { api_key: "dca:x", access_token: "tok" } })).token).toBe("tok")
  })

  it("resolves the base URL from attributes, then metadata, then the default", () => {
    expect(metaCreds(credential("meta", { attributes: { base_url: "https://a.test/v1" } })).baseUrl).toBe(
      "https://a.test/v1"
    )
    expect(metaCreds(credential("meta", { metadata: { base_url: "https://m.test/v1" } })).baseUrl).toBe(
      "https://m.test/v1"
    )
    expect(metaCreds(credential("meta")).baseUrl).toBe("https://api.meta.ai/v1")
  })

  it("fails with the Go 401 messages when no key is usable", () => {
    expect(() => requireMetaToken(credential("meta"))).toThrow(/missing API key or access token/)
    expect(() => requireMetaToken(credential("meta", { kind: "apikey" }))).toThrow(
      /meta-api-key requires a valid API key/
    )
  })
})

describe("error rules", () => {
  const now = 1_000_000_000_000
  const reset = Math.floor(now / 1000) + 90

  it("turns a future resets_at into the retry delay (429 and 404)", () => {
    const body = JSON.stringify({ error: { resets_at: reset, message: "later" } })
    expect(wrapMetaUpstreamError(429, body, now).retryAfterMs).toBe(90_000)
    expect(wrapMetaUpstreamError(404, body, now).retryAfterMs).toBe(90_000)
    expect(parseMetaRetryAfterMs(500, { error: { resets_at: reset } }, now)).toBeUndefined()
    expect(
      wrapMetaUpstreamError(429, JSON.stringify({ error: { resets_at: reset - 1000 } }), now).retryAfterMs
    ).toBeUndefined()
  })

  it("cools a 404 without resets_at for five minutes", () => {
    expect(wrapMetaUpstreamError(404, '{"error":{"message":"gone"}}', now).retryAfterMs).toBe(
      META_NOT_FOUND_COOLDOWN_MS
    )
    expect(wrapMetaUpstreamError(404, "", now).retryAfterMs).toBe(300_000)
  })

  it("scopes subscription-quota 429s to the credential", () => {
    for (const error of [
      { message: "Your subscription quota is exhausted" },
      { message: "Quota exhausted" },
      { code: "rate_limit_exceeded", resets_at: reset },
      { code: "monthly_quota", resets_at: reset }
    ]) {
      expect(wrapMetaUpstreamError(429, JSON.stringify({ error }), now).credentialScoped).toBe(true)
    }
    expect(wrapMetaUpstreamError(429, '{"error":{"code":"rate_limit_exceeded"}}', now).credentialScoped).toBeUndefined()
    expect(isMetaSubscriptionQuota(500, { error: { message: "subscription quota" } })).toBe(false)
    expect(wrapMetaUpstreamError(500, "boom", now)).toMatchObject({ status: 500, message: "boom" })
  })

  it("maps in-stream error events to a status (error.code in 400..599, else 502)", () => {
    const failed = (code: unknown) => json({ type: "response.failed", error: { code, message: "x" } })
    expect(metaStreamEventError(failed(429), "p", now)?.status).toBe(429)
    expect(metaStreamEventError(failed("rate_limit"), "p", now)?.status).toBe(502)
    expect(metaStreamEventError(failed(200), "p", now)?.status).toBe(502)
    expect(metaStreamEventError(json({ type: "response.created" }), "p", now)).toBeUndefined()
  })
})

describe("web_search sanitising", () => {
  it("drops search_content_types from web_search tools, also inside namespaces", () => {
    const body = json({
      tools: [
        { type: "web_search", search_content_types: ["text"], keep: 1 },
        { type: "web_search_preview", search_content_types: ["text"] },
        {
          type: "namespace",
          tools: [
            { type: "web_search", search_content_types: ["image"] },
            { type: "function", name: "f" }
          ]
        }
      ]
    })
    expect(sanitizeMetaWebSearchTools(body)).toEqual({
      tools: [
        { type: "web_search", keep: 1 },
        { type: "web_search_preview", search_content_types: ["text"] },
        { type: "namespace", tools: [{ type: "web_search" }, { type: "function", name: "f" }] }
      ]
    })
  })
})

describe("Meta executor", () => {
  it("posts a shaped streaming Responses request with the Muse headers", async () => {
    const h = await harness(metaKey(), () => sse([completed([message("hello")])]))
    const response = await execute(
      executor,
      h,
      {
        model: "muse-spark",
        payload: json(
          responsesRequest({
            stream: false,
            generate: true,
            safety_identifier: "s",
            prompt_cache_retention: "24h",
            client_metadata: { a: 1 },
            stream_options: { include_obfuscation: true },
            tools: [{ type: "web_search", search_content_types: ["text"] }],
            input: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
              { type: "reasoning", id: "rs_foreign", summary: [], encrypted_content: "opaque-muse-state" },
              { type: "reasoning", id: "rs_claude", summary: [], encrypted_content: `${"E".repeat(60)}` }
            ]
          })
        )
      },
      responsesOptions()
    )
    const call = h.calls[0]
    expect(call?.url).toBe("https://meta.test/v1/responses")
    expect(call?.headers["authorization"]).toBe("Bearer meta-key-1")
    expect(call?.headers["user-agent"]).toContain("muse-build/1.3.0")
    expect(call?.headers["x-client-id"]).toBe("tbh:tui")
    expect(call?.headers["accept"]).toBe("text/event-stream")
    expect(call?.headers["cache-control"]).toBe("no-cache")
    const body = JSON.parse(call?.text ?? "{}") as Record<string, unknown> & { input: Array<Record<string, unknown>> }
    expect(body["stream"]).toBe(true)
    for (const field of [
      "generate",
      "safety_identifier",
      "prompt_cache_retention",
      "client_metadata",
      "stream_options"
    ]) {
      expect(body).not.toHaveProperty(field)
    }
    expect(body["instructions"]).toBe("")
    expect(body["tools"]).toEqual([{ type: "web_search" }])
    // Foreign reasoning blobs are replayed; recognisable other-provider signatures are dropped.
    const reasoning = body.input.filter((item) => item["type"] === "reasoning")
    expect(reasoning.some((item) => item["encrypted_content"] === "opaque-muse-state")).toBe(true)
    expect(reasoning.some((item) => item["id"] === "rs_claude" && "encrypted_content" in item)).toBe(false)
    expect(JSON.parse(response.payload)).toMatchObject({ object: "response", status: "completed" })
    expect(h.usage.failed).toBe(false)
  })

  it("patches an empty completed output from output_item.done events", async () => {
    const item = message("assembled")
    const h = await harness(metaKey(), () =>
      sse([{ type: "response.output_item.done", output_index: 0, item }, completed([])])
    )
    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions()
    )
    expect((JSON.parse(response.payload) as { output: unknown[] }).output).toEqual([item])
  })

  it("accepts a plain JSON response body instead of SSE", async () => {
    const body = { id: "resp_9", object: "response", status: "completed", output: [message("plain")], usage: {} }
    const h = await harness(metaKey(), () => new Response(JSON.stringify(body)))
    const response = await execute(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions()
    )
    expect((JSON.parse(response.payload) as { output: unknown[] }).output).toEqual([message("plain")])
  })

  it("fails with 408 when the stream ends before a terminal event", async () => {
    const h = await harness(metaKey(), () => sse([{ type: "response.created", response: { id: "r" } }]))
    const error = await runFail(
      executor.execute(h.context, { model: "muse-spark", payload: json(responsesRequest()) }, responsesOptions()),
      h.layers
    )
    expect(error.status).toBe(408)
    expect(error.message).toContain("stream disconnected before response.completed or response.incomplete")
  })

  it("applies the 429/404 rules to upstream HTTP errors", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 120
    const quota = await harness(
      metaKey(),
      () =>
        new Response(JSON.stringify({ error: { message: "subscription quota used", resets_at: resetsAt } }), {
          status: 429
        })
    )
    const quotaError = await runFail(
      executor.execute(quota.context, { model: "muse-spark", payload: json(responsesRequest()) }, responsesOptions()),
      quota.layers
    )
    expect(quotaError).toMatchObject({ status: 429, credentialScoped: true })
    expect(quotaError.retryAfterMs).toBeGreaterThan(100_000)
    expect(quotaError.retryAfterMs).toBeLessThanOrEqual(120_000)

    const missing = await harness(metaKey(), () => new Response('{"error":{"message":"no model"}}', { status: 404 }))
    const missingError = await runFail(
      executor.execute(missing.context, { model: "muse-spark", payload: json(responsesRequest()) }, responsesOptions()),
      missing.layers
    )
    expect(missingError).toMatchObject({ status: 404, retryAfterMs: META_NOT_FOUND_COOLDOWN_MS })
    expect(missing.usage.failed).toBe(true)
  })

  it("answers /responses/compact with 501 and fails without a key", async () => {
    const h = await harness(metaKey(), () => sse([completed()]))
    const compact = await runFail(
      executor.execute(
        h.context,
        { model: "muse-spark", payload: json(responsesRequest()) },
        { ...responsesOptions(), alt: "responses/compact" }
      ),
      h.layers
    )
    expect(compact.status).toBe(501)
    const noKey = await harness(credential("meta"), () => sse([completed()]))
    const unauthorized = await runFail(
      executor.execute(noKey.context, { model: "muse-spark", payload: json(responsesRequest()) }, responsesOptions()),
      noKey.layers
    )
    expect(unauthorized.status).toBe(401)
    expect(noKey.calls).toHaveLength(0)
  })

  it("applies payload rules last (protocol = meta)", async () => {
    const yaml = `payload:\n  override:\n    - models: [{ name: "muse*", protocol: meta }]\n      params:\n        temperature: 0.1\n        stream: false\n`
    const h = await harness(metaKey(), () => sse([completed([message("x")])]), yaml)
    await execute(executor, h, { model: "muse-spark", payload: json(responsesRequest()) }, responsesOptions())
    const body = JSON.parse(h.calls[0]?.text ?? "{}") as Record<string, unknown>
    expect(body["temperature"]).toBe(0.1)
    // The rule is the final mutation: it wins over the built-in `stream: true`.
    expect(body["stream"]).toBe(false)
  })

  it("streams Responses events, patching the terminal output and reporting usage", async () => {
    const item = message("streamed")
    const h = await harness(
      metaKey(),
      () =>
        sse([
          { type: "response.created", response: { id: "r" } },
          { type: "response.output_item.done", output_index: 0, item },
          completed([])
        ]),
      undefined,
      true
    )
    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(true)
    )
    expect(collected.error).toBeUndefined()
    const joined = collected.chunks.join("")
    expect(joined).toContain("response.created")
    const terminal = collected.chunks
      .filter((chunk) => chunk.startsWith("data:") && chunk.includes("response.completed"))
      .map((chunk) => JSON.parse(chunk.slice(5)) as { response: { output: unknown[] } })[0]
    expect(terminal?.response.output).toEqual([item])
    expect(h.usage.failed).toBe(false)
  })

  it("fails a stream that carries an error event", async () => {
    const h = await harness(
      metaKey(),
      () =>
        sse([
          { type: "error", error: { code: 429, message: "slow down", resets_at: Math.floor(Date.now() / 1000) + 60 } }
        ]),
      undefined,
      true
    )
    const collected = await collectStream(
      executor,
      h,
      { model: "muse-spark", payload: json(responsesRequest()) },
      responsesOptions(true)
    )
    expect(collected.error?.status).toBe(429)
    expect(collected.error?.retryAfterMs).toBeGreaterThan(0)
    expect(h.usage.failed).toBe(true)
  })

  it("counts tokens only after the local tokenizer slice (501 for now)", async () => {
    const h = await harness(metaKey(), () => sse([completed()]))
    const error = await Effect.runPromise(
      Effect.flip(
        executor
          .countTokens(
            h.context,
            { model: "muse-spark", payload: json(responsesRequest()) as Json },
            responsesOptions()
          )
          .pipe(Effect.provide(h.layers))
      )
    )
    expect(error.status).toBe(501)
  })
})
