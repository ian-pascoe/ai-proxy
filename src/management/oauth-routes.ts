/**
 * Provider OAuth login routes of the management API.
 *
 * Go source: internal/api/server_management_v8.go (route table), handlers/management/auth_files_v8.go
 * (`StartOAuthV8`), oauth_callback.go (`PostOAuthCallback`, `GetOAuthCallback`, `handleOAuthCallback`),
 * auth_files_provider_oauth.go (`GetAuthStatus`, `CancelAuthSession`). Request/response shapes are the ones the control
 * panel uses (`oauthApi`: `GET /oauth/auth-url?provider=`, `GET /oauth/status?state=`, `DELETE /oauth/session?state=`,
 * `POST /oauth/callback {provider, redirect_url}`); `is_webui` is accepted and ignored (there is no local forwarder).
 * The login state lives in the ControlPlane (`src/oauth`).
 */
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { isJsonObject, type Json } from "../json/index.ts";
import { isValidOAuthState } from "../oauth/names.ts";
import { bodyJson, controlPlane, handled, jsonReply, queryParams, replyError } from "./http.ts";
import { oauthImportRoutes } from "./oauth-import.ts";

const BASE = "/v8/management/oauth";

const trimmed = (value: Json | undefined): string =>
  typeof value === "string" ? value.trim() : "";

const startLogin = Effect.gen(function* () {
  const params = yield* queryParams;
  const domain = params.get("domain")?.trim() || params.get("channel")?.trim() || undefined;
  const flow = params.get("flow")?.trim() || undefined;

  const result = yield* controlPlane("oauthStart", (stub) =>
    stub.oauthStart({
      provider: params.get("provider") ?? "",
      ...(domain === undefined ? {} : { domain }),
      ...(flow === undefined ? {} : { flow }),
    }),
  );

  if (!result.ok) return jsonReply(result.status, { error: result.error });

  return jsonReply(200, {
    status: "ok",
    url: result.url,
    state: result.state,
    ...(result.flow === undefined ? {} : { flow: result.flow }),
    ...(result.userCode === undefined ? {} : { user_code: result.userCode }),
    ...(result.expiresIn === undefined ? {} : { expires_in: result.expiresIn }),
  });
});

const loginStatus = Effect.gen(function* () {
  const state = ((yield* queryParams).get("state") ?? "").trim();

  if (state === "") return jsonReply(200, { status: "ok" });

  if (!isValidOAuthState(state)) return jsonReply(400, { status: "error", error: "invalid state" });
  const result = yield* controlPlane("oauthStatus", (stub) => stub.oauthStatus(state));

  return jsonReply(200, result);
});

const cancelLogin = Effect.gen(function* () {
  const state = ((yield* queryParams).get("state") ?? "").trim();

  if (state === "") return jsonReply(400, { status: "error", error: "missing state" });

  if (!isValidOAuthState(state)) return jsonReply(400, { status: "error", error: "invalid state" });
  const { cancelled } = yield* controlPlane("oauthCancel", (stub) => stub.oauthCancel(state));

  return jsonReply(200, { status: "ok", cancelled });
});

interface CallbackParts {
  readonly provider: string;
  readonly state: string;
  readonly code: string;
  readonly error: string;
}

/** `handleOAuthCallback`: explicit fields win, the rest is read from the pasted `redirect_url`. */
const completeLogin = (parts: CallbackParts & { readonly redirectUrl?: string }) =>
  Effect.gen(function* () {
    let { state, code, error } = parts;

    if (parts.redirectUrl !== undefined && parts.redirectUrl !== "") {
      const url = yield* Effect.try({
        try: () => new URL(parts.redirectUrl ?? "", "http://localhost"),
        catch: () => replyError(400, "invalid redirect_url", { status: "error" }),
      });

      if (state === "") state = url.searchParams.get("state")?.trim() ?? "";

      if (code === "") code = url.searchParams.get("code")?.trim() ?? "";

      if (error === "")
        error =
          url.searchParams.get("error")?.trim() ||
          url.searchParams.get("error_description")?.trim() ||
          "";
    }

    const result = yield* controlPlane("oauthCallback", (stub) =>
      stub.oauthCallback({
        ...(parts.provider === "" ? {} : { provider: parts.provider }),
        state,
        code,
        error,
      }),
    );

    return result.ok
      ? jsonReply(200, { status: "ok" })
      : jsonReply(result.status, { status: "error", error: result.error });
  });

const postCallback = Effect.gen(function* () {
  const body = yield* bodyJson.pipe(
    Effect.mapError(() => replyError(400, "invalid body", { status: "error" })),
  );

  if (!isJsonObject(body)) return yield* replyError(400, "invalid body", { status: "error" });

  return yield* completeLogin({
    provider: trimmed(body.provider),
    state: trimmed(body.state),
    code: trimmed(body.code),
    error: trimmed(body.error),
    redirectUrl: trimmed(body.redirect_url),
  });
});

const getCallback = Effect.gen(function* () {
  const params = yield* queryParams;

  return yield* completeLogin({
    provider: params.get("provider")?.trim() ?? "",
    state: params.get("state")?.trim() ?? "",
    code: params.get("code")?.trim() ?? "",
    error: params.get("error")?.trim() || params.get("error_description")?.trim() || "",
  });
});

export const oauthRoutes = [
  HttpRouter.route("GET", `${BASE}/auth-url`, handled(startLogin)),
  HttpRouter.route("GET", `${BASE}/status`, handled(loginStatus)),
  HttpRouter.route("DELETE", `${BASE}/session`, handled(cancelLogin)),
  HttpRouter.route("POST", `${BASE}/callback`, handled(postCallback)),
  HttpRouter.route("GET", `${BASE}/callback`, handled(getCallback)),
  ...oauthImportRoutes,
];
