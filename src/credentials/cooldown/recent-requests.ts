/**
 * Recent-requests ring: 20 buckets of 10 minutes (credentials.md §8.6).
 *
 * Go source: sdk/cliproxy/auth/types.go (recordRecentRequest, RecentRequestsSnapshot).
 */
import { Schema } from "effect"

export const RecentBucket = Schema.Struct({ bucket: Schema.Number, success: Schema.Int, failed: Schema.Int })

export type RecentBucket = typeof RecentBucket.Type

export const RECENT_BUCKETS = 20

export const RECENT_BUCKET_MS = 600_000

/** Records one request; returns a new ring (the slot of another bucket id is reset). */
export const recordRecentRequest = (
  ring: ReadonlyArray<RecentBucket> | undefined,
  now: number,
  success: boolean
): RecentBucket[] => {
  const next: RecentBucket[] = ring === undefined ? [] : ring.map((entry) => ({ ...entry }))
  const bucket = Math.floor(now / RECENT_BUCKET_MS)
  const slot = ((bucket % RECENT_BUCKETS) + RECENT_BUCKETS) % RECENT_BUCKETS
  const current = next[slot]

  const entry: RecentBucket =
    current !== undefined && current.bucket === bucket ? current : { bucket, success: 0, failed: 0 }

  next[slot] = success ? { ...entry, success: entry.success + 1 } : { ...entry, failed: entry.failed + 1 }

  // Sparse arrays do not survive JSON: fill the gaps with empty buckets.
  for (let index = 0; index < RECENT_BUCKETS; index += 1) next[index] ??= { bucket: -1, success: 0, failed: 0 }

  return next
}

export interface RecentRequestsEntry {
  /** Epoch ms at the start of the bucket. */
  readonly start: number
  readonly success: number
  readonly failed: number
}

/** 20 entries oldest -> newest ending with the bucket of `now`; stale slots count as empty. */
export const recentRequestsSnapshot = (
  ring: ReadonlyArray<RecentBucket> | undefined,
  now: number
): RecentRequestsEntry[] => {
  const current = Math.floor(now / RECENT_BUCKET_MS)
  const out: RecentRequestsEntry[] = []

  for (let offset = RECENT_BUCKETS - 1; offset >= 0; offset -= 1) {
    const bucket = current - offset
    const slot = ((bucket % RECENT_BUCKETS) + RECENT_BUCKETS) % RECENT_BUCKETS
    const entry = ring?.[slot]
    const live = entry !== undefined && entry.bucket === bucket
    out.push({ start: bucket * RECENT_BUCKET_MS, success: live ? entry.success : 0, failed: live ? entry.failed : 0 })
  }

  return out
}
