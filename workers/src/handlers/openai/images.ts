/**
 * OpenAI Images API routes for Codex image models: `POST /v1/images/generations` and `POST /v1/images/edits`
 * (entry protocol `openai-image`; the Codex executor answers with an Images API body or SSE frames).
 *
 * Go source: sdk/api/handlers/openai/openai_images_handlers.go (ImagesGenerations, ImagesEdits, imagesEditsFromJSON,
 * imagesEditsFromMultipart, buildOpenAICompatImagesJSONRequest, collectRoutedImages, streamRoutedImages). Only the
 * Codex tool models (`gpt-image-*`) are served here; xAI and OpenAI-compatible image models belong to their provider
 * slices. Multipart edits are converted to the JSON form (`images[].image_url`, `mask.image_url`) before execution
 * (Go does the same in the executor, `codexRewriteOpenAIImageEditMultipartToJSON`).
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { ExecutionError } from "../../executor/errors.ts"
import { invalidRequestBody, openAIErrorBody } from "../../http/errors.ts"
import { SSE_KEEP_ALIVE, sseEvent } from "../../http/sse.ts"
import { asString, get, type Json, type JsonObject } from "../../json/index.ts"
import { CODEX_DEFAULT_IMAGE_TOOL_MODEL } from "../../executor/codex/images.ts"
import { executeNonStream, executeStream, type ExecutionInput } from "../execute.ts"
import type { StreamFramer } from "../framing.ts"
import { currentConfig, type ProxyServices, readRequestBody } from "../request.ts"
import { errorResponse, streamResponse } from "../respond.ts"

const CODEX_IMAGE_MODELS = [
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5"
]

/** `imagesModelBase`: text after the last `/`, lower case. */
const imagesModelBase = (model: string): string => {
  const trimmed = model.trim()
  const slash = trimmed.lastIndexOf("/")
  return (slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed).trim().toLowerCase()
}

const isCodexImagesToolModel = (model: string): boolean => CODEX_IMAGE_MODELS.includes(imagesModelBase(model))

const badRequest = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(invalidRequestBody(message), { status: 400, contentType: "application/json" })

const unsupportedModel = (model: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(
    invalidRequestBody(
      `Model ${model} is not supported on /v1/images/generations or /v1/images/edits. Use ${CODEX_IMAGE_MODELS.join(", ")}, or a configured openai-compatibility image model.`
    ),
    { status: 400, contentType: "application/json" }
  )

/** Image frames are complete SSE events already; errors become an `error` event. */
const imagesFramer = (): StreamFramer => ({
  chunk: (payload) => payload,
  terminalError: (error) => {
    const status = error.status > 0 ? error.status : 500
    return sseEvent("error", openAIErrorBody(status, error.message))
  },
  closeError: () => undefined,
  done: () => "",
  emptyBody: "",
  keepAlive: SSE_KEEP_ALIVE
})

const fileDataUrl = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  const type = file.type.trim() !== "" ? file.type.trim() : "application/octet-stream"
  return `data:${type};base64,${btoa(binary)}`
}

const INTEGER_FORM_FIELDS = new Set(["n", "output_compression", "partial_images"])

/** `codexRewriteOpenAIImageEditMultipartToJSON`: form fields and uploads as the JSON edit request. */
const multipartEditToJson = async (form: FormData): Promise<JsonObject> => {
  const out: JsonObject = {}
  const images: Json[] = []
  let mask: string | undefined
  const files: File[] = []
  for (const [key, value] of form.entries()) {
    const name = key.trim()
    if (typeof value !== "string") {
      if (name === "mask") mask ??= await fileDataUrl(value)
      else if (name === "image[]" || name === "image") files.push(value)
      continue
    }
    if (name === "" || name === "model" || name === "stream") continue
    const path = name === "mask[file_id]" ? "mask.file_id" : name === "mask[image_url]" ? "mask.image_url" : name
    const trimmed = value.trim()
    const parsed =
      INTEGER_FORM_FIELDS.has(name.toLowerCase()) && /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed
    if (path.startsWith("mask.")) {
      const current = out["mask"]
      out["mask"] = {
        ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}),
        [path.slice(5)]: parsed
      }
    } else {
      out[path] = parsed
    }
  }
  if (mask !== undefined) {
    const current = out["mask"]
    out["mask"] = {
      ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}),
      image_url: mask
    }
  }
  for (const file of files) images.push({ image_url: await fileDataUrl(file) })
  if (images.length > 0) out["images"] = images
  return out
}

const handle = (edits: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const configResult = yield* Effect.result(currentConfig)
    if (configResult._tag === "Failure")
      return errorResponse("openai", configResult.failure, { passthroughHeaders: false })
    const config = configResult.success
    if (config.multimedia["disable-image-generation"] === true) return HttpServerResponse.empty({ status: 404 })
    const onError = (error: ExecutionError) =>
      errorResponse("openai", error, { passthroughHeaders: config.requests["passthrough-headers"] })

    let body: Json
    let formModel = ""
    let formStream = false
    const contentType = (request.headers["content-type"] ?? "").toLowerCase().trim()
    if (edits && (contentType.startsWith("multipart/form-data") || contentType === "")) {
      const raw = yield* Effect.result(request.arrayBuffer)
      if (raw._tag === "Failure") return badRequest(raw.failure.message)
      const formResult = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            const form = await new Request(new URL(request.url, "http://localhost"), {
              method: "POST",
              headers: { "content-type": request.headers["content-type"] ?? "" },
              body: new Uint8Array(raw.success)
            }).formData()
            formModel = String(form.get("model") ?? "").trim()
            formStream = ["1", "t", "true"].includes(
              String(form.get("stream") ?? "")
                .trim()
                .toLowerCase()
            )
            return await multipartEditToJson(form)
          },
          catch: (error) => (error instanceof Error ? error.message : String(error))
        })
      )
      if (formResult._tag === "Failure") return badRequest(formResult.failure)
      body = formResult.success
    } else if (!edits || contentType.startsWith("application/json")) {
      const read = yield* Effect.result(readRequestBody(request))
      if (read._tag === "Failure") return badRequest(read.failure.message)
      if (read.success.json === undefined) return badRequest("body must be valid JSON")
      body = read.success.json
    } else {
      return badRequest(`unsupported Content-Type "${contentType}"`)
    }

    let model = (formModel !== "" ? formModel : asString(get(body, "model"))).trim()
    if (model === "") model = CODEX_DEFAULT_IMAGE_TOOL_MODEL
    if (!isCodexImagesToolModel(model)) return unsupportedModel(model)
    if (asString(get(body, "prompt")).trim() === "") return badRequest("prompt is required")
    const stream = formStream || get(body, "stream") === true

    // `buildOpenAICompatImagesJSONRequest`: model set, `stream: true` or removed.
    const payload: JsonObject = { ...(body as JsonObject), model }
    if (stream) payload["stream"] = true
    else delete payload["stream"]

    const input: ExecutionInput = {
      entryProtocol: "openai-image",
      model,
      body: payload,
      alt: "",
      request,
      allowImageModel: true,
      // Free-plan Codex credentials cannot use the image tools (`WithDisallowFreeAuth`).
      disallowFreeAuth: true
    }
    if (stream) {
      return yield* streamResponse(executeStream(input), {
        framer: imagesFramer(),
        onError,
        keepAliveSeconds: config.requests.streaming["keepalive-seconds"]
      })
    }
    const result = yield* Effect.result(executeNonStream(input))
    if (result._tag === "Failure") return onError(result.failure)
    return HttpServerResponse.text(result.success.payload, {
      contentType: "application/json"
    })
  })

/** Route layer; requires the {@link ProxyServices} and `AccessPrincipal`. */
export const ImagesRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ProxyServices>()
    yield* router.add("POST", "/v1/images/generations", Effect.provide(handle(false), services))
    yield* router.add("POST", "/v1/images/edits", Effect.provide(handle(true), services))
  })
)
