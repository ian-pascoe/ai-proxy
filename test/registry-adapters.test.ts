// Adapters between the pipeline services and the model registry snapshot.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ExecutionError } from "../src/executor/errors.ts"
import { ModelCapabilities } from "../src/handlers/model-capabilities.ts"
import { ModelProviders } from "../src/handlers/model-providers.ts"
import { WorkerEnv } from "../src/platform/env.ts"
import { embeddedCatalogs } from "../src/registry/catalog.ts"
import { buildSnapshot, ModelRegistry, ModelRegistryError } from "../src/registry/service.ts"
import { configOf, source } from "./support/registry-sources.ts"

const snapshot = (yaml = "") =>
  buildSnapshot({
    sources: [source("claude-a.json", "claude"), source("codex-a.json", "codex", { planType: "pro" })],
    config: configOf(yaml),
    catalogs: embeddedCatalogs(),
    now: 1_800_000_000_000
  })

const registryLayer = (yaml = "") =>
  Layer.succeed(ModelRegistry, ModelRegistry.of({ snapshot: Effect.succeed(snapshot(yaml)) }))

const failingRegistry = Layer.succeed(
  ModelRegistry,
  ModelRegistry.of({ snapshot: Effect.fail(new ModelRegistryError({ message: "no control plane" })) })
)

const env = Layer.succeed(WorkerEnv, {} as Env)

describe("ModelProviders.registryLayer", () => {
  it.effect("resolves providers and the auto model from the registry snapshot", () =>
    Effect.gen(function* () {
      const models = yield* ModelProviders
      assert.deepStrictEqual(yield* models.providersFor("claude-sonnet-4-5-20250929"), ["claude"])
      assert.deepStrictEqual(yield* models.providersFor("CLAUDE-SONNET-4-5-20250929"), ["claude"])
      assert.deepStrictEqual(yield* models.providersFor("no-such-model"), [])
      assert.isDefined(yield* models.firstAvailableModel)
    }).pipe(Effect.provide(ModelProviders.registryLayer), Effect.provide(registryLayer()), Effect.provide(env))
  )

  it.effect("a registry failure becomes a 503", () =>
    Effect.gen(function* () {
      const models = yield* ModelProviders
      const error = yield* Effect.flip(models.providersFor("x"))
      assert.instanceOf(error, ExecutionError)
      assert.strictEqual(error.status, 503)
    }).pipe(Effect.provide(ModelProviders.registryLayer), Effect.provide(failingRegistry), Effect.provide(env))
  )
})

describe("ModelCapabilities.registryLayer", () => {
  const credential = (id: string, provider: string) => ({
    id,
    provider,
    kind: "oauth" as const,
    attributes: {},
    metadata: {}
  })

  it.effect("resolves the model definition of the credential and hands out the registry lookup", () =>
    Effect.gen(function* () {
      const capabilities = yield* ModelCapabilities
      const claude = yield* capabilities.thinking("claude-sonnet-4-5-20250929", credential("claude-a.json", "claude"))
      assert.strictEqual(claude.modelInfo?.id, "claude-sonnet-4-5-20250929")
      assert.isDefined(claude.modelInfo?.thinking)
      assert.isDefined(claude.lookup)
      assert.strictEqual(claude.lookup?.("claude-sonnet-4-5-20250929", "claude")?.id, "claude-sonnet-4-5-20250929")
    }).pipe(Effect.provide(ModelCapabilities.registryLayer), Effect.provide(registryLayer()), Effect.provide(env))
  )

  it.effect("falls back to the catalog lookup for credentials the registry does not know, and to unknown", () =>
    Effect.gen(function* () {
      const capabilities = yield* ModelCapabilities
      const stranger = yield* capabilities.thinking(
        "claude-sonnet-4-5-20250929",
        credential("claude-gone.json", "claude")
      )
      assert.strictEqual(stranger.modelInfo?.id, "claude-sonnet-4-5-20250929")
      const unknown = yield* capabilities.thinking("no-such-model", credential("claude-a.json", "claude"))
      assert.isUndefined(unknown.modelInfo)
    }).pipe(Effect.provide(ModelCapabilities.registryLayer), Effect.provide(registryLayer()), Effect.provide(env))
  )

  it.effect("a registry failure degrades to unknown capabilities (no validation)", () =>
    Effect.gen(function* () {
      const capabilities = yield* ModelCapabilities
      const resolved = yield* capabilities.thinking("m", credential("claude-a.json", "claude"))
      assert.deepStrictEqual(resolved, { modelInfo: undefined, lookup: undefined })
    }).pipe(Effect.provide(ModelCapabilities.registryLayer), Effect.provide(failingRegistry), Effect.provide(env))
  )
})
