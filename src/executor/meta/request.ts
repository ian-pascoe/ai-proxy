/**
 * Meta `/responses` request shaping.
 *
 * Go source: internal/runtime/executor/meta_executor_execute.go (`prepareResponsesRequest`),
 * helps/meta_tools.go (`SanitizeMetaWebSearchTools`), openai_responses_signature.go (keep-foreign reasoning
 * sanitising, in `executor/codex/request.ts`). Order: translate -> thinking -> model/stream fields -> instructions ->
 * reasoning sanitising -> tool sanitising -> payload rules (final barrier). The apply_patch bridge
 * (`NormalizeApplyPatchResponsesRequest` after the field deletions, `helps/apply-patch-responses.ts`) turns the Codex
 * custom tool into a strict function; the response side uses `MetaPrepared.applyPatch`. `is-compat` models use the
 * compat request transforms (`helps/translate.ts`).
 */
import { modelIsCompat, translateRequestForExecutor } from "../helps/translate.ts"
import { Effect } from "effect"
import { cloneJson, del, get, isJsonArray, isJsonObject, type Json } from "../../json/index.ts"
import { Formats } from "../../translator/formats.ts"
import type { TranslatorRegistry } from "../../translator/registry.ts"
import { ExecutionError } from "../errors.ts"
import { normalizeCodexInstructions, sanitizeReasoningEncryptedContent, setIfDifferent } from "../codex/request.ts"
import { ApplyPatchResponsesState, normalizeApplyPatchResponses } from "../helps/apply-patch-responses.ts"
import { finalizePayload } from "../helps/payload.ts"
import { parseSuffix } from "../suffix.ts"
import { Thinking } from "../thinking.ts"
import { type ExecutionContext, type ExecutorOptions, type ExecutorRequest, responseFormatOf } from "../types.ts"

/** `SanitizeMetaWebSearchTools`: Meta rejects `search_content_types` on `web_search` tools (also inside namespaces). */
export const sanitizeMetaWebSearchTools = (body: Json): Json => {
  const tools = get(body, "tools")

  if (!isJsonArray(tools)) return body

  const strip = (tool: Json): void => {
    if (isJsonObject(tool) && tool["type"] === "web_search") delete tool["search_content_types"]
  }

  for (const tool of tools) {
    strip(tool)

    if (isJsonObject(tool) && tool["type"] === "namespace" && isJsonArray(tool["tools"])) tool["tools"].forEach(strip)
  }

  return body
}

export interface MetaPrepared {
  readonly baseModel: string
  readonly body: Json
  /** The translated body before the payload rules (translator response context). */
  readonly translated: Json
  readonly from: string
  readonly responseFormat: string
  /** Request-local apply_patch bridge (`metaPreparedRequest.applyPatch`). */
  readonly applyPatch: ApplyPatchResponsesState
}

export const prepareMetaRequest = Effect.fnUntraced(function* (
  registry: TranslatorRegistry,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  provider: string,
  /** `false` only for local token counting (Go `prepareResponsesRequest(..., false)`); upstream calls always stream. */
  stream = true
) {
  const thinking = yield* Thinking
  const baseModel = parseSuffix(request.model).modelName
  const from = options.sourceFormat
  const to = Formats.Codex

  const translate = (payload: Json) =>
    translateRequestForExecutor(
      registry,
      from,
      to,
      { format: from, model: baseModel, stream, body: payload },
      thinking.summary,
      { headers: options.headers, config: context.config, isCompat: modelIsCompat(request) }
    )

  const translated = translate(request.payload)

  if (translated.error !== undefined) {
    return yield* new ExecutionError({
      status: translated.error.status,
      message: translated.error.message,
      requestScoped: true
    })
  }

  const original =
    options.originalRequest === undefined || options.originalRequest === request.payload
      ? cloneJson(translated.body)
      : translate(options.originalRequest).body

  let body = yield* thinking.apply({
    body: translated.body,
    model: request.model,
    from,
    to,
    provider,
    source: request.payload,
    ...(options.originalRequest !== undefined ? { originalSource: options.originalRequest } : {}),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup
  })

  body = setIfDifferent(body, "model", baseModel)
  body = setIfDifferent(body, "stream", stream)

  for (const field of [
    "generate",
    "prompt_cache_retention",
    "safety_identifier",
    "stream_options",
    "client_metadata"
  ]) {
    body = del(body, field)
  }

  const applyPatch = new ApplyPatchResponsesState(from, options.originalRequest ?? request.payload, original)

  try {
    body = normalizeApplyPatchResponses(body, options.originalRequest ?? request.payload)
  } catch (error) {
    return yield* new ExecutionError({
      status: 400,
      message: error instanceof Error ? error.message : String(error),
      requestScoped: true
    })
  }

  body = normalizeCodexInstructions(body, false)
  body = sanitizeReasoningEncryptedContent(body, true)
  body = sanitizeMetaWebSearchTools(body)
  const translatedForResponse = cloneJson(body)
  body = finalizePayload(
    context.config,
    provider,
    {
      model: baseModel,
      requestedModel: options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
      // Go passes the executor identifier as the payload-rule protocol for Meta.
      protocol: provider,
      fromProtocol: from,
      requestPath: options.metadata.requestPath,
      headers: options.headers,
      original
    },
    body
  )

  return {
    baseModel,
    body,
    translated: translatedForResponse,
    from,
    responseFormat: responseFormatOf(options),
    applyPatch
  } satisfies MetaPrepared
})
