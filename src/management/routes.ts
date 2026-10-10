/**
 * Management API routes (`/v8/management/*`) and the control panels (`/management.html`, the `web/` panel at `/`).
 *
 * Go source: internal/api/server_management_v8.go (route table). Authorization is the Access admin gate
 * (`access/routes.ts`: the whole `/v8/management` prefix and `/management.html`), which replaces the Go management
 * key, IP ban and `allow-remote` logic. Routes that are not ported: plugins, Home, file logs (answered like Go with
 * file logging off), the deprecated `/v0/management` tree. OAuth login (`/oauth/*`) is in `oauth-routes.ts`; usage
 * (`/observability/usage/*`) is in `usage-routes.ts`.
 */
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  type HttpClient,
  HttpRouter,
  type HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import { routeServices } from "../http/route-services.ts";
import type { WorkerEnv } from "../platform/env.ts";
import { ModelRegistryLive } from "../registry/live.ts";
import type { ModelRegistry } from "../registry/service.ts";
import { apiCallHandler } from "./api-call.ts";
import { configRoutes } from "./config-routes.ts";
import { credentialModelsHandler, credentialRoutes } from "./credentials-routes.ts";
import { modelDefinitionsHandler } from "./model-definitions.ts";
import { oauthRoutes } from "./oauth-routes.ts";
import { panelHandler } from "./panel.ts";
import { quotaCheckHandler } from "./quota-routes.ts";
import { PANEL_PAGE_PATHS, webPanelAsset, webPanelPage } from "./web-panel.ts";
import { usageRoutes } from "./usage-routes.ts";
import {
  errorLogsHandler,
  latestVersionHandler,
  logsDisabledHandler,
  requestLogHandler,
} from "./server-routes.ts";

const BASE = "/v8/management";

/** All management routes; needs `ModelRegistry` and an `HttpClient`. */
export const ManagementRoutes = HttpRouter.addAll(
  Effect.gen(function* () {
    // Handlers run per request: bind the isolate-wide services once instead of leaking them into the request context.
    const services = yield* routeServices<ModelRegistry | HttpClient.HttpClient>();

    const bound = <
      R extends
        | ModelRegistry
        | HttpClient.HttpClient
        | WorkerEnv
        | HttpServerRequest.HttpServerRequest,
    >(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
    ) => Effect.provide(handler, services);

    return [
      ...configRoutes,
      ...credentialRoutes,
      ...usageRoutes,
      ...oauthRoutes,
      HttpRouter.route("GET", `${BASE}/credentials/models`, bound(credentialModelsHandler)),
      HttpRouter.route("POST", `${BASE}/credentials/quota`, bound(quotaCheckHandler)),
      HttpRouter.route("GET", `${BASE}/server/latest-version`, bound(latestVersionHandler)),
      HttpRouter.route("POST", `${BASE}/requests/api-call`, bound(apiCallHandler)),
      HttpRouter.route(
        "GET",
        `${BASE}/routing/model-definitions/*`,
        bound(modelDefinitionsHandler),
      ),
      HttpRouter.route("GET", `${BASE}/observability/logs`, logsDisabledHandler),
      HttpRouter.route("DELETE", `${BASE}/observability/logs`, logsDisabledHandler),
      HttpRouter.route("GET", `${BASE}/observability/logs/errors/*`, errorLogsHandler),
      HttpRouter.route("GET", `${BASE}/observability/logs/requests/*`, requestLogHandler),
      HttpRouter.route("GET", "/management.html", panelHandler),
      ...PANEL_PAGE_PATHS.map((path) => HttpRouter.route("GET", path, webPanelPage)),
      HttpRouter.route("GET", "/assets/*", webPanelAsset),
    ];
  }),
);

/** Production wiring: ControlPlane-backed model registry and the global `fetch`. Wrap with `withAccess(...)`. */
export const ManagementRoutesLive = ManagementRoutes.pipe(
  Layer.provide(Layer.mergeAll(ModelRegistryLive, FetchHttpClient.layer)),
);
