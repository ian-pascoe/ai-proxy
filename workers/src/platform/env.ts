import { Context } from "effect"

/**
 * Cloudflare bindings (`env`) of the current Worker invocation.
 *
 * Provided per request through the `Context` handed to the web handler, never through a
 * long-lived layer: bindings must not be captured across requests.
 */
export class WorkerEnv extends Context.Service<WorkerEnv, Env>()("cliproxy/platform/WorkerEnv") {}

/** Cloudflare `ExecutionContext` (`waitUntil`, `passThroughOnException`) of the current invocation. */
export class WorkerExecutionContext extends Context.Service<WorkerExecutionContext, ExecutionContext>()(
  "cliproxy/platform/WorkerExecutionContext"
) {}

/** Builds the per-request context passed as the second argument of the web handler. */
export const requestContext = (env: Env, ctx: ExecutionContext): Context.Context<WorkerEnv | WorkerExecutionContext> =>
  Context.make(WorkerEnv, env).pipe(Context.add(WorkerExecutionContext, ctx))
