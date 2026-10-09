/**
 * `SessionState` Durable Object: generic TTL + compare-and-swap key/value store for replay and continuity state.
 *
 * New in the Workers port (the Go server keeps these caches in process memory or the Home KV). One instance per
 * (store, scope, session) address, `SESSION_STATE.getByName(addressName(...))`; the Worker talks to it through
 * {@link SessionState.run} (see `client.ts`). Expired entries read as absent immediately; an alarm deletes them
 * (and the whole instance storage once nothing is left) so abandoned sessions cost nothing.
 */
import { DurableObject } from "cloudflare:workers"
import { StateEngine } from "./engine.ts"
import type { StateOp, StateResult } from "./protocol.ts"
import { SqliteStateTable } from "./sqlite-table.ts"

export class SessionState extends DurableObject<Env> {
  #engine: StateEngine
  #armedAt: number | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#engine = this.#newEngine()
  }

  #newEngine(): StateEngine {
    return new StateEngine(new SqliteStateTable(this.ctx.storage.sql))
  }

  /**
   * Executes `ops` atomically and in order. `now` is the caller's clock (Effect `Clock`, so tests control it);
   * results are positional.
   */
  async run(ops: StateOp[], now: number = Date.now()): Promise<StateResult[]> {
    const results = this.ctx.storage.transactionSync(() => this.#engine.run(ops, now))
    if (ops.some((op) => op.op === "put" || op.op === "incr")) await this.#arm(this.#engine.nextExpiry())
    return results
  }

  /** Drops expired entries and re-arms the alarm; an empty instance deletes its storage. */
  async sweep(now: number = Date.now()): Promise<void> {
    const next = this.ctx.storage.transactionSync(() => this.#engine.sweep(now))
    this.#armedAt = undefined
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      // `deleteAll` drops the SQLite tables too.
      this.#engine = this.#newEngine()
      return
    }
    await this.#arm(next)
  }

  override async alarm(): Promise<void> {
    await this.sweep(Date.now())
  }

  async #arm(next: number | undefined): Promise<void> {
    if (next === undefined || next === this.#armedAt) return
    this.#armedAt = next
    await this.ctx.storage.setAlarm(next)
  }
}
