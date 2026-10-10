/**
 * Usage record sink. Records are collected per attempt by `UsageReporter` and handed to the sink once; the production
 * sink (`d1-sink.ts`) persists them to D1 through `ctx.waitUntil`. It reads the per-request `WorkerEnv` and
 * `WorkerExecutionContext` from the fiber context when publishing (never captured in the layer); the requirement is
 * deliberately not part of the type so the conductor's attempt plumbing stays unchanged.
 */
import { Context, Effect, Layer } from "effect";
import type { UsageRecord } from "./record.ts";

export class UsageSink extends Context.Service<
  UsageSink,
  {
    /** Must not fail or block the response; implementations defer slow work (e.g. `waitUntil`). */
    readonly publish: (record: UsageRecord) => Effect.Effect<void>;
  }
>()("cliproxy/usage/UsageSink") {
  /** Drops records. */
  static readonly noop = Layer.succeed(UsageSink, UsageSink.of({ publish: () => Effect.void }));

  /** Appends records to `records` (tests). */
  static readonly memory = (records: Array<UsageRecord>) =>
    Layer.succeed(
      UsageSink,
      UsageSink.of({
        publish: (record) =>
          Effect.sync(() => {
            records.push(record);
          }),
      }),
    );
}
