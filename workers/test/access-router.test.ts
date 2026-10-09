import { env, exports } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeAccessLayer, makeWithAccess } from "../src/access/layer.ts"
import { AccessPrincipal } from "../src/access/principal.ts"
import { RootRoutes } from "../src/http/routes.ts"
import { requestContext } from "../src/platform/env.ts"
import { AUD, fakeJwksLayer, makeFakeJwks, makeKey, serviceClaims, signToken, userClaims } from "./support/access.ts"

const key = await makeKey("router-kid")

const whoami = Effect.gen(function* () {
  const identity = yield* AccessPrincipal
  return HttpServerResponse.text(JSON.stringify(identity.principal) + "|" + identity.callerScope.slice(0, 8))
})

// Stand-ins for the real handlers of later slices, one per gated prefix.
const TestRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/models", whoami),
  HttpRouter.add("POST", "/v1/chat/completions", whoami),
  HttpRouter.add("GET", "/v1beta/models", whoami),
  HttpRouter.add("GET", "/openai/v1/videos", whoami),
  HttpRouter.add("POST", "/backend-api/codex/responses", whoami),
  HttpRouter.add("GET", "/v8/management/config", whoami)
)

const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  ACCESS_ADMIN_EMAILS: "admin@example.com",
  ACCESS_ADMIN_SERVICE_TOKENS: "admin.access",
  ACCESS_DEV_BYPASS: ""
}

const ctx = {} as unknown as ExecutionContext

const makeHandler = () => {
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])))
  return HttpRouter.toWebHandler(Layer.mergeAll(RootRoutes, access, makeWithAccess(access)(TestRoutes)), {
    disableLogger: true
  })
}

const withToken = async (claims: Record<string, unknown>): Promise<RequestInit> => ({
  headers: { "Cf-Access-Jwt-Assertion": await jwt(claims) }
})
const now = () => Math.floor(Date.now() / 1000)
const jwt = (claims: Record<string, unknown>) => signToken({ key, now: now(), claims })

describe("Access gate through the router", () => {
  const { handler, dispose } = makeHandler()
  afterAll(dispose)

  const call = (path: string, init: RequestInit = {}, bindings: Env = accessEnv, base = "https://proxy.test") =>
    handler(new Request(`${base}${path}`, init), requestContext(bindings, ctx))

  it("keeps /healthz and / public", async () => {
    expect((await call("/healthz")).status).toBe(200)
    const root = await call("/")
    expect(root.status).toBe(200)
    expect((await call("/nope")).status).toBe(404)
  })

  it.each([
    ["GET", "/v1/models"],
    ["POST", "/v1/chat/completions"],
    ["GET", "/v1beta/models"],
    ["GET", "/openai/v1/videos"],
    ["POST", "/backend-api/codex/responses"],
    ["GET", "/v8/management/config"]
  ])("rejects %s %s without a token (flat Go-style body, CORS headers kept)", async (method, path) => {
    const response = await call(path, { method })
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(await response.text()).toBe('{"error":"Missing API key"}')
  })

  it("rejects malformed and foreign tokens with Invalid API key", async () => {
    const malformed = await call("/v1/models", { headers: { "cf-access-jwt-assertion": "garbage" } })
    expect(malformed.status).toBe(401)
    expect(await malformed.text()).toBe('{"error":"Invalid API key"}')

    const other = await makeKey("router-kid")
    const forged = await signToken({ key: other, now: now(), claims: userClaims("alice@example.com") })
    expect((await call("/v1/models", { headers: { "cf-access-jwt-assertion": forged } })).status).toBe(401)

    const wrongAud = await signToken({ key, now: now(), claims: userClaims("a@x.com"), audience: "nope" })
    expect((await call("/v1/models", { headers: { "cf-access-jwt-assertion": wrongAud } })).status).toBe(401)
  })

  it("passes a valid user token to the handler with the principal", async () => {
    const response = await call("/v1/models", await withToken(userClaims("alice@example.com")))
    expect(response.status).toBe(200)
    const [principal, scope] = (await response.text()).split("|")
    expect(JSON.parse(principal ?? "")).toEqual({
      kind: "user",
      email: "alice@example.com",
      sub: "sub-alice@example.com"
    })
    expect(scope).toBe("21cd36b0")
  })

  it("accepts service tokens on proxy routes", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      ...(await withToken(serviceClaims("some.access")))
    })
    expect(response.status).toBe(200)
    expect((await response.text()).startsWith('{"kind":"service","commonName":"some.access"}')).toBe(true)
  })

  it("answers CORS preflights without authentication", async () => {
    const response = await call("/v1/models", { method: "OPTIONS", headers: { origin: "https://x.test" } })
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("does not let alternative path spellings bypass the gate", async () => {
    for (const path of ["//v1/models", "/%76%31/models", "/V1/models", "/./v1/models", "/a/../v1/models"]) {
      const response = await call(path)
      expect([401, 404], path).toContain(response.status)
      expect(await response.text()).not.toContain("kind")
    }
  })

  it("enforces the admin allow-list on management routes", async () => {
    const alice = await call("/v8/management/config", await withToken(userClaims("alice@example.com")))
    expect(alice.status).toBe(403)
    expect(await alice.text()).toBe('{"error":"Forbidden"}')

    const admin = await call("/v8/management/config", await withToken(userClaims("Admin@Example.com")))
    expect(admin.status).toBe(200)

    const adminService = await call("/v8/management/config", await withToken(serviceClaims("admin.access")))
    expect(adminService.status).toBe(200)

    const otherService = await call("/v8/management/config", await withToken(serviceClaims("other.access")))
    expect(otherService.status).toBe(403)
  })

  it("fails closed with 500 when Access is not configured", async () => {
    const response = await call("/v1/models", await withToken(userClaims("alice@example.com")), {
      ...accessEnv,
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: ""
    })
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('{"error":"Authentication service error"}')
    expect((await call("/healthz", {}, { ...accessEnv, ACCESS_TEAM_DOMAIN: "" })).status).toBe(200)
  })

  it("dev bypass works for loopback hosts only", async () => {
    const dev = { ...accessEnv, ACCESS_DEV_BYPASS: "true" }
    const local = await call("/v8/management/config", {}, dev, "http://localhost:8787")
    expect(local.status).toBe(200)
    expect(await local.text()).toContain('"email":"dev@localhost"')
    const remote = await call("/v8/management/config", {}, dev)
    expect(remote.status).toBe(401)
  })
})

const fetchWorker = (path: string) => exports.default.fetch(new Request(`https://proxy.test${path}`))

describe("Worker entry point", () => {
  it("serves public routes and gates protected ones (unconfigured defaults fail closed)", async () => {
    expect((await fetchWorker("/healthz")).status).toBe(200)
    const response = await fetchWorker("/v1/models")
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('{"error":"Authentication service error"}')
  })
})
