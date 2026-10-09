/**
 * `GET /management.html`: the control panel single-page app.
 *
 * Go source: internal/api/server_management.go (`serveManagementControlPanel`), internal/managementasset/updater.go.
 * The page is a static asset (`public/management.html`, installed by `pnpm panel:sync` with a SHA-256 check against
 * the GitHub release digest, see `tools/panel-sync.mjs`) served through the `ASSETS` binding. It is gated like the
 * management API (Access admin, `access/routes.ts`) although it contains no secrets. The panel talks to
 * `/v8/management` on the page's own origin; Access authenticates those calls, so the "management key" the login
 * form asks for can be any non-empty text.
 */
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { WorkerEnv } from "../platform/env.ts"
import { jsonReply } from "./http.ts"

const ASSET_PATH = "/management.html"

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
  const etag = asset.headers.get("etag")
  return HttpServerResponse.raw(asset.body, {
    status: 200,
    headers: { ...PANEL_HEADERS, ...(etag === null ? {} : { etag }) }
  })
})
