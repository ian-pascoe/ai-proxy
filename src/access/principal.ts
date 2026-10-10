// Mirrors CallerScope in sdk/cliproxy/session/identity.go (sha256 of a versioned prefix + caller credential).
// The Go `userApiKey` is replaced by the Cloudflare Access principal.
import { Context, Effect } from "effect";

/** The authenticated caller: an Access user (email) or an Access service token (client id). */
export type Principal =
  | { readonly kind: "user"; readonly email: string; readonly sub: string }
  | { readonly kind: "service"; readonly commonName: string };

/** A verified principal plus the identifiers derived from it. */
export interface AccessIdentity {
  readonly principal: Principal;
  /** Stable text identity for usage records: `user:<lowercased email>` or `service:<common_name>`. */
  readonly principalId: string;
  /** Irreversible namespace used to isolate session state between callers (`callerScope(principalId)`). */
  readonly callerScope: string;
}

/**
 * The authenticated principal of the current request.
 *
 * Provided by the Access gate for every request under a protected prefix (see `access/routes.ts`); handlers for
 * `/v1*`, `/v1beta*`, `/openai/v1*`, `/backend-api/codex*` and `/v8/management*` can `yield* AccessPrincipal`.
 */
export class AccessPrincipal extends Context.Service<AccessPrincipal, AccessIdentity>()(
  "cliproxy/access/AccessPrincipal",
) {}

export const principalId = (principal: Principal): string =>
  principal.kind === "user"
    ? `user:${principal.email.toLowerCase()}`
    : `service:${principal.commonName}`;

const CALLER_SCOPE_PREFIX = "cli-proxy-api:caller-scope:v1\u0000";

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** `sha256("cli-proxy-api:caller-scope:v1\x00" + value)` as lowercase hex; empty for a blank value (like Go). */
export const callerScope = (value: string): Effect.Effect<string> => {
  const trimmed = value.trim();

  if (trimmed === "") return Effect.succeed("");

  return Effect.promise(async () =>
    toHex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(CALLER_SCOPE_PREFIX + trimmed),
      ),
    ),
  );
};

export const makeIdentity = (principal: Principal): Effect.Effect<AccessIdentity> =>
  Effect.gen(function* () {
    const id = principalId(principal);

    return { principal, principalId: id, callerScope: yield* callerScope(id) };
  });
