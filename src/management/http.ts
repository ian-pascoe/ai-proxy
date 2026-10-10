/**
 * Shared plumbing of the management routes: JSON replies, the ControlPlane stub, request body readers.
 *
 * Go source: internal/api/handlers/management/handler.go (response headers set by the management middleware) and
 * the `c.JSON(status, gin.H{"error": ...})` convention of every management handler.
 */
import { Data, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts"
import { causeSummary } from "../observability/cause.ts"
import { WorkerEnv } from "../platform/env.ts"

const JSON_CONTENT_TYPE = "application/json; charset=utf-8"

/** Sent on every management response (`X-CPA-*`): the panel reads the version and hides plugin pages. */
export const MANAGEMENT_HEADERS = {
  "x-cpa-version": "workers",
  "x-cpa-support-plugin": "false",
  "cache-control": "no-store"
} as const

export const jsonReply = (status: number, body: unknown): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: JSON_CONTENT_TYPE })

/** An early exit with a ready response (the Effect failure channel of every management handler). */
export class Reply extends Data.TaggedError("Reply")<{ readonly response: HttpServerResponse.HttpServerResponse }> {}

export const replyError = (status: number, error: string, extra: JsonObject = {}): Reply =>
  new Reply({ response: jsonReply(status, { error, ...extra }) })

type Stub = ReturnType<Env["CONTROL_PLANE"]["getByName"]>

/** Calls the singleton ControlPlane; a failed RPC is logged (never with payloads) and answered with 502. */
export const controlPlane = <R>(label: string, call: (stub: Stub) => R): Effect.Effect<Awaited<R>, Reply, WorkerEnv> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv
    return yield* Effect.tryPromise({
      // RPC results are promise-pipelining stubs; `await` yields the plain data.
      try: async (): Promise<Awaited<R>> => await call(env.CONTROL_PLANE.getByName("global")),
      catch: (cause) => cause
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError(`management ${label} failed: ${cause instanceof Error ? cause.message : "unknown error"}`).pipe(
          Effect.andThen(Effect.fail(replyError(502, "control plane unavailable")))
        )
      )
    )
  })

/** Request body as text; `invalid body` (400) when it cannot be read. */
export const bodyText = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  // `arrayBuffer` instead of `text`: workerd warns when `.text()` reads a non-text type such as application/yaml.
  const buffer = yield* request.arrayBuffer.pipe(Effect.mapError(() => replyError(400, "invalid body")))
  return new TextDecoder().decode(buffer)
})

/** Request body parsed as JSON (any value); 400 `invalid body` otherwise. */
export const bodyJson = Effect.gen(function* () {
  const text = yield* bodyText
  return yield* Effect.try({
    try: () => JSON.parse(text) as Json,
    catch: () => replyError(400, "invalid body")
  })
})

/** Request body parsed as a JSON object; 400 `invalid body` otherwise. */
export const bodyObject = bodyJson.pipe(
  Effect.flatMap((value) =>
    isJsonObject(value) ? Effect.succeed(value) : Effect.fail(replyError(400, "invalid body"))
  )
)

/** Query parameters of the current request (first value wins). */
export const queryParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return new URL(request.originalUrl, "http://localhost").searchParams
})

/**
 * Turns a handler's failure channel into responses and adds the management headers. Unexpected defects are logged and
 * answered with 500 (never with details).
 */
export const handled = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catch((reply) => Effect.succeed(reply.response)),
    Effect.catchCause((cause) =>
      Effect.logError(`management handler failed: ${causeSummary(cause)}`).pipe(
        Effect.as(jsonReply(500, { error: "internal error" }))
      )
    ),
    Effect.map((response) => HttpServerResponse.setHeaders(response, MANAGEMENT_HEADERS))
  )
