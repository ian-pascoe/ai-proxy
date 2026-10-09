/**
 * ControlPlane RPC access for executors (request-time credential preparation).
 *
 * Go source: sdk/cliproxy/auth/conductor_refresh.go (EnsureFresh / tryRefreshAfterUnauthorized semantics). The
 * `ControlPlane` Durable Object is the single writer of credentials; executors only ask it for a snapshot with a usable
 * `metadata.access_token`.
 * TODO(retry slice #7): a shared 401 -> `refreshNow(id, rejectedAccessToken)` -> retry-once helper belongs here.
 */
import { Effect } from "effect"
import { WorkerEnv } from "../../platform/env.ts"
import { ExecutionError } from "../errors.ts"

/** The access token of a credential snapshot's metadata (`""` when absent). */
export const accessTokenOf = (metadata: Readonly<Record<string, unknown>>): string => {
  const token = metadata["access_token"]
  return typeof token === "string" ? token.trim() : ""
}

/**
 * `ControlPlane.ensureFresh(id)`: returns the credential metadata ready for use (Vertex mints a service-account token,
 * OAuth providers refresh an expired token). Failures never carry the upstream detail to the client.
 */
export const ensureFreshMetadata = (credentialId: string) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv
    const result = yield* Effect.tryPromise({
      try: async () => await env.CONTROL_PLANE.getByName("global").ensureFresh(credentialId),
      catch: (cause) => new ExecutionError({ status: 500, message: "internal server error", cause })
    })
    if (!result.ok) {
      return yield* new ExecutionError({
        status: result.terminal ? 401 : 500,
        message: result.terminal ? "credential requires re-authentication" : "internal server error",
        credentialScoped: true
      })
    }
    return result.credential.metadata as Readonly<Record<string, unknown>>
  })
