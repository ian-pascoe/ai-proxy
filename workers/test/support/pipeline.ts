// Test helpers for the request pipeline: a Worker handler with a fake Access JWKS, a static config, an in-memory
// usage sink and a mocked upstream HttpClient.
import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http"
import { makeAccessLayer, makeWithAccess } from "../../src/access/layer.ts"
import { parseConfigYaml } from "../../src/config/codec.ts"
import { ConfigReader } from "../../src/config/reader.ts"
import type { Config } from "../../src/config/schema.ts"
import type { CredentialPicker } from "../../src/executor/picker.ts"
import { StaticCredentialPickerLayer } from "../../src/executor/static-picker.ts"
import type { Thinking } from "../../src/executor/thinking.ts"
import { makeProxyRoutes } from "../../src/handlers/layer.ts"
import { ModelCapabilities } from "../../src/handlers/model-capabilities.ts"
import { ModelProviders } from "../../src/handlers/model-providers.ts"
import { CredentialRefresher } from "../../src/executor/helps/credential-refresh.ts"
import { RootRoutes } from "../../src/http/routes.ts"
import { requestContext } from "../../src/platform/env.ts"
import type { UsageRecord } from "../../src/usage/record.ts"
import { UsageSink } from "../../src/usage/sink.ts"
import { AUD, fakeJwksLayer, makeFakeJwks, makeKey, signToken, userClaims } from "./access.ts"

export interface UpstreamCall {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export type UpstreamResponder = (call: UpstreamCall) => Response | Promise<Response>

/** HttpClient that records every request and answers with `respond`. */
export const mockHttpClient = (
  calls: Array<UpstreamCall>,
  respond: UpstreamResponder
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.promise(async () => {
        const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        const call: UpstreamCall = {
          url: url.toString(),
          method: request.method,
          headers: { ...request.headers },
          body
        }
        calls.push(call)
        return HttpClientResponse.fromWeb(request, await respond(call))
      })
    )
  )

export const staticConfigReader = (config: Config): Layer.Layer<ConfigReader> =>
  Layer.succeed(ConfigReader, ConfigReader.of({ get: Effect.succeed({ version: 1, config }), invalidate: Effect.void }))

export const loadConfig = (yaml: string): Promise<Config> => Effect.runPromise(parseConfigYaml(yaml))

/** SSE response body streamed in the given pieces (pieces may split lines). */
export const sseResponse = (pieces: ReadonlyArray<string>, init: ResponseInit = {}): Response => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" }, ...init })
}

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  })

const key = await makeKey("pipeline-kid")

const accessEnv: Env = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  ACCESS_ADMIN_EMAILS: "",
  ACCESS_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: ""
}

const ctx = {} as unknown as ExecutionContext

export interface PipelineOptions {
  readonly config: Config
  readonly respond: UpstreamResponder
  readonly thinking?: Layer.Layer<Thinking>
  /** Defaults to the config-only static picker (no Durable Object). */
  readonly credentialPicker?: Layer.Layer<CredentialPicker, never, ConfigReader>
}

export interface PipelineHarness {
  readonly calls: Array<UpstreamCall>
  readonly records: Array<UsageRecord>
  readonly call: (path: string, init?: RequestInit) => Promise<Response>
  readonly dispose: () => Promise<void>
}

export const makePipeline = (options: PipelineOptions): PipelineHarness => {
  const calls: Array<UpstreamCall> = []
  const records: Array<UsageRecord> = []
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])))
  const routes = makeProxyRoutes({
    configReader: staticConfigReader(options.config),
    httpClient: mockHttpClient(calls, options.respond),
    usageSink: UsageSink.memory(records),
    credentialPicker: options.credentialPicker ?? StaticCredentialPickerLayer,
    // Tests configure everything through the static config: no registry, no refresh.
    modelProviders: ModelProviders.configLayer,
    modelCapabilities: ModelCapabilities.configLayer,
    credentialRefresher: CredentialRefresher.none,
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {})
  })
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(routes)),
    {
      disableLogger: true
    }
  )
  const call = async (path: string, init: RequestInit = {}) => {
    const token = await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims("dev@example.com") })
    const headers = new Headers(init.headers)
    headers.set("Cf-Access-Jwt-Assertion", token)
    return handler(new Request(`https://proxy.test${path}`, { ...init, headers }), requestContext(accessEnv, ctx))
  }
  return { calls, records, call, dispose }
}

/** POST JSON helper. */
export const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
})
