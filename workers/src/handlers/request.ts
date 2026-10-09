/**
 * Shared request handling for the proxy routes: body reading/decoding and the services every handler needs.
 *
 * Go source: sdk/api/handlers/request_body.go (ReadRequestBody), sdk/api/handlers/handlers.go (GetAlt).
 */
import { Effect } from "effect"
import type { HttpClient, HttpServerRequest } from "effect/http"
import { ConfigReader } from "../config/reader.ts"
import type { Config } from "../config/schema.ts"
import { ExecutionError } from "../executor/errors.ts"
import type { CredentialRefresher } from "../executor/helps/credential-refresh.ts"
import type { CredentialPicker } from "../executor/picker.ts"
import type { ExecutorRegistry } from "../executor/registry.ts"
import type { Thinking } from "../executor/thinking.ts"
import { decodeRequestBody } from "../http/body.ts"
import { type Json, tryParseJson } from "../json/index.ts"
import type { UsageSink } from "../usage/sink.ts"
import type { ModelCapabilities } from "./model-capabilities.ts"
import type { ModelProviders } from "./model-providers.ts"

/** Services the proxy routes close over (provided once per isolate by `handlers/layer.ts`). */
export type ProxyServices =
  | ConfigReader
  | CredentialPicker
  | CredentialRefresher
  | ExecutorRegistry
  | ModelCapabilities
  | ModelProviders
  | UsageSink
  | HttpClient.HttpClient
  | Thinking

/** A request that could not be read; answered with `400 {"error":{"message":"Invalid request: ..."}}`. */
export class InvalidRequestBody extends Error {
  override readonly name = "InvalidRequestBody"
}

export interface RequestBody {
  readonly text: string
  /** Parsed body; `undefined` when the text is not JSON. */
  readonly json: Json | undefined
}

/** Reads and decodes (`Content-Encoding: zstd`) the request body. */
export const readRequestBody = (
  request: HttpServerRequest.HttpServerRequest,
  options: { readonly decode: boolean } = { decode: true }
): Effect.Effect<RequestBody, InvalidRequestBody> =>
  request.arrayBuffer.pipe(
    Effect.mapError((error) => new InvalidRequestBody(error.message)),
    Effect.flatMap((buffer) =>
      Effect.try({
        try: () =>
          decodeRequestBody(new Uint8Array(buffer), options.decode ? request.headers["content-encoding"] : undefined),
        catch: (error) => new InvalidRequestBody(error instanceof Error ? error.message : String(error))
      })
    ),
    Effect.map((text) => ({ text, json: tryParseJson(text) }))
  )

/** `GetAlt`: `alt` (or `$alt`) query value, with `sse` meaning the default framing (`""`). */
export const altOf = (request: HttpServerRequest.HttpServerRequest): string => {
  const url = new URL(request.url, "http://localhost")
  const alt = url.searchParams.get("alt") ?? url.searchParams.get("$alt") ?? ""
  return alt === "sse" ? "" : alt
}

/** The config snapshot, or a 503 when it cannot be read at all. */
export const currentConfig = Effect.gen(function* () {
  const reader = yield* ConfigReader
  return yield* reader.get.pipe(
    Effect.map((snapshot): Config => snapshot.config),
    Effect.mapError((cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }))
  )
})
