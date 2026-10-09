/**
 * Cron dispatch (`scheduled` handler). The Worker has a single three-hourly trigger (wrangler.jsonc); every
 * maintenance job registers itself in `scheduledTasks` so slices add a line instead of editing `index.ts`.
 *
 * Jobs run one after another and are isolated: a failing job is logged and does not stop the others.
 */
import { Cause, Effect, Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { ConfigReader } from "./config/reader.ts"
import { WorkerEnv, WorkerExecutionContext } from "./platform/env.ts"
import { CatalogStore } from "./registry/catalog-store.ts"
import { refreshCatalogs } from "./registry/refresh.ts"

/** Services available to scheduled jobs (provided by {@link ScheduledLayer} and the invocation's bindings). */
export type ScheduledServices = HttpClient.HttpClient | ConfigReader | CatalogStore | WorkerEnv | WorkerExecutionContext

export interface ScheduledTask {
  readonly name: string
  readonly run: Effect.Effect<unknown, unknown, ScheduledServices>
}

export const scheduledTasks: ReadonlyArray<ScheduledTask> = [
  // internal/registry catalog updaters (3 h): general, Codex client and Devin catalogs into KV.
  { name: "model-catalog-refresh", run: refreshCatalogs },
  // Credential refresh safety sweep: re-arms the ControlPlane refresh alarm.
  {
    name: "credential-refresh-sweep",
    run: Effect.gen(function* () {
      const env = yield* WorkerEnv
      yield* Effect.promise(() => env.CONTROL_PLANE.getByName("global").sweepRefresh())
    })
  }
]

export const ScheduledLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  ConfigReader.layerControlPlane(),
  CatalogStore.layer
)

/** Runs all jobs for one cron invocation. */
export const runScheduledTasks = (
  tasks: ReadonlyArray<ScheduledTask>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> =>
  Effect.forEach(
    tasks,
    (task) =>
      task.run.pipe(
        Effect.catchCause((cause) => Effect.logError(`scheduled task ${task.name} failed: ${Cause.pretty(cause)}`))
      ),
    { discard: true }
  ).pipe(
    Effect.provide(ScheduledLayer),
    Effect.provideService(WorkerEnv, env),
    Effect.provideService(WorkerExecutionContext, ctx),
    Effect.runPromise
  )

export const dispatchScheduled = (_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> =>
  runScheduledTasks(scheduledTasks, env, ctx)
