/**
 * Catalogs as the Worker sees them: the copies refreshed into KV by the cron job, falling back per catalog to the
 * embedded ones.
 *
 * Go counterpart: the `modelsCatalogStore` / `codexClientCatalogStore` / `devinCatalogStore` globals that the catalog
 * updaters (internal/registry/catalog_sources.go) publish into. Here the "published" catalog is the KV entry.
 */
import { Clock, Context, Effect, Layer, Ref } from "effect";
import { WorkerEnv } from "../platform/env.ts";
import {
  embeddedCatalogs,
  type ModelCatalogs,
  parseModelsCatalog,
  validateCodexClientModels,
  withDevinBuiltins,
} from "./catalog.ts";
import { parseDevinCatalog } from "./devin.ts";

/** KV keys of the refreshed catalogs (raw JSON text) and of the last refresh report. */
export const CATALOG_KEYS = {
  models: "registry/models.json",
  codexClient: "registry/codex_client_models.json",
  devin: "registry/devin_models.json",
  status: "registry/refresh-status.json",
} as const;

export type CatalogName = "models" | "codexClient" | "devin";

/** Raw KV contents; `null`/`undefined` = nothing stored (use the embedded catalog). */
export type CatalogTexts = { readonly [N in CatalogName]?: string | null | undefined };

/** How long an isolate serves its parsed catalogs before looking at KV again. */
export const CATALOG_CACHE_TTL_MS = 60_000;

const tryParse = (
  text: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "invalid JSON" };
  }
};

/** Validates `text` as catalog `name` (the same checks the refresh applies before publishing). */
export const validateCatalogText = (name: CatalogName, text: string): string | undefined => {
  const parsed = tryParse(text);

  if (!parsed.ok) return parsed.error;

  const result =
    name === "models"
      ? parseModelsCatalog(parsed.value)
      : name === "devin"
        ? parseDevinCatalog(parsed.value)
        : validateCodexClientModels(parsed.value);

  return result.ok ? undefined : result.error;
};

/** Builds the catalogs from KV texts; invalid texts are reported in `warnings` and replaced by the embedded copy. */
export const catalogsFromTexts = (
  texts: CatalogTexts,
): { readonly catalogs: ModelCatalogs; readonly warnings: ReadonlyArray<string> } => {
  const base = embeddedCatalogs();
  const warnings: string[] = [];
  let { models, devin, codexClient } = base;

  const usable = (name: CatalogName): unknown => {
    const text = texts[name];

    if (text === undefined || text === null) return undefined;
    const parsed = tryParse(text);

    if (parsed.ok) return parsed.value;
    warnings.push(
      `stored ${name} catalog is not valid JSON, using the embedded one: ${parsed.error}`,
    );

    return undefined;
  };

  const modelsJson = usable("models");

  if (modelsJson !== undefined) {
    const parsed = parseModelsCatalog(modelsJson);

    if (parsed.ok) models = parsed.value;
    else warnings.push(`stored models catalog rejected, using the embedded one: ${parsed.error}`);
  }

  const devinJson = usable("devin");

  if (devinJson !== undefined) {
    const parsed = parseDevinCatalog(devinJson);

    if (parsed.ok) devin = withDevinBuiltins(parsed.value);
    else warnings.push(`stored devin catalog rejected, using the embedded one: ${parsed.error}`);
  }

  const codexJson = usable("codexClient");

  if (codexJson !== undefined) {
    const parsed = validateCodexClientModels(codexJson);

    if (parsed.ok) codexClient = parsed.value;
    else
      warnings.push(
        `stored codex client catalog rejected, using the embedded one: ${parsed.error}`,
      );
  }

  return { catalogs: { models, devin, codexClient }, warnings };
};

export const readCatalogTexts = async (kv: KVNamespace): Promise<CatalogTexts> => {
  const [models, codexClient, devin] = await Promise.all([
    kv.get(CATALOG_KEYS.models),
    kv.get(CATALOG_KEYS.codexClient),
    kv.get(CATALOG_KEYS.devin),
  ]);

  return { models, codexClient, devin };
};

const sameTexts = (a: CatalogTexts, b: CatalogTexts): boolean =>
  a.models === b.models && a.codexClient === b.codexClient && a.devin === b.devin;

interface Cached {
  readonly loadedAt: number;
  readonly texts: CatalogTexts;
  readonly catalogs: ModelCatalogs;
}

export class CatalogStore extends Context.Service<
  CatalogStore,
  {
    /** The active catalogs (cached per isolate, re-read from KV every minute). Never fails: KV errors keep the last value. */
    readonly load: Effect.Effect<ModelCatalogs, never, WorkerEnv>;
    /** Raw stored texts (for the refresh job, which compares against and replaces them). */
    readonly stored: Effect.Effect<CatalogTexts, Error, WorkerEnv>;
    /** Drops the isolate cache (after a refresh wrote new texts). */
    readonly invalidate: Effect.Effect<void>;
  }
>()("cliproxy/registry/CatalogStore") {
  static readonly layer = Layer.effect(
    CatalogStore,
    Effect.gen(function* () {
      const cache = yield* Ref.make<Cached | undefined>(undefined);

      const stored = Effect.gen(function* () {
        const env = yield* WorkerEnv;

        return yield* Effect.tryPromise({
          try: () => readCatalogTexts(env.CACHE),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("failed to read catalogs from KV"),
        });
      });

      const load = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cache);

        if (cached !== undefined && now - cached.loadedAt < CATALOG_CACHE_TTL_MS)
          return cached.catalogs;
        const texts = yield* stored.pipe(Effect.result);

        if (texts._tag === "Failure") {
          yield* Effect.logWarning(
            `catalog KV read failed, keeping the previous catalogs: ${texts.failure.message}`,
          );
          const fallback = cached?.catalogs ?? embeddedCatalogs();
          yield* Ref.set(cache, { loadedAt: now, texts: cached?.texts ?? {}, catalogs: fallback });

          return fallback;
        }

        if (cached !== undefined && sameTexts(cached.texts, texts.success)) {
          yield* Ref.set(cache, { ...cached, loadedAt: now });

          return cached.catalogs;
        }

        const built = catalogsFromTexts(texts.success);

        for (const warning of built.warnings) yield* Effect.logWarning(warning);
        yield* Ref.set(cache, { loadedAt: now, texts: texts.success, catalogs: built.catalogs });

        return built.catalogs;
      });

      return CatalogStore.of({ load, stored, invalidate: Ref.set(cache, undefined) });
    }),
  );
}
