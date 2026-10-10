import { env } from "cloudflare:workers"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { encodeConfig, parseConfigYaml, stringifyConfigYaml } from "../src/config/codec.ts"
import { ConfigStoreError } from "../src/config/errors.ts"
import { ConfigReader, ConfigSource } from "../src/config/reader.ts"
import { decodeStoredConfig, type ConfigSnapshotWire } from "../src/config/store.ts"
import { WorkerEnv } from "../src/platform/env.ts"

// Each test uses its own Durable Object instance; production uses getByName("global").
const controlPlane = () => env.CONTROL_PLANE.getByName(crypto.randomUUID())

const YAML = `
routing:
  strategy: fill-first
requests:
  payload:
    override:
      - models: [{ name: "gpt-*" }]
        params: { temperature: 0.2 }
api-keys:
  claude:
    - name: a
      base-url: https://api.anthropic.com
      keys: [{ api-key: sk-1, weight: 2 }]
`

describe("ControlPlane config storage (Workers pool)", () => {
  it.effect("starts at version 0 with the default config", () =>
    Effect.gen(function* () {
      const stub = controlPlane()
      const snapshot = yield* Effect.promise(async () => await stub.getConfig())
      assert.strictEqual(snapshot.version, 0)
      assert.isFalse(snapshot.unchanged)
      const config = yield* decodeStoredConfig(snapshot.document ?? "")
      assert.strictEqual(config.routing.strategy, "round-robin")
      const same = yield* Effect.promise(async () => await stub.getConfig(0))
      assert.isTrue(same.unchanged)
      assert.isUndefined(same.document)
    })
  )

  it.effect("round-trips YAML through the Durable Object", () =>
    Effect.gen(function* () {
      const stub = controlPlane()
      const imported = yield* parseConfigYaml(YAML)
      const put = yield* Effect.promise(async () => await stub.putConfig(YAML))
      assert.isTrue(put.ok)

      if (!put.ok) return
      assert.strictEqual(put.version, 1)

      const snapshot = yield* Effect.promise(async () => await stub.getConfig())
      assert.strictEqual(snapshot.version, 1)
      const stored = yield* decodeStoredConfig(snapshot.document ?? "")
      assert.deepStrictEqual(encodeConfig(stored), encodeConfig(imported))

      // export -> import again through the DO: the same config and the same YAML
      const exported = stringifyConfigYaml(stored)
      const second = yield* Effect.promise(async () => await stub.putConfig(exported))
      assert.isTrue(second.ok)

      const again = yield* decodeStoredConfig(
        (yield* Effect.promise(async () => await stub.getConfig())).document ?? ""
      )

      assert.deepStrictEqual(encodeConfig(again), encodeConfig(imported))
      assert.strictEqual(stringifyConfigYaml(again), exported)
    })
  )

  it.effect("versions increase and unchanged versions are reported cheaply", () =>
    Effect.gen(function* () {
      const stub = controlPlane()
      yield* Effect.promise(async () => await stub.putConfig("routing: { strategy: fill-first }"))
      const second = yield* Effect.promise(async () => await stub.putConfig('{"routing":{"strategy":"round-robin"}}'))
      assert.isTrue(second.ok && second.version === 2)
      const unchanged = yield* Effect.promise(async () => await stub.getConfig(2))
      assert.isTrue(unchanged.unchanged)
      const changed = yield* Effect.promise(async () => await stub.getConfig(1))
      assert.isFalse(changed.unchanged)
      assert.strictEqual(changed.version, 2)
    })
  )

  it.effect("rejects invalid documents without changing the stored config", () =>
    Effect.gen(function* () {
      const stub = controlPlane()
      yield* Effect.promise(async () => await stub.putConfig("routing: { strategy: fill-first }"))
      const bad = yield* Effect.promise(async () => await stub.putConfig("routing: { retry: { request-retry: many } }"))
      assert.isFalse(bad.ok)

      if (bad.ok) return
      assert.strictEqual(bad.error, "invalid")
      const snapshot = yield* Effect.promise(async () => await stub.getConfig())
      assert.strictEqual(snapshot.version, 1)
      const config = yield* decodeStoredConfig(snapshot.document ?? "")
      assert.strictEqual(config.routing.strategy, "fill-first")
    })
  )

  it.effect("supports optimistic concurrency with expectedVersion", () =>
    Effect.gen(function* () {
      const stub = controlPlane()
      const first = yield* Effect.promise(async () => await stub.putConfig("{}", 0))
      assert.isTrue(first.ok)
      const stale = yield* Effect.promise(async () => await stub.putConfig("{}", 0))
      assert.isFalse(stale.ok)

      if (stale.ok) return
      assert.strictEqual(stale.error, "conflict")
      assert.strictEqual(stale.error === "conflict" ? stale.currentVersion : -1, 1)
      const fresh = yield* Effect.promise(async () => await stub.putConfig("{}", 1))
      assert.isTrue(fresh.ok && fresh.version === 2)
    })
  )

  it.effect("persists across Durable Object instances with the same name", () =>
    Effect.gen(function* () {
      const name = crypto.randomUUID()
      yield* Effect.promise(
        async () => await env.CONTROL_PLANE.getByName(name).putConfig("routing: { strategy: fill-first }")
      )
      const snapshot = yield* Effect.promise(async () => await env.CONTROL_PLANE.getByName(name).getConfig())
      assert.strictEqual(snapshot.version, 1)
    })
  )

  it.effect("ConfigReader reads through the Durable Object binding", () =>
    Effect.gen(function* () {
      // The reader always talks to getByName("global"); this is the only test that touches it.
      const global = env.CONTROL_PLANE.getByName("global")
      const put = yield* Effect.promise(async () => await global.putConfig(YAML))
      assert.isTrue(put.ok)
      const reader = yield* ConfigReader
      const snapshot = yield* reader.get.pipe(Effect.provideService(WorkerEnv, env))
      assert.strictEqual(snapshot.config.routing.strategy, "fill-first")
      assert.strictEqual(snapshot.config["api-keys"].claude[0]?.keys[0]?.weight, 2)
      assert.strictEqual(snapshot.version, put.ok ? put.version : -1)
    }).pipe(Effect.provide(ConfigReader.layerControlPlane()))
  )
})

// --- cached reader with a fake source -----------------------------------------------------------------------------

interface FakeSource {
  readonly layer: Layer.Layer<ConfigSource>
  readonly calls: Ref.Ref<ReadonlyArray<number | undefined>>
  readonly state: Ref.Ref<{ version: number; yaml: string; failing: boolean }>
}

const makeFakeSource = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<number | undefined>>([])
  const state = yield* Ref.make({ version: 1, yaml: "routing: { strategy: fill-first }", failing: false })

  const layer = Layer.succeed(
    ConfigSource,
    ConfigSource.of({
      fetch: (since) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (all) => [...all, since])
          const current = yield* Ref.get(state)

          if (current.failing) return yield* new ConfigStoreError({ message: "down" })

          if (since === current.version) {
            return { version: current.version, unchanged: true, updatedAt: 0 } satisfies ConfigSnapshotWire
          }

          const config = yield* parseConfigYaml(current.yaml).pipe(Effect.orDie)

          return {
            version: current.version,
            unchanged: false,
            document: JSON.stringify(encodeConfig(config)),
            updatedAt: 0
          } satisfies ConfigSnapshotWire
        })
    })
  )

  return { layer, calls, state } satisfies FakeSource
})

describe("ConfigReader cache", () => {
  const run = <A, E>(body: (source: FakeSource, reader: ConfigReader["Service"]) => Effect.Effect<A, E, WorkerEnv>) =>
    Effect.gen(function* () {
      const source = yield* makeFakeSource

      const reader = yield* ConfigReader.pipe(
        Effect.provide(ConfigReader.layer({ ttl: 5_000 }).pipe(Layer.provide(source.layer)))
      )

      return yield* body(source, reader).pipe(Effect.provideService(WorkerEnv, env))
    })

  it.effect("serves from cache within the TTL, then re-checks the version", () =>
    run((source, reader) =>
      Effect.gen(function* () {
        const first = yield* reader.get
        assert.strictEqual(first.config.routing.strategy, "fill-first")
        yield* TestClock.adjust(4_999)
        const cached = yield* reader.get
        assert.strictEqual(cached, first)
        assert.deepStrictEqual(yield* Ref.get(source.calls), [undefined])

        yield* TestClock.adjust(1)
        const rechecked = yield* reader.get
        assert.strictEqual(rechecked, first) // unchanged: same snapshot object, no decode
        assert.deepStrictEqual(yield* Ref.get(source.calls), [undefined, 1])

        // the TTL restarts after a successful check
        yield* TestClock.adjust(4_999)
        yield* reader.get
        assert.strictEqual((yield* Ref.get(source.calls)).length, 2)
      })
    )
  )

  it.effect("picks up a new version after the TTL", () =>
    run((source, reader) =>
      Effect.gen(function* () {
        yield* reader.get
        yield* Ref.set(source.state, { version: 2, yaml: "routing: { strategy: round-robin }", failing: false })
        const stillCached = yield* reader.get
        assert.strictEqual(stillCached.version, 1)
        yield* TestClock.adjust(5_000)
        const updated = yield* reader.get
        assert.strictEqual(updated.version, 2)
        assert.strictEqual(updated.config.routing.strategy, "round-robin")
      })
    )
  )

  it.effect("invalidate forces a re-read", () =>
    run((source, reader) =>
      Effect.gen(function* () {
        yield* reader.get
        yield* Ref.set(source.state, { version: 2, yaml: "routing: { strategy: round-robin }", failing: false })
        yield* reader.invalidate
        assert.strictEqual((yield* reader.get).version, 2)
        assert.deepStrictEqual(yield* Ref.get(source.calls), [undefined, undefined])
      })
    )
  )

  it.effect("serves the stale snapshot when the source fails, and fails when nothing is cached", () =>
    run((source, reader) =>
      Effect.gen(function* () {
        yield* Ref.update(source.state, (s) => ({ ...s, failing: true }))
        const initial = yield* reader.get.pipe(Effect.flip)
        assert.strictEqual(initial._tag, "ConfigStoreError")

        yield* Ref.update(source.state, (s) => ({ ...s, failing: false }))
        const first = yield* reader.get
        yield* Ref.update(source.state, (s) => ({ ...s, failing: true }))
        yield* TestClock.adjust(5_000)
        const stale = yield* reader.get
        assert.strictEqual(stale, first)
      })
    )
  )
})
