/**
 * In-memory credential pool: credentials (stored files + config API keys), runtime state, rotation cursors and
 * session affinity behind the `pick` / `report` operations of the ControlPlane Durable Object.
 *
 * Go counterpart: the `Manager` parts that register credentials and select them (sdk/cliproxy/auth/conductor*.go).
 * The class is free of Cloudflare types so it can be unit tested with a fake store and an injected clock. The
 * Durable Object guarantees single-threaded access, which replaces the Go mutexes.
 */
import type { Config } from "../config/schema.ts"
import { sessionAffinityTtlMs } from "../config/accessors.ts"
import type { JsonObject } from "../json/index.ts"
import { type StoredCredential, deriveFileCredential, sanitizeAliases } from "./derive.ts"
import { parseAuthFile, type ImportFailureReason } from "./import.ts"
import { type Credential, type CredentialState, emptyState } from "./model.ts"
import { redactSecrets } from "./redact.ts"
import { SessionCache } from "./selection/affinity.ts"
import { canonicalModelKey } from "./selection/model-name.ts"
import { rotateRoute } from "./selection/routing.ts"
import { selectCredential, type CredentialEntry, type SelectionSettings } from "./selection/pick.ts"
import { RotationState } from "./selection/strategies.ts"
import type { Lease, PickRequest, PickResult, ReportOutcome, ReportResult } from "./selection/types.ts"
import type { UpsertOptions, UpsertOutcome } from "./store.ts"
import { summarizeCredential, toSnapshot, type CredentialSummary } from "./summary.ts"
import { synthesizeConfigCredentials } from "./synthesize.ts"
import { type ModelSource, toModelSource } from "../registry/source.ts"

/** Storage the pool needs (implemented by `CredentialStore`; tests may fake it). */
export interface PoolStore {
  list(): StoredCredential[]
  get(id: string): StoredCredential | undefined
  upsert(id: string, provider: string, metadata: JsonObject, options: UpsertOptions): UpsertOutcome
  setDisabled(id: string, disabled: boolean): StoredCredential | undefined
  remove(id: string): boolean
  loadStates(): Map<string, CredentialState>
  saveState(id: string, state: CredentialState): void
  deleteState(id: string): void
}

/** The config as seen by the pool: a version for cheap change detection plus the decoded document. */
export interface ConfigView {
  readonly version: number
  readonly config: Config
}

export interface PoolOptions {
  readonly store: PoolStore
  /** Returns the current config; called on every operation, so it must be cheap when nothing changed. */
  readonly config: () => ConfigView
  readonly now?: () => number
  readonly newId?: () => string
}

export type UpsertResult =
  | {
      readonly ok: true
      readonly id: string
      readonly provider: string
      readonly created: boolean
      readonly credentialVersion: number
      readonly credentialsChanged: boolean
    }
  | { readonly ok: false; readonly reason: ImportFailureReason; readonly message: string }

interface View {
  readonly configVersion: number
  readonly settings: SelectionSettings
  readonly credentials: ReadonlyMap<string, Credential>
}

/** Rotates alias pools: successive requests start on different upstream models. */
const POOL_OFFSET_WRAP = 2_000_000_000

export class CredentialPool {
  readonly #store: PoolStore
  readonly #config: () => ConfigView
  readonly #now: () => number
  readonly #newId: () => string
  readonly #rotation = new RotationState()
  readonly #affinity = new SessionCache()
  readonly #poolOffsets = new Map<string, number>()
  readonly #states: Map<string, CredentialState>
  #view: View | undefined

  constructor(options: PoolOptions) {
    this.#store = options.store
    this.#config = options.config
    this.#now = options.now ?? Date.now
    this.#newId = options.newId ?? (() => crypto.randomUUID())
    this.#states = options.store.loadStates()
  }

  /** Rebuilds the derived credential set when the config or the stored credentials changed. */
  #current(): View {
    const { version, config } = this.#config()
    if (this.#view !== undefined && this.#view.configVersion === version) return this.#view
    const now = this.#now()
    const credentials = new Map<string, Credential>()
    for (const stored of this.#store.list()) {
      credentials.set(stored.id, deriveFileCredential(stored, { config }))
    }
    for (const credential of synthesizeConfigCredentials(config, now)) credentials.set(credential.id, credential)

    // Config credentials are content-addressed: state of ids that disappeared (rotated keys) is garbage.
    for (const id of this.#states.keys()) {
      if (!credentials.has(id)) {
        this.#states.delete(id)
        this.#store.deleteState(id)
        this.#affinity.invalidateAuth(id)
      }
    }
    const oauthModelAlias: Record<string, ReturnType<typeof sanitizeAliases>> = {}
    for (const [channel, aliases] of Object.entries(config.oauth["model-alias"])) {
      oauthModelAlias[channel.trim().toLowerCase()] = sanitizeAliases(aliases)
    }
    const ttl = sessionAffinityTtlMs(config)
    this.#affinity.setTtl(ttl)
    this.#view = {
      configVersion: version,
      credentials,
      settings: {
        strategy: config.routing.strategy,
        sessionAffinity: config.routing["session-affinity"],
        sessionAffinitySubagents: config.routing["session-affinity-subagents"],
        forceModelPrefix: config.routing["force-model-prefix"],
        oauthModelAlias
      }
    }
    return this.#view
  }

  /** Drops the derived view so the next operation re-reads the store (after a credential write). */
  #invalidate(): void {
    this.#view = undefined
  }

  #state(id: string): CredentialState {
    return this.#states.get(id) ?? emptyState()
  }

  /** Model-registration view of every credential (no secrets): see `registry/source.ts`. */
  modelSources(): ModelSource[] {
    const view = this.#current()
    return [...view.credentials.values()].map((credential) => toModelSource(credential, this.#state(credential.id)))
  }

  pick(request: PickRequest): PickResult {
    const view = this.#current()
    const now = this.#now()
    const entries: CredentialEntry[] = []
    for (const credential of view.credentials.values()) entries.push({ credential, state: this.#state(credential.id) })

    const outcome = selectCredential({
      credentials: entries,
      request,
      settings: view.settings,
      runtime: { rotation: this.#rotation, affinity: this.#affinity },
      now
    })
    if (!outcome.ok) return outcome

    const { credential } = outcome.entry
    let route = outcome.route
    if (route.upstreamModels.length > 1) {
      const key = `${credential.id}|${route.routeModel.toLowerCase()}`
      const offset = this.#poolOffsets.get(key) ?? 0
      this.#poolOffsets.set(key, (offset + 1) % POOL_OFFSET_WRAP)
      route = rotateRoute(route, offset)
    }
    const stateModel = canonicalModelKey(route.selectionModel)
    const lease: Lease = {
      id: this.#newId(),
      credentialId: credential.id,
      credentialVersion: credential.credentialVersion,
      provider: credential.provider,
      model: stateModel,
      issuedAt: now,
      ...(outcome.affinityKeys.length === 0 ? {} : { affinityKeys: outcome.affinityKeys })
    }
    return {
      ok: true,
      credential: toSnapshot(credential),
      route: {
        requestedModel: route.requestedModel,
        routeModel: route.routeModel,
        upstreamModel: route.upstreamModel,
        upstreamModels: route.upstreamModels,
        originalAlias: route.originalAlias,
        forceMapping: route.forceMapping,
        stateModel
      },
      lease
    }
  }

  /**
   * Records the outcome of an attempt. Only counters, the last error and session-affinity effects are applied here;
   * cooldown/quota transitions are added by the retry/cooldown slice on top of this entry point.
   */
  report(lease: Lease, result: ReportResult): ReportOutcome {
    const credential = this.#current().credentials.get(lease.credentialId)
    if (credential === undefined) return { ok: false, error: "unknown_credential" }
    // A result for credentials that changed in the meantime says nothing about the new material.
    if (lease.credentialVersion < credential.credentialVersion) return { ok: true, applied: false }

    const now = this.#now()
    const previous = this.#state(credential.id)
    if (result.success) {
      this.#states.set(credential.id, { ...previous, success: previous.success + 1, updatedAt: now })
      for (const key of lease.affinityKeys ?? []) this.#affinity.touch(key, credential.id, now)
      return { ok: true, applied: true }
    }

    const error = result.error
    const lastError = {
      message: redactSecrets(
        error?.message ?? (result.httpStatus === undefined ? "request failed" : `HTTP ${result.httpStatus}`)
      ),
      retryable: error?.retryable ?? false,
      ...(error?.code === undefined ? {} : { code: error.code }),
      ...((error?.httpStatus ?? result.httpStatus) === undefined
        ? {}
        : { httpStatus: (error?.httpStatus ?? result.httpStatus) as number })
    }
    const next: CredentialState = { ...previous, failed: previous.failed + 1, lastError, updatedAt: now }
    this.#states.set(credential.id, next)
    this.#store.saveState(credential.id, next)
    if (result.requestScoped !== true) {
      for (const key of lease.affinityKeys ?? []) this.#affinity.compareAndDelete(key, credential.id)
    }
    return { ok: true, applied: true }
  }

  list(): CredentialSummary[] {
    const view = this.#current()
    return [...view.credentials.values()]
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((credential) => summarizeCredential(credential, this.#state(credential.id)))
  }

  /** Imports/updates one auth file. `mergeExisting` keeps user settings of the previous file (re-login). */
  upsert(name: string, content: string | JsonObject, options: { readonly mergeExisting: boolean }): UpsertResult {
    const parsed = parseAuthFile(name, content)
    if (!parsed.ok) return parsed
    const outcome = this.#store.upsert(parsed.id, parsed.provider, parsed.metadata, options)
    this.#invalidate()
    // Replaced material starts a fresh life: stale tokens must not keep a cooldown or a session binding.
    if (outcome.credentialsChanged && !outcome.created) {
      this.#states.delete(parsed.id)
      this.#store.deleteState(parsed.id)
      this.#affinity.invalidateAuth(parsed.id)
    }
    return {
      ok: true,
      id: parsed.id,
      provider: outcome.record.provider,
      created: outcome.created,
      credentialVersion: outcome.record.credentialVersion,
      credentialsChanged: outcome.credentialsChanged
    }
  }

  remove(id: string): boolean {
    const removed = this.#store.remove(id)
    if (removed) {
      this.#states.delete(id)
      this.#affinity.invalidateAuth(id)
      this.#invalidate()
    }
    return removed
  }

  /** Disables/enables a stored credential. Config API keys are disabled by removing them from the config. */
  setDisabled(id: string, disabled: boolean): "ok" | "not_found" | "config_credential" {
    if (this.#store.get(id) === undefined) {
      return this.#current().credentials.has(id) ? "config_credential" : "not_found"
    }
    this.#store.setDisabled(id, disabled)
    if (disabled) this.#affinity.invalidateAuth(id)
    this.#invalidate()
    return "ok"
  }
}
