/**
 * Usage record sink. Records are collected per attempt by `UsageReporter` and handed to the sink once; persistence
 * (D1 via `ctx.waitUntil`) is implemented by the usage slice behind this interface.
 */
import { Context, Effect, Layer } from "effect"
import type { UsageRecord } from "./record.ts"

export class UsageSink extends Context.Service<
  UsageSink,
  {
    /** Must not fail or block the response; implementations defer slow work (e.g. `waitUntil`). */
    readonly publish: (record: UsageRecord) => Effect.Effect<void>
  }
>()("cliproxy/usage/UsageSink") {
  /** Drops records (until persistence lands). */
  static readonly noop = Layer.succeed(UsageSink, UsageSink.of({ publish: () => Effect.void }))

  /** Appends records to `records` (tests). */
  static readonly memory = (records: Array<UsageRecord>) =>
    Layer.succeed(
      UsageSink,
      UsageSink.of({
        publish: (record) =>
          Effect.sync(() => {
            records.push(record)
          })
      })
    )
}
