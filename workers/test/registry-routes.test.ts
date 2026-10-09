// /v1/models and /v1beta/models through the router with the Access gate, a faked registry and the real ControlPlane.
import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeAccessLayer, makeWithAccess } from "../src/access/layer.ts"
import { ConfigReader } from "../src/config/reader.ts"
import { requestContext } from "../src/platform/env.ts"
import { CatalogStore } from "../src/registry/catalog-store.ts"
import { ModelRoutes } from "../src/registry/routes.ts"
import { ModelRegistry, ModelRegistryError, buildSnapshot } from "../src/registry/service.ts"
import { RootRoutes } from "../src/http/routes.ts"
import { AUD, fakeJwksLayer, makeFakeJwks, makeKey, signToken, userClaims } from "./support/access.ts"
import { catalogs } from "./support/registry.ts"
import { configOf, source } from "./support/registry-sources.ts"

const key = await makeKey("models-kid")
const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  ACCESS_ADMIN_EMAILS: "",
  ACCESS_DEV_BYPASS: ""
}
const ctx = {} as unknown as ExecutionContext
const NOW = 1_800_000_000_000

const makeHandler = (registryLayer: Layer.Layer<ModelRegistry>) => {
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])))
  return HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(ModelRoutes.pipe(Layer.provide(registryLayer)))),
    { disableLogger: true }
  )
}

const token = async () =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims("user@example.com") })

const caller =
  (handler: ReturnType<typeof makeHandler>) =>
  async (path: string, headers: Record<string, string> = {}, auth = true) =>
    await handler.handler(
      new Request(`https://proxy.test${path}`, {
        headers: { ...(auth ? { "Cf-Access-Jwt-Assertion": await token() } : {}), ...headers }
      }),
      requestContext(accessEnv, ctx)
    )

describe("model routes with a fixed registry", () => {
  const snapshot = buildSnapshot({
    config: configOf(),
    catalogs,
    now: NOW,
    sources: [
      source("claude-a.json", "claude", { prefix: "team" }),
      source("gem.json", "gemini", { excludedModels: ["gemini-3*", "*preview*"] })
    ]
  })
  const registry = Layer.succeed(ModelRegistry, ModelRegistry.of({ snapshot: Effect.succeed(snapshot) }))
  const handler = makeHandler(registry)
  afterAll(handler.dispose)
  const call = caller(handler)

  it("requires Access on all four routes", async () => {
    for (const path of ["/v1/models", "/v1/models/x", "/v1beta/models", "/v1beta/models/x"]) {
      const response = await call(path, {}, false)
      expect(response.status, path).toBe(401)
    }
  })

  it("lists OpenAI shape by default and Claude shape for Anthropic clients, with CORS and JSON content type", async () => {
    const openai = await call("/v1/models")
    expect(openai.status).toBe(200)
    expect(openai.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(openai.headers.get("access-control-allow-origin")).toBe("*")
    const body = (await openai.json()) as {
      object: string
      data: Array<{ id: string; object: string; owned_by: string }>
    }
    expect(body.object).toBe("list")
    const ids = body.data.map((model) => model.id)
    expect(ids).toContain("team/claude-sonnet-4-5-20250929")
    expect(ids).toContain("claude-sonnet-4-5-20250929")
    expect(ids).toContain("gemini-2.5-pro")
    expect(ids).not.toContain("gemini-3-pro-preview")
    expect(ids.toSorted()).toEqual(ids)

    for (const headers of [{ "anthropic-version": "2023-06-01" }, { "user-agent": "claude-cli/1.0" }]) {
      const claude = await call("/v1/models", headers)
      const parsed = (await claude.json()) as {
        data: Array<{ id: string; type: string }>
        has_more: boolean
        first_id: string
      }
      expect(parsed.has_more).toBe(false)
      expect(parsed.data[0]?.type).toBe("model")
      expect(parsed.data.some((model) => model.id.startsWith("claude-fable-5-dd-"))).toBe(true)
    }
    const grok = (await (await call("/v1/models", { "user-agent": "Grok-Shell/9" })).json()) as {
      data: Array<{ api_backend: string }>
    }
    expect(grok.data[0]?.api_backend).toBe("responses")
  })

  it("serves model details for ids containing slashes, plain or percent-encoded", async () => {
    for (const path of ["/v1/models/team/claude-sonnet-4-5-20250929", "/v1/models/team%2Fclaude-sonnet-4-5-20250929"]) {
      const response = await call(path)
      expect(response.status, path).toBe(200)
      expect(await response.json()).toMatchObject({ id: "team/claude-sonnet-4-5-20250929", object: "model" })
    }
    for (const path of ["/v1/models/nope", "/v1/models/"]) {
      const response = await call(path)
      expect(response.status, path).toBe(404)
      expect(await response.text()).toBe(
        '{"error":{"code":"model_not_found","message":"Model not found","type":"invalid_request_error"}}'
      )
    }
  })

  it("answers client_version with an explicit not-implemented error until the Codex catalog lands", async () => {
    const response = await call("/v1/models?client_version=0.1.0")
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { type: "not_implemented" } })
  })

  it("lists Gemini models and serves details with or without the models/ prefix", async () => {
    const list = (await (await call("/v1beta/models")).json()) as {
      models: Array<{ name: string; supportedGenerationMethods: string[] }>
    }
    expect(list.models.map((model) => model.name)).toContain("models/gemini-2.5-pro")
    for (const path of ["/v1beta/models/gemini-2.5-pro", "/v1beta/models/models/gemini-2.5-pro"]) {
      const response = await call(path)
      expect(response.status, path).toBe(200)
      expect(await response.json()).toMatchObject({ name: "models/gemini-2.5-pro" })
    }
    const missing = await call("/v1beta/models/nope")
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('{"error":{"message":"Not Found","type":"not_found"}}')
  })
})

describe("model routes when the registry is unavailable", () => {
  const handler = makeHandler(
    Layer.succeed(
      ModelRegistry,
      ModelRegistry.of({ snapshot: Effect.fail(new ModelRegistryError({ message: "failed to read model sources" })) })
    )
  )
  afterAll(handler.dispose)

  it("answers 500 with a generic error body", async () => {
    const call = caller(handler)
    for (const path of ["/v1/models", "/v1beta/models"]) {
      const response = await call(path)
      expect(response.status).toBe(500)
      expect(await response.text()).toBe('{"error":{"message":"Model registry unavailable","type":"server_error"}}')
    }
  })
})

describe("model routes with the real ControlPlane", () => {
  const registry = ModelRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(ConfigReader.layerControlPlane(), CatalogStore.layer))
  )

  it("lists models of imported credentials (prefix, plan tier, exclusions) and hides disabled ones", async () => {
    const stub = env.CONTROL_PLANE.getByName("global")
    await stub.putConfig(`
oauth:
  excluded-models:
    codex: ["gpt-image-*"]
  model-alias:
    claude:
      - { name: claude-sonnet-4-5-20250929, alias: sonnet, fork: true }
`)
    await stub.importAuthFile(
      "claude-a.json",
      JSON.stringify({
        type: "claude",
        email: "a@x.com",
        access_token: "tok-secret-a",
        refresh_token: "ref-secret-a",
        prefix: "team"
      })
    )
    await stub.importAuthFile(
      "codex-a.json",
      JSON.stringify({ type: "codex", email: "c@x.com", access_token: "tok-secret-c", plan_type: "free" })
    )
    await stub.importAuthFile(
      "claude-off.json",
      JSON.stringify({ type: "claude", email: "off@x.com", access_token: "t", disabled: true })
    )

    const sources = await stub.listModelSources()
    expect(JSON.stringify(sources)).not.toContain("secret")
    expect(sources.find((candidate) => candidate.id === "codex-a.json")).toMatchObject({
      provider: "codex",
      executor: "codex",
      planType: "free",
      authKind: "oauth",
      compat: false
    })

    const handler = makeHandler(registry)
    try {
      const response = await caller(handler)("/v1/models")
      expect(response.status).toBe(200)
      const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id)
      expect(ids).toEqual(
        expect.arrayContaining([
          "team/sonnet",
          "sonnet",
          "team/claude-sonnet-4-5-20250929",
          "claude-sonnet-4-5-20250929",
          "gpt-5.5",
          "gpt-6-luna"
        ])
      )
      expect(ids).not.toContain("gpt-6-astra")
      expect(ids.some((id) => id.startsWith("gpt-image-"))).toBe(false)
    } finally {
      await handler.dispose()
    }
  })
})
