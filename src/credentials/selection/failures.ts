/**
 * Pick failures: `model_cooldown`, `auth_unavailable`, `auth_not_found`, `provider_not_found`.
 *
 * Go source: sdk/cliproxy/auth/selector.go (`modelCooldownError`, `getAvailableAuthsWithPriorityMode`) and
 * errors.go (`newAuthUnavailableError`). Docs: credentials.md §6.5.
 */
import type { PickFailure } from "./types.ts";

/** Go `Duration.String()` for whole seconds (`45s`, `1m30s`, `1h0m0s`). */
export const formatDurationSeconds = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) return `${hours}h${minutes}m${rest}s`;

  if (minutes > 0) return `${minutes}m${rest}s`;

  return `${rest}s`;
};

export const providerNotFound = (): PickFailure => ({
  code: "provider_not_found",
  message: "no provider available for the requested model",
  retryable: false,
});

export const authNotFound = (message = "no auth available"): PickFailure => ({
  code: "auth_not_found",
  message,
  retryable: false,
});

/** `newAuthUnavailableError`: retryable 503 with `Retry-After` only when a recovery time is known. */
export const authUnavailable = (earliest: number, now: number): PickFailure => {
  if (earliest > now) {
    return {
      code: "auth_unavailable",
      message: "no auth available",
      httpStatus: 503,
      retryable: true,
      retryAfterSeconds: Math.ceil((earliest - now) / 1000),
    };
  }

  return { code: "auth_unavailable", message: "no auth available", retryable: false };
};

/** `modelCooldownError`: HTTP 429 with the Go JSON body. */
export const modelCooldown = (model: string, provider: string, resetInMs: number): PickFailure => {
  const resetMs = Math.max(0, resetInMs);
  const resetSeconds = Math.ceil(resetMs / 1000);
  const display = resetMs > 0 && resetMs < 1000 ? 1 : Math.round(resetMs / 1000);
  let message = `All credentials for model ${model === "" ? "requested model" : model} are cooling down`;

  if (provider !== "") message += ` via provider ${provider}`;

  const error = {
    code: "model_cooldown",
    message,
    model,
    reset_time: formatDurationSeconds(display),
    reset_seconds: resetSeconds,
    ...(provider !== "" ? { provider } : {}),
  };

  return {
    code: "model_cooldown",
    message,
    httpStatus: 429,
    retryable: true,
    retryAfterSeconds: resetSeconds,
    body: JSON.stringify({ error }),
  };
};
