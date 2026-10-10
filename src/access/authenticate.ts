// Authentication of one request: Access JWT -> principal -> (for management) admin check. New in the Workers port.
import { Effect } from "effect";
import { ConfigurationError, ForbiddenError, InternalError, UnauthorizedError } from "../errors.ts";
import { WorkerEnv } from "../platform/env.ts";
import { type AdminLists, devBypass, isAdmin, loadAccessConfig } from "./config.ts";
import type { AccessIdentity, Principal } from "./principal.ts";
import { makeIdentity } from "./principal.ts";
import type { AccessJwks } from "./jwks.ts";
import type { AccessZone } from "./routes.ts";
import { verifyAccessJwt } from "./verify.ts";

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type AccessError = UnauthorizedError | ForbiddenError | InternalError | ConfigurationError;

/** Additional admin allow-lists (the config document's `access.admin-*`); a failure only denies, never errors. */
export type ExtraAdmins = Effect.Effect<AdminLists, unknown, WorkerEnv>;

let devBypassRefusalLogged = false;

/** Logs (once per isolate) that `ACCESS_DEV_BYPASS` is set on a Worker that has Access configured. */
const warnDevBypassRefused = Effect.suspend(() => {
  if (devBypassRefusalLogged) return Effect.void;
  devBypassRefusalLogged = true;

  return Effect.logWarning(
    "ACCESS_DEV_BYPASS is ignored because ACCESS_TEAM_DOMAIN/ACCESS_AUD are set; remove it from this environment",
  );
});

/** The env admins first (no I/O); the config admins only for principals that are not env admins. */
const isAdminPrincipal = (env: AdminLists, principal: Principal, extra: ExtraAdmins | undefined) =>
  Effect.gen(function* () {
    if (isAdmin(env, principal)) return true;

    if (extra === undefined) return false;
    const lists = yield* Effect.result(extra);

    if (lists._tag === "Failure") {
      yield* Effect.logWarning("config admin allow-list unavailable; only ACCESS_ADMIN_* apply");

      return false;
    }

    return isAdmin(lists.success, principal);
  });

/**
 * Authenticates a request for the given zone.
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL (used by the dev bypass only).
 * `extraAdmins` extends the env admin allow-lists for the management zone. Failures use the Go auth middleware
 * wording (`Missing API key`, `Invalid API key`).
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
  extraAdmins?: ExtraAdmins,
): Effect.Effect<AccessIdentity, AccessError, WorkerEnv | AccessJwks> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const bypass = devBypass(env, requestUrl);

    if (bypass?._tag === "Active") {
      // Local `alchemy dev` only; the bypass principal is an administrator.
      return yield* makeIdentity({ kind: "user", email: bypass.email, sub: "dev-bypass" });
    }

    if (bypass?._tag === "Refused") yield* warnDevBypassRefused;

    const config = yield* loadAccessConfig(env);
    const token = headers[ACCESS_JWT_HEADER]?.trim() ?? "";

    if (token === "") return yield* new UnauthorizedError({ message: "Missing API key" });

    const principal: Principal = yield* verifyAccessJwt(token, config);

    if (zone === "management" && !(yield* isAdminPrincipal(config, principal, extraAdmins))) {
      return yield* new ForbiddenError({ message: "Forbidden" });
    }

    return yield* makeIdentity(principal);
  });
