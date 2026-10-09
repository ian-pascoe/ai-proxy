import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { authenticateRequest } from "../src/access/authenticate.ts"
import { configAdminLists, devBypass, devBypassEmail, isAdmin, loadAccessConfig } from "../src/access/config.ts"
import { JWKS_REFRESH_COOLDOWN_MS } from "../src/access/jwks.ts"
import { callerScope, makeIdentity, principalId } from "../src/access/principal.ts"
import { classifyPath } from "../src/access/routes.ts"
import { verifyAccessJwt } from "../src/access/verify.ts"
import { requestContext } from "../src/platform/env.ts"
import {
  AUD,
  fakeJwksLayer,
  ISSUER,
  JWKS_URL,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  userClaims
} from "./support/access.ts"
import type { FakeJwks, TestKey } from "./support/access.ts"
import { env } from "cloudflare:workers"

const NOW_MS = 1_700_000_000_000
const NOW = NOW_MS / 1000
const config = { issuer: ISSUER, jwksUrl: JWKS_URL, audiences: [AUD] }

const keyA = await makeKey("kid-a")
const keyB = await makeKey("kid-b")

/** Runs `body` at a fixed virtual time with one JWKS cache shared by every verification inside it. */
const withJwks = <A, E>(
  state: FakeJwks,
  body: Effect.Effect<A, E, import("../src/access/jwks.ts").AccessJwks>
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS)
    return yield* body.pipe(Effect.provide(fakeJwksLayer(state)))
  })

const token = (key: TestKey, overrides: Partial<Parameters<typeof signToken>[0]> = {}) =>
  Effect.promise(() => signToken({ key, now: NOW, claims: userClaims("alice@example.com"), ...overrides }))

describe("verifyAccessJwt", () => {
  it.effect("accepts a valid user token", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const principal = yield* verifyAccessJwt(yield* token(keyA), config)
        assert.deepStrictEqual(principal, { kind: "user", email: "alice@example.com", sub: "sub-alice@example.com" })
      })
    )
  )

  it.effect("accepts a valid service token", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { claims: serviceClaims("abc123.access") })
        const principal = yield* verifyAccessJwt(jwt, config)
        assert.deepStrictEqual(principal, { kind: "service", commonName: "abc123.access" })
      })
    )
  )

  it.effect("accepts any configured audience and tokens with several aud values", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { audience: ["other", "aud-tag-2"] })
        const principal = yield* verifyAccessJwt(jwt, { ...config, audiences: [AUD, "aud-tag-2"] })
        assert.strictEqual(principal.kind, "user")
      })
    )
  )

  it.effect("rejects a wrong audience", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyAccessJwt(yield* token(keyA, { audience: "nope" }), config))
        assert.strictEqual(error._tag, "UnauthorizedError")
        assert.strictEqual(error.message, "Invalid API key")
      })
    )
  )

  it.effect("rejects a wrong issuer", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { issuer: "https://evil.cloudflareaccess.com" })
        const error = yield* Effect.flip(verifyAccessJwt(jwt, config))
        assert.strictEqual(error._tag, "UnauthorizedError")
      })
    )
  )

  it.effect("rejects an expired token but tolerates small clock skew", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        // exp = now - 10s: inside the 30s skew.
        const skewed = yield* token(keyA, { now: NOW - 3610 })
        assert.strictEqual((yield* verifyAccessJwt(skewed, config)).kind, "user")
        // exp = now - 120s: expired.
        const expired = yield* token(keyA, { now: NOW - 3720 })
        assert.strictEqual((yield* Effect.flip(verifyAccessJwt(expired, config)))._tag, "UnauthorizedError")
      })
    )
  )

  it.effect("rejects a token that is not valid yet (nbf)", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const future = yield* token(keyA, { notBefore: NOW + 300 })
        assert.strictEqual((yield* Effect.flip(verifyAccessJwt(future, config)))._tag, "UnauthorizedError")
        const nearFuture = yield* token(keyA, { notBefore: NOW + 10 })
        assert.strictEqual((yield* verifyAccessJwt(nearFuture, config)).kind, "user")
      })
    )
  )

  it.effect("rejects a token signed by a different key with a known kid", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const forged = yield* token(keyB, { kid: "kid-a" })
        assert.strictEqual((yield* Effect.flip(verifyAccessJwt(forged, config)))._tag, "UnauthorizedError")
      })
    )
  )

  it.effect("rejects malformed tokens and tokens without claims identifying a principal", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        for (const bad of ["", "not-a-jwt", "a.b.c", "eyJhbGciOiJub25lIn0.e30."]) {
          assert.strictEqual((yield* Effect.flip(verifyAccessJwt(bad, config)))._tag, "UnauthorizedError")
        }
        const anonymous = yield* token(keyA, { claims: {} })
        assert.strictEqual((yield* Effect.flip(verifyAccessJwt(anonymous, config)))._tag, "UnauthorizedError")
      })
    )
  )

  it.effect("refetches the JWKS for an unknown kid, at most once per cooldown", () => {
    const state = makeFakeJwks([keyA])
    return withJwks(
      state,
      Effect.gen(function* () {
        yield* verifyAccessJwt(yield* token(keyA), config)
        assert.strictEqual(state.fetches, 1)

        // Key rotation: B is published after the first fetch. Inside the cooldown the unknown kid is rejected
        // without hitting the endpoint.
        state.keys = [keyA.jwk, keyB.jwk]
        const early = yield* Effect.flip(verifyAccessJwt(yield* token(keyB), config))
        assert.strictEqual(early._tag, "UnauthorizedError")
        assert.strictEqual(state.fetches, 1)

        yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS + 1)
        const principal = yield* verifyAccessJwt(yield* token(keyB, { now: NOW + 31 }), config)
        assert.strictEqual(principal.kind, "user")
        assert.strictEqual(state.fetches, 2)

        // Known kids are served from the cache.
        yield* verifyAccessJwt(yield* token(keyA, { now: NOW + 31 }), config)
        assert.strictEqual(state.fetches, 2)
      })
    )
  })

  it.effect("fails with InternalError when the JWKS cannot be fetched, and recovers", () => {
    const state = makeFakeJwks([keyA])
    state.fail = true
    return withJwks(
      state,
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyAccessJwt(yield* token(keyA), config))
        assert.strictEqual(error._tag, "InternalError")
        state.fail = false
        assert.strictEqual((yield* verifyAccessJwt(yield* token(keyA), config)).kind, "user")
      })
    )
  })

  it.effect("keeps serving cached keys when a refresh fails", () => {
    const state = makeFakeJwks([keyA])
    return withJwks(
      state,
      Effect.gen(function* () {
        yield* verifyAccessJwt(yield* token(keyA), config)
        state.fail = true
        yield* TestClock.adjust(11 * 60_000)
        const jwt = yield* token(keyA, { now: NOW + 660 })
        assert.strictEqual((yield* verifyAccessJwt(jwt, config)).kind, "user")
        assert.strictEqual(state.fetches, 2)
      })
    )
  })
})

describe("authenticateRequest", () => {
  const testEnv = {
    ...env,
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_AUD: AUD,
    ACCESS_ADMIN_EMAILS: "Admin@Example.com",
    ACCESS_ADMIN_SERVICE_TOKENS: "admin.access"
  }
  const context = requestContext(testEnv, {} as unknown as ExecutionContext)
  const run = <A, E>(
    state: FakeJwks,
    body: Effect.Effect<A, E, import("../src/platform/env.ts").WorkerEnv | import("../src/access/jwks.ts").AccessJwks>
  ) => withJwks(state, body.pipe(Effect.provideContext(context)))

  it.effect("fails with Missing API key when the header is absent", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const error = yield* Effect.flip(authenticateRequest({}, "https://proxy.test/v1/models", "protected"))
        assert.strictEqual(error._tag, "UnauthorizedError")
        assert.strictEqual(error.message, "Missing API key")
      })
    )
  )

  it.effect("derives the identity and enforces the admin allow-list for management", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const url = "https://proxy.test/v8/management/config"
        const alice = { "cf-access-jwt-assertion": yield* token(keyA) }
        const identity = yield* authenticateRequest(alice, url, "protected")
        assert.strictEqual(identity.principalId, "user:alice@example.com")
        assert.strictEqual(identity.callerScope, "21cd36b03d03c619f37e1df80f5e22b7c4c9319b4e8151ea93327b51520a06e9")
        assert.strictEqual((yield* Effect.flip(authenticateRequest(alice, url, "management")))._tag, "ForbiddenError")

        const admin = { "cf-access-jwt-assertion": yield* token(keyA, { claims: userClaims("ADMIN@example.com") }) }
        assert.strictEqual((yield* authenticateRequest(admin, url, "management")).principal.kind, "user")

        const svc = { "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("admin.access") }) }
        assert.strictEqual((yield* authenticateRequest(svc, url, "management")).principalId, "service:admin.access")
        const other = { "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("other.access") }) }
        assert.strictEqual((yield* Effect.flip(authenticateRequest(other, url, "management")))._tag, "ForbiddenError")
      })
    )
  )

  it.effect("extends the env admins with the config document's access.admin-* keys", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const url = "https://proxy.test/v8/management/config"
        const lists = configAdminLists({
          access: { "api-keys": [], "admin-emails": [" Carol@Example.com "], "admin-service-tokens": ["cfg.access"] }
        })
        let reads = 0
        const extra = Effect.sync(() => {
          reads++
          return lists
        })
        const carol = { "cf-access-jwt-assertion": yield* token(keyA, { claims: userClaims("carol@example.com") }) }
        assert.strictEqual(
          (yield* authenticateRequest(carol, url, "management", extra)).principalId,
          "user:carol@example.com"
        )
        assert.strictEqual((yield* Effect.flip(authenticateRequest(carol, url, "management")))._tag, "ForbiddenError")
        const svc = { "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("cfg.access") }) }
        assert.strictEqual(
          (yield* authenticateRequest(svc, url, "management", extra)).principalId,
          "service:cfg.access"
        )
        // Env admins never need the config (an admin can always repair a broken document).
        reads = 0
        const admin = { "cf-access-jwt-assertion": yield* token(keyA, { claims: userClaims("admin@example.com") }) }
        const broken = Effect.fail("control plane down")
        assert.strictEqual((yield* authenticateRequest(admin, url, "management", broken)).principal.kind, "user")
        // A config that cannot be read denies everyone else.
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(carol, url, "management", broken)))._tag,
          "ForbiddenError"
        )
        assert.strictEqual(reads, 0)
      })
    )
  )

  it.effect("fails closed with a configuration error when Access is not configured", () =>
    withJwks(
      makeFakeJwks([keyA]),
      authenticateRequest({}, "https://proxy.test/v1/models", "protected").pipe(
        Effect.provideContext(
          requestContext({ ...env, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }, {} as unknown as ExecutionContext)
        ),
        Effect.flip,
        Effect.map((error) => assert.strictEqual(error._tag, "ConfigurationError"))
      )
    )
  )
})

describe("principal", () => {
  it.effect("callerScope mirrors the Go derivation", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callerScope("user:alice@example.com"),
        "21cd36b03d03c619f37e1df80f5e22b7c4c9319b4e8151ea93327b51520a06e9"
      )
      assert.strictEqual(
        yield* callerScope("service:abc.access"),
        "84a7bf2e7053ab5a89f0f60fc4e2fc30abb4cf0284421d8bb85ff4d38254733a"
      )
      assert.strictEqual(yield* callerScope("  "), "")
      const identity = yield* makeIdentity({ kind: "service", commonName: "abc.access" })
      assert.strictEqual(identity.callerScope, "84a7bf2e7053ab5a89f0f60fc4e2fc30abb4cf0284421d8bb85ff4d38254733a")
    })
  )

  it("principalId lowercases emails", () => {
    expect(principalId({ kind: "user", email: "Alice@Example.COM", sub: "s" })).toBe("user:alice@example.com")
  })
})

describe("config", () => {
  const base = { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ACCESS_ADMIN_EMAILS: "", ACCESS_ADMIN_SERVICE_TOKENS: "" }

  it.effect("normalises the team domain and splits the lists", () =>
    Effect.gen(function* () {
      const loaded = yield* loadAccessConfig({
        ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
        ACCESS_AUD: "a1, a2\nb3",
        ACCESS_ADMIN_EMAILS: "One@x.com,two@x.com",
        ACCESS_ADMIN_SERVICE_TOKENS: "t1.access"
      })
      assert.strictEqual(loaded.issuer, "https://team.cloudflareaccess.com")
      assert.strictEqual(loaded.jwksUrl, "https://team.cloudflareaccess.com/cdn-cgi/access/certs")
      assert.deepStrictEqual(loaded.audiences, ["a1", "a2", "b3"])
      assert.isTrue(isAdmin(loaded, { kind: "user", email: "ONE@x.com", sub: "" }))
      assert.isFalse(isAdmin(loaded, { kind: "user", email: "three@x.com", sub: "" }))
      assert.isTrue(isAdmin(loaded, { kind: "service", commonName: "t1.access" }))
      const short = yield* loadAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "a" })
      assert.strictEqual(short.issuer, "https://team.cloudflareaccess.com")
    })
  )

  it.effect("rejects missing or invalid settings", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.flip(loadAccessConfig(base)))._tag, "ConfigurationError")
      const noAud = loadAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: "team" })
      assert.strictEqual((yield* Effect.flip(noAud))._tag, "ConfigurationError")
      const badHost = loadAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: "evil.com/path?x", ACCESS_AUD: "a" })
      assert.strictEqual((yield* Effect.flip(badHost))._tag, "ConfigurationError")
    })
  )

  it("dev bypass is honoured for loopback hosts only", () => {
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "" }, "http://localhost:8787/v1/models")).toBeUndefined()
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "http://localhost:8787/v1/models")).toBe("dev@localhost")
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "me@x.com" }, "http://127.0.0.1:8787/")).toBe("me@x.com")
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "https://proxy.example.com/v1/models")).toBeUndefined()
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "https://localhost.evil.com/v1/models")).toBeUndefined()
    // Never once Access is configured.
    const configured = { ACCESS_DEV_BYPASS: "true", ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "" }
    expect(devBypassEmail(configured, "http://localhost:8787/v1/models")).toBeUndefined()
    expect(devBypass(configured, "http://localhost:8787/v1/models")).toEqual({ _tag: "Refused" })
    expect(devBypass({ ACCESS_DEV_BYPASS: "1", ACCESS_AUD: "aud" }, "http://127.0.0.1/")).toEqual({ _tag: "Refused" })
    expect(devBypass({ ACCESS_DEV_BYPASS: "1", ACCESS_AUD: " " }, "http://127.0.0.1/")).toEqual({
      _tag: "Active",
      email: "dev@localhost"
    })
  })
})

describe("classifyPath", () => {
  it("classifies public, protected and management paths", () => {
    expect(classifyPath("https://x.test/healthz")).toBe("public")
    expect(classifyPath("https://x.test/")).toBe("public")
    expect(classifyPath("https://x.test/nope")).toBe("public")
    for (const path of [
      "/v1/chat/completions",
      "/v1",
      "/v1beta/models/gemini:generateContent",
      "/v1internal:generateContent",
      "/openai/v1/videos",
      "/backend-api/codex/responses"
    ]) {
      expect(classifyPath(`https://x.test${path}?q=1`)).toBe("protected")
    }
    expect(classifyPath("https://x.test/v8/management/config")).toBe("management")
  })

  it("is not fooled by alternative spellings", () => {
    expect(classifyPath("https://x.test//v1/models")).toBe("protected")
    expect(classifyPath("https://x.test/V1/models")).toBe("protected")
    expect(classifyPath("https://x.test/%76%31/models")).toBe("protected")
    expect(classifyPath("https://x.test/a/../v1/models")).toBe("protected")
    expect(classifyPath("https://x.test/V8/Management/x")).toBe("management")
    expect(classifyPath("https://x.test/%2576%31/models")).toBe("public")
  })
})
