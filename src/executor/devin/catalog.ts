/**
 * Devin catalog lookups for model UID resolution.
 *
 * Go source: internal/registry/devin_models.go (`LookupDevinModel`: active catalog, then built-ins). The Workers port
 * reads the embedded catalog (`registry/catalog/devin_models.json`); the cron-refreshed KV copy reaches executors
 * through `ExecutorRequest.modelLookup` where wired.
 */
import { devinModels, embeddedCatalogs } from "../../registry/catalog.ts"

interface CatalogEntry {
  readonly levels: ReadonlyArray<string>
  readonly maxCompletionTokens: number
}

let entries: ReadonlyMap<string, CatalogEntry> | undefined

const bareId = (modelId: string): string =>
  modelId
    .trim()
    .toLowerCase()
    .replace(/^devin\//, "")

const catalog = (): ReadonlyMap<string, CatalogEntry> => {
  if (entries === undefined) {
    const map = new Map<string, CatalogEntry>()

    for (const model of devinModels(embeddedCatalogs())) {
      map.set(bareId(model.id), {
        levels: model.thinking?.levels ?? [],
        maxCompletionTokens: model.maxCompletionTokens ?? 0
      })
    }

    entries = map
  }

  return entries
}

/** `registry.LookupDevinModel(id).Thinking.Levels` (`undefined` = not in the catalog). */
export const devinLevelLookup = (modelId: string): ReadonlyArray<string> | undefined =>
  catalog().get(bareId(modelId))?.levels

/** `registry.LookupModelInfo(model, "devin").MaxCompletionTokens` from the embedded catalog (0 = unknown). */
export const devinMaxCompletionTokens = (modelId: string): number =>
  catalog().get(bareId(modelId))?.maxCompletionTokens ?? 0
