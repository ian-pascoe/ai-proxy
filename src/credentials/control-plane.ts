import { DurableObject } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { ConfigStore, decodeStoredConfig, type ConfigSnapshotWire, type PutConfigResult } from "../config/store.ts"
import type { Config } from "../config/schema.ts"
import type { JsonObject } from "../json/index.ts"
import { isTokenPayloadKey } from "./merge.ts"
import { CredentialPool, type ConfigView, type UpsertResult } from "./pool.ts"
import type { Credential } from "./model.ts"
import { RefreshManager, type RefreshOptions, type RefreshResult, type RunSummary } from "./refresh/index.ts"
import { type RetryPlan, RetryQuery } from "./selection/retry.ts"
import { Lease, PickRequest, ReportResult, type PickResult, type ReportOutcome } from "./selection/types.ts"
import { CredentialStore } from "./store.ts"
import type { CredentialSummary } from "./summary.ts"
import type { ModelSource } from "../registry/source.ts"
import { authIndexOf } from "../management/auth-index.ts"
import { buildCredentialEntry } from "../management/credential-entry.ts"
import {
  apiCallToken,
  findCredential,
  type ApiCallTokenResult,
  type CredentialMutation,
  type CredentialRef,
  type RefreshAllItem,
  type RefreshOneResult
} from "../management/credential-ops.ts"
import { applyFieldPatch } from "./field-patch.ts"
import { type DevinStatusSummary, refreshDevinStatuses } from "./devin-status.ts"
import {
  type CallbackInput,
  type CallbackResult,
  makeOAuthService,
  type OAuthService,
  type StartInput,
  type StartResult,
  type StatusResult
} from "../oauth/service.ts"
import { OAuthSessions, SqliteSessionTable } from "../oauth/session-store.ts"

const decodePickRequest = Schema.decodeUnknownSync(PickRequest)

const decodeLease = Schema.decodeUnknownSync(Lease)

const decodeReportResult = Schema.decodeUnknownSync(ReportResult)

const decodeRetryQuery = Schema.decodeUnknownSync(RetryQuery)

const PROTECTED_KEYS = new Set(["type", "disabled", "api_key", "dca_token", "dca_expired", "dca_expires_at"])

/** Keys `patchCredentialMetadata` must not write: token lifecycle, identity of the provider, the disabled flag. */
const isProtectedMetadataKey = (key: string): boolean => isTokenPayloadKey(key) || PROTECTED_KEYS.has(key)

/** JSON object as it crosses the RPC boundary (the recursive `JsonObject` is too deep for the RPC stub types). */
type WireJsonObject = Record<string, Schema.MutableJson>

export type SetDisabledResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "not_found" | "config_credential" }

/**
 * Singleton Durable Object (`CONTROL_PLANE.getByName("global")`): the single writer for config, credentials,
 * cooldown state and refresh scheduling (see docs/ARCHITECTURE.md).
 *
 * Implements the config store, the credential store/selection (`pick`, `report`, credential management) and OAuth
 * token refresh (`alarm`, `refreshNow`, `ensureFresh`, `sweepRefresh`; see `refresh/manager.ts`). Methods are exposed to the Worker through JS RPC and exchange plain data only.
 */
export class ControlPlane extends DurableObject<Env> {
  readonly #config: ConfigStore
  readonly #pool: CredentialPool
  readonly #refresh: RefreshManager
  readonly #oauth: OAuthService
  #configView: ConfigView | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#config = new ConfigStore(ctx.storage.sql)
    this.#pool = new CredentialPool({
      store: new CredentialStore(ctx.storage.sql),
      config: () => this.#currentConfig(),
      decorate: (credential) => this.#refresh.decorate(credential)
    })
    this.#refresh = new RefreshManager({
      host: this.#pool,
      alarm: {
        set: (at) => ctx.storage.setAlarm(at),
        clear: () => ctx.storage.deleteAlarm()
      },
      http: FetchHttpClient.layer,
      metaMintUrl: env.META_MINT_URL,
      workers: () => this.#currentConfig().config.oauth["auth-auto-refresh-workers"]
    })
    this.#oauth = makeOAuthService({
      metaMintUrl: env.META_MINT_URL,
      sessions: new OAuthSessions(new SqliteSessionTable(ctx.storage.sql)),
      sink: {
        get: (name) => this.#pool.refreshTarget(name)?.credential.metadata,
        list: () =>
          this.#pool.refreshTargets().map(({ credential }) => ({
            id: credential.id,
            type: typeof credential.metadata.type === "string" ? credential.metadata.type : "",
            metadata: credential.metadata
          })),
        save: async (name, metadata) => {
          const result = this.#pool.upsert(name, metadata, { mergeExisting: false })

          if (!result.ok) return { ok: false, message: result.message }
          await this.#rearm()

          return { ok: true }
        },
        remove: async (id) => {
          await this.removeCredential(id)
        }
      }
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

  /**
   * Reports the outcome of the attempt that used `lease` (counters, cooldown/quota state machine, session affinity).
   */
  report(lease: Lease, result: ReportResult): ReportOutcome {
    return this.#pool.report(decodeLease(lease), decodeReportResult(result))
  }

  /** What the model registry needs from every credential (provider, prefix, exclusions, aliases, model state); no secrets. */
  listModelSources(): ModelSource[] {
    return this.#pool.modelSources()
  }

  /**
   * After a failed retry round: should another round start and how long should the Worker wait first?
   * (`request-retry`, cooldown recovery times, `max-retry-interval`; credentials.md §7.1.)
   */
  planRetry(query: RetryQuery): RetryPlan {
    return this.#pool.planRetry(decodeRetryQuery(query))
  }

  /** All credentials with runtime state; token material is redacted. */
  listCredentials(): CredentialSummary[] {
    return this.#pool.list()
  }

  /**
   * Creates or replaces the auth file `name` (parsed object or JSON text). `mergeExisting` (default true) carries user
   * settings of the previous file over, as a re-login does.
   */
  async upsertCredential(
    name: string,
    content: string | JsonObject,
    options?: { mergeExisting?: boolean }
  ): Promise<UpsertResult> {
    const result = this.#pool.upsert(name, content, { mergeExisting: options?.mergeExisting ?? true })

    if (result.ok) await this.#rearm()

    return result
  }

  /**
   * Imports a Go auth JSON file verbatim (an existing credential of the same name is replaced; `mergeExisting` keeps
   * its user settings like a re-login).
   */
  async importAuthFile(
    name: string,
    content: string | JsonObject,
    options: { readonly mergeExisting?: boolean } = {}
  ): Promise<UpsertResult> {
    const result = this.#pool.upsert(name, content, { mergeExisting: options.mergeExisting === true })

    if (result.ok) await this.#rearm()

    return result
  }

  /** Removes a stored credential and its runtime state. */
  async removeCredential(id: string): Promise<{ readonly removed: boolean }> {
    const removed = this.#pool.remove(id)

    if (removed) {
      this.#refresh.forget(id)
      await this.#rearm()
    }

    return { removed }
  }

  /** Removes several stored credentials; returns the ids that existed. */
  async removeCredentials(ids: ReadonlyArray<string>): Promise<string[]> {
    const removed: string[] = []

    for (const id of ids) if ((await this.removeCredential(id)).removed) removed.push(id)

    return removed
  }

  /** Disables or re-enables a stored credential (persisted as `disabled` in its file JSON). */
  async setCredentialDisabled(id: string, disabled: boolean): Promise<SetDisabledResult> {
    const result = this.#pool.setDisabled(id, disabled)

    if (result !== "ok") return { ok: false, error: result }
    await this.#rearm()

    return { ok: true }
  }

  // --- token refresh (refresh/manager.ts) ----------------------------------------------------------------------

  /** Durable Object alarm: refreshes due credentials and re-arms the single multiplexed alarm. */
  override async alarm(): Promise<void> {
    await this.#refresh.onAlarm()
  }

  /**
   * Request-time refresh after the upstream answered 401 (`tryRefreshAfterUnauthorized`): pass the access token that
   * was rejected so concurrent 401s share one refresh and an already replaced token is not refreshed again. On success
   * the executor retries once with `credential.metadata.access_token`. Never throws: failures are structured.
   */
  refreshNow(credentialId: string, rejectedAccessToken?: string): Promise<RefreshResult> {
    const options: RefreshOptions = rejectedAccessToken === undefined ? {} : { rejectedAccessToken }

    return this.#refresh.refreshNow(credentialId, options)
  }

  /** Manual refresh (management): ignores the terminal-unauthorized gating. */
  forceRefresh(credentialId: string): Promise<RefreshResult> {
    return this.#refresh.refreshNow(credentialId, { force: true })
  }

  /**
   * Returns the credential ready to use: a cached/minted Vertex service-account token, a minted Meta key, or a
   * refreshed OAuth token when the stored one is missing/expired (Antigravity: within 5 min). Executors call it when
   * the picked snapshot has no usable `metadata.access_token`.
   */
  ensureFresh(credentialId: string): Promise<RefreshResult> {
    return this.#refresh.ensureFresh(credentialId)
  }

  /** Cron safety sweep: refreshes what is overdue and re-arms a lost alarm. */
  sweepRefresh(): Promise<RunSummary> {
    return this.#refresh.sweep()
  }

  /** Cron task `devin-user-status`: `GetUserStatus` profile and quota signals of every stored Devin credential. */
  async refreshDevinStatus(): Promise<DevinStatusSummary> {
    const summary = await Effect.runPromise(
      refreshDevinStatuses(this.#pool).pipe(Effect.provide(FetchHttpClient.layer))
    )

    if (summary.refreshed > 0) await this.#rearm()

    return summary
  }

  /**
   * Merges non-token settings into a stored credential's file (`UpdatePreparedAuth`: request preparation results such
   * as Antigravity `project_id` or Claude profile fields). `null` deletes a key. Token material, `type` and
   * `disabled` cannot be written here.
   */
  async patchCredentialMetadata(
    credentialId: string,
    patch: JsonObject
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: "not_found" | "forbidden_key" }> {
    const target = this.#pool.refreshTarget(credentialId)

    if (target === undefined) return { ok: false, error: "not_found" }

    if (Object.keys(patch).some(isProtectedMetadataKey)) return { ok: false, error: "forbidden_key" }
    const metadata: JsonObject = { ...target.credential.metadata }

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete metadata[key]
      else metadata[key] = value
    }

    this.#pool.commitRefresh(credentialId, { metadata })
    await this.#rearm()

    return { ok: true }
  }

  // --- management API (src/management) -------------------------------------------------------------------------

  /** Panel entries of all stored auth files (no secrets). Config API keys are not listed. */
  listCredentialEntries(): WireJsonObject[] {
    const now = Date.now()

    return this.#pool
      .entries()
      .filter(({ credential }) => credential.source === "file")
      .map(({ credential, state }) => buildCredentialEntry(credential, state, now))
  }

  /** The stored auth file verbatim, for download. */
  getCredentialFile(name: string): WireJsonObject | undefined {
    return this.#pool.refreshTarget(name)?.credential.metadata
  }

  /** Edits fields of a stored auth file (`PATCH /credentials/fields`); see `field-patch.ts`. */
  async patchCredentialFields(ref: CredentialRef, fields: WireJsonObject): Promise<CredentialMutation> {
    const target = findCredential(this.#pool.entries(), ref)

    if (target === undefined || target.credential.source !== "file") {
      return { ok: false, error: "not_found", message: "auth file not found" }
    }

    const patched = applyFieldPatch(target.credential.metadata, fields)

    if (!patched.ok) return { ok: false, error: "invalid", message: patched.message }
    this.#pool.commitRefresh(target.credential.id, { metadata: patched.metadata })
    await this.#rearm()

    return { ok: true, id: target.credential.id }
  }

  /** Enables/disables a credential addressed by file name and/or `auth_index`. */
  async setCredentialDisabledByRef(ref: CredentialRef, disabled: boolean): Promise<SetDisabledResult> {
    const target = findCredential(this.#pool.entries(), ref)

    if (target === undefined) return { ok: false, error: "not_found" }

    return await this.setCredentialDisabled(target.credential.id, disabled)
  }

  /** Clears quota/cooldown state (`POST /routing/cooldown/reset`). */
  resetCredentialCooldown(
    ref: CredentialRef
  ):
    | { readonly ok: true; readonly authIndex: string; readonly models: ReadonlyArray<string> }
    | { readonly ok: false } {
    const target = findCredential(this.#pool.entries(), ref)
    const reset = target === undefined ? undefined : this.#pool.resetCooldown(target.credential.id)

    return target === undefined || reset === undefined
      ? { ok: false }
      : { ok: true, authIndex: authIndexOf(target.credential.id), models: reset.models }
  }

  /** Manual refresh of one auth file (`POST /credentials/refresh`). */
  async refreshCredential(ref: CredentialRef): Promise<RefreshOneResult> {
    const target = findCredential(this.#pool.entries(), ref)

    if (target === undefined || target.credential.source !== "file") return { ok: false, error: "not_found" }
    const id = target.credential.id
    const result = await this.#refresh.refreshNow(id, { force: true })

    if (!result.ok && result.error.code !== "not_refreshable") {
      return { ok: false, error: "refresh_failed", message: result.error.message }
    }

    const current = this.#pool.entry(id)

    if (current === undefined) return { ok: false, error: "not_found" }

    return {
      ok: true,
      refreshed: result.ok && result.refreshed,
      entry: buildCredentialEntry(current.credential, current.state, Date.now())
    }
  }

  /** Manual refresh of every refreshable auth file (`all=true`). */
  async refreshAllCredentials(): Promise<RefreshAllItem[]> {
    const results = await Promise.all(
      this.#pool.refreshTargets().map(async ({ credential }) => ({
        id: credential.id,
        result: await this.#refresh.refreshNow(credential.id, { force: true })
      }))
    )

    const items: RefreshAllItem[] = []

    for (const { id, result } of results) {
      if (result.ok) items.push({ id, success: true })
      // Credentials without a refresh token are not part of a refresh run.
      else if (result.error.code !== "not_refreshable") items.push({ id, success: false, error: result.error.message })
    }

    return items
  }

  /**
   * The value `$TOKEN$` stands for in `POST /requests/api-call`: the (refreshed when needed) access token of a stored
   * credential or the API key of a config credential.
   */
  async resolveApiCallToken(authIndex: string): Promise<ApiCallTokenResult> {
    const target = findCredential(this.#pool.entries(), { authIndex })

    if (target === undefined) return { ok: false, error: "not_found" }
    let credential: Pick<Credential, "metadata" | "attributes"> = target.credential

    if (target.credential.source === "file") {
      const fresh = await this.#refresh.ensureFresh(target.credential.id)

      if (!fresh.ok) return { ok: false, error: "refresh_failed" }
      credential = fresh.credential
    }

    const token = apiCallToken(credential)

    return token === "" ? { ok: false, error: "token_not_found" } : { ok: true, token }
  }

  // --- provider OAuth logins (src/oauth) ------------------------------------------------------------------------

  /** Starts a provider login (`GET /oauth/auth-url`): returns the URL to open and the session `state`. */
  oauthStart(input: StartInput): Promise<StartResult> {
    return this.#runOAuth(this.#oauth.start(input))
  }

  /** `GET /oauth/status`: pending/ok/error; for device logins each call advances the upstream poll when due. */
  oauthStatus(state: string): Promise<StatusResult> {
    return this.#runOAuth(this.#oauth.status(state))
  }

  /** Completes a callback login from a pasted/redirected `code` + `state` (management and public browser routes). */
  oauthCallback(input: CallbackInput): Promise<CallbackResult> {
    return this.#runOAuth(this.#oauth.callback(input))
  }

  /** `DELETE /oauth/session`: cancels a pending login. */
  oauthCancel(state: string): Promise<{ readonly cancelled: boolean }> {
    return Effect.runPromise(this.#oauth.cancel(state))
  }

  #runOAuth<A>(effect: Effect.Effect<A, never, HttpClient.HttpClient>): Promise<A> {
    return Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer)))
  }

  /** Credential changes move refresh deadlines; a failure to re-arm must never fail the management call. */
  async #rearm(): Promise<void> {
    await this.#refresh.rearm().catch(() => undefined)
  }
}
