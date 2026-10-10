/**
 * Thinking hook point for executors and the translator registry.
 *
 * Go source: internal/runtime/executor/helps/model_capabilities.go (ApplyRequestThinking),
 * internal/runtime/executor/helps/thinking.go (translatedRequestSummaryConfig), internal/thinking/apply.go
 * (ApplyThinking), internal/thinking/summary.go (ExtractTranslatedSummaryConfig, ApplySummaryConfigForModel).
 * Executors call `apply` after request translation and the upstream model rewrite, before provider shaping and payload
 * rules. {@link Thinking.live} runs the real pipeline (parse suffix -> canonical config -> validate -> provider
 * applier); {@link Thinking.noop} passes bodies through (tests that do not care about thinking).
 */
import { Context, Effect, Layer, Predicate } from "effect";
import { type Json, cloneJson } from "../json/index.ts";
import type { Format } from "../translator/formats.ts";
import { noopSummaryHooks, type SummaryHooks, TranslatorRegistry } from "../translator/registry.ts";
import { builtinTranslators } from "../translator/builtin.ts";
import {
  applySummaryConfigForModel,
  applyThinking,
  extractExplicitSummaryConfig,
  extractSummaryConfig,
  extractTranslatedSummaryConfig,
  type SummaryConfig,
  type ModelInfoLookup,
  type ThinkingModelInfo,
  UNSPECIFIED_SUMMARY,
} from "../thinking/index.ts";
import { ExecutionError } from "./errors.ts";

export interface ThinkingRequest {
  /** Translated (provider-format) body; implementations may mutate and return it. */
  readonly body: Json;
  /** Model the client asked for after credential resolution, `(suffix)` kept (Go `req.Model`). */
  readonly model: string;
  /** Client format (Go `from`). */
  readonly from: Format;
  /** Provider format (Go `to`). */
  readonly to: Format;
  /** Registry/provider key used for model capability lookup (executor identifier, e.g. `openai-compatible-x`). */
  readonly provider: string;
  /** The client body of this attempt (source config, Responses `configuration_update` items). */
  readonly source?: Json;
  /** The client's original body (defaults to `source`); the baseline for the reasoning-summary intent. */
  readonly originalSource?: Json;
  /** Whether request translation changed Responses `configuration_update` items. */
  readonly configurationUpdatesChanged?: boolean;
  /**
   * Credential-resolved model capabilities (API-key models may override the registry), `null` = resolved but unknown.
   * Without it the model is treated as unknown (user-defined, no validation).
   */
  readonly modelInfo?: ThinkingModelInfo | null | undefined;
  /** `registry.LookupModelInfo` for everything but `modelInfo` (summary visibility, cross-model rules). */
  readonly lookupModelInfo?: ModelInfoLookup | undefined;
}

const lowerFormat = (format: string): string => format.trim().toLowerCase();

/** `translatedRequestSummaryConfig`: where the reasoning-summary intent comes from after translation. */
const translatedSummaryConfig = (
  translators: TranslatorRegistry,
  request: ThinkingRequest,
  source: Json | undefined,
  originalSource: Json | undefined,
): SummaryConfig => {
  const from = lowerFormat(request.from);
  const to = lowerFormat(request.to);

  const target =
    from === to
      ? extractSummaryConfig(request.body, to)
      : extractExplicitSummaryConfig(request.body, to);

  if (target.mode !== "unspecified") return target;

  const current = extractTranslatedSummaryConfig(source, from, to);
  const original = extractTranslatedSummaryConfig(originalSource, from, to);

  if (current.mode === "unspecified") return original;

  if (!translators.hasRequestTransformer(request.from, request.to)) return UNSPECIFIED_SUMMARY;

  const candidate = applySummaryConfigForModel(cloneJson(request.body), to, request.model, current);

  if (extractExplicitSummaryConfig(candidate, to).mode !== "unspecified")
    return UNSPECIFIED_SUMMARY;

  return current;
};

const isSummaryConfig = (value: unknown): value is SummaryConfig =>
  Predicate.hasProperty(value, "mode") && Predicate.hasProperty(value, "detail");

/** Summary hooks run by the translator registry around request transforms (`sdk/translator/registry.go`). */
export const summaryHooks: SummaryHooks = {
  extract: (body, client, provider) => extractTranslatedSummaryConfig(body, client, provider),
  apply: (body, provider, model, summary) =>
    applySummaryConfigForModel(
      body,
      provider,
      model,
      isSummaryConfig(summary) ? summary : UNSPECIFIED_SUMMARY,
    ) ?? body,
};

export class Thinking extends Context.Service<
  Thinking,
  {
    /** Applies the thinking configuration; fails with a request-scoped 400 `ExecutionError` on invalid configs. */
    readonly apply: (request: ThinkingRequest) => Effect.Effect<Json, ExecutionError>;
    /** Reasoning-summary hooks applied by the translator registry around request transforms. */
    readonly summary: SummaryHooks;
  }
>()("cliproxy/executor/Thinking") {
  /** Passthrough implementation (tests that do not exercise thinking). */
  static readonly noop = Layer.succeed(
    Thinking,
    Thinking.of({ apply: (request) => Effect.succeed(request.body), summary: noopSummaryHooks }),
  );

  /** The real pipeline (`src/thinking`). */
  static readonly live = Layer.sync(Thinking, () => makeLiveThinking(builtinTranslators));
}

/** Builds the real thinking service over a translator registry (used to decide whether a transform exists). */
export function makeLiveThinking(translators: TranslatorRegistry) {
  return Thinking.of({
    summary: summaryHooks,
    apply: (request) => {
      const source = request.source ?? request.originalSource;
      const originalSource = request.originalSource ?? source;

      const result = applyThinking(request.body, {
        model: request.model,
        fromFormat: request.from,
        toFormat: request.to,
        providerKey: request.provider,
        sourceBody: source,
        summaryConfig: translatedSummaryConfig(translators, request, source, originalSource),
        ...(request.configurationUpdatesChanged === true ? { normalizedUpdatesChanged: true } : {}),
        ...(request.modelInfo === undefined ? {} : { modelInfo: request.modelInfo }),
        ...(request.lookupModelInfo === undefined
          ? {}
          : { lookupModelInfo: request.lookupModelInfo }),
      });

      if (result.error !== undefined) {
        return Effect.fail(
          new ExecutionError({
            status: result.error.statusCode,
            message: result.error.message,
            requestScoped: true,
          }),
        );
      }

      return Effect.succeed(result.body ?? request.body);
    },
  });
}
