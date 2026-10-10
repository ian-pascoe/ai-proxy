/**
 * Usage retention cron job: deletes usage records older than `USAGE_RETENTION_DAYS` (default 30; 0 keeps everything).
 *
 * Go counterpart: `redis-usage-queue-retention-seconds` bounds the in-process queue (internal/redisqueue/queue.go);
 * D1 keeps history, so retention is expressed in days and applied by the scheduled handler.
 */
import { Clock, Effect } from "effect";
import { WorkerEnv } from "../platform/env.ts";
import { pruneUsageRecords } from "./d1.ts";

export const DEFAULT_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/** Parses the variable: blank/invalid -> default, <= 0 -> 0 (disabled). */
export const retentionDays = (raw: string | undefined): number => {
  const value = (raw ?? "").trim();

  if (value === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(value);

  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;

  return days <= 0 ? 0 : days;
};

/** Deletes records older than the retention window; returns how many were removed. */
export const pruneExpiredUsage = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const days = retentionDays(env.USAGE_RETENTION_DAYS);

  if (days === 0) return 0;
  const cutoff = (yield* Clock.currentTimeMillis) - days * DAY_MS;
  const removed = yield* Effect.promise(() => pruneUsageRecords(env.USAGE, cutoff));

  if (removed > 0)
    yield* Effect.logInfo("usage retention").pipe(
      Effect.annotateLogs({ removed, retentionDays: days }),
    );

  return removed;
});
