// Port of the inline routes in internal/api/server_routes.go:44-53 (/healthz) and :138-146 (/).
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

const JSON_CONTENT_TYPE = "application/json; charset=utf-8"

// Gin serialises `gin.H` (a map) with sorted keys, so `endpoints` precedes `message`.
const ROOT_BODY = JSON.stringify({
  endpoints: ["POST /v1/chat/completions", "POST /v1/completions", "GET /v1/models"],
  message: "CLI Proxy API Server"
})

// The router falls back to GET for HEAD requests and the web handler drops the body, which matches the Go
// handler (HEAD -> 200 with an empty body).
const health = HttpServerResponse.text(JSON.stringify({ status: "ok" }), { contentType: JSON_CONTENT_TYPE })

export const RootRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/healthz", health),
  HttpRouter.add("GET", "/", HttpServerResponse.text(ROOT_BODY, { contentType: JSON_CONTENT_TYPE }))
)
