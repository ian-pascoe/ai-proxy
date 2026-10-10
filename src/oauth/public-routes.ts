/**
 * Public browser callback routes of the OAuth logins.
 *
 * Go source: internal/api/server_routes.go (`/anthropic/callback`, `/codex/callback`, `/antigravity/callback`,
 * `/callback`, `/devin/callback`; `oauthCallbackSuccessHTML`). Provider client IDs only allow `localhost` redirect
 * URIs, so a browser reaches these routes only when the user rewrites the host of the redirected URL to the Worker.
 * They sit outside `/v8/management` and therefore outside the Access admin gate: a request is honoured only for the
 * `state` of a pending login of the route's provider (an unguessable 128-bit value held in the ControlPlane), and the
 * answer is a static page that never contains tokens, codes, states or error details.
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { controlPlane } from "../management/http.ts"
import { isValidOAuthState, type OAuthProvider } from "./names.ts"

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
} as const

const page = (status: number, title: string, message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(
    `<html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    { status, contentType: "text/html; charset=utf-8", headers: HEADERS }
  )

const rejected = page(400, "Invalid request", "This sign-in link is invalid or has expired. Start the login again.")

const unavailable = page(503, "Unavailable", "The login could not be processed right now. Try again.")

const callbackHandler = (provider: OAuthProvider) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const params = new URL(request.originalUrl, "http://localhost").searchParams
    const state = params.get("state")?.trim() ?? ""
    const code = params.get("code")?.trim() ?? ""
    const error = params.get("error")?.trim() || params.get("error_description")?.trim() || ""

    // Cheap filter before touching the ControlPlane.
    if (!isValidOAuthState(state) || (code === "" && error === "")) return rejected

    const result = yield* controlPlane("oauthCallback", (stub) =>
      stub.oauthCallback({ provider, state, code, error })
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (result === undefined) return unavailable

    if (!result.ok) return rejected

    return result.outcome === "completed"
      ? page(200, "Authentication successful!", "You can close this window and return to the management panel.")
      : page(200, "Authentication failed", "Return to the management panel to see the result and try again.")
  })

const PATHS: ReadonlyArray<readonly [`/${string}`, OAuthProvider]> = [
  ["/anthropic/callback", "anthropic"],
  ["/codex/callback", "codex"],
  ["/antigravity/callback", "antigravity"],
  ["/callback", "devin"],
  ["/devin/callback", "devin"]
]

export const OAuthCallbackRoutes = HttpRouter.addAll(
  PATHS.map(([path, provider]) => HttpRouter.route("GET", path, callbackHandler(provider)))
)
