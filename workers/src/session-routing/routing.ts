/**
 * Request-side session routing: combines the explicit identity (headers/body markers), the LCP conversation
 * fingerprints, the derived content-hash identity and the message-hash fallback into what the pick RPC and the usage
 * record need.
 *
 * Go source: sdk/cliproxy/session/identity.go (`Enrich`: derived identity only without any explicit marker),
 * sdk/cliproxy/auth/selector.go (`SessionAffinitySelector.Pick`/`extractSessionIDs`: explicit -> LCP -> derived ->
 * message hash) and conductor_execution.go (`syncMetadataSessionToContext`: the identity recorded in usage).
 */
import type { SessionInfo } from "../handlers/session.ts"
import type { Json } from "../json/index.ts"
import { extractCanonicalTurns, prepareFingerprints, type LcpPrepared } from "./canonical.ts"
import { boundSessionIdentity, deriveId, hasExplicitSession, messageHashIds } from "./identity.ts"

/** A session identity as the pick RPC and usage records carry it. */
export interface RoutingSession {
  readonly id: string
  readonly parentId?: string
  readonly isFork?: boolean
}

export interface SessionRouting {
  /** Conversation fingerprints for the LCP matcher (affinity on, no explicit identity, at least one non-system turn). */
  readonly lcp?: LcpPrepared
  /** Derived / message-hash identity for requests the LCP matcher does not handle. */
  readonly fallbackSession?: RoutingSession
  /** The identity recorded in usage when the credential pick does not settle on another one (LCP). */
  /** `ctx:v1:<hash>` (Go `derived_session_id` metadata); only without an explicit marker. */
  readonly derivedId?: string
  readonly usageSession?: { readonly id: string; readonly parentId?: string }
}

export interface SessionRoutingInput {
  readonly headers: Headers
  /** The client's original request body. */
  readonly body: Json | undefined
  /** Entry protocol (`sourceFormat`). */
  readonly format: string
  readonly callerScope: string
  readonly explicit: SessionInfo | undefined
  /** `routing.session-affinity`: without it only the usage identity is computed. */
  readonly affinity: boolean
}

/** The identity of a session for usage records: bounded, parent only when it differs. */
export const usageIdentity = (
  id: string,
  parentId: string | undefined
): { readonly id: string; readonly parentId?: string } => {
  const bounded = boundSessionIdentity(id)
  const parent = parentId === undefined || parentId === "" ? "" : boundSessionIdentity(parentId)
  return { id: bounded, ...(parent === "" || parent === bounded ? {} : { parentId: parent }) }
}

export const prepareSessionRouting = (input: SessionRoutingInput): SessionRouting => {
  const { explicit } = input
  if (explicit !== undefined) return { usageSession: usageIdentity(explicit.sessionId, explicit.parentSessionId) }

  const derived = hasExplicitSession(input.headers, input.body)
    ? ""
    : deriveId(input.format, input.body, input.callerScope)
  let usageSession = derived === "" ? undefined : usageIdentity(`derived:${derived}`, undefined)
  const derivedId = derived === "" ? {} : { derivedId: derived }
  if (!input.affinity) return usageSession === undefined ? {} : { ...derivedId, usageSession }

  const prepared = prepareFingerprints(extractCanonicalTurns(input.format, input.body))
  const lcp =
    prepared.fingerprints.length > 0 &&
    prepared.minPrefixLength > 0 &&
    prepared.minPrefixLength <= prepared.fingerprints.length
      ? prepared
      : undefined

  let fallbackSession: RoutingSession | undefined
  if (derived !== "") {
    fallbackSession = { id: `derived:${derived}` }
  } else {
    const hashes = messageHashIds(input.body)
    if (hashes.primary !== "") {
      fallbackSession = { id: hashes.primary, ...(hashes.fallback === "" ? {} : { parentId: hashes.fallback }) }
      usageSession = usageIdentity(hashes.primary, undefined)
    }
  }
  return {
    ...derivedId,
    ...(lcp === undefined ? {} : { lcp }),
    ...(fallbackSession === undefined ? {} : { fallbackSession }),
    ...(usageSession === undefined ? {} : { usageSession })
  }
}
