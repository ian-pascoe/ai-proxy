// Route policy: which paths need Cloudflare Access authentication (mirrors the Go route groups in
// internal/api/server_routes.go that use AuthMiddleware) and which need an administrator.

/** Paths under these prefixes require a verified Access principal. `/v1` also covers `/v1beta*` and `/v1internal`. */
export const PROTECTED_PREFIXES = [
  "/v1",
  "/openai/v1",
  "/backend-api/codex",
  "/v8/management",
] as const;

/** Paths under this prefix additionally require the principal to be on the admin allow-list. */
export const MANAGEMENT_PREFIX = "/v8/management";

/** The control panel page: static, but only administrators get it (Go serves it unauthenticated behind its login). */
export const MANAGEMENT_PANEL_PATH = "/management.html";

/**
 * Top-level paths of the new control panel (`web/`, served by `src/management/web-panel.ts`): `/` itself, the panel's
 * pages and their sub-paths, and its bundled files under `/assets`. Like the management API, only administrators get
 * them. Deviation from Go: `/` serves the panel instead of the public JSON banner.
 */
export const PANEL_SECTIONS = [
  "accounts",
  "keys",
  "models",
  "usage",
  "settings",
  "assets",
] as const;

const isPanelPath = (path: string): boolean =>
  path === "/" ||
  PANEL_SECTIONS.some((section) => path === `/${section}` || path.startsWith(`/${section}/`));

export type AccessZone = "public" | "protected" | "management";

/**
 * The path of a request URL, percent-decoded, with duplicate slashes collapsed and lowercased; `undefined` when the
 * URL cannot be parsed.
 */
export const normalizedPath = (requestUrl: string): string | undefined => {
  let path: string;

  try {
    path = new URL(requestUrl, "http://invalid.invalid").pathname;
  } catch {
    return undefined;
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }

  return path.replace(/\/{2,}/g, "/").toLowerCase();
};

/**
 * Classifies a request URL. Matching is deliberately a superset of what the router matches (percent-decoding,
 * duplicate slashes and case are normalised) so an unusual spelling of a protected path cannot reach a handler
 * unauthenticated; over-matching only turns a 404 into a 401.
 */
export const classifyPath = (requestUrl: string): AccessZone => {
  const path = normalizedPath(requestUrl);

  if (path === undefined) return "protected";

  if (
    path.startsWith(MANAGEMENT_PREFIX) ||
    path.startsWith(MANAGEMENT_PANEL_PATH) ||
    isPanelPath(path)
  )
    return "management";

  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)) ? "protected" : "public";
};
