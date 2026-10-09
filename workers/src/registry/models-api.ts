/**
 * Dispatch and bodies of the model listing endpoints (pure; the HTTP wiring is in `routes.ts`).
 *
 * Go source: internal/api/server_routes.go (`unifiedModelsHandler`, `isAnthropicModelsRequest`, `handleGrokModels`,
 * `geminiModelsHandler`, `geminiGetHandler`), sdk/api/handlers/handlers_interceptors.go (`WriteModelListResponse`
 * with `ModelDetailIDContextKey`).
 */
import type { Json, JsonObject } from "../json/index.ts"
import {
  claudeList,
  geminiDetail,
  geminiList,
  goCompactJson,
  goJson,
  goStructJson,
  grokList,
  openaiList
} from "./listings.ts"
import type { ModelInfo } from "./model-info.ts"

export interface ModelsReply {
  readonly status: number
  /** Serialised JSON body, byte-identical to the Go server's for the same model set. */
  readonly body: string
}

export type ModelsFormat = "grok" | "codex-client" | "claude" | "openai"

export interface ModelsRequestInfo {
  readonly userAgent: string
  readonly anthropicVersion: string
  /** `client_version` query value; `undefined` when the parameter is absent (an empty value still counts). */
  readonly clientVersion: string | undefined
}

/** The order of `unifiedModelsHandler`: Grok shell, Codex client catalog, Anthropic, OpenAI. */
export const modelsFormat = (request: ModelsRequestInfo): ModelsFormat => {
  if (request.userAgent.toLowerCase().includes("grok-shell")) return "grok"
  if (request.clientVersion !== undefined) return "codex-client"
  if (request.anthropicVersion !== "" || request.userAgent.startsWith("claude-cli")) return "claude"
  return "openai"
}

const ok = (body: string): ModelsReply => ({ status: 200, body })

const MODEL_NOT_FOUND = goJson({
  error: { message: "Model not found", type: "invalid_request_error", code: "model_not_found" }
})

const GEMINI_NOT_FOUND = '{"error":{"message":"Not Found","type":"not_found"}}'

const entryId = (entry: Json): string => {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return ""
  const id = entry.id
  if (typeof id === "string" && id !== "") return id
  return typeof entry.slug === "string" ? entry.slug : ""
}

/** Detail routes serve the catalog entry whose `id` (or `slug`) equals the requested id, else 404. */
const selectDetail = (payload: JsonObject, id: string, render: (value: Json) => string): ModelsReply => {
  const entries = [...((payload.data as Json[] | undefined) ?? []), ...((payload.models as Json[] | undefined) ?? [])]
  const found = entries.find((entry) => entryId(entry) !== "" && entryId(entry) === id)
  return found === undefined ? { status: 404, body: MODEL_NOT_FOUND } : ok(render(found))
}

export interface ModelsOptions {
  /** `upstream.claude.disable-cloaking-model-list`. */
  readonly disableCloaking: boolean
  /** Builds the Codex client catalog for `client_version` queries (`registry/codex-client-models.ts`). */
  readonly codexClient: (models: ReadonlyArray<ModelInfo>, clientVersion: string) => JsonObject
}

/**
 * `GET /v1/models` (`detailId === undefined`) and `GET /v1/models/{id}`. `models` are the available models sorted
 * by id.
 */
export const respondModels = (
  models: ReadonlyArray<ModelInfo>,
  request: ModelsRequestInfo,
  options: ModelsOptions,
  detailId?: string
): ModelsReply => {
  const format = modelsFormat(request)
  let payload: JsonObject
  let render = goJson
  switch (format) {
    case "grok":
      payload = grokList(models)
      render = goStructJson
      break
    case "codex-client":
      payload = options.codexClient(models, request.clientVersion ?? "")
      render = goCompactJson
      break
    case "claude":
      payload = claudeList(models, options.disableCloaking)
      break
    default:
      payload = openaiList(models)
  }
  // A selected element keeps the serialisation of its list (struct order for Grok entries).
  return detailId === undefined ? ok(render(payload)) : selectDetail(payload, detailId, render)
}

/** `GET /v1beta/models`. */
export const respondGeminiList = (models: ReadonlyArray<ModelInfo>): ModelsReply => ok(goJson(geminiList(models)))

/** `GET /v1beta/models/{model}`; `action` is the path remainder without the leading slash. */
export const respondGeminiDetail = (models: ReadonlyArray<ModelInfo>, action: string): ModelsReply => {
  const entry = geminiDetail(models, action)
  return entry === undefined ? { status: 404, body: GEMINI_NOT_FOUND } : ok(goJson(entry))
}
