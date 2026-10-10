/**
 * Bounded retry used by `RefreshTokensWithRetry` (Claude, Codex): up to `attempts` calls, sleeping `attempt` seconds
 * between them, stopping early on non-retryable failures. The last error is returned unchanged so its status and
 * text keep driving the failure classification (Go wraps it in "token refresh failed after N attempts: ...").
 */
import { Effect } from "effect";
import type { RefreshError } from "./error.ts";

export const withRetries = <A, R>(
  attempt: Effect.Effect<A, RefreshError, R>,
  options: {
    readonly attempts: number;
    readonly retryable: (error: RefreshError) => boolean;
    readonly delayMs: (attempt: number) => number;
  },
): Effect.Effect<A, RefreshError, R> => {
  const run = (index: number): Effect.Effect<A, RefreshError, R> =>
    attempt.pipe(
      Effect.catch((error) =>
        !options.retryable(error) || index + 1 >= options.attempts
          ? Effect.fail(error)
          : Effect.sleep(`${options.delayMs(index + 1)} millis`).pipe(
              Effect.andThen(run(index + 1)),
            ),
      ),
    );

  return run(0);
};
