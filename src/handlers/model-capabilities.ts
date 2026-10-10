/**
 * Model capability lookup for the thinking pipeline (`registry.LookupModelInfo`).
 *
 * Go source: sdk/cliproxy/service_models.go (buildOpenAICompatibilityConfigModels, buildConfiguredModelInfo),
 * internal/modelconfig/model_info.go (NormalizeThinkingSupport), sdk/cliproxy/auth/conductor_models.go
 * (attachResolvedExecutionModelInfo). The conductor resolves the capabilities of the model of one attempt and hands
 * them to the executor (`ExecutorRequest.modelInfo`, `modelLookup`). Production uses the model registry snapshot;
 * `configLayer` (models declared under `api-keys.openai-compatibility`) serves tests without a registry.
 */
import { Context, Effect, Layer } from "effect";
import { ConfigReader } from "../config/reader.ts";
import type { ModelEntry } from "../config/schema.ts";
import { resolveCompatConfig } from "../executor/models.ts";
import type { CredentialSnapshot } from "../executor/picker.ts";
import { parseSuffix } from "../executor/suffix.ts";
import type { WorkerEnv } from "../platform/env.ts";
import { ModelRegistry } from "../registry/service.ts";
import type {
  ModelInfoLookup,
  ModelThinkingSupport,
  ThinkingModelInfo,
} from "../thinking/index.ts";

/** What the thinking pipeline needs to know about the model of one attempt. */
export interface ThinkingResolution {
  /** The exact definition served by the credential (API-key models can override the catalogue); `undefined` = unknown. */
  readonly modelInfo: ThinkingModelInfo | undefined;
  /** Registry lookup for everything else (`registry.LookupModelInfo`). */
  readonly lookup: ModelInfoLookup | undefined;
}

export class ModelCapabilities extends Context.Service<
  ModelCapabilities,
  {
    /** Capabilities of `model` (suffix already stripped) as served by this credential. */
    readonly thinking: (
      model: string,
      credential: CredentialSnapshot,
    ) => Effect.Effect<ThinkingResolution, never, WorkerEnv>;
  }
>()("cliproxy/handlers/ModelCapabilities") {
  /**
   * The model registry snapshot (requires `ModelRegistry`): the credential's own registration first (prefix/alias
   * aware, config `models` included), then the static catalogs; the snapshot's lookup is handed to the pipeline.
   */
  static readonly registryLayer = Layer.effect(
    ModelCapabilities,
    Effect.gen(function* () {
      const registry = yield* ModelRegistry;

      return ModelCapabilities.of({
        thinking: (model, credential) =>
          registry.snapshot.pipe(
            Effect.map((snapshot): ThinkingResolution => {
              const wanted = model.trim().toLowerCase();

              const own = snapshot
                .modelsForCredential(credential.id)
                .find(
                  (info) =>
                    info.id.toLowerCase() === wanted ||
                    (info.metadataModelId ?? "").trim().toLowerCase() === wanted,
                );

              return {
                modelInfo: own ?? snapshot.lookupModelInfo(model, credential.provider),
                lookup: snapshot.lookupModelInfo,
              };
            }),
            Effect.orElseSucceed((): ThinkingResolution => ({
              modelInfo: undefined,
              lookup: undefined,
            })),
          ),
      });
    }),
  );

  /** Capabilities of the models declared in config (requires `ConfigReader`); tests without a registry. */
  static readonly configLayer = Layer.effect(
    ModelCapabilities,
    Effect.gen(function* () {
      const reader = yield* ConfigReader;

      return ModelCapabilities.of({
        thinking: (model, credential) =>
          reader.get.pipe(
            Effect.map(({ config }): ThinkingResolution => {
              const group = resolveCompatConfig(config, credential);

              return {
                modelInfo:
                  group === undefined ? undefined : compatModelInfo(group.models ?? [], model),
                lookup: undefined,
              };
            }),
            Effect.orElseSucceed((): ThinkingResolution => ({
              modelInfo: undefined,
              lookup: undefined,
            })),
          ),
      });
    }),
  );

  /** Every model is unknown. */
  static readonly none = Layer.succeed(
    ModelCapabilities,
    ModelCapabilities.of({
      thinking: () => Effect.succeed({ modelInfo: undefined, lookup: undefined }),
    }),
  );
}

/** `NormalizeThinkingSupport`: lower-cased unique levels; `none` allows zero, `auto` allows dynamic budgets. */
const normalizeSupport = (raw: NonNullable<ModelEntry["thinking"]>): ModelThinkingSupport => {
  let zeroAllowed = raw["zero-allowed"];
  let dynamicAllowed = raw["dynamic-allowed"];
  const levels: string[] = [];

  for (const value of raw.levels ?? []) {
    const level = value.trim().toLowerCase();

    if (level === "") continue;

    if (level === "none") zeroAllowed = true;

    if (level === "auto") dynamicAllowed = true;

    if (!levels.includes(level)) levels.push(level);
  }

  return {
    ...(raw.min === undefined ? {} : { min: raw.min }),
    ...(raw.max === undefined ? {} : { max: raw.max }),
    ...(zeroAllowed === undefined ? {} : { zeroAllowed }),
    ...(dynamicAllowed === undefined ? {} : { dynamicAllowed }),
    levels,
  };
};

/** The configured entry whose alias (or name when it has none) equals `model`, as `ModelInfo`. */
export const compatModelInfo = (
  models: ReadonlyArray<ModelEntry>,
  model: string,
): ThinkingModelInfo | undefined => {
  const wanted = parseSuffix(model.trim()).modelName.toLowerCase();

  if (wanted === "") return undefined;

  for (const entry of models) {
    const name = entry.name.trim();
    const alias = (entry.alias ?? "").trim();
    const id = alias === "" ? name : alias;

    if (id === "" || (id.toLowerCase() !== wanted && name.toLowerCase() !== wanted)) continue;
    const image = entry.image === true;

    // Models without explicit thinking support default to the three OpenAI effort levels (images: none).
    const thinking =
      entry.thinking === undefined
        ? image
          ? undefined
          : { levels: ["low", "medium", "high"] }
        : normalizeSupport(entry.thinking);

    return {
      id,
      type: image ? "openai-image" : "openai-compatibility",
      userDefined: false,
      ...(thinking === undefined ? {} : { thinking }),
    };
  }

  return undefined;
};
