import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { CorsLayer } from "./cors.ts"
import { RootRoutes } from "./routes.ts"

/** All routes and global middleware of the Worker. Later slices merge their route layers here. */
export const AppLayer = Layer.mergeAll(RootRoutes, CorsLayer)

/**
 * Creates the Web `Request` handler. Per-request services (`WorkerEnv`, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `platform/env.ts`.
 */
export const makeWebHandler = () => HttpRouter.toWebHandler(AppLayer, { disableLogger: true })
