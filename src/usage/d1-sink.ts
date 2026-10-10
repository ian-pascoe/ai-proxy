/**
 * `UsageSink` backed by D1 (binding `USAGE`). Writes run in `ctx.waitUntil`, so they never delay or fail a response;
 * a failed write is logged (request id and error message only) and the record is dropped.
 *
 * Go counterpart: the `usage.Plugin` registered by internal/redisqueue (HandleUsage -> Enqueue).
 */
import { Context, Effect, Layer } from "effect"
import { WorkerEnv, WorkerExecutionContext } from "../platform/env.ts"
import { insertUsageRecord } from "./d1.ts"
import type { UsageRecord } from "./record.ts"
import { UsageSink } from "./sink.ts"

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Writes `record` and logs (request id and error message only, never the record) instead of failing. */
export const writeUsageRecord = (db: D1Database, record: UsageRecord): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => insertUsageRecord(db, record), catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("usage record write failed").pipe(
        Effect.annotateLogs({ requestId: record.requestId, error: errorMessage(error) })
      )
    )
  )

export const D1UsageSink = Layer.succeed(
  UsageSink,
  UsageSink.of({
    publish: (record) =>
      Effect.contextWith((context: Context.Context<never>) => {
        // The bindings are per-request services of the invocation, resolved here and never captured by the layer.
        const env = Context.getOrUndefined(context, WorkerEnv)
        const db = env?.USAGE

        if (db === undefined) return Effect.void
        // Runs detached from the response (and possibly after it), keeping the invocation's context (loggers).
        const write = Effect.runPromiseWith(context)(writeUsageRecord(db, record))
        const ctx = Context.getOrUndefined(context, WorkerExecutionContext)

        if (ctx !== undefined) {
          try {
            ctx.waitUntil(write)

            return Effect.void
          } catch {
            // waitUntil is unavailable (invocation already finished): fall through and await the write.
          }
        }

        return Effect.promise(() => write)
      })
  })
)
