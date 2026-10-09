// Execution conductor: retry rounds across credentials, cooldown waits (TestClock), request-scoped rules, stream
// bootstrap failover, alias pools, force-mapping and session affinity, run against the real credential pool with an
// injected clock and a mocked upstream (conductor_retry_round_test.go, conductor_execution_quota_test.go,
// conductor_request_scoped_errors_test.go, conductor_stream_*_test.go, conductor_force_mapping_test.go).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { AccessPrincipal } from "../src/access/principal.ts"
import type { ConfigReader } from "../src/config/reader.ts"
import { ExecutionError } from "../src/executor/errors.ts"
import { CredentialRefresher } from "../src/executor/helps/credential-refresh.ts"
import { ExecutorRegistry } from "../src/executor/registry.ts"
import type { ProviderExecutor } from "../src/executor/types.ts"
import type { RefreshResult } from "../src/credentials/refresh/index.ts"
import { Thinking } from "../src/executor/thinking.ts"
import { executeNonStream, executeStream } from "../src/handlers/execute.ts"
import { ModelCapabilities } from "../src/handlers/model-capabilities.ts"
import { ModelProviders } from "../src/handlers/model-providers.ts"
import { WorkerEnv } from "../src/platform/env.ts"
import { Formats } from "../src/translator/formats.ts"
import type { UsageRecord } from "../src/usage/record.ts"
import { UsageSink } from "../src/usage/sink.ts"
import { jsonResponse, mockHttpClient, sseResponse, staticConfigReader, type UpstreamCall } from "./support/pipeline.ts"
import { makePool, type MemoryPoolStore, poolPickerLayer, type PoolHarness } from "./support/pool.ts"

const identity = {
  principal: { kind: "user", email: "dev@example.com", sub: "sub" },
  principalId: "user:dev@example.com",
  callerScope: "scope-1"
} as const

const fakeRequest = (headers: Record<string, string> = {}) =>
  // Only url, method and headers are read by the conductor.
  ({ url: "/v1/chat/completions", method: "POST", headers }) as unknown as HttpServerRequest.HttpServerRequest

const group = (name: string, extra = "", models = "{ name: m }") => `
    - name: ${name}
      base-url: https://${name}.example/v1
      ${extra}
      models: [${models}]
      keys: [{ api-key: key-${name} }]`

const config = (groups: string, extra = "") => `
${extra}
api-keys:
  openai-compatibility:${groups}
`

const CHAT_OK = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }]
}

/** Which credential an upstream call used (`Authorization: Bearer key-<name>`). */
const keyOf = (call: UpstreamCall): string => (call.headers["authorization"] ?? "").replace("Bearer key-", "")

const upstreamError = (status: number, body = "upstream failure", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers })

interface Run {
  readonly harness: PoolHarness
  readonly calls: Array<UpstreamCall>
  readonly records: Array<UsageRecord>
  /** Provides every service of the pipeline; scoped effects must be wrapped in `Effect.scoped` by the caller. */
  readonly exec: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>
}

interface SetupOptions {
  readonly refresher?: Layer.Layer<CredentialRefresher> | ((harness: PoolHarness) => Layer.Layer<CredentialRefresher>)
  readonly executors?: Layer.Layer<ExecutorRegistry>
  readonly providers?: Layer.Layer<ModelProviders, never, ConfigReader>
  readonly prepare?: (harness: PoolHarness) => void
  readonly store?: MemoryPoolStore
}

const setup = (
  yaml: string,
  respond: (call: UpstreamCall, index: number) => Response | Promise<Response>,
  options: SetupOptions = {}
): Effect.Effect<Run> =>
  Effect.gen(function* () {
    const harness = yield* Effect.promise(
      async () => await makePool(yaml, options.store === undefined ? {} : { store: options.store })
    )
    options.prepare?.(harness)
    const refresher =
      typeof options.refresher === "function"
        ? options.refresher(harness)
        : (options.refresher ?? CredentialRefresher.none)
    const calls: Array<UpstreamCall> = []
    const records: Array<UsageRecord> = []
    const layer = Layer.mergeAll(
      poolPickerLayer(harness.pool),
      options.providers ?? ModelProviders.configLayer,
      ModelCapabilities.configLayer,
      options.executors ?? ExecutorRegistry.layer,
      refresher,
      UsageSink.memory(records),
      mockHttpClient(calls, (call) => respond(call, calls.length - 1)),
      Thinking.live
    ).pipe(Layer.provideMerge(staticConfigReader(harness.config)))
    const exec = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      // The layer provides every service the conductor needs (`Scope` is provided by the caller where used).
      effect.pipe(
        Effect.provide(layer),
        Effect.provideService(AccessPrincipal, identity),
        Effect.provideService(WorkerEnv, {} as Env)
      ) as unknown as Effect.Effect<A, E>
    return { harness, calls, records, exec }
  })

const chatInput = (model = "m", extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({
  entryProtocol: Formats.OpenAI,
  model,
  body: { model, messages: [{ role: "user", content: "hello" }], ...extra },
  alt: "",
  request: fakeRequest(headers)
})

const bodyOf = (call: UpstreamCall): Record<string, unknown> => JSON.parse(call.body) as Record<string, unknown>

const failure = <A>(effect: Effect.Effect<A, ExecutionError>) => Effect.flip(effect)

describe("failover within a round", () => {
  it.effect("moves to the next credential after a 5xx and cools the failed one down", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        keyOf(call) === "a" ? upstreamError(500) : jsonResponse(CHAT_OK)
      )
      const result = yield* run.exec(executeNonStream(chatInput()))
      assert.include(result.payload, "chat.completion")
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"])
      assert.deepStrictEqual(
        run.records.map((record) => [record.failed, record.source]),
        [
          [true, "a"],
          [false, "b"]
        ]
      )
      // The failed credential is cooling: the next requests keep using b without touching a.
      yield* run.exec(executeNonStream(chatInput()))
      yield* run.exec(executeNonStream(chatInput()))
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "b", "b"])
    })
  )

  it.effect("returns request faults at once without rotating or cooling (isRequestInvalidError)", () =>
    Effect.gen(function* () {
      const body = '{"error":{"message":"bad input","type":"invalid_request_error"}}'
      const run = yield* setup(config(group("a") + group("b")), () => upstreamError(400, body))
      const error = yield* failure(run.exec(executeNonStream(chatInput())))
      assert.strictEqual(error.status, 400)
      assert.strictEqual(error.message, body)
      assert.strictEqual(run.calls.length, 1)
      // The credential stays selectable: request faults carry no penalty.
      const first = run.calls.map(keyOf)[0] as string
      const credential = run.harness.pool.list().find((item) => item.label === first)
      assert.strictEqual(credential?.unavailable, false)
      assert.strictEqual(credential?.failed, 1)
    })
  )

  it.effect("429 and 401 rotate to the next credential; the final error is the last upstream error", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        keyOf(call) === "a" ? upstreamError(401, "bad key") : upstreamError(429, "quota gone")
      )
      const error = yield* failure(run.exec(executeNonStream(chatInput())))
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"])
      assert.strictEqual(error.status, 429)
      assert.strictEqual(error.message, "quota gone")
    })
  )

  it.effect("reports a client abort as a lifecycle failure without cooling the credential", () =>
    Effect.gen(function* () {
      // The upstream never answers: the request is interrupted while the attempt is in flight.
      const run = yield* setup(config(group("a")), () => new Promise<Response>(() => {}))
      const fiber = yield* Effect.forkChild(run.exec(executeNonStream(chatInput())))
      yield* TestClock.adjust(10)
      assert.strictEqual(run.calls.length, 1)
      yield* Fiber.interrupt(fiber)
      const credential = run.harness.pool.list()[0]
      assert.strictEqual(credential?.failed, 1)
      assert.strictEqual(credential?.unavailable, false)
      assert.strictEqual(run.records.length, 1)
    })
  )
})

describe("retry rounds (TestExecuteRetryRoundCredentialWindows / MaxCredentialsAgesSkippedAuths)", () => {
  it.effect("credentials drop out of later rounds when their request-retry is spent", () =>
    Effect.gen(function* () {
      const yaml = config(
        group("a", "request-retry: 3\n      disable-cooling: true") +
          group("b", "request-retry: 2\n      disable-cooling: true") +
          group("c", "request-retry: 2\n      disable-cooling: true"),
        "routing:\n  retry:\n    request-retry: 3"
      )
      const run = yield* setup(yaml, () => upstreamError(500))
      const error = yield* failure(run.exec(executeNonStream(chatInput())))
      assert.strictEqual(error.status, 500)
      const counts = Object.fromEntries(
        ["a", "b", "c"].map((name) => [name, run.calls.filter((call) => keyOf(call) === name).length])
      )
      assert.deepStrictEqual(counts, { a: 4, b: 3, c: 3 })
    })
  )

  it.effect("max-retry-credentials caps the credentials tried per round", () =>
    Effect.gen(function* () {
      const off = "disable-cooling: true"
      const yaml = config(
        group("a", `request-retry: 1\n      ${off}`) +
          group("b", `request-retry: 1\n      ${off}`) +
          group("c", `request-retry: 1\n      ${off}`) +
          group("d", `request-retry: 2\n      ${off}`),
        "routing:\n  retry:\n    request-retry: 2\n    max-retry-credentials: 3"
      )
      const run = yield* setup(yaml, () => upstreamError(500))
      yield* failure(run.exec(executeNonStream(chatInput())))
      const order = run.calls.map(keyOf)
      assert.strictEqual(order.length, 7)
      assert.strictEqual(order.at(-1), "d")
      for (const name of ["a", "b", "c"]) assert.isAtMost(order.filter((key) => key === name).length, 2)
      assert.isAtMost(order.filter((key) => key === "d").length, 3)
    })
  )

  it.effect("without request-retry a failed request is not retried beyond the credentials of one round", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a", "disable-cooling: true")), () => upstreamError(500))
      yield* failure(run.exec(executeNonStream(chatInput())))
      assert.strictEqual(run.calls.length, 1)
    })
  )
})

describe("cooldown waits", () => {
  const waiting = config(group("a"), "routing:\n  retry:\n    request-retry: 1\n    max-retry-interval: 30")

  it.effect("waits for the recovery of the only credential (TestClock) and then succeeds", () =>
    Effect.gen(function* () {
      const run = yield* setup(waiting, (_call, index) =>
        index === 0 ? upstreamError(429, "slow down", { "retry-after": "12" }) : jsonResponse(CHAT_OK)
      )
      const fiber = yield* Effect.forkChild(run.exec(executeNonStream(chatInput())))
      yield* TestClock.adjust(5000)
      run.harness.clock.advance(5000)
      assert.strictEqual(run.calls.length, 1)
      assert.isUndefined(fiber.pollUnsafe())
      // 12 s cooldown plus up to 2 s of jitter.
      run.harness.clock.advance(10_000)
      yield* TestClock.adjust(10_000)
      const result = yield* Fiber.join(fiber)
      assert.include(result.payload, "chat.completion")
      assert.strictEqual(run.calls.length, 2)
    })
  )

  it.effect("answers 429 with Retry-After instead of waiting longer than max-retry-interval", () =>
    Effect.gen(function* () {
      const yaml = config(group("a"), "routing:\n  retry:\n    request-retry: 1\n    max-retry-interval: 5")
      const run = yield* setup(yaml, () => upstreamError(429, "quota", { "retry-after": "90" }))
      const error = yield* failure(run.exec(executeNonStream(chatInput())))
      assert.strictEqual(error.status, 429)
      assert.strictEqual(error.safeHeaders?.["retry-after"], "90")
      assert.strictEqual(run.calls.length, 1)
    })
  )

  it.effect("selection failures while every credential cools carry the Go model_cooldown body", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a")), () => upstreamError(429, "quota", { "retry-after": "30" }))
      yield* failure(run.exec(executeNonStream(chatInput())))
      const error = yield* failure(run.exec(executeNonStream(chatInput())))
      assert.strictEqual(error.status, 429)
      assert.strictEqual(error.code, "model_cooldown")
      assert.strictEqual(error.safeHeaders?.["retry-after"], "30")
      assert.include(error.message, '"code":"model_cooldown"')
      assert.strictEqual(run.calls.length, 1)
    })
  )
})

const rule = (action: string) =>
  `request-scoped-errors:\n        - { status: 400, match: ["context window"], action: ${action} }`
const respondContextWindow = (call: UpstreamCall) =>
  keyOf(call) === "a" ? upstreamError(400, "the context window is too large") : jsonResponse(CHAT_OK)

describe("request-scoped error rules", () => {
  it.effect("continue: the matching error moves on to the next credential without a penalty", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a", rule("continue")) + group("b")), respondContextWindow)
      const result = yield* run.exec(executeNonStream(chatInput()))
      assert.include(result.payload, "chat.completion")
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"])
      const a = run.harness.pool.list().find((item) => item.label === "a")
      assert.strictEqual(a?.unavailable, false)
    })
  )

  it.effect("continue-and-cooldown: moves on and cools the credential", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a", rule("continue-and-cooldown")) + group("b")), respondContextWindow)
      yield* run.exec(executeNonStream(chatInput()))
      yield* run.exec(executeNonStream(chatInput()))
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "b"])
    })
  )

  it.effect("stop: returns the error to the client; stop-and-cooldown also cools", () =>
    Effect.gen(function* () {
      const stop = yield* setup(config(group("a", rule("stop")) + group("b")), respondContextWindow)
      const error = yield* failure(stop.exec(executeNonStream(chatInput())))
      assert.strictEqual(error.status, 400)
      assert.strictEqual(stop.calls.length, 1)

      const cool = yield* setup(config(group("a", rule("stop-and-cooldown"))), respondContextWindow)
      yield* failure(cool.exec(executeNonStream(chatInput())))
      const next = yield* failure(cool.exec(executeNonStream(chatInput())))
      assert.strictEqual(next.code, "auth_unavailable")
      assert.strictEqual(cool.calls.length, 1)
    })
  )

  it.effect("a rule that does not match leaves the default classification in place", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a", rule("continue")) + group("b")), () =>
        upstreamError(400, "other problem")
      )
      const error = yield* failure(run.exec(executeNonStream(chatInput())))
      assert.strictEqual(error.status, 400)
      assert.strictEqual(run.calls.length, 1)
    })
  )
})

describe("alias pools and force-mapping", () => {
  const pooled = config(`
    - name: p
      base-url: https://p.example/v1
      models:
        - { name: up-1, alias: shared }
        - { name: up-2, alias: shared }
      keys: [{ api-key: key-p }]`)

  it.effect("tries the pool's upstream models in turn within one credential and cools them separately", () =>
    Effect.gen(function* () {
      const run = yield* setup(pooled, (call) =>
        bodyOf(call).model === "up-1" ? upstreamError(500) : jsonResponse(CHAT_OK)
      )
      for (let index = 0; index < 4; index += 1) yield* run.exec(executeNonStream(chatInput("shared")))
      const models = run.calls.map((call) => bodyOf(call).model)
      // up-1 fails at most once (then cools for 60 s); every request is served by up-2.
      assert.strictEqual(models.filter((model) => model === "up-1").length, 1)
      assert.strictEqual(models.filter((model) => model === "up-2").length, 4)
      assert.strictEqual(run.records.filter((record) => record.failed).length, 1)
    })
  )

  it.effect("rewrites the model of a force-mapped response (non-stream and stream)", () =>
    Effect.gen(function* () {
      const yaml = config(`
    - name: f
      base-url: https://f.example/v1
      models: [{ name: real-model, alias: friendly, force-mapping: true }]
      keys: [{ api-key: key-f }]`)
      const run = yield* setup(yaml, (call) => {
        const stream = bodyOf(call).stream === true
        return stream
          ? sseResponse([
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"real-model","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n',
              "data: [DONE]\n\n"
            ])
          : jsonResponse({ ...CHAT_OK, model: "real-model" })
      })
      const result = yield* run.exec(executeNonStream(chatInput("friendly")))
      assert.strictEqual((JSON.parse(result.payload) as { model: string }).model, "friendly")
      assert.strictEqual(bodyOf(run.calls[0] as UpstreamCall).model, "real-model")

      const stream = yield* run.exec(
        Effect.scoped(
          executeStream(chatInput("friendly", { stream: true })).pipe(
            Effect.flatMap((output) => Stream.runCollect(output.chunks))
          )
        )
      )
      const joined = [...stream].join("")
      assert.include(joined, '"model":"friendly"')
      assert.notInclude(joined, "real-model")
    })
  )
})

const chunk = (text: string) =>
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`

const collect = (run: Run, input = chatInput("m", { stream: true })) =>
  run.exec(
    Effect.scoped(
      executeStream(input).pipe(
        Effect.flatMap((output) => Stream.runCollect(output.chunks).pipe(Effect.map((chunks) => [...chunks])))
      )
    )
  )

describe("streaming", () => {
  it.effect("fails over before the first byte (HTTP error, then an empty stream)", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b") + group("c")), (call) => {
        const key = keyOf(call)
        if (key === "a") return upstreamError(503)
        if (key === "b") return sseResponse([": keep-alive\n\n"])
        return sseResponse([chunk("hi"), "data: [DONE]\n\n"])
      })
      const chunks = yield* collect(run)
      assert.isTrue(chunks.some((text) => text.includes('"content":"hi"')))
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "c"])
      assert.deepStrictEqual(
        run.records.map((record) => record.failed),
        [true, true, false]
      )
    })
  )

  it.effect("does not fail over after the first byte: the error reaches the client and is reported", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), () =>
        sseResponse([chunk("part"), '{"error":{"message":"midstream"}}\n'])
      )
      const exit = yield* Effect.exit(collect(run))
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(run.calls.length, 1)
      assert.strictEqual(run.records.length, 1)
      assert.isTrue(run.records[0]?.failed)
    })
  )

  it.effect("reports success when the stream ends and an early close as lifecycle (no cooldown)", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a")), () => sseResponse([chunk("one"), chunk("two"), "data: [DONE]\n\n"]))
      yield* collect(run)
      assert.deepStrictEqual(
        run.harness.pool.list().map((item) => [item.failed, item.unavailable]),
        [[0, false]]
      )

      // Client goes away after the first chunk.
      yield* run.exec(
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          const output = yield* executeStream(chatInput("m", { stream: true })).pipe(Scope.provide(scope))
          yield* Stream.take(output.chunks, 1).pipe(Stream.runDrain, Scope.provide(scope))
          yield* Scope.close(scope, Exit.void)
        })
      )
      const credential = run.harness.pool.list()[0]
      assert.strictEqual(credential?.unavailable, false)
    })
  )

  it.effect("requests.streaming.bootstrap-retries repeats the execution for bootstrap failures", () =>
    Effect.gen(function* () {
      const yaml = config(group("a", "disable-cooling: true"), "requests:\n  streaming:\n    bootstrap-retries: 1")
      const run = yield* setup(yaml, (_call, index) =>
        index === 0 ? sseResponse([": nothing\n\n"]) : sseResponse([chunk("ok"), "data: [DONE]\n\n"])
      )
      const chunks = yield* collect(run)
      assert.isTrue(chunks.some((text) => text.includes('"content":"ok"')))
      assert.strictEqual(run.calls.length, 2)

      const none = yield* setup(config(group("a", "disable-cooling: true")), () => sseResponse([": nothing\n\n"]))
      const exit = yield* Effect.exit(collect(none))
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(none.calls.length, 1)
    })
  )
})

describe("session affinity and thinking", () => {
  it.effect("binds a session (explicit header) to one credential per caller scope", () =>
    Effect.gen(function* () {
      const yaml = config(group("a") + group("b") + group("c"), "routing:\n  session-affinity: true")
      const run = yield* setup(yaml, () => jsonResponse(CHAT_OK))
      const sessionInput = chatInput("m", {}, { "x-session-id": "session-42" })
      for (let index = 0; index < 5; index += 1) yield* run.exec(executeNonStream(sessionInput))
      assert.strictEqual(new Set(run.calls.map(keyOf)).size, 1)
      // Without a session marker unrelated conversations rotate ...
      const conversation = (text: string) => ({
        ...chatInput(),
        body: { model: "m", messages: [{ role: "user", content: text }] }
      })
      for (let index = 0; index < 6; index += 1) yield* run.exec(executeNonStream(conversation(`topic ${index}`)))
      assert.isAbove(new Set(run.calls.slice(5).map(keyOf)).size, 1)
      // ... while the same conversation stays on one credential (LCP matcher / derived identity).
      const before = run.calls.length
      for (let index = 0; index < 4; index += 1) yield* run.exec(executeNonStream(conversation("topic 0")))
      assert.strictEqual(new Set(run.calls.slice(before).map(keyOf)).size, 1)
      assert.strictEqual(run.calls.slice(before).map(keyOf)[0], keyOf(run.calls[5] as UpstreamCall))
      // Usage records carry the session identity (explicit, then LCP) and the credential's base URL.
      assert.strictEqual(run.records[0]?.sessionId, "header:session-42")
      assert.match(run.records[5]?.sessionId ?? "", /^lcp:v1:[0-9a-f]{64}$/)
      assert.strictEqual(run.records[before]?.sessionId, run.records[5]?.sessionId)
      assert.match(run.records[0]?.baseUrl ?? "", /^https:\/\/[a-z]\.example/)
    })
  )

  it.effect("applies the thinking suffix through the real pipeline", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("t", "", "{ name: m, thinking: { levels: [low, medium, high] } }")), () =>
        jsonResponse(CHAT_OK)
      )
      yield* run.exec(executeNonStream(chatInput("m(high)")))
      const body = bodyOf(run.calls[0] as UpstreamCall)
      assert.strictEqual(body.model, "m")
      assert.strictEqual(body.reasoning_effort, "high")
    })
  )
})

describe("credential preparation and 401 refresh (tryRefreshAfterUnauthorized)", () => {
  const AUTH_FILE = {
    type: "claude",
    email: "a@x.com",
    access_token: "old",
    refresh_token: "r",
    expired: "2999-01-01T00:00:00Z"
  }
  const providers = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: () => Effect.succeed(["claude"]),
      firstAvailableModel: Effect.succeed(undefined)
    })
  )

  /** An executor that rejects the token `old` with 401 and records which token each call used. */
  const tokenExecutor = (seen: string[]): Layer.Layer<ExecutorRegistry> => {
    const execute: ProviderExecutor["execute"] = (context) =>
      Effect.suspend(() => {
        const token = String(context.credential.metadata["access_token"] ?? "")
        seen.push(token)
        return token === "old"
          ? Effect.fail(new ExecutionError({ status: 401, message: "token expired" }))
          : Effect.succeed({ payload: '{"ok":true}', headers: new Headers() })
      })
    const unsupported: ProviderExecutor["executeStream"] = () =>
      Effect.fail(new ExecutionError({ status: 501, message: "unsupported" }))
    const executor: ProviderExecutor = {
      identifier: "claude",
      execute,
      executeStream: unsupported,
      countTokens: execute
    }
    return Layer.succeed(ExecutorRegistry, ExecutorRegistry.of({ get: () => executor }))
  }

  const refresherFor =
    (
      counts: { refresh: Array<string | undefined>; ensure: number },
      respond: (harness: PoolHarness, rejected: string | undefined) => RefreshResult
    ) =>
    (harness: PoolHarness): Layer.Layer<CredentialRefresher> =>
      Layer.succeed(
        CredentialRefresher,
        CredentialRefresher.of({
          refreshNow: (_id, rejected) =>
            Effect.sync(() => {
              counts.refresh.push(rejected)
              return respond(harness, rejected)
            }),
          ensureFresh: () =>
            Effect.sync(() => {
              counts.ensure += 1
              return respond(harness, undefined)
            })
        })
      )

  /** Stores a refreshed token (bumping the credential version, like the ControlPlane) and returns the snapshot. */
  const rotate =
    (token: string) =>
    (harness: PoolHarness): RefreshResult => {
      harness.pool.upsert("claude-a.json", { ...AUTH_FILE, access_token: token }, { mergeExisting: false })
      const picked = harness.pool.pick({ providers: ["claude"], model: "m" })
      if (!picked.ok) throw new Error("pick failed")
      return { ok: true, refreshed: true, credential: picked.credential }
    }

  it.effect(
    "refreshes once after a 401, repeats the attempt with the new token and reports against the new version",
    () =>
      Effect.gen(function* () {
        const seen: string[] = []
        const counts = { refresh: [] as Array<string | undefined>, ensure: 0 }
        const run = yield* setup("", () => jsonResponse({}), {
          providers,
          executors: tokenExecutor(seen),
          refresher: refresherFor(counts, (harness) => rotate("new")(harness)),
          prepare: (harness) => harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false })
        })
        const result = yield* run.exec(executeNonStream(chatInput("claude-x")))
        assert.strictEqual(result.payload, '{"ok":true}')
        assert.deepStrictEqual(seen, ["old", "new"])
        assert.deepStrictEqual(counts.refresh, ["old"])
        assert.strictEqual(counts.ensure, 0)
        // The rejected attempt keeps its own failed usage record; the repeat is reported as a success.
        assert.deepStrictEqual(
          run.records.map((record) => [record.failed, record.fail?.statusCode]),
          [
            [true, 401],
            [false, undefined]
          ]
        )
        const [credential] = run.harness.pool.list()
        assert.deepInclude(credential, { success: 1, failed: 0, unavailable: false, credentialVersion: 2 })
      })
  )

  it.effect("keeps the 401 (and cools the credential) when the refresh fails; marks terminal failures", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const counts = { refresh: [] as Array<string | undefined>, ensure: 0 }
      const failure = (terminal: boolean) => (): RefreshResult => ({
        ok: false,
        error: { code: "unauthorized", message: "invalid_grant", httpStatus: 400 },
        terminal
      })
      const soft = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor(seen),
        refresher: refresherFor(counts, failure(false)),
        prepare: (harness) => harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false })
      })
      const error = yield* failure_(soft.exec(executeNonStream(chatInput("claude-x"))))
      assert.strictEqual(error.status, 401)
      assert.isUndefined(error.terminalAuth)
      assert.deepStrictEqual(seen, ["old"])
      assert.strictEqual(soft.harness.pool.list()[0]?.unavailable, true)

      const hard = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor([]),
        refresher: refresherFor(counts, failure(true)),
        prepare: (harness) => harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false })
      })
      const terminal = yield* failure_(hard.exec(executeNonStream(chatInput("claude-x"))))
      assert.strictEqual(terminal.terminalAuth, true)
    })
  )

  it.effect("does not repeat when the token did not change, and ignores other statuses", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const counts = { refresh: [] as Array<string | undefined>, ensure: 0 }
      const same = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor(seen),
        refresher: refresherFor(counts, (harness) => {
          const picked = harness.pool.pick({ providers: ["claude"], model: "m" })
          if (!picked.ok) throw new Error("pick failed")
          return { ok: true, refreshed: false, credential: picked.credential }
        }),
        prepare: (harness) => harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false })
      })
      const error = yield* failure_(same.exec(executeNonStream(chatInput("claude-x"))))
      assert.strictEqual(error.status, 401)
      assert.deepStrictEqual(seen, ["old"])
      assert.strictEqual(counts.refresh.length, 1)

      const fresh = { refresh: [] as Array<string | undefined>, ensure: 0 }
      const other = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: Layer.succeed(
          ExecutorRegistry,
          ExecutorRegistry.of({
            get: () => ({
              identifier: "claude",
              execute: () => Effect.fail(new ExecutionError({ status: 500, message: "boom" })),
              executeStream: () => Effect.fail(new ExecutionError({ status: 500, message: "boom" })),
              countTokens: () => Effect.fail(new ExecutionError({ status: 500, message: "boom" }))
            })
          })
        ),
        refresher: refresherFor(fresh, rotate("new")),
        prepare: (harness) => harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false })
      })
      yield* failure_(other.exec(executeNonStream(chatInput("claude-x"))))
      assert.deepStrictEqual(fresh.refresh, [])
    })
  )

  it.effect("prepares a credential without an access token through ensureFresh before the first attempt", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const counts = { refresh: [] as Array<string | undefined>, ensure: 0 }
      const bare = { type: "claude", email: "a@x.com", refresh_token: "r" }
      const run = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor(seen),
        refresher: refresherFor(counts, (harness) => {
          harness.pool.upsert("claude-a.json", { ...bare, access_token: "new" }, { mergeExisting: false })
          const picked = harness.pool.pick({ providers: ["claude"], model: "m" })
          if (!picked.ok) throw new Error("pick failed")
          return { ok: true, refreshed: true, credential: picked.credential }
        }),
        prepare: (harness) => harness.pool.upsert("claude-a.json", bare, { mergeExisting: false })
      })
      yield* run.exec(executeNonStream(chatInput("claude-x")))
      assert.strictEqual(counts.ensure, 1)
      assert.deepStrictEqual(seen, ["new"])
      assert.strictEqual(run.harness.pool.list()[0]?.success, 1)

      // A usable token needs no preparation.
      const ready = { refresh: [] as Array<string | undefined>, ensure: 0 }
      const usable = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor([]),
        refresher: refresherFor(ready, rotate("new")),
        prepare: (harness) =>
          harness.pool.upsert("claude-a.json", { ...AUTH_FILE, access_token: "tok" }, { mergeExisting: false })
      })
      yield* usable.exec(executeNonStream(chatInput("claude-x")))
      assert.strictEqual(ready.ensure, 0)
    })
  )

  it.effect("a credential that cannot be prepared fails the attempt and rotates on", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const counts = { refresh: [] as Array<string | undefined>, ensure: 0 }
      const run = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor(seen),
        refresher: refresherFor(counts, () => ({
          ok: false,
          error: { code: "refresh_failed", message: "refresh endpoint down", httpStatus: 503 },
          terminal: false
        })),
        prepare: (harness) =>
          harness.pool.upsert(
            "claude-a.json",
            { type: "claude", email: "a@x.com", refresh_token: "r" },
            { mergeExisting: false }
          )
      })
      const error = yield* failure_(run.exec(executeNonStream(chatInput("claude-x"))))
      assert.strictEqual(error.status, 503)
      assert.deepStrictEqual(seen, [])
      assert.strictEqual(counts.ensure, 1)
    })
  )
})

const failure_ = <A>(effect: Effect.Effect<A, ExecutionError>) => Effect.flip(effect)
