// Port of the inline route in internal/api/server_routes.go:44-53 (/healthz). Deviation: Go's public JSON banner at
// `/` (:138-146) is replaced by the control panel (src/management/web-panel.ts), which only administrators get.
import { HttpRouter, HttpServerResponse } from "effect/http";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// The router falls back to GET for HEAD requests and the web handler drops the body, which matches the Go
// handler (HEAD -> 200 with an empty body).
const health = HttpServerResponse.text(JSON.stringify({ status: "ok" }), {
  contentType: JSON_CONTENT_TYPE,
});

export const RootRoutes = HttpRouter.add("GET", "/healthz", health);
