import { DurableObject } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import { ConfigStore, decodeStoredConfig, type ConfigSnapshotWire, type PutConfigResult } from "../config/store.ts"
import type { Config } from "../config/schema.ts"
import type { JsonObject } from "../json/index.ts"
import { CredentialPool, type ConfigView, type UpsertResult } from "./pool.ts"
import { Lease, PickRequest, ReportResult, type PickResult, type ReportOutcome } from "./selection/types.ts"
import { CredentialStore } from "./store.ts"
import type { CredentialSummary } from "./summary.ts"

const decodePickRequest = Schema.decodeUnknownSync(PickRequest)
const decodeLease = Schema.decodeUnknownSync(Lease)
const decodeReportResult = Schema.decodeUnknownSync(ReportResult)

export type SetDisabledResult =
  { readonly ok: true } | { readonly ok: false; readonly error: "not_found" | "config_credential" }

/**
 * Singleton Durable Object (`CONTROL_PLANE.getByName("global")`): the single writer for config, credentials,
 * cooldown state and refresh scheduling (see docs/workers-port/ARCHITECTURE.md).
 *
 * Implements the config store and the credential store/selection (`pick`, `report`, credential management).
 * Methods are exposed to the Worker through JS RPC and exchange plain data only.
 */
export class ControlPlane extends DurableObject<Env> {
  readonly #config: ConfigStore
  readonly #pool: CredentialPool
  #configView: ConfigView | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#config = new ConfigStore(ctx.storage.sql)
    this.#pool = new CredentialPool({
      store: new CredentialStore(ctx.storage.sql),
      config: () => this.#currentConfig()
    })
  }

  /** Decoded config, re-decoded only when the stored version changed. */
  #currentConfig(): ConfigView {
    const cached = this.#configView
    const snapshot = this.#config.get(cached?.version)
    if (cached !== undefined && snapshot.unchanged) return cached
    const config: Config = Effect.runSync(decodeStoredConfig(snapshot.document ?? ""))
    this.#configView = { version: snapshot.version, config }
    return this.#configView
  }

  /**
   * Current config document. Pass the version already cached by the caller to get a cheap `unchanged: true`
   * answer instead of the full document.
   */
  getConfig(sinceVersion?: number): ConfigSnapshotWire {
    return this.#config.get(sinceVersion)
  }

  /**
   * Replaces the config with `text` (YAML or JSON). Returns a structured result instead of throwing so validation
   * and version-conflict errors survive the RPC boundary. `expectedVersion` enables optimistic concurrency.
   */
  putConfig(text: string, expectedVersion?: number): PutConfigResult {
    return this.#config.put(text, expectedVersion)
  }

  /**
   * Selects a credential for `request` (candidate set, availability, priority tiers, strategy, session affinity) and
   * returns everything the executor needs plus a lease to hand back to {@link report}. A failure to select is a
   * structured result (`ok: false`), not an exception.
   */
  pick(request: PickRequest): PickResult {
    return this.#pool.pick(decodePickRequest(request))
  }

  /** Reports the outcome of the attempt that used `lease`. */
  report(lease: Lease, result: ReportResult): ReportOutcome {
    return this.#pool.report(decodeLease(lease), decodeReportResult(result))
  }

  /** All credentials with runtime state; token material is redacted. */
  listCredentials(): CredentialSummary[] {
    return this.#pool.list()
  }

  /**
   * Creates or replaces the auth file `name` (parsed object or JSON text). `mergeExisting` (default true) carries user
   * settings of the previous file over, as a re-login does.
   */
  upsertCredential(name: string, content: string | JsonObject, options?: { mergeExisting?: boolean }): UpsertResult {
    return this.#pool.upsert(name, content, { mergeExisting: options?.mergeExisting ?? true })
  }

  /** Imports a Go auth JSON file verbatim (an existing credential of the same name is replaced). */
  importAuthFile(name: string, content: string | JsonObject): UpsertResult {
    return this.#pool.upsert(name, content, { mergeExisting: false })
  }

  /** Removes a stored credential and its runtime state. */
  removeCredential(id: string): { readonly removed: boolean } {
    return { removed: this.#pool.remove(id) }
  }

  /** Disables or re-enables a stored credential (persisted as `disabled` in its file JSON). */
  setCredentialDisabled(id: string, disabled: boolean): SetDisabledResult {
    const result = this.#pool.setDisabled(id, disabled)
    return result === "ok" ? { ok: true } : { ok: false, error: result }
  }
}
