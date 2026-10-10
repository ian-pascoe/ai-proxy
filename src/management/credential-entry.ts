/**
 * One entry of `GET /v8/management/credentials` (the panel's "auth files" list).
 *
 * Go source: internal/api/handlers/management/auth_files.go (`buildAuthFileEntryLocked`, `quotaObservationPayload`,
 * `extractCodexIDTokenClaims`, `reconcileAuthFileCooldownState`), sdk/cliproxy/auth/cooldown_view.go
 * (`CooldownSnapshotForAuth`) and types.go (`RecentRequestsSnapshot`). Pure: no secrets are included (the Codex
 * `id_token` is reduced to a few claims), so the result can leave the ControlPlane Durable Object.
 *
 * Differences: only auth files are listed (Go lists config API keys as `runtime_only` only for plugin credentials);
 * `recent_requests` come from the credential's recent-requests ring; cooldown reasons are reduced to
 * the quota reason or the last error class.
 */
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts"
import { decodeJwtClaims } from "../credentials/expiry.ts"
import { type RecentBucket, RECENT_BUCKET_MS, recentRequestsSnapshot } from "../credentials/cooldown/recent-requests.ts"
import type { Credential, CredentialState } from "../credentials/model.ts"
import { DEFAULT_WEIGHT } from "../credentials/weight.ts"
import { authIndexOf } from "./auth-index.ts"

const BUCKET_MS = RECENT_BUCKET_MS

const iso = (ms: number): string => new Date(ms).toISOString()

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "")

const pad = (value: number): string => String(value).padStart(2, "0")

const clock = (ms: number): string => `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())}`

/** `RecentRequestsSnapshot`: 20 ten-minute buckets, oldest first, labelled `HH:MM-HH:MM` (UTC). */
export const recentRequestBuckets = (
  ring: ReadonlyArray<RecentBucket> | undefined,
  now: number
): Array<{ time: string; success: number; failed: number }> =>
  recentRequestsSnapshot(ring, now).map((entry) => ({
    time: `${clock(entry.start)}-${clock(entry.start + BUCKET_MS)}`,
    success: entry.success,
    failed: entry.failed
  }))

/** Codex `id_token` claims the panel shows (plan type and subscription window). */
const codexClaims = (credential: Credential): JsonObject | undefined => {
  if (credential.provider !== "codex") return undefined
  const token = text(credential.metadata.id_token)

  if (token === "") return undefined
  const auth = decodeJwtClaims(token)?.["https://api.openai.com/auth"]

  if (!isJsonObject(auth)) return undefined
  const out: JsonObject = {}
  const account = text(auth.chatgpt_account_id)

  if (account !== "") out.chatgpt_account_id = account
  const plan = text(auth.chatgpt_plan_type)

  if (plan !== "") out.plan_type = plan

  for (const key of ["chatgpt_subscription_active_start", "chatgpt_subscription_active_until"] as const) {
    const value = auth[key]

    if (value !== undefined && value !== null) out[key] = value
  }

  return Object.keys(out).length === 0 ? undefined : out
}

const quotaReason = (reason: string | undefined): string => {
  if (reason === "credential_quota" || reason === "quota") return reason

  return reason === "cloudflare challenge" ? "cloudflare_challenge" : "unknown"
}

const cooldownView = (
  scope: "credential" | "model",
  modelKey: string,
  next: number,
  now: number,
  state: Pick<CredentialState, "quota" | "lastError">
): JsonObject => {
  const reason = state.quota.exceeded ? quotaReason(state.quota.reason) : state.lastError?.code?.trim() || "unknown"
  const status = state.lastError?.httpStatus

  return {
    scope,
    ...(scope === "model" ? { model_key: modelKey } : {}),
    reason,
    retry_at: iso(next),
    remaining_seconds: Math.ceil((next - now) / 1000),
    ...(reason === "quota" || reason === "cloudflare_challenge" ? { backoff_level: state.quota.backoffLevel } : {}),
    ...(status !== undefined && status >= 400 && status <= 599 ? { http_status: status } : {})
  }
}

/** `CooldownSnapshotForAuth`: unexpired credential-wide and per-model retry timers. */
export const cooldownSnapshot = (state: CredentialState, now: number): JsonObject[] => {
  const views: JsonObject[] = []
  const credentialNext = state.quota.exceeded && state.quota.nextRecoverAt > now ? state.quota.nextRecoverAt : 0

  if (state.quota.exceeded && state.quota.reason === "credential_quota" && credentialNext > 0) {
    views.push(cooldownView("credential", "", credentialNext, now, state))
  } else if (Object.keys(state.modelStates).length === 0) {
    const next = Math.max(
      state.unavailable ? state.nextRetryAfter : 0,
      state.quota.exceeded ? state.quota.nextRecoverAt : 0
    )

    if (next > now) views.push(cooldownView("credential", "", next, now, state))
  }

  for (const model of Object.keys(state.modelStates).toSorted()) {
    const modelState = state.modelStates[model]

    if (modelState === undefined || model.trim() === "") continue

    const next = Math.max(
      modelState.unavailable ? modelState.nextRetryAfter : 0,
      modelState.quota.exceeded ? modelState.quota.nextRecoverAt : 0
    )

    if (next > now) views.push(cooldownView("model", model, next, now, modelState))
  }

  return views
}

const integer = (value: Json | undefined): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)

  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim())

  return undefined
}

const websockets = (credential: Credential): boolean | undefined => {
  const raw = credential.attributes.websockets?.trim().toLowerCase() ?? credential.metadata.websockets

  if (raw === true || raw === "true" || raw === "1") return true

  if (raw === false || raw === "false" || raw === "0") return false

  return undefined
}

/** Builds the panel entry of an auth-file credential. `now` is epoch milliseconds. */
export const buildCredentialEntry = (credential: Credential, state: CredentialState, now: number): JsonObject => {
  const { metadata } = credential
  const disabled = credential.disabled
  const cooldowns = cooldownSnapshot(state, now)
  const blocked = state.unavailable || cooldowns.length > 0
  const nextRetry = state.nextRetryAfter > now ? state.nextRetryAfter : 0

  const entry: JsonObject = {
    id: credential.id,
    auth_index: authIndexOf(credential.id),
    name: credential.id,
    type: credential.provider,
    provider: credential.provider,
    label: credential.label,
    status: disabled ? "disabled" : blocked && state.status === "active" ? "error" : state.status,
    status_message: state.statusMessage ?? "",
    disabled,
    unavailable: blocked,
    runtime_only: false,
    source: "file",
    size: new TextEncoder().encode(JSON.stringify(metadata)).length,
    success: state.success,
    failed: state.failed,
    recent_requests: recentRequestBuckets(state.recentRequests, now),
    quota: {
      ...(state.quota.observedAt === undefined ? {} : { observed_at: iso(state.quota.observedAt) }),
      signals: { ...state.quota.signals }
    }
  }

  const modelQuotas: JsonObject = {}

  for (const [model, modelState] of Object.entries(state.modelStates)) {
    if (modelState.quota.observedAt === undefined && Object.keys(modelState.quota.signals ?? {}).length === 0) continue
    modelQuotas[model] = {
      ...(modelState.quota.observedAt === undefined ? {} : { observed_at: iso(modelState.quota.observedAt) }),
      signals: { ...modelState.quota.signals }
    }
  }

  if (Object.keys(modelQuotas).length > 0) entry.model_quotas = modelQuotas

  if (metadata.quota_probe !== undefined && metadata.quota_probe !== null) {
    entry.supports_quota = true
    entry.quota_probe = metadata.quota_probe
  }

  const email = text(metadata.email)

  if (email !== "") entry.email = email
  const projectId = text(metadata.project_id)

  if (projectId !== "") entry.project_id = projectId
  entry.account_type = "oauth"

  if (email !== "") entry.account = email

  if (credential.createdAt > 0) entry.created_at = iso(credential.createdAt)

  if (credential.updatedAt > 0) {
    entry.modtime = iso(credential.updatedAt)
    entry.updated_at = iso(credential.updatedAt)
  }

  const lastRefresh = text(metadata.last_refresh)

  if (lastRefresh !== "") entry.last_refresh = lastRefresh

  if (nextRetry > 0) entry.next_retry_after = iso(nextRetry)
  const claims = codexClaims(credential)

  if (claims !== undefined) entry.id_token = claims

  const priority = integer(metadata.priority)

  if (priority !== undefined) entry.priority = priority
  const note = text(metadata.note)

  if (note !== "") entry.note = note

  if (Object.hasOwn(metadata, "weight") || credential.weight !== DEFAULT_WEIGHT) entry.weight = credential.weight
  const ws = websockets(credential)

  if (ws !== undefined) entry.websockets = ws
  const retry = integer(metadata.request_retry)

  if (retry !== undefined && retry >= 0) entry.request_retry = retry
  entry.cooldowns = cooldowns

  return entry
}
