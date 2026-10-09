// Authentication of one request: Access JWT -> principal -> (for management) admin check. New in the Workers port.
import { Effect } from "effect"
import { ConfigurationError, ForbiddenError, InternalError, UnauthorizedError } from "../errors.ts"
import { WorkerEnv } from "../platform/env.ts"
import { devBypassEmail, isAdmin, loadAccessConfig } from "./config.ts"
import type { AccessIdentity, Principal } from "./principal.ts"
import { makeIdentity } from "./principal.ts"
import type { AccessJwks } from "./jwks.ts"
import type { AccessZone } from "./routes.ts"
import { verifyAccessJwt } from "./verify.ts"

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion"

export type AccessError = UnauthorizedError | ForbiddenError | InternalError | ConfigurationError

/**
 * Authenticates a request for the given zone.
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL (used by the dev bypass only).
 * Failures use the Go auth middleware wording (`Missing API key`, `Invalid API key`).
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">
): Effect.Effect<AccessIdentity, AccessError, WorkerEnv | AccessJwks> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv
    const bypassEmail = devBypassEmail(env, requestUrl)
    if (bypassEmail !== undefined) {
      // Local `wrangler dev` only; the bypass principal is an administrator.
      return yield* makeIdentity({ kind: "user", email: bypassEmail, sub: "dev-bypass" })
    }

    const config = yield* loadAccessConfig(env)
    const token = headers[ACCESS_JWT_HEADER]?.trim() ?? ""
    if (token === "") return yield* new UnauthorizedError({ message: "Missing API key" })

    const principal: Principal = yield* verifyAccessJwt(token, config)
    if (zone === "management" && !isAdmin(config, principal)) {
      return yield* new ForbiddenError({ message: "Forbidden" })
    }
    return yield* makeIdentity(principal)
  })
