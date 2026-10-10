/**
 * `GET /v8/management/routing/model-definitions/:channel`: the static catalog of one provider channel.
 *
 * Go source: internal/api/handlers/management/model_definitions.go, internal/registry/model_registry.go (`ModelInfo`
 * JSON tags and `omitempty` rules). The catalogs are the ones the model registry serves (KV copy or embedded).
 */
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import type { JsonObject } from "../json/index.ts"
import { staticModelsByChannel } from "../registry/catalog.ts"
import type { ModelInfo } from "../registry/model-info.ts"
import { ModelRegistry } from "../registry/service.ts"
import { handled, jsonReply, replyError } from "./http.ts"

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value !== ""

const nonZero = (value: number | undefined): value is number => value !== undefined && value !== 0

const nonEmptyList = (value: ReadonlyArray<string> | undefined): value is ReadonlyArray<string> =>
  value !== undefined && value.length > 0

/** The Go JSON encoding of a `registry.ModelInfo` (declaration order, `omitempty` applied). */
export const modelInfoWire = (model: ModelInfo): JsonObject => {
  const out: JsonObject = {
    id: model.id,
    object: model.object,
    created: model.created,
    owned_by: model.ownedBy,
    type: model.type
  }

  if (nonEmpty(model.displayName)) out.display_name = model.displayName

  if (nonEmpty(model.name)) out.name = model.name

  if (nonEmpty(model.version)) out.version = model.version

  if (nonEmpty(model.description)) out.description = model.description

  if (nonZero(model.inputTokenLimit)) out.inputTokenLimit = model.inputTokenLimit

  if (nonZero(model.outputTokenLimit)) out.outputTokenLimit = model.outputTokenLimit

  if (nonEmptyList(model.supportedGenerationMethods))
    out.supportedGenerationMethods = [...model.supportedGenerationMethods]

  if (nonZero(model.contextLength)) out.context_length = model.contextLength

  if (nonZero(model.maxCompletionTokens)) out.max_completion_tokens = model.maxCompletionTokens

  if (nonEmptyList(model.supportedParameters)) out.supported_parameters = [...model.supportedParameters]

  if (nonEmptyList(model.supportedInputModalities)) out.supportedInputModalities = [...model.supportedInputModalities]

  if (nonEmptyList(model.supportedOutputModalities))
    out.supportedOutputModalities = [...model.supportedOutputModalities]

  if (model.supportsWebSearch === true) out.supports_web_search = true

  if (model.thinking !== undefined) {
    const thinking: JsonObject = {}

    if (nonZero(model.thinking.min)) thinking.min = model.thinking.min

    if (nonZero(model.thinking.max)) thinking.max = model.thinking.max

    if (model.thinking.zeroAllowed === true) thinking.zero_allowed = true

    if (model.thinking.dynamicAllowed === true) thinking.dynamic_allowed = true

    if (nonEmptyList(model.thinking.levels)) thinking.levels = [...model.thinking.levels]
    out.thinking = thinking
  }

  const overrideHeader = model.config?.overrideHeader

  if (overrideHeader !== undefined) out.config = { override_header: { ...overrideHeader } }

  return out
}

const modelDefinitions = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.originalUrl, "http://localhost")
  const raw = url.pathname.slice("/v8/management/routing/model-definitions".length).replace(/^\/+/, "")
  let channel = raw

  try {
    channel = decodeURIComponent(raw)
  } catch {
    // Keep the raw segment.
  }

  channel = channel.trim() || (url.searchParams.get("channel")?.trim() ?? "")

  if (channel === "") return yield* replyError(400, "channel is required")
  const registry = yield* ModelRegistry
  const snapshot = yield* registry.snapshot.pipe(Effect.mapError(() => replyError(502, "model registry unavailable")))
  const models = staticModelsByChannel(snapshot.catalogs, channel)

  if (models === undefined) return yield* replyError(400, "unknown channel", { channel })

  return jsonReply(200, { channel: channel.toLowerCase(), models: models.map(modelInfoWire) })
})

export const modelDefinitionsHandler = handled(modelDefinitions)
