// Test helpers for the Google executors: a pipeline harness (like support/pipeline.ts) with a fixed credential list,
// a fixed model -> provider table and an overridable ControlPlane stub.
import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { makeAccessLayer, makeWithAccess } from "../../src/access/layer.ts"
import type { Config } from "../../src/config/schema.ts"
import {
  type AttemptResult,
  CredentialPicker,
  type CredentialSnapshot,
  type PickRequest
} from "../../src/executor/picker.ts"
import { Thinking } from "../../src/executor/thinking.ts"
import { ModelProviders } from "../../src/handlers/model-providers.ts"
import { makeProxyRoutes } from "../../src/handlers/layer.ts"
import { RootRoutes } from "../../src/http/routes.ts"
import { requestContext } from "../../src/platform/env.ts"
import type { UsageRecord } from "../../src/usage/record.ts"
import { UsageSink } from "../../src/usage/sink.ts"
import { AUD, fakeJwksLayer, makeFakeJwks, makeKey, signToken, userClaims } from "./access.ts"
import { mockHttpClient, staticConfigReader, type UpstreamCall, type UpstreamResponder } from "./pipeline.ts"

const key = await makeKey("gemini-kid")

export const credential = (
  provider: string,
  id: string,
  extra: Partial<Pick<CredentialSnapshot, "attributes" | "metadata" | "kind">> = {}
): CredentialSnapshot => ({
  id,
  provider,
  kind: extra.kind ?? "apikey",
  attributes: extra.attributes ?? {},
  metadata: extra.metadata ?? {}
})

export interface GeminiHarnessOptions {
  readonly config: Config
  readonly respond: UpstreamResponder
  /** Credential returned by the picker for every request. */
  readonly credential: CredentialSnapshot
  /** Model id -> providers (`ModelProviders`). */
  readonly models: Readonly<Record<string, ReadonlyArray<string>>>
  /** Overrides on the Worker `env` (e.g. a `CONTROL_PLANE` stub). */
  readonly env?: Partial<Record<string, unknown>>
  readonly thinking?: Layer.Layer<Thinking>
}

export interface GeminiHarness {
  readonly calls: Array<UpstreamCall>
  readonly records: Array<UsageRecord>
  readonly picks: Array<PickRequest>
  readonly reports: Array<AttemptResult>
  readonly call: (path: string, init?: RequestInit) => Promise<Response>
  readonly dispose: () => Promise<void>
}

export const makeGeminiHarness = (options: GeminiHarnessOptions): GeminiHarness => {
  const calls: Array<UpstreamCall> = []
  const records: Array<UsageRecord> = []
  const picks: Array<PickRequest> = []
  const reports: Array<AttemptResult> = []
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])))
  const picker = Layer.succeed(
    CredentialPicker,
    CredentialPicker.of({
      pick: (request) => {
        picks.push(request)
        return Effect.succeed({ credential: options.credential, leaseId: `lease-${picks.length}` })
      },
      report: (_lease, result) => Effect.sync(() => void reports.push(result))
    })
  )
  const models = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: (model) =>
        Effect.succeed(Object.hasOwn(options.models, model) ? (options.models[model] as ReadonlyArray<string>) : []),
      firstAvailableModel: Effect.succeed(undefined)
    })
  )
  const routes = makeProxyRoutes({
    configReader: staticConfigReader(options.config),
    httpClient: mockHttpClient(calls, options.respond),
    usageSink: UsageSink.memory(records),
    credentialPicker: picker,
    modelProviders: models,
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {})
  })
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(routes)),
    { disableLogger: true }
  )
  const workerEnv = {
    ...env,
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_AUD: AUD,
    ACCESS_ADMIN_EMAILS: "",
    ACCESS_ADMIN_SERVICE_TOKENS: "",
    ACCESS_DEV_BYPASS: "",
    ...options.env
  } as unknown as Env
  const call = async (path: string, init: RequestInit = {}) => {
    const token = await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims("dev@example.com") })
    const headers = new Headers(init.headers)
    headers.set("Cf-Access-Jwt-Assertion", token)
    return handler(
      new Request(`https://proxy.test${path}`, { ...init, headers }),
      requestContext(workerEnv, {} as unknown as ExecutionContext)
    )
  }
  return { calls, records, picks, reports, call, dispose }
}
