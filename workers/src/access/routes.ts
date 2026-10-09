// Route policy: which paths need Cloudflare Access authentication (mirrors the Go route groups in
// internal/api/server_routes.go that use AuthMiddleware) and which need an administrator.

/** Paths under these prefixes require a verified Access principal. `/v1` also covers `/v1beta*` and `/v1internal`. */
export const PROTECTED_PREFIXES = ["/v1", "/openai/v1", "/backend-api/codex", "/v8/management"] as const

/** Paths under this prefix additionally require the principal to be on the admin allow-list. */
export const MANAGEMENT_PREFIX = "/v8/management"

export type AccessZone = "public" | "protected" | "management"

/**
 * Classifies a request URL. Matching is deliberately a superset of what the router matches (percent-decoding,
 * duplicate slashes and case are normalised) so an unusual spelling of a protected path cannot reach a handler
 * unauthenticated; over-matching only turns a 404 into a 401.
 */
export const classifyPath = (requestUrl: string): AccessZone => {
  let path: string
  try {
    path = new URL(requestUrl, "http://invalid.invalid").pathname
  } catch {
    return "protected"
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  path = path.replace(/\/{2,}/g, "/").toLowerCase()
  if (path.startsWith(MANAGEMENT_PREFIX)) return "management"
  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)) ? "protected" : "public"
}
