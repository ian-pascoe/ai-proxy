import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { AccessLayer } from "../access/layer.ts"
import { ProxyLayer } from "../handlers/layer.ts"
import { RootRoutes } from "./routes.ts"

/**
 * All routes and global middleware of the Worker. Later slices merge their route layers here. Route layers whose
 * handlers use `AccessPrincipal` are wrapped with `withAccess(...)` (src/access/layer.ts); protected prefixes are
 * authenticated by `AccessLayer` regardless.
 */
export const AppLayer = Layer.mergeAll(RootRoutes, AccessLayer, ProxyLayer)

/**
 * Creates the Web `Request` handler. Per-request services (`WorkerEnv`, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `platform/env.ts`.
 */
export const makeWebHandler = () => HttpRouter.toWebHandler(AppLayer, { disableLogger: true })
