/**
 * xAI text-to-speech: `POST /v1/audio/speech` (OpenAI shape) and `POST /v1/tts` (entry protocol `openai-speech`).
 *
 * Go source: sdk/api/handlers/openai/openai_speech_handlers.go (handleXAISpeech, speechRoutingModel, speechModelBase,
 * buildXAISpeechPayload, mapXAISpeechVoice, speechOutputFormat, speechCodecFormat, speechResponseContentType). The
 * OpenAI request is converted to the xAI `/tts` body; the upstream audio is written back verbatim (no keep-alive
 * bytes: they would be prefixed onto the audio).
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { routeServices } from "../../http/route-services.ts"
import { goMarshal } from "../../http/json-text.ts"
import { invalidRequestBody } from "../../http/errors.ts"
import { mergeUpstreamHeaders } from "../../http/headers.ts"
import { asString, get, isJsonObject, type Json, type JsonObject } from "../../json/index.ts"
import { executeNonStream, type ExecutionInput } from "../execute.ts"
import { currentConfig, type ProxyServices, readRequestBody } from "../request.ts"
import { errorResponse } from "../respond.ts"

const DEFAULT_SPEECH_MODEL = "grok-tts"

const SPEECH_VOICE_MODEL = "grok-voice-tts-1.0"

const DEFAULT_VOICE = "eve"

const MAX_SPEECH_CHARACTERS = 60000

const MAX_SPEECH_BODY_BYTES = 1 << 20

const DEFAULT_SAMPLE_RATE = 24000

/** OpenAI TTS voice names mapped onto Grok voices; unknown names pass through. */
const OPENAI_VOICES: Readonly<Record<string, string>> = {
  alloy: "ara",
  ash: "orion",
  ballad: "luna",
  coral: "celeste",
  echo: "rex",
  fable: "sal",
  onyx: "leo",
  nova: "eve",
  sage: "iris",
  shimmer: "aurora",
  verse: "lumen"
}

/** `speechModelBase`: provider prefix and a trailing `(...)` suffix are dropped, lower case. */
const speechModelBase = (model: string): string => {
  let name = model.trim()
  const lower = name.toLowerCase()

  for (const prefix of ["xai/", "x-ai/", "grok/"]) {
    if (lower.startsWith(prefix)) {
      name = name.slice(prefix.length).trim()
      break
    }
  }

  const open = name.lastIndexOf("(")

  if (open > 0 && name.endsWith(")")) name = name.slice(0, open).trim()

  return name.trim().toLowerCase()
}

/** `speechRoutingModel`: the routed model, or `undefined` when the model is not a speech model. */
export const speechRoutingModel = (model: string): string | undefined => {
  switch (speechModelBase(model)) {
    case "":
    case "tts-1":
    case "tts-1-hd":
    case "gpt-4o-mini-tts":
    case DEFAULT_SPEECH_MODEL:
      return DEFAULT_SPEECH_MODEL
    case SPEECH_VOICE_MODEL:
      return SPEECH_VOICE_MODEL
    default:
      return undefined
  }
}

const codecFormat = (
  codec: string,
  sampleRate: number
): { readonly format: string; readonly output?: JsonObject } | string => {
  switch (codec) {
    case "":
    case "mp3":
      return { format: "mp3" }
    case "wav":
    case "pcm":
      return { format: codec, output: { codec, sample_rate: sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE } }
    default:
      return "response_format must be mp3, wav, or pcm"
  }
}

const outputFormat = (raw: Json): { readonly format: string; readonly output?: JsonObject } | string => {
  const responseFormat = asString(get(raw, "response_format")).trim().toLowerCase()

  if (responseFormat !== "") return codecFormat(responseFormat, DEFAULT_SAMPLE_RATE)
  const native = get(raw, "output_format")

  if (native === undefined) return { format: "mp3" }

  if (!isJsonObject(native)) return "output_format must be an object"
  const codec = asString(native["codec"]).trim().toLowerCase()
  const rate = native["sample_rate"]
  const sampleRate = typeof rate === "number" && rate > 0 ? Math.trunc(rate) : DEFAULT_SAMPLE_RATE

  return codecFormat(codec, sampleRate)
}

/** `buildXAISpeechPayload`; a string result is the validation error. */
export const buildSpeechPayload = (raw: Json): { readonly payload: JsonObject; readonly format: string } | string => {
  let input = asString(get(raw, "input")).trim()

  if (input === "") input = asString(get(raw, "text")).trim()

  if (input === "") return "input is required"

  if ([...input].length > MAX_SPEECH_CHARACTERS) return "input is longer than 60000 characters"
  let voice = asString(get(raw, "voice")).trim()

  if (voice === "") voice = asString(get(raw, "voice_id"))
  voice = voice.trim().toLowerCase()
  const language = asString(get(raw, "language")).trim()

  const payload: JsonObject = {
    text: input,
    voice_id: voice === "" ? DEFAULT_VOICE : (OPENAI_VOICES[voice] ?? voice),
    language: language === "" ? "auto" : language
  }

  const speed = get(raw, "speed")

  if (typeof speed === "number" && speed > 0) payload["speed"] = speed
  const format = outputFormat(raw)

  if (typeof format === "string") return format

  if (format.output !== undefined) payload["output_format"] = format.output

  return { payload, format: format.format }
}

const speechContentType = (format: string): string =>
  format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : "audio/mpeg"

/** `speechResponseContentType`: a generic upstream type is replaced by the one of the requested codec. */
export const speechResponseContentType = (format: string, upstream: string | null | undefined): string => {
  const mediaType = (upstream ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  const generic = ["", "application/json", "application/octet-stream", "text/plain"].includes(mediaType)

  return generic ? speechContentType(format) : (upstream as string)
}

const speechError = (status: number, message: string) =>
  HttpServerResponse.text(goMarshal({ error: { message, type: "invalid_request_error" } }), {
    status,
    contentType: "application/json"
  })

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const configResult = yield* Effect.result(currentConfig)

  if (configResult._tag === "Failure")
    return errorResponse("openai", configResult.failure, { passthroughHeaders: false })
  const config = configResult.success
  const read = yield* Effect.result(readRequestBody(request))

  if (read._tag === "Failure")
    return HttpServerResponse.text(invalidRequestBody(read.failure.message), {
      status: read.failure.status,
      contentType: "application/json"
    })

  if (new TextEncoder().encode(read.success.text).length > MAX_SPEECH_BODY_BYTES) {
    return speechError(400, "request body is larger than 1MB")
  }

  const raw = read.success.json

  if (raw === undefined) return speechError(400, "body must be valid JSON")
  const requested = asString(get(raw, "model")).trim()
  const model = speechRoutingModel(requested)

  if (model === undefined) {
    return speechError(400, `Model ${requested} is not supported on /v1/audio/speech. Use ${DEFAULT_SPEECH_MODEL}.`)
  }

  const built = buildSpeechPayload(raw)

  if (typeof built === "string") return speechError(400, built)

  const input: ExecutionInput = {
    entryProtocol: "openai-speech",
    model,
    body: built.payload,
    alt: "",
    request,
    allowSpeechModel: true
  }

  const result = yield* Effect.result(executeNonStream(input))

  if (result._tag === "Failure") {
    return errorResponse("openai", result.failure, { passthroughHeaders: config.requests["passthrough-headers"] })
  }

  const output = result.success

  const headers = mergeUpstreamHeaders(
    { "content-type": speechResponseContentType(built.format, output.headers?.get("content-type")) },
    output.headers
  )

  delete headers["content-length"]

  return HttpServerResponse.uint8Array(output.bytes ?? new TextEncoder().encode(output.payload), { headers })
})

/** Route layer; requires the {@link ProxyServices} and `AccessPrincipal`. */
export const SpeechRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ProxyServices>()
    yield* router.add("POST", "/v1/audio/speech", Effect.provide(handle, services))
    yield* router.add("POST", "/v1/tts", Effect.provide(handle, services))
  })
)
