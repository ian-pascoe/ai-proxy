/**
 * Model resolution for an inbound request: `(suffix)` parsing, `auto`, endpoint-specific model guards and provider
 * lookup.
 *
 * Go source: sdk/api/handlers/handlers_routing.go (getRequestDetailsWithOptions, validateImageOnlyModel,
 * validateSpeechOnlyModel, adjustExecutionProvidersForEntryProtocol), internal/util/provider.go (GetProviderName,
 * ResolveAutoModel). The thinking suffix stays inside the model string all the way to the executor.
 */
import { Effect } from "effect";
import { ExecutionError } from "../executor/errors.ts";
import { parseSuffix } from "../executor/suffix.ts";
import { goMarshal } from "../http/json-text.ts";
import { ModelProviders } from "./model-providers.ts";

export interface ResolvedModel {
  readonly providers: ReadonlyArray<string>;
  /** Route model (`auto` replaced), suffix kept. */
  readonly model: string;
}

export interface ResolveOptions {
  readonly allowImageModel?: boolean;
  readonly allowSpeechModel?: boolean;
  /** Entry protocol, for provider ordering. */
  readonly entryProtocol?: string;
}

const IMAGE_ONLY_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-image-2.0",
]);

const SPEECH_ONLY_MODELS = new Set(["grok-tts", "grok-voice-tts-1.0"]);

const NATIVE_ENTRY_PROTOCOLS = new Set([
  "interactions",
  "openai",
  "openai-response",
  "claude",
  "gemini",
]);

const GEMINI_INTERACTIONS = "gemini-interactions";

/** `routeModelBaseName`: text after the last `/`. */
export const routeModelBaseName = (model: string): string => {
  const trimmed = model.trim();
  const index = trimmed.lastIndexOf("/");

  return index >= 0 && index < trimmed.length - 1 ? trimmed.slice(index + 1).trim() : trimmed;
};

const isInteractions = (provider: string) => provider.trim().toLowerCase() === GEMINI_INTERACTIONS;

/** `adjustExecutionProvidersForEntryProtocol`. */
export const adjustProvidersForEntryProtocol = (
  providers: ReadonlyArray<string>,
  entryProtocol: string | undefined,
): ReadonlyArray<string> => {
  if (entryProtocol === undefined) return providers;
  const entry = entryProtocol.trim().toLowerCase();

  if (entry === "interactions") {
    return [
      ...providers.filter(isInteractions),
      ...providers.filter((provider) => !isInteractions(provider)),
    ];
  }

  if (!NATIVE_ENTRY_PROTOCOLS.has(entry))
    return providers.filter((provider) => !isInteractions(provider));

  return providers;
};

/** Body of the 400 answer for unroutable models (already JSON; OpenAI handlers pass it through). */
export const unknownModelBody = (model: string): string =>
  goMarshal({
    error: {
      message: `unknown provider for model ${model}`,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    },
  });

export const resolveModel = Effect.fnUntraced(function* (
  modelName: string,
  options: ResolveOptions = {},
) {
  const models = yield* ModelProviders;
  const initial = parseSuffix(modelName);
  let resolved = modelName;

  if (initial.modelName === "auto") {
    const first = yield* models.firstAvailableModel;

    if (first === undefined) {
      yield* Effect.logWarning("failed to resolve 'auto' model: no model available");
    } else {
      resolved = initial.hasSuffix ? `${first}(${initial.rawSuffix})` : first;
    }
  }

  const baseModel = parseSuffix(resolved).modelName.trim();
  const guardName = routeModelBaseName(baseModel === "" ? resolved : baseModel);

  if (IMAGE_ONLY_MODELS.has(guardName.toLowerCase()) && options.allowImageModel !== true) {
    return yield* new ExecutionError({
      status: 503,
      message: `model ${guardName} is only supported on /v1/images/generations and /v1/images/edits`,
      requestScoped: true,
    });
  }

  if (SPEECH_ONLY_MODELS.has(guardName.toLowerCase()) && options.allowSpeechModel !== true) {
    return yield* new ExecutionError({
      status: 400,
      message: `model ${guardName} is only supported on /v1/audio/speech and /v1/tts`,
      requestScoped: true,
    });
  }

  const lookup = (model: string) =>
    Effect.gen(function* () {
      if (model === "") return [] as ReadonlyArray<string>;
      const exact = yield* models.providersFor(model);

      if (exact.length > 0 || model.toLowerCase() === model) return exact;

      return yield* models.providersFor(model.toLowerCase());
    });

  let providers = yield* lookup(baseModel);

  // Custom models may be registered with their suffixed name, e.g. `my-model(8192)`.
  if (providers.length === 0 && baseModel !== resolved) providers = yield* lookup(resolved);

  if (providers.length === 0) {
    return yield* new ExecutionError({
      status: 400,
      code: "model_not_found",
      message: unknownModelBody(modelName),
      requestScoped: true,
    });
  }

  return {
    providers: adjustProvidersForEntryProtocol([...new Set(providers)], options.entryProtocol),
    model: resolved,
  } satisfies ResolvedModel;
});
