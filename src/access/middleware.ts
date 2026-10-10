// Router middleware gating the proxy and management routes (mirrors AuthMiddleware in
// internal/api/server_middleware.go: flat `{"error": "..."}` bodies).
import { Effect, Match, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ConfigReader } from "../config/reader.ts";
import { authenticateRequest } from "./authenticate.ts";
import type { AccessError } from "./authenticate.ts";
import { configAdminLists } from "./config.ts";
import { crossSiteRejection } from "./csrf.ts";
import { AccessJwks } from "./jwks.ts";
import { AccessPrincipal } from "./principal.ts";
import type { AccessIdentity, Principal } from "./principal.ts";
import { classifyPath } from "./routes.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const noPrincipal = (): never => {
  throw new Error("AccessPrincipal is not available on public routes");
};

/**
 * Identity provided on public routes, which have no caller. The router types every handler as possibly requiring
 * `AccessPrincipal`, but only route layers wrapped with `withAccess` (all under protected prefixes) read it; reading
 * any field here is a defect, like a missing service.
 */
const PUBLIC_ROUTE_IDENTITY: AccessIdentity = {
  get principal(): Principal {
    return noPrincipal();
  },
  get principalId(): string {
    return noPrincipal();
  },
  get callerScope(): string {
    return noPrincipal();
  },
};

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.text(JSON.stringify({ error: message }), {
    status,
    contentType: JSON_CONTENT_TYPE,
  });

/** Maps an authentication failure to a response; server-side failures are logged without details a client could use. */
export const accessErrorResponse = (
  error: AccessError,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  return Match.value(error).pipe(
    Match.tag("UnauthorizedError", (denied) => Effect.succeed(errorResponse(401, denied.message))),
    Match.tag("ForbiddenError", (denied) => Effect.succeed(errorResponse(403, denied.message))),
    Match.orElse((failure) =>
      Effect.logError(`authentication middleware error: ${failure._tag}: ${failure.message}`).pipe(
        Effect.as(errorResponse(500, "Authentication service error")),
      ),
    ),
  );
};

/**
 * Global middleware: requests under the protected prefixes (see `routes.ts`) must carry a valid Access JWT, and
 * `/v8/management*` additionally needs an admin principal (`ACCESS_ADMIN_*` env lists plus the config document's
 * `access.admin-*` keys). Cross-site requests and cross-origin WebSocket upgrades are refused first (`csrf.ts`).
 * Everything else (`/healthz`, `/`, unknown paths) is passed through untouched. On success the principal is available
 * to handlers as `AccessPrincipal`.
 *
 * Register it after `CorsLayer` so that 401/403 responses still carry CORS headers and preflights are not gated.
 */
export const AccessGate = HttpRouter.middleware<{ provides: AccessPrincipal }>()(
  Effect.gen(function* () {
    // Resolved when the layer is built (once per isolate); `WorkerEnv` stays a per-request service.
    const jwks = yield* AccessJwks;
    const reader = yield* ConfigReader;

    const configAdmins = reader.get.pipe(
      Effect.map((snapshot) => configAdminLists(snapshot.config)),
    );

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const zone = classifyPath(request.originalUrl);

        if (zone === "public") {
          return yield* Effect.provideService(app, AccessPrincipal, PUBLIC_ROUTE_IDENTITY);
        }

        const rejection = crossSiteRejection(
          request.method,
          request.headers,
          request.originalUrl,
          zone,
        );

        if (rejection !== undefined) return errorResponse(rejection.status, rejection.message);

        const authenticated = yield* Effect.result(
          authenticateRequest(request.headers, request.originalUrl, zone, configAdmins).pipe(
            Effect.provideService(AccessJwks, jwks),
          ),
        );

        if (Result.isFailure(authenticated))
          return yield* accessErrorResponse(authenticated.failure);

        return yield* Effect.provideService(app, AccessPrincipal, authenticated.success);
      });
  }),
  { global: true },
);
