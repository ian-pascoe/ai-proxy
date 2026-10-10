// JWKS cache for Cloudflare Access (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`).
// New in the Workers port. Keys are cached per isolate (the layer lives as long as the web handler) and refreshed
// when an unknown `kid` shows up, at most once per cooldown so bogus `kid`s cannot trigger a fetch per request.
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { importJWK } from "jose";
import type { JWK } from "jose";
import { isJsonArray, isJsonObject } from "../json/index.ts";

/** Keys are considered fresh for this long (same default as jose's `createRemoteJWKSet`). */
export const JWKS_MAX_AGE_MS = 600_000;

/** Minimum delay between two refresh attempts for one JWKS URL once keys are cached. */
export const JWKS_REFRESH_COOLDOWN_MS = 30_000;

/** The JWKS endpoint could not be fetched or parsed and no cached key can serve the request. */
export class JwksFetchError extends Schema.TaggedError<JwksFetchError>()("JwksFetchError", {
  message: Schema.String,
}) {}

/** The JWKS has no key with the requested `kid`. */
export class UnknownKeyError extends Schema.TaggedError<UnknownKeyError>()("UnknownKeyError", {
  message: Schema.String,
}) {}

export class AccessJwks extends Context.Service<
  AccessJwks,
  {
    readonly getKey: (
      jwksUrl: string,
      kid: string,
    ) => Effect.Effect<CryptoKey, JwksFetchError | UnknownKeyError>;
  }
>()("cliproxy/access/AccessJwks") {
  static readonly layer = Layer.effect(
    AccessJwks,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      return AccessJwks.of(makeJwksCache(client));
    }),
  );

  /** Production layer: JWKS fetched with the global `fetch`. */
  static readonly layerLive = AccessJwks.layer.pipe(Layer.provide(FetchHttpClient.layer));
}

interface CacheEntry {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly fetchedAt: number;
  readonly attemptedAt: number;
}

const importKeys = async (body: Schema.Json): Promise<ReadonlyMap<string, CryptoKey>> => {
  const list = isJsonObject(body) ? body["keys"] : undefined;

  if (!isJsonArray(list)) throw new Error("JWKS document has no keys array");
  const keys = new Map<string, CryptoKey>();

  // SAFETY: each entry is only used after the kty/kid checks below and importJWK validates the remaining fields.
  for (const candidate of list as ReadonlyArray<JWK>) {
    if (candidate?.kty !== "RSA" || typeof candidate.kid !== "string") continue;

    try {
      const key = await importJWK(candidate, "RS256");

      if (key instanceof Uint8Array) continue;
      keys.set(candidate.kid, key);
    } catch {
      // Skip keys that cannot be imported; the remaining keys stay usable.
    }
  }

  return keys;
};

const makeJwksCache = (httpClient: HttpClient.HttpClient) => {
  const client = HttpClient.filterStatusOk(httpClient);
  const cache = new Map<string, CacheEntry>();

  const fetchKeys = (url: string) =>
    client.get(url).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap((body) => Effect.tryPromise(() => importKeys(body))),
      Effect.mapError(() => new JwksFetchError({ message: "Unable to fetch Access signing keys" })),
    );

  const unknownKey = new UnknownKeyError({ message: "Unknown signing key" });

  const getKey = (
    url: string,
    kid: string,
  ): Effect.Effect<CryptoKey, JwksFetchError | UnknownKeyError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const entry = cache.get(url);
      const cached = entry?.keys.get(kid);

      if (entry !== undefined) {
        if (cached !== undefined && now - entry.fetchedAt < JWKS_MAX_AGE_MS) return cached;

        // Within the cooldown serve whatever is cached; an unknown kid is then a plain rejection.
        if (now - entry.attemptedAt < JWKS_REFRESH_COOLDOWN_MS) {
          return cached ?? (yield* unknownKey);
        }

        // Mark the attempt before fetching so concurrent requests do not stampede the endpoint.
        cache.set(url, { ...entry, attemptedAt: now });
      }

      const refreshed = yield* fetchKeys(url).pipe(Effect.result);

      if (Result.isFailure(refreshed)) {
        // Keep serving a stale key when the endpoint is down.
        return cached ?? (yield* refreshed.failure);
      }

      cache.set(url, { keys: refreshed.success, fetchedAt: now, attemptedAt: now });

      return refreshed.success.get(kid) ?? (yield* unknownKey);
    });

  return { getKey };
};
