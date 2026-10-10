/**
 * The control panel built from `web/` (`pnpm web:build` writes `public/index.html` and `public/assets/*`): `/`, its
 * page paths (`access/routes.ts` `PANEL_SECTIONS`) and the bundled files under `/assets`.
 *
 * New in the Workers port: Go serves the upstream panel at `/management.html` (still served by `panel.ts` until the new
 * panel replaces it) and a public JSON banner at `/`. Every page path answers the same `index.html`; the panel's router
 * picks the page in the browser. Both pages and files are gated like the management API (Access admin) because the
 * Worker runs before static assets. The page talks to `/v8/management` on its own origin and sends no credentials of
 * its own: Access authenticates those calls.
 */
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { PANEL_SECTIONS } from "../access/routes.ts";
import { WorkerEnv } from "../platform/env.ts";
import { jsonReply } from "./http.ts";

export const PANEL_NOT_BUILT = "the control panel is not built; run `pnpm web:build`";

/**
 * Inline `style` attributes carry computed meter widths; scripts, styles and fonts come only from the panel's own
 * bundle, and the page may only call its own origin.
 */
export const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy": PANEL_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const;

/** The asset response; `undefined` when the binding throws. */
const fetchAsset = (request: Request) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    return yield* Effect.tryPromise({
      try: async () => await env.ASSETS.fetch(request),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
  });

const requestUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, "http://localhost");
});

/** `GET /` and every panel page path: the panel's `index.html` (the assets binding serves it for `/`). */
export const webPanelPage = Effect.gen(function* () {
  const url = yield* requestUrl;

  const asset = yield* fetchAsset(
    new Request(new URL("/", url), { headers: { accept: "text/html" } }),
  );

  const contentType = asset?.headers.get("content-type") ?? "";

  if (asset === undefined || asset.status !== 200 || !contentType.includes("text/html")) {
    yield* Effect.logWarning(PANEL_NOT_BUILT);

    return jsonReply(404, { error: PANEL_NOT_BUILT });
  }

  return HttpServerResponse.raw(asset.body, { status: 200, headers: PAGE_HEADERS });
});

/** Headers of a bundle file worth keeping: hashed names are cached forever by the assets platform. */
const PASSED_ASSET_HEADERS = ["content-type", "cache-control", "etag", "last-modified"] as const;

/** `GET /assets/*`: the panel's hashed bundle files, passed through from the assets binding. */
export const webPanelAsset = Effect.gen(function* () {
  const url = yield* requestUrl;
  const asset = yield* fetchAsset(new Request(url, { method: "GET" }));

  if (asset === undefined || asset.status !== 200) return jsonReply(404, { error: "not found" });

  const passed = PASSED_ASSET_HEADERS.flatMap((name) => {
    const value = asset.headers.get(name);

    return value === null ? [] : [[name, value] as const];
  });

  return HttpServerResponse.raw(asset.body, {
    status: 200,
    headers: { "x-content-type-options": "nosniff", ...Object.fromEntries(passed) },
  });
});

/**
 * Router paths of the panel pages: `/` and each section with its sub-paths (a `/x/*` route also matches `/x`).
 * `/assets` is served by `webPanelAsset`.
 */
export const PANEL_PAGE_PATHS: ReadonlyArray<`/${string}`> = [
  "/",
  ...PANEL_SECTIONS.filter((section) => section !== "assets").map(
    (section): `/${string}` => `/${section}/*`,
  ),
];
