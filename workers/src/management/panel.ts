/**
 * `GET /management.html`: the control panel single-page app.
 *
 * Go source: internal/api/server_management.go (`serveManagementControlPanel`), internal/managementasset/updater.go.
 * The page is a static asset (`public/management.html`, installed by `pnpm panel:sync` with a SHA-256 check against
 * the GitHub release digest, see `tools/panel-sync.mjs`) served through the `ASSETS` binding. It is gated like the
 * management API (Access admin, `access/routes.ts`) although it contains no secrets. The panel talks to
 * `/v8/management` on the page's own origin; Access authenticates those calls, so the "management key" its login form
 * asks for is meaningless here. Deviation from Go: the page is served with `AUTO_LOGIN_SCRIPT` prepended to `<head>`,
 * which stores a placeholder key and the "remember me" flag before the panel boots, so the panel logs in on its own.
 */
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { WorkerEnv } from "../platform/env.ts"
import { jsonReply } from "./http.ts"

const ASSET_PATH = "/management.html"

/** Placeholder stored as the panel's management key (never checked: Access is the authentication). */
export const PANEL_PLACEHOLDER_KEY = "cloudflare-access"

/**
 * Seeds the panel's saved login (Cli-Proxy-API-Management-Center `restoreSession`: `localStorage.isLoggedIn === "true"`
 * plus a `managementKey`; the API base defaults to the page's origin). A plain JSON value is migrated by the panel into
 * its obfuscated storage format on start. Logging out in the panel only lasts until the next page load.
 */
export const AUTO_LOGIN_SCRIPT =
  `(()=>{try{if(localStorage.getItem("isLoggedIn")!=="true"){` +
  `localStorage.setItem("managementKey",${JSON.stringify(JSON.stringify(PANEL_PLACEHOLDER_KEY))});` +
  `localStorage.setItem("isLoggedIn","true")}}catch{}})()`

const PANEL_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer"
} as const

export const NOT_INSTALLED = "management.html is not installed; run `pnpm panel:sync` before deploying"

export const panelHandler = Effect.gen(function* () {
  const env = yield* WorkerEnv
  const request = yield* HttpServerRequest.HttpServerRequest
  const assetUrl = new URL(ASSET_PATH, new URL(request.originalUrl, "http://localhost"))
  const asset = yield* Effect.tryPromise({
    try: async () => await env.ASSETS.fetch(new Request(assetUrl, { headers: { accept: "text/html" } })),
    catch: () => undefined
  }).pipe(Effect.orElseSucceed(() => undefined))
  const contentType = asset?.headers.get("content-type") ?? ""
  if (asset === undefined || asset.status !== 200 || !contentType.includes("text/html")) {
    // Without the asset the platform answers an SPA fallback or 404; make the failure explicit.
    yield* Effect.logWarning(NOT_INSTALLED)
    return jsonReply(404, { error: NOT_INSTALLED })
  }
  const page = new HTMLRewriter()
    .on("head", {
      element: (head) => {
        head.prepend(`<script>${AUTO_LOGIN_SCRIPT}</script>`, { html: true })
      }
    })
    .transform(asset)
  // The asset's ETag describes the unmodified file; the rewritten page is always sent in full (no-cache, no ETag).
  return HttpServerResponse.raw(page.body, { status: 200, headers: PANEL_HEADERS })
})
