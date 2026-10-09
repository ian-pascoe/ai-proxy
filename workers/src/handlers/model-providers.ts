/**
 * Model -> provider lookup used by model resolution.
 *
 * Go source: internal/registry/model_registry.go (GetModelProviders, GetFirstAvailableModel). The model registry
 * slice replaces the config-backed implementation below with the full catalog (static models, OAuth credentials,
 * availability/quota state); the service interface stays the same.
 */
import { Context, Effect, Layer } from "effect"
import { ConfigReader } from "../config/reader.ts"
import { configCredentials } from "../executor/config-credentials.ts"
import { ExecutionError } from "../executor/errors.ts"
import type { WorkerEnv } from "../platform/env.ts"
import { ModelRegistry } from "../registry/service.ts"

export class ModelProviders extends Context.Service<
  ModelProviders,
  {
    /** Providers able to serve exactly this model id, in preference order (Go `GetModelProviders`). */
    readonly providersFor: (model: string) => Effect.Effect<ReadonlyArray<string>, ExecutionError, WorkerEnv>
    /** First available model of any provider (Go `GetFirstAvailableModel("")`), used for `auto`. */
    readonly firstAvailableModel: Effect.Effect<string | undefined, ExecutionError, WorkerEnv>
  }
>()("cliproxy/handlers/ModelProviders") {
  /**
   * The model registry: every credential's catalog (prefixes, aliases, exclusions, cooling state) as of the current
   * snapshot (requires `ModelRegistry`).
   */
  static readonly registryLayer = Layer.effect(
    ModelProviders,
    Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const snapshot = registry.snapshot.pipe(
        Effect.mapError((cause) => new ExecutionError({ status: 503, message: "model registry unavailable", cause }))
      )
      return ModelProviders.of({
        providersFor: (model) => Effect.map(snapshot, (current) => current.providersForModel(model)),
        firstAvailableModel: Effect.map(snapshot, (current) => current.firstAvailableModel())
      })
    })
  )

  /** Models declared under `api-keys.openai-compatibility` (requires `ConfigReader`); tests without a registry. */
  static readonly configLayer = Layer.effect(
    ModelProviders,
    Effect.gen(function* () {
      const reader = yield* ConfigReader
      const index = reader.get.pipe(
        Effect.mapError((cause) => new ExecutionError({ status: 503, message: "config unavailable", cause })),
        Effect.map(({ config }) => {
          const byModel = new Map<string, string[]>()
          for (const entry of configCredentials(config)) {
            for (const model of entry.models) {
              const providers = byModel.get(model) ?? []
              if (!providers.includes(entry.credential.provider)) providers.push(entry.credential.provider)
              byModel.set(model, providers)
            }
          }
          return byModel
        })
      )
      return ModelProviders.of({
        providersFor: (model) => Effect.map(index, (byModel) => byModel.get(model) ?? []),
        firstAvailableModel: Effect.map(index, (byModel) => byModel.keys().next().value)
      })
    })
  )
}
