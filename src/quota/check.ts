/**
 * One quota check end to end, from the Worker: the ControlPlane resolves the credential and its fresh token
 * (`quotaProbeTarget`), the Worker calls the provider usage endpoint (src/quota/probe.ts) and the ControlPlane merges
 * the outcome into the stored report (`recordQuotaReport`). Used by `POST /v8/management/credentials/quota` and the
 * `quota-check` cron task (`runQuotaSweep`).
 *
 * The upstream call runs in the Worker rather than inside the Durable Object so the single-writer object is not held
 * by slow provider endpoints and the Worker's injected `HttpClient` (mocked in tests) is used.
 */
import { Clock, Data, Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { QuotaReport } from "../management/contract/credentials.ts";
import { WorkerEnv } from "../platform/env.ts";
import { probeQuota } from "./probe.ts";
import type { QuotaOutcome } from "./report.ts";

/** A ControlPlane RPC failed (the message never carries payloads). */
export class QuotaControlPlaneError extends Data.TaggedError("QuotaControlPlaneError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type QuotaCheckResult =
  | { readonly kind: "checked"; readonly report: QuotaReport }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported"; readonly provider: string };

type Stub = ReturnType<Env["CONTROL_PLANE"]["getByName"]>;

const call = <R>(
  operation: string,
  run: (stub: Stub) => R,
): Effect.Effect<Awaited<R>, QuotaControlPlaneError, WorkerEnv> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    return yield* Effect.tryPromise({
      // RPC results are promise-pipelining stubs; `await` yields the plain data.
      try: async (): Promise<Awaited<R>> => await run(env.CONTROL_PLANE.getByName("global")),
      catch: (cause) =>
        new QuotaControlPlaneError({
          operation,
          message: cause instanceof Error ? cause.message : "unknown error",
        }),
    });
  });

const record = (id: string, outcome: QuotaOutcome) =>
  Effect.gen(function* () {
    const checkedAt = yield* Clock.currentTimeMillis;

    return yield* call("recordQuotaReport", (stub) =>
      stub.recordQuotaReport(id, outcome, checkedAt),
    );
  });

/** Checks the quota of the auth file `name` (and/or `authIndex`) and returns the stored report. */
export const checkCredentialQuota = (ref: {
  readonly name?: string;
  readonly authIndex?: string;
}): Effect.Effect<QuotaCheckResult, QuotaControlPlaneError, WorkerEnv | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const target = yield* call("quotaProbeTarget", (stub) => stub.quotaProbeTarget(ref));

    if (target.ok) {
      const outcome = yield* probeQuota(target.target);
      const report = yield* record(target.target.id, outcome);

      return report === undefined
        ? ({ kind: "not_found" } as const)
        : ({ kind: "checked", report } as const);
    }

    switch (target.error) {
      case "not_found":
        return { kind: "not_found" } as const;
      case "unsupported":
        return { kind: "unsupported", provider: target.provider } as const;
      case "unavailable": {
        const report = yield* record(target.id, { ok: false, error: target.message });

        return report === undefined
          ? ({ kind: "not_found" } as const)
          : ({ kind: "checked", report } as const);
      }
    }
  });

export interface QuotaSweepSummary {
  readonly checked: number;
  readonly failed: number;
}

/** Cron task `quota-check`: checks every enabled auth file of a supported provider, four at a time. */
export const runQuotaSweep: Effect.Effect<
  QuotaSweepSummary,
  QuotaControlPlaneError,
  WorkerEnv | HttpClient.HttpClient
> = Effect.gen(function* () {
  const ids = yield* call("quotaCheckTargets", (stub) => stub.quotaCheckTargets());

  const results = yield* Effect.forEach(
    ids,
    (id) =>
      checkCredentialQuota({ name: id }).pipe(
        Effect.map((result) => result.kind === "checked" && result.report.error === undefined),
        Effect.catch((error) =>
          Effect.logWarning(
            `quota check for ${id} failed: ${error.operation}: ${error.message}`,
          ).pipe(Effect.as(false)),
        ),
      ),
    { concurrency: 4 },
  );

  const checked = results.filter(Boolean).length;
  const summary = { checked, failed: results.length - checked };
  yield* Effect.logInfo(`quota check: ${summary.checked} checked, ${summary.failed} failed`);

  return summary;
});
