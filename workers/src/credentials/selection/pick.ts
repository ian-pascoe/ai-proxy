/**
 * Credential selection: candidate set -> availability -> priority tier -> strategy, optionally wrapped by session
 * affinity. Pure and deterministic given its inputs (state, runtime cursors and the clock are parameters).
 *
 * Go source: sdk/cliproxy/auth/conductor_selection.go (`pickNextMixedLegacy`), selector.go (`getAvailableAuths*`,
 * `collectAvailableByPriority`, `RoundRobinSelector`, `FillFirstSelector`, `WeightedRoundRobinSelector`,
 * `SessionAffinitySelector.Pick`). Docs: credentials.md §6.1-6.5, §6.9.
 *
 * Multiple providers are selected from one ID-sorted union (the Go "mixed" legacy path); the scheduler fast path's
 * per-provider slot cursor is not reproduced.
 */
import type { RoutingStrategy } from "../../config/schema.ts"
import { type Credential, type CredentialState, executorKey } from "../model.ts"
import { affinityKey, isSubagentSession, type SessionCache } from "./affinity.ts"
import { isBlockedForModel } from "./availability.ts"
import { authNotFound, authUnavailable, modelCooldown, providerNotFound } from "./failures.ts"
import { canonicalModelKey } from "./model-name.ts"
import { resolveModelRoute, type ModelRoute, type RoutingContext } from "./routing.ts"
import type { RotationState } from "./strategies.ts"
import type { PickFailure, PickRequest } from "./types.ts"

export interface CredentialEntry {
  readonly credential: Credential
  readonly state: CredentialState
}

export interface SelectionSettings extends Omit<RoutingContext, "knownPrefixes"> {
  readonly strategy: RoutingStrategy
  readonly sessionAffinity: boolean
  /** `routing.session-affinity-subagents`: subagents inherit the parent's credential. */
  readonly sessionAffinitySubagents: boolean
}

export interface SelectionRuntime {
  readonly rotation: RotationState
  readonly affinity: SessionCache
}

export interface SelectionInput {
  readonly credentials: ReadonlyArray<CredentialEntry>
  readonly request: PickRequest
  readonly settings: SelectionSettings
  readonly runtime: SelectionRuntime
  readonly now: number
}

export type SelectionOutcome =
  | {
      readonly ok: true
      readonly entry: CredentialEntry
      readonly route: ModelRoute
      /** Affinity cache keys bound by this pick (for `report`). */
      readonly affinityKeys: ReadonlyArray<string>
    }
  | { readonly ok: false; readonly failure: PickFailure }

interface Candidate {
  readonly entry: CredentialEntry
  readonly route: ModelRoute
  readonly id: string
  readonly weight: number
  readonly priority: number
}

const MAX_SESSION_ID = 256

/** `BoundSessionIdentity`: over-long identities are shortened with a stable digest. */
const boundSessionId = (id: string): string => {
  if (id.length <= MAX_SESSION_ID) return id
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  const digest = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0")
  return `${id.slice(0, 190)}#${digest}`
}

const truthy = (value: unknown): boolean =>
  value === true || (typeof value === "string" && value.toLowerCase() === "true")

/** Prefix set of enabled credentials: `team-a/gpt-5` only belongs to credentials registered under `team-a`. */
export const knownPrefixes = (credentials: ReadonlyArray<CredentialEntry>): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const { credential } of credentials) {
    if (!credential.disabled && credential.prefix !== undefined && credential.prefix !== "") out.add(credential.prefix)
  }
  return out
}

const highestPriority = (candidates: ReadonlyArray<Candidate>): Candidate[] => {
  let best = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) if (candidate.priority > best) best = candidate.priority
  return candidates.filter((candidate) => candidate.priority === best)
}

/** Selects one credential for `request`, or explains why none is selectable. */
export const selectCredential = (input: SelectionInput): SelectionOutcome => {
  const { request, settings, runtime, now } = input
  const providers = new Set(request.providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean))
  if (providers.size === 0) return { ok: false, failure: providerNotFound() }

  const routing: RoutingContext = { ...settings, knownPrefixes: knownPrefixes(input.credentials) }
  const tried = new Set(request.tried ?? [])
  const pinned = request.pinnedAuthId?.trim() ?? ""

  // 1. Candidate set.
  const all: Candidate[] = []
  for (const entry of input.credentials) {
    const { credential } = entry
    if (credential.disabled) continue
    if (pinned !== "" && credential.id !== pinned) continue
    if (request.requireAuthKind !== undefined && credential.authKind !== request.requireAuthKind) continue
    if (
      request.disallowFreeCodex === true &&
      credential.provider === "codex" &&
      (credential.attributes.plan_type ?? "").trim().toLowerCase() === "free"
    ) {
      continue
    }
    if (!providers.has(executorKey(credential))) continue
    if (tried.has(credential.id)) continue
    const route = resolveModelRoute(credential, request.model, routing)
    if (route === undefined) continue
    all.push({ entry, route, id: credential.id, weight: credential.weight, priority: credential.priority })
  }
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (all.length === 0) return { ok: false, failure: authNotFound() }

  // Weighted round-robin ignores credentials with a non-positive weight before availability is evaluated.
  const weighted = settings.strategy === "weighted-round-robin"
  const pool = weighted ? all.filter((candidate) => candidate.weight > 0) : all
  if (pool.length === 0) return { ok: false, failure: authNotFound("no auth candidates") }

  // 2. Availability across all tiers.
  const available: Candidate[] = []
  let cooldownCount = 0
  let earliest = 0
  for (const candidate of pool) {
    const block = isBlockedForModel(
      candidate.entry.credential,
      candidate.entry.state,
      candidate.route.selectionModel,
      now
    )
    if (!block.blocked) {
      available.push(candidate)
      continue
    }
    if (block.reason === "cooldown") cooldownCount += 1
    if (block.reason !== "disabled" && block.next > now && (earliest === 0 || block.next < earliest))
      earliest = block.next
  }
  if (available.length === 0) {
    if (cooldownCount === pool.length && earliest !== 0) {
      const provider = providers.size === 1 ? [...providers][0] : ""
      return { ok: false, failure: modelCooldown(request.model, provider ?? "", earliest - now) }
    }
    return { ok: false, failure: authUnavailable(earliest, now) }
  }

  // 3. Priority tier + strategy (+ optional Codex websocket preference).
  const providerLabel = [...providers].toSorted().join(",")
  const modelKey = canonicalModelKey(request.model)
  const rotationKey = `${providerLabel}:${modelKey}`
  const strategyPick = (candidates: ReadonlyArray<Candidate>): Candidate | undefined => {
    let list = candidates
    if (request.preferWebsockets === true && providers.has("codex")) {
      const websockets = list.filter(
        ({ entry }) => truthy(entry.credential.attributes.websockets) || truthy(entry.credential.metadata.websockets)
      )
      if (websockets.length > 0) list = websockets
    }
    switch (settings.strategy) {
      case "fill-first":
        return runtime.rotation.fillFirst(list)
      case "weighted-round-robin":
        return runtime.rotation.weightedRoundRobin(rotationKey, list)
      default:
        return runtime.rotation.roundRobin(rotationKey, list)
    }
  }
  const fallbackTier = highestPriority(available)

  const done = (picked: Candidate | undefined, affinityKeys: ReadonlyArray<string>): SelectionOutcome =>
    picked === undefined
      ? { ok: false, failure: authNotFound("no auth available with positive weight") }
      : { ok: true, entry: picked.entry, route: picked.route, affinityKeys }

  // 4. Session affinity: a binding outranks priority, an unavailable binding falls back to the highest tier.
  const sessionId = settings.sessionAffinity ? (request.session?.id.trim() ?? "") : ""
  if (sessionId === "") return done(strategyPick(fallbackTier), [])

  const session = request.session
  const scope = session?.callerScope ?? ""
  const primaryId = boundSessionId(sessionId)
  const parentRaw = session?.parentId?.trim() ?? ""
  const parentId = parentRaw === "" ? "" : boundSessionId(parentRaw)
  const cacheKey = affinityKey(scope, providerLabel, primaryId, modelKey)
  const fallbackKey =
    parentId !== "" && parentId !== primaryId ? affinityKey(scope, providerLabel, parentId, modelKey) : undefined
  const isFork = session?.isFork === true
  const isSubagent = !isFork && isSubagentSession(primaryId, parentId)
  const bind = (authId: string): string[] => {
    runtime.affinity.set(cacheKey, authId, now)
    if (fallbackKey !== undefined && !isSubagent && !isFork) {
      runtime.affinity.set(fallbackKey, authId, now)
      return [cacheKey, fallbackKey]
    }
    return [cacheKey]
  }
  const find = (authId: string | undefined): Candidate | undefined =>
    authId === undefined ? undefined : available.find((candidate) => candidate.id === authId)

  const cachedId = runtime.affinity.getAndRefresh(cacheKey, now)
  const bound = find(cachedId)
  if (bound !== undefined) return done(bound, bind(bound.id))
  // A stale binding is re-picked straight away; the parent alias is only consulted without a binding.
  if (cachedId === undefined && fallbackKey !== undefined && (!isSubagent || settings.sessionAffinitySubagents)) {
    const inherited = find(runtime.affinity.get(fallbackKey, now))
    if (inherited !== undefined) return done(inherited, bind(inherited.id))
  }
  const picked = strategyPick(fallbackTier)
  return done(picked, picked === undefined ? [] : bind(picked.id))
}
