/**
 * Meta upstream error rules.
 *
 * Go source: internal/runtime/executor/meta_executor.go (`parseMetaRetryAfter`, `isMetaSubscriptionQuota`),
 * meta_executor_execute.go (`wrapMetaUpstreamError`, `metaStreamEventError`, `metaNotFoundCooldown`).
 */
import { asInt, get, type Json, tryParseJson } from "../../json/index.ts";
import { ExecutionError } from "../errors.ts";

/** `metaNotFoundCooldown`: a 404 without a usable `resets_at` cools the model for five minutes. */
export const META_NOT_FOUND_COOLDOWN_MS = 5 * 60_000;

/** `parseMetaRetryAfter`: `error.resets_at` (unix seconds) in the future, for 429 and 404 bodies. */
export const parseMetaRetryAfterMs = (
  status: number,
  body: Json | undefined,
  nowMs: number,
): number | undefined => {
  if ((status !== 429 && status !== 404) || body === undefined) return undefined;
  const resetsAt = asInt(get(body, "error.resets_at"));

  if (resetsAt > 0 && resetsAt * 1000 > nowMs) return resetsAt * 1000 - nowMs;

  return undefined;
};

/** `isMetaSubscriptionQuota`: a 429 that exhausts the subscription rather than the model. */
export const isMetaSubscriptionQuota = (status: number, body: Json | undefined): boolean => {
  if (status !== 429 || body === undefined) return false;
  const message = String(get(body, "error.message") ?? "").toLowerCase();
  const code = String(get(body, "error.code") ?? "").toLowerCase();

  if (message.includes("subscription quota") || message.includes("quota exhausted")) return true;

  return (
    (code === "rate_limit_exceeded" || code.includes("quota")) &&
    get(body, "error.resets_at") !== undefined
  );
};

/** `wrapMetaUpstreamError`. */
export const wrapMetaUpstreamError = (
  status: number,
  body: string,
  nowMs: number,
): ExecutionError => {
  const parsed = tryParseJson(body);
  const resetMs = parseMetaRetryAfterMs(status, parsed, nowMs);

  if (status === 429) {
    const credentialScoped = isMetaSubscriptionQuota(status, parsed);

    return new ExecutionError({
      status,
      message: body,
      ...(resetMs !== undefined ? { retryAfterMs: resetMs } : {}),
      ...(credentialScoped ? { credentialScoped: true } : {}),
    });
  }

  if (status === 404) {
    return new ExecutionError({
      status,
      message: body,
      retryAfterMs: resetMs ?? META_NOT_FOUND_COOLDOWN_MS,
    });
  }

  return new ExecutionError({ status, message: body });
};

/** `metaStreamEventError`: `error` / `response.failed` events become upstream errors (status from `error.code`). */
export const metaStreamEventError = (
  event: Json | undefined,
  payload: string,
  nowMs: number,
): ExecutionError | undefined => {
  const type = String(get(event, "type") ?? "");

  if (type !== "error" && type !== "response.failed") return undefined;
  const code = asInt(get(event, "error.code"));

  return wrapMetaUpstreamError(code >= 400 && code <= 599 ? code : 502, payload, nowMs);
};
