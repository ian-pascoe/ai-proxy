/**
 * Logging conventions: log through Effect (`Effect.logInfo` and friends, annotated with plain data) and never
 * log tokens, API keys, JWTs, cookies or request/response bodies. Use these helpers when headers must be logged.
 */

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-goog-api-key",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
]);

/** Returns the headers as a plain record with sensitive values replaced by `[redacted]`. */
export const redactHeaders = (headers: Headers) =>
  Object.fromEntries(
    Array.from(headers, ([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
    ]),
  );
