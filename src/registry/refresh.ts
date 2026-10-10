/**
 * Remote catalog refresh (cron): fetches the model catalogs, validates them and publishes them into KV.
 *
 * Go source: internal/registry/catalog_sources.go (`catalogUpdater`, `catalogFetcher`, `publishCatalogBytes`,
 * `readCatalogSource`), model_updater.go (`modelsURLs`, `ModelsRefreshInterval`), codex_client_models_updater.go and
 * devin_models_updater.go (URLs). Behaviour kept: sources are tried in order and the first valid one wins; an explicit
 * `models.<x>` URL replaces the defaults; an invalid or unreachable source keeps the last valid catalog; a general
 * catalog without `meta` keeps the previous `meta` section; responses are limited to 8 MiB.
 * Differences: no file-path sources and no ticker (the cron trigger runs this every 3 hours); there is no refresh
 * callback because registrations are derived on demand from the stored catalogs.
 */
import { Clock, Effect, Option } from "effect";
import { HttpClient } from "effect/http";
import { ConfigReader } from "../config/reader.ts";
import { isJsonObject, type Json } from "../json/index.ts";
import { WorkerEnv } from "../platform/env.ts";
import { detectChangedProviders, embeddedModelsDocument, parseModelsCatalog } from "./catalog.ts";
import {
  CATALOG_KEYS,
  CatalogStore,
  type CatalogName,
  type CatalogTexts,
  validateCatalogText,
} from "./catalog-store.ts";

/** `ModelsRefreshInterval`; the three-hourly cron trigger (`CRONS` in alchemy.run.ts) implements it. */
export const MODELS_REFRESH_INTERVAL_HOURS = 3;

/** `readCatalogSource` size limit (`maxCodexClientModelsSize`). */
export const MAX_CATALOG_BYTES = 8 << 20;

export const DEFAULT_CATALOG_URLS: Readonly<Record<CatalogName, ReadonlyArray<string>>> = {
  models: [
    "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
    "https://models.router-for.me/models.json",
  ],
  codexClient: [
    "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json",
    "https://models.router-for.me/codex_client_models.json",
  ],
  devin: [
    "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/devin_models.json",
    "https://models.router-for.me/devin_models.json",
  ],
};

type Source =
  | { readonly mode: "fetch"; readonly urls: ReadonlyArray<string> }
  | { readonly mode: "embed" }
  | { readonly mode: "disabled"; readonly reason?: string };

/** `models.<catalog>` config value: empty = official URLs, `embed`/`disabled` as in Go, otherwise one http(s) URL. */
export const resolveSource = (configured: string, name: CatalogName): Source => {
  const value = configured.trim();

  if (value === "") return { mode: "fetch", urls: DEFAULT_CATALOG_URLS[name] };

  if (value === "embed") return { mode: "embed" };

  if (value === "disabled") return { mode: "disabled" };

  try {
    const url = new URL(value);

    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "") {
      return { mode: "fetch", urls: [value] };
    }
  } catch {
    // Falls through to the rejection below.
  }

  return { mode: "disabled", reason: "must be an http(s) URL" };
};

export type RefreshStatus = "updated" | "unchanged" | "failed" | "skipped";

export interface RefreshOutcome {
  readonly catalog: CatalogName;
  readonly status: RefreshStatus;
  /** URL the published catalog came from. */
  readonly source?: string;
  /** Providers whose model definitions changed (general catalog only). */
  readonly changedProviders?: ReadonlyArray<string>;
  readonly message?: string;
}

const makeOutcome = (value: RefreshOutcome): RefreshOutcome => value;

const catalogConfigKey = {
  models: "catalog",
  codexClient: "codex-catalog",
  devin: "devin-catalog",
} as const;

/** First source whose body passes `validateCatalogText`. */
const fetchValid = (
  client: HttpClient.HttpClient,
  name: CatalogName,
  urls: ReadonlyArray<string>,
): Effect.Effect<{ readonly url: string; readonly text: string } | undefined> =>
  Effect.gen(function* () {
    for (const url of urls) {
      const text = yield* client.get(url).pipe(
        Effect.flatMap((response) => response.text),
        Effect.option,
      );

      if (Option.isNone(text)) continue;

      if (new TextEncoder().encode(text.value).length > MAX_CATALOG_BYTES) continue;

      if (validateCatalogText(name, text.value) === undefined) return { url, text: text.value };
    }

    return undefined;
  });

/** `publishCatalogBytes`: a catalog without `meta` keeps the previous one. Returns the text to store. */
const carryOverMeta = (text: string, previousText: string | undefined): string => {
  const next: Json = JSON.parse(text);
  const nextMeta = isJsonObject(next) ? next.meta : undefined;

  if (Array.isArray(nextMeta) && nextMeta.length > 0) return text;

  const previous: Json =
    previousText === undefined ? embeddedModelsDocument : JSON.parse(previousText);

  const previousMeta = isJsonObject(previous) ? previous.meta : undefined;

  if (!Array.isArray(previousMeta) || previousMeta.length === 0) return text;

  return JSON.stringify({ ...(isJsonObject(next) ? next : {}), meta: previousMeta });
};

const changedProvidersOf = (
  previousText: string | undefined,
  nextText: string,
): ReadonlyArray<string> => {
  const previous = parseModelsCatalog(
    previousText === undefined ? embeddedModelsDocument : JSON.parse(previousText),
  );

  const next = parseModelsCatalog(JSON.parse(nextText));

  return previous.ok && next.ok ? detectChangedProviders(previous.value, next.value) : [];
};

/**
 * One refresh round over the three catalogs. Never fails: every problem is part of the returned outcomes, and the
 * last valid catalog stays in place.
 */
export const refreshCatalogs: Effect.Effect<
  ReadonlyArray<RefreshOutcome>,
  never,
  HttpClient.HttpClient | WorkerEnv | ConfigReader | CatalogStore
> = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const store = yield* CatalogStore;
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

  const configured = yield* ConfigReader.use((reader) => reader.get).pipe(
    Effect.map((snapshot) => snapshot.config.models),
    Effect.catch((error) =>
      Effect.logWarning(
        `config unavailable for catalog refresh, using default sources: ${error.message}`,
      ).pipe(Effect.as({ catalog: "", "codex-catalog": "", "devin-catalog": "" })),
    ),
  );

  const current: CatalogTexts = yield* store.stored.pipe(Effect.catch(() => Effect.succeed({})));

  const refreshOne = (name: CatalogName): Effect.Effect<RefreshOutcome> =>
    Effect.gen(function* () {
      const source = resolveSource(configured[catalogConfigKey[name]], name);

      if (source.mode === "disabled") {
        return makeOutcome({
          catalog: name,
          status: "skipped",
          ...(source.reason === undefined
            ? {}
            : { message: `models.${catalogConfigKey[name]} ${source.reason}` }),
        });
      }

      const key = CATALOG_KEYS[name];

      if (source.mode === "embed") {
        if (current[name] === undefined || current[name] === null)
          return makeOutcome({ catalog: name, status: "unchanged" });
        yield* Effect.tryPromise(() => env.CACHE.delete(key));

        return makeOutcome({
          catalog: name,
          status: "updated",
          message: "reverted to the embedded catalog",
        });
      }

      const fetched = yield* fetchValid(client, name, source.urls);

      if (fetched === undefined) {
        yield* Effect.logWarning(
          `model catalog refresh failed for ${name}; keeping last valid catalog`,
        );

        return makeOutcome({ catalog: name, status: "failed", message: "no valid catalog source" });
      }

      const previous = current[name] ?? undefined;
      const text = name === "models" ? carryOverMeta(fetched.text, previous) : fetched.text;

      if (text === previous)
        return makeOutcome({ catalog: name, status: "unchanged", source: fetched.url });
      yield* Effect.tryPromise(() => env.CACHE.put(key, text));
      const changedProviders = name === "models" ? changedProvidersOf(previous, text) : undefined;

      return makeOutcome({
        catalog: name,
        status: "updated",
        source: fetched.url,
        ...(changedProviders === undefined ? {} : { changedProviders }),
      });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          makeOutcome({ catalog: name, status: "failed", message: "storing the catalog failed" }),
        ),
      ),
    );

  const outcomes: RefreshOutcome[] = [];

  for (const name of ["models", "codexClient", "devin"] as const)
    outcomes.push(yield* refreshOne(name));

  const now = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() =>
    env.CACHE.put(CATALOG_KEYS.status, JSON.stringify({ at: now, outcomes })),
  ).pipe(Effect.ignore);
  yield* store.invalidate;

  for (const outcome of outcomes) {
    yield* Effect.logInfo(
      `model catalog ${outcome.catalog}: ${outcome.status}` +
        (outcome.changedProviders === undefined || outcome.changedProviders.length === 0
          ? ""
          : ` (changed providers: ${outcome.changedProviders.join(", ")})`),
    );
  }

  return outcomes;
});
