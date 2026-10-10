// Test helpers: locally generated RSA keys, signed Access JWTs and a fake JWKS HTTP client.
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import type { JWK } from "jose"
import { AccessJwks } from "../../src/access/jwks.ts"

export const TEAM = "team.cloudflareaccess.com"

export const ISSUER = `https://${TEAM}`

export const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`

export const AUD = "aud-tag-1"

export interface TestKey {
  readonly kid: string
  readonly privateKey: CryptoKey
  readonly jwk: JWK
}

export const makeKey = async (kid: string): Promise<TestKey> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true })

  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } }
}

export interface TokenOptions {
  readonly key: TestKey
  /** Overrides the `kid` header (defaults to the key's kid). */
  readonly kid?: string
  readonly claims?: Record<string, unknown>
  readonly issuer?: string
  readonly audience?: string | ReadonlyArray<string>
  /** Seconds since epoch. */
  readonly now: number
  readonly expiresIn?: number
  readonly notBefore?: number
}

export const signToken = (options: TokenOptions): Promise<string> => {
  const jwt = new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? options.key.kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience([...(typeof options.audience === "string" ? [options.audience] : (options.audience ?? [AUD]))])
    .setIssuedAt(options.now)
    .setExpirationTime(options.now + (options.expiresIn ?? 3600))

  if (options.notBefore !== undefined) jwt.setNotBefore(options.notBefore)

  return jwt.sign(options.key.privateKey)
}

export const userClaims = (email: string) => ({ email, sub: `sub-${email}`, type: "app" })

export const serviceClaims = (commonName: string) => ({ common_name: commonName, sub: "", type: "app" })

/** Mutable state behind the fake JWKS endpoint. */
export interface FakeJwks {
  keys: Array<JWK>
  fetches: number
  fail: boolean
}

export const makeFakeJwks = (keys: ReadonlyArray<TestKey>): FakeJwks => ({
  keys: keys.map((key) => key.jwk),
  fetches: 0,
  fail: false
})

/** `AccessJwks` layer backed by a fake HttpClient serving `state`. */
export const fakeJwksLayer = (state: FakeJwks): Layer.Layer<AccessJwks> =>
  AccessJwks.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            state.fetches++
            const body = state.fail ? "boom" : JSON.stringify({ keys: state.keys, public_cert: {} })

            return HttpClientResponse.fromWeb(
              request,
              new Response(body, { status: state.fail ? 500 : 200, headers: { "content-type": "application/json" } })
            )
          })
        )
      )
    )
  )
