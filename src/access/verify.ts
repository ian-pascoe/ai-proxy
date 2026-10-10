// Verification of the `Cf-Access-Jwt-Assertion` JWT (RS256, JWKS, iss/aud/exp/nbf). New in the Workers port.
import { Clock, Effect } from "effect";
import { decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { InternalError, UnauthorizedError } from "../errors.ts";
import type { AccessConfig } from "./config.ts";
import { AccessJwks } from "./jwks.ts";
import type { Principal } from "./principal.ts";

/** Allowed clock difference in seconds for `exp` / `nbf`. */
export const CLOCK_SKEW_SECONDS = 30;

// Same wording as the Go auth middleware (sdk/access/errors.go).
const invalidCredential = () => new UnauthorizedError({ message: "Invalid API key" });

/** User tokens carry `email` + `sub`; service tokens carry the client id in `common_name`. */
export const principalFromClaims = (claims: JWTPayload): Principal | undefined => {
  const email = typeof claims["email"] === "string" ? claims["email"].trim() : "";

  if (email !== "")
    return { kind: "user", email, sub: typeof claims.sub === "string" ? claims.sub : "" };
  const commonName = typeof claims["common_name"] === "string" ? claims["common_name"].trim() : "";

  if (commonName !== "") return { kind: "service", commonName };

  return undefined;
};

/**
 * Verifies the Access JWT and returns its principal.
 *
 * Fails with `UnauthorizedError` for any token problem (malformed, bad signature, wrong iss/aud, expired, unknown
 * kid) and with `InternalError` when the signing keys cannot be obtained.
 */
export const verifyAccessJwt = (
  token: string,
  config: Pick<AccessConfig, "issuer" | "jwksUrl" | "audiences">,
): Effect.Effect<Principal, UnauthorizedError | InternalError, AccessJwks> =>
  Effect.gen(function* () {
    const jwks = yield* AccessJwks;

    const header = yield* Effect.try({
      try: () => decodeProtectedHeader(token),
      catch: invalidCredential,
    });

    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "") {
      return yield* invalidCredential();
    }

    const key = yield* jwks.getKey(config.jwksUrl, header.kid).pipe(
      Effect.catchTags({
        UnknownKeyError: () => Effect.fail(invalidCredential()),
        JwksFetchError: (error) => Effect.fail(new InternalError({ message: error.message })),
      }),
    );

    const now = yield* Clock.currentTimeMillis;

    const { payload } = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, key, {
          algorithms: ["RS256"],
          issuer: config.issuer,
          audience: [...config.audiences],
          clockTolerance: CLOCK_SKEW_SECONDS,
          currentDate: new Date(now),
          requiredClaims: ["exp"],
        }),
      catch: invalidCredential,
    });

    const principal = principalFromClaims(payload);

    return principal ?? (yield* invalidCredential());
  });
