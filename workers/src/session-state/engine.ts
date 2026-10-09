/**
 * Entry semantics of one `SessionState` instance: expiry, compare-and-swap generations and the entry bound.
 *
 * The engine is synchronous and runs over a tiny {@link StateTable}: SQLite inside the Durable Object
 * (`sqlite-table.ts`) and a `Map` for the in-process fallback and the unit tests (`MemoryStateTable`).
 * Expiry is lazy (an expired entry reads as absent and is dropped on contact); the Durable Object additionally
 * sweeps from an alarm so abandoned sessions free their storage.
 */
import {
  DEFAULT_MAX_ENTRIES,
  MAX_TTL_MS,
  MAX_VALUE_CHARS,
  MIN_TTL_MS,
  type StateOp,
  type StateResult
} from "./protocol.ts"

export interface StateRow {
  readonly value: string
  readonly generation: number
  /** Absolute expiry in epoch milliseconds. */
  readonly expiresAt: number
}

export interface StateTable {
  get(key: string): StateRow | undefined
  put(key: string, row: StateRow): void
  delete(key: string): void
  count(): number
  /** Removes every entry that expired at or before `now`. */
  purgeExpired(now: number): void
  /** Removes the `count` entries with the lowest generations (the oldest writes). */
  evictOldest(count: number): void
  /** Earliest expiry of any entry. */
  nextExpiry(): number | undefined
  /** Highest generation in the table (0 when empty). */
  maxGeneration(): number
}

export class MemoryStateTable implements StateTable {
  readonly rows = new Map<string, StateRow>()
  get(key: string): StateRow | undefined {
    return this.rows.get(key)
  }
  put(key: string, row: StateRow): void {
    this.rows.set(key, row)
  }
  delete(key: string): void {
    this.rows.delete(key)
  }
  count(): number {
    return this.rows.size
  }
  purgeExpired(now: number): void {
    for (const [key, row] of this.rows) if (row.expiresAt <= now) this.rows.delete(key)
  }
  evictOldest(count: number): void {
    const oldest = [...this.rows.entries()].toSorted((a, b) => a[1].generation - b[1].generation).slice(0, count)
    for (const [key] of oldest) this.rows.delete(key)
  }
  nextExpiry(): number | undefined {
    let next: number | undefined
    for (const row of this.rows.values()) if (next === undefined || row.expiresAt < next) next = row.expiresAt
    return next
  }
  maxGeneration(): number {
    let max = 0
    for (const row of this.rows.values()) if (row.generation > max) max = row.generation
    return max
  }
}

const clampTtl = (ttlMs: number): number =>
  Number.isFinite(ttlMs) ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.trunc(ttlMs))) : MIN_TTL_MS

export class StateEngine {
  readonly #table: StateTable
  #last: number

  constructor(table: StateTable) {
    this.#table = table
    this.#last = table.maxGeneration()
  }

  /**
   * Generations are time-based (`max(last + 1, now)`), so a generation is never reused even after the instance
   * emptied itself and started again from scratch (no ABA on stale compare-and-swap tokens).
   */
  #nextGeneration(now: number): number {
    this.#last = Math.max(this.#last + 1, Math.trunc(now))
    return this.#last
  }

  #live(key: string, now: number): StateRow | undefined {
    const row = this.#table.get(key)
    if (row === undefined) return undefined
    if (row.expiresAt <= now) {
      this.#table.delete(key)
      return undefined
    }
    return row
  }

  /** Executes the operations in order; results are positional. */
  run(ops: ReadonlyArray<StateOp>, now: number): StateResult[] {
    return ops.map((op) => this.#apply(op, now))
  }

  #apply(op: StateOp, now: number): StateResult {
    if (typeof op.key !== "string" || op.key === "") return { status: "rejected", reason: "invalid" }
    const current = this.#live(op.key, now)
    const currentGeneration = current?.generation ?? 0
    switch (op.op) {
      case "get": {
        if (current === undefined) return { status: "ok", generation: 0 }
        if (op.extendTtlMs !== undefined) {
          const expiresAt = Math.max(current.expiresAt, now + clampTtl(op.extendTtlMs))
          if (expiresAt !== current.expiresAt) this.#table.put(op.key, { ...current, expiresAt })
        }
        return { status: "ok", generation: current.generation, value: current.value }
      }
      case "put": {
        if (typeof op.value !== "string") return { status: "rejected", reason: "invalid" }
        if (op.value.length > MAX_VALUE_CHARS) return { status: "rejected", reason: "too_large" }
        if (op.ifGeneration !== undefined && op.ifGeneration !== currentGeneration) {
          return current === undefined
            ? { status: "conflict", generation: 0 }
            : { status: "conflict", generation: current.generation, value: current.value }
        }
        const generation = this.#nextGeneration(now)
        this.#table.put(op.key, { value: op.value, generation, expiresAt: now + clampTtl(op.ttlMs) })
        this.#enforceBound(op.maxEntries ?? DEFAULT_MAX_ENTRIES, now)
        return { status: "ok", generation }
      }
      case "incr": {
        const count = Number.parseInt(current?.value ?? "0", 10)
        const next = (Number.isSafeInteger(count) && count >= 0 ? count : 0) + 1
        const generation = this.#nextGeneration(now)
        this.#table.put(op.key, { value: String(next), generation, expiresAt: now + clampTtl(op.ttlMs) })
        this.#enforceBound(op.maxEntries ?? DEFAULT_MAX_ENTRIES, now)
        return { status: "ok", generation, value: String(next) }
      }
      case "delete": {
        if (op.ifGeneration !== undefined && op.ifGeneration !== currentGeneration) {
          return current === undefined
            ? { status: "conflict", generation: 0 }
            : { status: "conflict", generation: current.generation, value: current.value }
        }
        if (current !== undefined) this.#table.delete(op.key)
        return { status: "ok", generation: 0 }
      }
    }
  }

  /** Drops expired entries first, then the oldest writes; the entry written last always has the highest generation. */
  #enforceBound(maxEntries: number, now: number): void {
    const limit = Math.max(1, Math.trunc(maxEntries))
    if (this.#table.count() <= limit) return
    this.#table.purgeExpired(now)
    const overflow = this.#table.count() - limit
    if (overflow > 0) this.#table.evictOldest(overflow)
  }

  /** Alarm work: drops expired entries; returns the next expiry (undefined when the instance is empty). */
  sweep(now: number): number | undefined {
    this.#table.purgeExpired(now)
    return this.#table.nextExpiry()
  }

  nextExpiry(): number | undefined {
    return this.#table.nextExpiry()
  }

  size(): number {
    return this.#table.count()
  }
}
