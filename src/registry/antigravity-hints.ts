/**
 * Per-credential Antigravity model entitlements (`fetchAvailableModels`) applied to the static catalog.
 *
 * Go source: sdk/cliproxy/antigravity_models.go (`filterAntigravityModels`, `applyAntigravityFetchedModelCapabilities`,
 * `parseAntigravityModelCapabilityHints`). The cron task (`executor/antigravity/models.ts`) stores the probe result in KV;
 * the registry snapshot attaches it to the credential's `ModelSource`.
 */
import type { ModelInfo } from "./model-info.ts"

export interface AntigravityModelHints {
  /** Entitled model ids (lower-cased); `undefined` for legacy replies without `models` (never revokes a model). */
  readonly modelIds?: ReadonlyArray<string>
  /** `webSearchModelIds` (lower-cased): these models get `supportsWebSearch`. */
  readonly webSearchModelIds: ReadonlyArray<string>
}

/** `normalizeAntigravityFetchedModelID`. */
export const normalizeFetchedModelId = (modelId: string): string => modelId.trim().toLowerCase()

/** The static list intersected with the entitlements, with web-search capability from the probe. */
export const applyAntigravityHints = (models: ModelInfo[], hints: AntigravityModelHints | undefined): ModelInfo[] => {
  if (hints === undefined) return models
  const entitled = hints.modelIds === undefined ? undefined : new Set(hints.modelIds)
  const webSearch = new Set(hints.webSearchModelIds)
  const out: ModelInfo[] = []

  for (const model of models) {
    const id = normalizeFetchedModelId(model.id)

    if (entitled !== undefined && !entitled.has(id)) continue
    out.push(webSearch.has(id) ? { ...model, supportsWebSearch: true } : model)
  }

  return out
}
