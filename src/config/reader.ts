/**
 * Worker-side cached reader for the config stored in the ControlPlane Durable Object.
 *
 * Each isolate keeps the last snapshot. After `ttl` it asks the Durable Object for the document with the cached
 * version, so an unchanged config costs one small RPC and no decoding. When the Durable Object is unreachable the
 * last snapshot keeps being served (stale-if-error). Per-request bindings are never captured: the DO stub is
 * resolved from `WorkerEnv` at call time.
 */
import { Clock, Context, Duration, Effect, Layer, Ref } from "effect";
import { WorkerEnv } from "../platform/env.ts";
import { ConfigStoreError } from "./errors.ts";
import type { Config } from "./schema.ts";
import { decodeStoredConfig, type ConfigSnapshotWire } from "./store.ts";

export interface ConfigSnapshot {
  readonly version: number;
  readonly config: Config;
}

/** Where config snapshots come from; the default implementation talks to the ControlPlane Durable Object. */
export class ConfigSource extends Context.Service<
  ConfigSource,
  {
    readonly fetch: (
      sinceVersion: number | undefined,
    ) => Effect.Effect<ConfigSnapshotWire, ConfigStoreError, WorkerEnv>;
  }
>()("cliproxy/config/ConfigSource") {
  static readonly controlPlane = Layer.succeed(
    ConfigSource,
    ConfigSource.of({
      fetch: (sinceVersion) =>
        Effect.gen(function* () {
          const env = yield* WorkerEnv;

          return yield* Effect.tryPromise({
            try: async () => await env.CONTROL_PLANE.getByName("global").getConfig(sinceVersion),
            catch: (cause) =>
              new ConfigStoreError({ message: "failed to read config from ControlPlane", cause }),
          });
        }),
    }),
  );
}

interface Cached {
  readonly snapshot: ConfigSnapshot;
  readonly checkedAt: number;
}

export interface ConfigReaderOptions {
  /** How long a snapshot is served before the version is re-checked (default 5 s). */
  readonly ttl?: Duration.Input;
}

export class ConfigReader extends Context.Service<
  ConfigReader,
  {
    /** The current config snapshot (cached). */
    readonly get: Effect.Effect<ConfigSnapshot, ConfigStoreError, WorkerEnv>;
    /** Drops the cached snapshot so the next `get` re-reads (use after a local write). */
    readonly invalidate: Effect.Effect<void>;
  }
>()("cliproxy/config/ConfigReader") {
  /** Requires a {@link ConfigSource}. */
  static readonly layer = (options: ConfigReaderOptions = {}) =>
    Layer.effect(ConfigReader, makeConfigReader(options));

  /** Reads through the ControlPlane Durable Object. */
  static readonly layerControlPlane = (options: ConfigReaderOptions = {}) =>
    ConfigReader.layer(options).pipe(Layer.provide(ConfigSource.controlPlane));
}

export const makeConfigReader = Effect.fnUntraced(function* (options: ConfigReaderOptions) {
  const source = yield* ConfigSource;
  const ttlMillis = Duration.toMillis(options.ttl ?? Duration.seconds(5));
  const cache = yield* Ref.make<Cached | undefined>(undefined);

  const refresh = (cached: Cached | undefined) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const wire = yield* source.fetch(cached?.snapshot.version);

      if (wire.unchanged && cached !== undefined) {
        yield* Ref.set(cache, { snapshot: cached.snapshot, checkedAt: now });

        return cached.snapshot;
      }

      if (wire.document === undefined) {
        return yield* new ConfigStoreError({ message: "ControlPlane returned no config document" });
      }

      const config = yield* decodeStoredConfig(wire.document).pipe(
        Effect.mapError(
          (cause) => new ConfigStoreError({ message: "stored config is invalid", cause }),
        ),
      );

      const snapshot: ConfigSnapshot = { version: wire.version, config };
      yield* Ref.set(cache, { snapshot, checkedAt: now });

      return snapshot;
    });

  const get = Effect.gen(function* () {
    const cached = yield* Ref.get(cache);
    const now = yield* Clock.currentTimeMillis;

    if (cached !== undefined && now - cached.checkedAt < ttlMillis) return cached.snapshot;

    return yield* refresh(cached).pipe(
      Effect.catch((error) =>
        cached === undefined
          ? Effect.fail(error)
          : Effect.logWarning(
              `config refresh failed, serving stale snapshot v${cached.snapshot.version}: ${error.message}`,
            ).pipe(Effect.as(cached.snapshot)),
      ),
    );
  });

  return ConfigReader.of({ get, invalidate: Ref.set(cache, undefined) });
});
