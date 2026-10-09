/**
 * Thinking hook point for executors and the translator registry.
 *
 * Go source: internal/runtime/executor/helps/model_capabilities.go (ApplyRequestThinking), internal/thinking/apply.go
 * (ApplyThinking), internal/thinking/summary.go (ExtractTranslatedSummaryConfig, ApplySummaryConfigForModel).
 * Executors call `apply` after request translation and the upstream model rewrite, before provider shaping and
 * payload rules. The default layer is a no-op; the thinking slice provides the real implementation behind this
 * service (parse suffix -> canonical config -> validate -> provider applier).
 */
import { Context, Effect, Layer } from "effect"
import type { Json } from "../json/index.ts"
import type { Format } from "../translator/formats.ts"
import { noopSummaryHooks, type SummaryHooks } from "../translator/registry.ts"
import type { ExecutionError } from "./errors.ts"

export interface ThinkingRequest {
  /** Translated (provider-format) body; implementations may mutate and return it. */
  readonly body: Json
  /** Model the client asked for after credential resolution, `(suffix)` kept (Go `req.Model`). */
  readonly model: string
  /** Client format (Go `from`). */
  readonly from: Format
  /** Provider format (Go `to`). */
  readonly to: Format
  /** Registry/provider key used for model capability lookup (executor identifier, e.g. `openai-compatible-x`). */
  readonly provider: string
  /** The client's original body (source config, Responses `configuration_update` items). */
  readonly source?: Json
  /** Whether request translation changed Responses `configuration_update` items. */
  readonly configurationUpdatesChanged?: boolean
  /** Credential-resolved model capabilities (API-key models may override the registry); opaque here. */
  readonly modelInfo?: unknown
}

export class Thinking extends Context.Service<
  Thinking,
  {
    /** Applies the thinking configuration; fails with a request-scoped 400 `ExecutionError` on invalid configs. */
    readonly apply: (request: ThinkingRequest) => Effect.Effect<Json, ExecutionError>
    /** Reasoning-summary hooks applied by the translator registry around request transforms. */
    readonly summary: SummaryHooks
  }
>()("cliproxy/executor/Thinking") {
  /** Passthrough implementation used until the thinking pipeline is ported. */
  static readonly noop = Layer.succeed(
    Thinking,
    Thinking.of({ apply: (request) => Effect.succeed(request.body), summary: noopSummaryHooks })
  )
}
