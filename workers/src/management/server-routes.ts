/**
 * Operational management routes that need no credentials: latest-version check and the file-log stubs.
 *
 * Go source: internal/api/handlers/management/config_basic.go (`GetLatestVersion`), logs.go (`GetLogs`,
 * `GetRequestErrorLogs`: file based, answers `logging to file disabled` when file logging is off). Workers have no
 * log files (use `alchemy logs --tail` / Workers Logs), so the log routes behave like Go with file logging disabled.
 */
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http"
import { isJsonObject, type Json } from "../json/index.ts"
import { handled, jsonReply, replyError } from "./http.ts"

const RELEASE_URL = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest"

const latestVersion = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.get(RELEASE_URL).pipe(
    HttpClientRequest.setHeaders({ accept: "application/vnd.github+json", "user-agent": "CLIProxyAPI" })
  )
  const outcome = yield* Effect.gen(function* () {
    const response = yield* client.execute(request).pipe(Effect.timeout("10 seconds"))
    return { status: response.status, text: yield* response.text.pipe(Effect.timeout("10 seconds")) }
  }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.result)
  if (outcome._tag === "Failure") {
    return yield* replyError(502, "request_failed", { message: "failed to reach the release API" })
  }
  const { status, text } = outcome.success
  if (status < 200 || status >= 300) {
    return yield* replyError(502, "unexpected_status", { message: `unexpected release API status ${status}` })
  }
  const release = yield* Effect.try({
    try: () => JSON.parse(text) as Json,
    catch: () => replyError(502, "decode_failed", { message: "release response is not JSON" })
  })
  const tag = isJsonObject(release) ? String(release.tag_name ?? "").trim() || String(release.name ?? "").trim() : ""
  if (tag === "") return yield* replyError(502, "invalid_response", { message: "release has no tag" })
  return jsonReply(200, { "latest-version": tag })
})

export const latestVersionHandler = handled(latestVersion)

/** `GET|DELETE /observability/logs`: no log files on Workers. */
export const logsDisabledHandler = handled(Effect.fail(replyError(400, "logging to file disabled")))

/** `GET /observability/logs/errors[/:name]`: no error log files, so the list is empty and every name is unknown. */
export const errorLogsHandler = handled(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const rest = new URL(request.originalUrl, "http://localhost").pathname
      .slice("/v8/management/observability/logs/errors".length)
      .replace(/^\/+/, "")
    return rest === "" ? jsonReply(200, { files: [] }) : yield* replyError(404, "log file not found")
  })
)

/** `GET /observability/logs/requests/:id`. */
export const requestLogHandler = handled(Effect.fail(replyError(404, "log file not found")))
