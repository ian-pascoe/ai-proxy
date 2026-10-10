// Port of corsMiddleware (internal/api/server_middleware.go:25-143).
import { Effect } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { classifyPath } from "../access/routes.ts";

/** Mirrors `corsExposedResponseHeaders` in internal/api/server_middleware.go. */
export const CORS_EXPOSED_RESPONSE_HEADERS = [
  "X-CPA-TRACE-ID",
  "X-CPA-VERSION",
  "X-CPA-COMMIT",
  "X-CPA-BUILD-DATE",
  "X-CPA-SUPPORT-PLUGIN",
  "X-CPA-HOME-VERSION",
  "X-CPA-HOME-BUILD-DATE",
  "X-SERVER-VERSION",
  "X-SERVER-BUILD-DATE",
  "Location",
  "Retry-After",
  "X-Request-Id",
  "OpenAI-Request-Id",
] as const;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": CORS_EXPOSED_RESPONSE_HEADERS.join(", "),
} as const;

/** Gin answers unknown routes with a plain-text 404. */
const notFound = HttpServerResponse.text("404 page not found", { status: 404 });

/**
 * Global middleware: every response (including 404s) carries the CORS headers, and `OPTIONS` requests are
 * answered with an empty 204 before routing.
 *
 * Deviation from Go: the management zone (`/v8/management*`, `/management.html`) gets no CORS headers at all, so other
 * origins can neither pass a preflight nor read a management response with an admin's Access cookie. The panel is
 * served by the Worker itself and does not need CORS.
 */
export const CorsLayer = HttpRouter.middleware<{ handles: HttpServerError.HttpServerError }>()(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const response =
        request.method === "OPTIONS"
          ? HttpServerResponse.empty({ status: 204 })
          : yield* app.pipe(
              Effect.catchTag("HttpServerError", (error) =>
                error.reason._tag === "RouteNotFound"
                  ? Effect.succeed(notFound)
                  : Effect.fail(error),
              ),
            );

      if (classifyPath(request.originalUrl) === "management") return response;

      return HttpServerResponse.setHeaders(response, corsHeaders);
    }),
  { global: true },
);
