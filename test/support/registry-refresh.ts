/** Fakes for catalog refresh tests: in-memory KV, scripted HTTP client, config source and an Effect runner. */
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { encodeConfig, parseConfigYaml } from "../../src/config/codec.ts"
import { ConfigReader, ConfigSource } from "../../src/config/reader.ts"
import { WorkerEnv } from "../../src/platform/env.ts"
import { CatalogStore } from "../../src/registry/catalog-store.ts"

export class FakeKv {
  readonly data = new Map<string, string>()
  readonly puts: string[] = []
  failPut = false
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }
  async put(key: string, value: string): Promise<void> {
    if (this.failPut) throw new Error("kv down")
    this.puts.push(key)
    this.data.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }
}

/** Responses by URL; unknown URLs answer 404. Records the requested URLs. */
export const fakeHttp = (responses: Record<string, string | number>, requested: string[] = []) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url)
        const reply = responses[request.url]
        const status = typeof reply === "number" ? reply : reply === undefined ? 404 : 200

        return HttpClientResponse.fromWeb(request, new Response(typeof reply === "string" ? reply : "", { status }))
      })
    )
  )

export const fakeConfig = (yaml: string) =>
  ConfigReader.layer().pipe(
    Layer.provide(
      Layer.succeed(
        ConfigSource,
        ConfigSource.of({
          fetch: () =>
            parseConfigYaml(yaml).pipe(
              Effect.orDie,
              Effect.map((config) => ({
                version: 1,
                unchanged: false,
                document: JSON.stringify(encodeConfig(config)),
                updatedAt: 0
              }))
            )
        })
      )
    )
  )

export const workerEnv = (kv: FakeKv): Layer.Layer<WorkerEnv> =>
  Layer.succeed(WorkerEnv, { CACHE: kv as unknown as KVNamespace } as unknown as Env)

export const refreshLayer = (kv: FakeKv, http: Layer.Layer<HttpClient.HttpClient>, yaml = "") =>
  Layer.mergeAll(http, fakeConfig(yaml), CatalogStore.layer, workerEnv(kv))
