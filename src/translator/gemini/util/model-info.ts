/**
 * Model capability lookups needed by translators (Go `registry.LookupModelInfo`). Translators are pure functions, so
 * only the embedded static catalog is consulted (the live registry snapshot is not reachable from here).
 */
import { embeddedCatalogs, lookupStaticModelInfo, lookupStaticModelInfoByChannel } from "../../../registry/catalog.ts"
import type { ModelInfo } from "../../../registry/model-info.ts"

/** Static `LookupModelInfo(model, provider)`: the provider's catalog section first, then every section. */
export const lookupModelInfo = (model: string, provider: string): ModelInfo | undefined => {
  const catalogs = embeddedCatalogs()
  return lookupStaticModelInfoByChannel(catalogs, model, provider) ?? lookupStaticModelInfo(catalogs, model)
}
