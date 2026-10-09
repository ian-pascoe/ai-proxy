// Unit tests for executor building blocks: upstream SSE reading, retry-after, custom headers, model resolution,
// config credentials and the static credential picker.
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { configCredentials, openAICompatModelIds } from "../src/executor/config-credentials.ts"
import { customHeaders } from "../src/executor/helps/custom-headers.ts"
import { normalizeOpenAIMaxTokens } from "../src/executor/helps/openai-compat-models.ts"
import { openAICompatRetryAfterMs } from "../src/executor/helps/retry-after.ts"
import { executionModelCandidates, openAICompatibleProviderKey, resolveModelAliasPool } from "../src/executor/models.ts"
import { OpenAICompatStreamReader, openAICompatStreamDataError } from "../src/executor/openai-compat/stream.ts"
import { CredentialPicker, type CredentialSnapshot } from "../src/executor/picker.ts"
import { StaticCredentialPickerLayer } from "../src/executor/static-picker.ts"
import { parseSuffix } from "../src/executor/suffix.ts"
import { LineSplitter } from "../src/http/sse.ts"
import { WorkerEnv } from "../src/platform/env.ts"
import { builtinTranslators } from "../src/translator/builtin.ts"
import { Formats } from "../src/translator/formats.ts"
import { makeTranslationState, TranslatorRegistry } from "../src/translator/registry.ts"
import { loadConfig, staticConfigReader } from "./support/pipeline.ts"

describe("LineSplitter", () => {
  it("splits on \\n only, drops trailing \\r and flushes the last line", () => {
    const splitter = new LineSplitter()
    expect(splitter.push("a\r\nb")).toEqual(["a"])
    expect(splitter.push("c\rd\n\n")).toEqual(["bc\rd", ""])
    expect(splitter.push("tail\r")).toEqual([])
    expect(splitter.end()).toEqual(["tail"])
    expect(splitter.end()).toEqual([])
  })
})

const reader = (responseFormat: string = Formats.OpenAI, registry = builtinTranslators) =>
  new OpenAICompatStreamReader({
    registry,
    responseFormat,
    providerFormat: Formats.OpenAI,
    context: { model: "m", originalRequest: {}, translatedRequest: {}, state: makeTranslationState() }
  })

const feed = (r: OpenAICompatStreamReader, lines: ReadonlyArray<string>) => lines.map((line) => r.push(line))

describe("OpenAICompatStreamReader", () => {
  it("joins multi-line data frames and ignores comments, ids and retries", () => {
    const r = reader()
    const steps = feed(r, [": ping", "id: 1", "retry: 10", 'data: {"a":', "data: 1}", ""])
    expect(steps.at(-1)).toEqual({ chunks: ['{"a":\n1}'], stop: false })
  })

  it("stops after [DONE]", () => {
    const r = reader()
    expect(feed(r, ["data: [DONE]", ""]).at(-1)).toEqual({ chunks: [], stop: true })
    expect(r.push('data: {"late":1}')).toEqual({ chunks: [], stop: true })
  })

  it.each([
    [["event: error", ""], 502, "upstream error event ended without data"],
    [["data: {}", "data: [DONE]", ""], 502, "upstream stream ended with incomplete data before [DONE]"],
    [["event: response.failed", "data: [DONE]", ""], 502, "upstream error event ended before [DONE]"],
    [['data: {"a":', ""], 502, "upstream stream ended with incomplete SSE data frame"],
    [['data: {"error":{"status_code":503}}', ""], 503, '{"error":{"status_code":503}}'],
    [['data: {"type":"response.failed","status":200}', ""], 502, '{"type":"response.failed","status":200}'],
    [["event: error", 'data: {"ok":true}', ""], 502, '{"ok":true}'],
    [["[1,2]"], 502, "[1,2]"]
  ])("fails %j with %i", (lines, status, message) => {
    const steps = feed(reader(), lines)
    const failed = steps.find((step) => step.error !== undefined)
    expect(failed?.stop).toBe(true)
    expect(failed?.error?.status).toBe(status)
    expect(failed?.error?.message).toBe(message)
  })

  it("does not treat null error fields as errors", () => {
    expect(openAICompatStreamDataError('{"error":null,"choices":[]}', "")).toBeUndefined()
    expect(openAICompatStreamDataError('{"code":1}', "")).toBeUndefined()
  })

  it("flushes a pending frame at EOF and tolerates a missing [DONE]", () => {
    const r = reader()
    r.push('data: {"x":1}')
    expect(r.end()).toEqual({ chunks: ['{"x":1}'], stop: true })
  })

  it("fails Responses streams that end without [DONE] unless the translator can finalise", () => {
    const strict = reader(Formats.OpenAIResponse)
    expect(strict.end().error?.message).toBe("upstream stream closed before [DONE]")

    const registry = new TranslatorRegistry().register(Formats.OpenAIResponse, Formats.OpenAI, undefined, {
      stream: (context, line) => {
        context.state.canFinalize = true
        return line === "data: [DONE]" ? ["event: response.completed\ndata: {}\n\n"] : []
      }
    })
    const finalising = reader(Formats.OpenAIResponse, registry)
    finalising.push('data: {"x":1}')
    finalising.push("")
    expect(finalising.end()).toEqual({ chunks: ["event: response.completed\ndata: {}\n\n"], stop: true })
  })

  it("fails with 502 when a translator retains a tool-input error", () => {
    const registry = new TranslatorRegistry().register(Formats.OpenAI, Formats.OpenAI, undefined, {
      stream: (context) => {
        context.state.toolInputError = "bad"
        return ["partial"]
      }
    })
    const step = feed(reader(Formats.OpenAI, registry), ['data: {"x":1}', ""]).at(-1)
    expect(step?.chunks).toEqual(["partial"])
    expect(step?.error?.status).toBe(502)
  })
})

describe("openAICompatRetryAfterMs", () => {
  const now = Date.parse("2026-01-01T00:00:00Z")
  it("reads seconds, HTTP dates and the TPM fallback for 429 only", () => {
    expect(openAICompatRetryAfterMs(429, new Headers({ "retry-after": "12" }), "", now)).toBe(12_000)
    expect(
      openAICompatRetryAfterMs(429, new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }), "", now)
    ).toBe(30_000)
    expect(openAICompatRetryAfterMs(429, new Headers(), '{"error":{"code":"TPMRateLimitExceeded"}}', now)).toBe(60_000)
    expect(
      openAICompatRetryAfterMs(429, new Headers(), '{"error":{"message":"Tokens per minute limit exceeded"}}', now)
    ).toBe(60_000)
    expect(openAICompatRetryAfterMs(429, new Headers(), "{}", now)).toBeUndefined()
    expect(openAICompatRetryAfterMs(503, new Headers({ "retry-after": "5" }), "", now)).toBeUndefined()
  })
})

const credential = (attributes: Record<string, string>, prefix?: string): CredentialSnapshot => ({
  id: "c",
  provider: "openai-compatible-x",
  kind: "apikey",
  attributes,
  metadata: {},
  ...(prefix !== undefined ? { prefix } : {})
})

describe("custom headers", () => {
  it("expands client headers and the session id, omitting unknown values", () => {
    const c = credential({
      "header:X-Fixed": "v",
      "header:X-Client": "$X-Trace",
      "header:X-Missing": "$X-Nope",
      "header:X-Session": "$CPA-SESSION-ID",
      "header:X-Mixed": "s=$cpa-session-id;",
      base_url: "ignored"
    })
    expect(customHeaders(c, new Headers({ "x-trace": "t1" }), "sess")).toEqual([
      ["X-Fixed", "v"],
      ["X-Client", "t1"],
      ["X-Session", "sess"],
      ["X-Mixed", "s=sess;"]
    ])
    expect(customHeaders(c, undefined, undefined)).toEqual([["X-Fixed", "v"]])
  })
})

describe("max token normalisation", () => {
  it("keeps exactly one field", () => {
    expect(normalizeOpenAIMaxTokens({ max_tokens: 5 }, true)).toEqual({ max_completion_tokens: 5 })
    expect(normalizeOpenAIMaxTokens({ max_completion_tokens: 5 }, false)).toEqual({ max_tokens: 5 })
    expect(normalizeOpenAIMaxTokens({ max_tokens: 1, max_completion_tokens: 2 }, true)).toEqual({
      max_completion_tokens: 2
    })
    expect(normalizeOpenAIMaxTokens({ a: 1 }, true)).toEqual({ a: 1 })
  })
})

describe("model resolution helpers", () => {
  it("parses suffixes", () => {
    expect(parseSuffix("gpt-5(high)")).toEqual({ modelName: "gpt-5", hasSuffix: true, rawSuffix: "high" })
    expect(parseSuffix("a(b)c")).toEqual({ modelName: "a(b)c", hasSuffix: false, rawSuffix: "" })
  })

  it("derives provider keys", () => {
    expect(openAICompatibleProviderKey("OpenRouter")).toBe("openai-compatible-openrouter")
    expect(openAICompatibleProviderKey("openai-compatible-x")).toBe("openai-compatible-x")
    expect(openAICompatibleProviderKey("")).toBe("openai-compatibility")
  })

  it("resolves alias pools with the request suffix", () => {
    const models = [
      { name: "up-1", alias: "pool" },
      { name: "up-2(low)", alias: "POOL" },
      { name: "up-1", alias: "pool" }
    ]
    expect(resolveModelAliasPool("pool(high)", models)).toEqual(["up-1(high)", "up-2(low)"])
    expect(resolveModelAliasPool("other", models)).toEqual([])
  })

  it.effect("builds credentials and execution models from config", () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() =>
        loadConfig(`
routing:
  force-model-prefix: true
api-keys:
  openai-compatibility:
    - name: Pool
      base-url: https://p.test
      prefix: team
      priority: 2
      models:
        - { name: up-a, alias: pool }
        - { name: up-b, alias: pool }
        - { name: team }
      keys:
        - { api-key: k1, weight: 3 }
        - { api-key: k2 }
    - name: Off
      base-url: https://off.test
      disabled: true
      keys: [{ api-key: k3 }]
`)
      )
      const group = config["api-keys"]["openai-compatibility"][0]!
      assert.deepStrictEqual(openAICompatModelIds(group, true), ["team/pool", "team", "team/team"])
      const creds = configCredentials(config)
      assert.strictEqual(creds.length, 2)
      const first = creds[0]!.credential
      assert.deepStrictEqual(first, {
        id: "openai-compatible-pool#0.0",
        provider: "openai-compatible-pool",
        kind: "apikey",
        label: "Pool",
        prefix: "team",
        attributes: {
          base_url: "https://p.test",
          compat_name: "Pool",
          provider_key: "openai-compatible-pool",
          config_index: "0",
          priority: "2",
          source: "config:pool[0.0]",
          weight: "3",
          api_key: "k1"
        },
        metadata: {}
      })
      assert.deepStrictEqual(executionModelCandidates(config, first, "team/pool(1024)"), ["up-a(1024)", "up-b(1024)"])
      assert.deepStrictEqual(executionModelCandidates(config, first, "team/unknown"), ["unknown"])
    })
  )
})

describe("static credential picker", () => {
  const yaml = `
api-keys:
  openai-compatibility:
    - name: A
      base-url: https://a.test
      models: [{ name: m }]
      keys: [{ api-key: a1 }, { api-key: a2 }]
    - name: B
      base-url: https://b.test
      priority: 5
      models: [{ name: m }, { name: only-b }]
      keys: [{ api-key: b1 }]
`
  const run = <A, E>(effect: Effect.Effect<A, E, CredentialPicker | WorkerEnv>) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => loadConfig(yaml))
      return yield* effect.pipe(
        Effect.provide(StaticCredentialPickerLayer),
        Effect.provide(staticConfigReader(config)),
        Effect.provideService(WorkerEnv, {} as Env)
      )
    })

  it.effect("prefers the highest priority, round-robins and honours exclusions", () =>
    run(
      Effect.gen(function* () {
        const picker = yield* CredentialPicker
        const providers = ["openai-compatible-a", "openai-compatible-b"]
        const pick = (excludedIds: ReadonlyArray<string> = []) =>
          picker
            .pick({ providers, model: "m(high)", callerScope: "s", excludedIds })
            .pipe(Effect.map((result) => result.credential.id))
        assert.strictEqual(yield* pick(), "openai-compatible-b#1.0")
        const a1 = yield* pick(["openai-compatible-b#1.0"])
        const a2 = yield* pick(["openai-compatible-b#1.0"])
        assert.deepStrictEqual([a1, a2].toSorted(), ["openai-compatible-a#0.0", "openai-compatible-a#0.1"])
        const none = yield* Effect.flip(
          picker.pick({ providers: ["openai-compatible-a"], model: "only-b", callerScope: "s" })
        )
        assert.strictEqual(none.code, "auth_not_found")
        assert.strictEqual(none.status, 503)
        const empty = yield* Effect.flip(picker.pick({ providers: [], model: "m", callerScope: "s" }))
        assert.strictEqual(empty.code, "provider_not_found")
        yield* picker.report("lease", { ok: false, model: "m", status: 500 })
      })
    )
  )
})
