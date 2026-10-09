# Request Pipeline — End-to-End Reference (for the TypeScript / Cloudflare Workers port)

Scope: inbound HTTP routes → handlers → model resolution → auth manager/conductor → executors → translators →
thinking → payload rules → response framing, plus signature caches and usage accounting.
Source of truth: the Go repo at `/home/ianpascoe/src/ai-proxy` (module `github.com/router-for-me/CLIProxyAPI/v8`).
Paths below are repo-relative; `file:line` citations were verified against the working tree. Credential selection /
cooldown / refresh internals (conductor) and per-provider upstream wire details (URLs, headers, OAuth) are covered by
the sibling research docs (e.g. `providers-claude-codex-openai.md`); here only the **interface** to them is described.

---

## 0. Pipeline at a glance

```
HTTP in (gin)                                           internal/api/server_routes.go:63-134
 └ middleware: trace-id wrapper, [request logger], CORS, [home heartbeat], [example-key safe mode]
 └ per-group AuthMiddleware (client API key)             internal/api/server_middleware.go:159
 └ handler (sdk/api/handlers/{openai,claude,gemini})     parses body, picks entry protocol ("handlerType")
     └ BaseAPIHandler.Execute*WithAuthManager            sdk/api/handlers/handlers_execution.go:47 / handlers_stream.go:284
         1. [plugin model router]  (out of scope)
         2. resolve providers+model  (getRequestDetailsWithOptions)   handlers_routing.go:165
         3. build executor.Request{Model,Payload} + Options{SourceFormat,ResponseFormat,Headers,Query,OriginalRequest,Metadata}
         4. AuthManager.Execute / ExecuteCount / ExecuteStream(providers, req, opts)   sdk/cliproxy/auth/conductor_execution.go:122/182/235
              └ round-robin/priority pick of credential, per-credential model alias, retry across credentials
              └ ProviderExecutor.Execute/ExecuteStream/CountTokens(ctx, auth, req, opts)   (internal/runtime/executor/*)
                   a. translate request   (sdk/translator registry: from=client format → to=provider format)
                   b. set upstream model, apply thinking (ApplyRequestThinking)
                   c. provider-specific shaping (cloaking, cache_control, …)
                   d. USER PAYLOAD RULES  (final barrier)   helps/payload_helpers.go:54
                   e. HTTP/WS to upstream, usage reporter wraps client
                   f. translate response chunk-by-chunk (provider format → client format)
 └ handler frames the result as SSE / JSON / WebSocket, formats errors per protocol
 └ usage Record published (async) to plugins (redis-queue plugin is the only built-in sink)
```

Key idea: **every inbound protocol is an "entry protocol" string** (`openai`, `openai-response`, `claude`, `gemini`,
`interactions`, plus special `openai-image`, `openai-video`, `openai-speech`, `codex-alpha-search`). The same string is
passed to the executor as `Options.SourceFormat`; the executor picks its own *target* format (`claude`, `codex`, `gemini`,
`openai`, `antigravity`, …) and the translator registry bridges the two.

---

## 1. Inbound HTTP routes

All routes are registered in `internal/api/server_routes.go:setupRoutes` (lines 45-215) unless noted. Auth middleware is
`AuthMiddleware(accessManager)` (§1.2) unless stated. gin router: `*action`/`*model` are catch-all params.

### 1.1 Route table

| Method + path | Handler | Entry protocol / format | Notes |
|---|---|---|---|
| `GET,HEAD /healthz` | inline | – | `{"status":"ok"}` (HEAD → 200 empty). **No auth.** (:52-53) |
| `GET /` | inline | – | `{"message":"CLI Proxy API Server","endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"]}` no auth (:138-146) |
| `GET /management.html` + `/v0/management/*` | management | – | Out of scope; `/v0/management` is deprecated per AGENTS.md |
| **`/v1` group (auth)** | | | |
| `GET /v1/models` | `unifiedModelsHandler` (:384) | openai **or** claude list shape | see §2.9 |
| `GET /v1/models/*model` | same, with `ModelDetailIDContextKey` set | | returns a single entry or 404 |
| `POST /v1/chat/completions` | `OpenAIAPIHandler.ChatCompletions` (`sdk/api/handlers/openai/openai_handlers.go:116`) | `openai` | auto-detects Responses-shaped payload (§2.4) |
| `POST /v1/completions` | `OpenAIAPIHandler.Completions` | `openai` (legacy text completions converted to chat) | §2.4 |
| `POST /v1/images/generations` | `OpenAIAPIHandler.ImagesGenerations` (`…/openai_images_handlers.go:619`) | `openai-image` / `openai-response` | §2.7 |
| `POST /v1/images/edits` | `ImagesEdits` | idem (JSON or multipart) | |
| `POST /v1/videos`, `/v1/videos/generations`, `/v1/videos/edits`, `/v1/videos/extensions` | `XAIVideosGenerations/Edits/Extensions` | `openai-video` | xAI-native passthrough (§2.8) |
| `GET /v1/videos/:request_id` | `XAIVideosRetrieve` | `openai-video` | |
| `POST /v1/audio/speech`, `POST /v1/tts` | `AudioSpeech` / `XAITTS` | `openai-speech` | §2.8 |
| `POST /v1/messages` | `ClaudeCodeAPIHandler.ClaudeMessages` (`claude/code_handlers.go:72`) | `claude` | |
| `POST /v1/messages/count_tokens` | `ClaudeCountTokens` (:104) | `claude` (count) | |
| `GET /v1/responses` | `OpenAIResponsesAPIHandler.ResponsesWebsocket` (`openai_responses_websocket.go:269`) | `openai-response` over **WebSocket** | §2.6 |
| `POST /v1/responses` | `Responses` (`openai_responses_handlers.go:601`) | `openai-response` | |
| `POST /v1/responses/compact` | `Compact` (:627) | `openai-response`, `alt="responses/compact"` | non-stream only |
| `POST /v1/alpha/search` | `Server.codexAlphaSearch` (`internal/api/server_routes.go:341`) | `codex-alpha-search` (no translator) | raw proxy to Codex, §2.10 |
| `POST /v1/live`, `GET /v1/live/:call_id` | Codex live handler | WebRTC bootstrap | **not portable**, §9 |
| **Realtime (separate auth middlewares)** | | | |
| `GET,POST /v1/realtime`, `POST /v1/realtime/calls`, `GET /v1/realtime/calls/:call_id`, `POST /v1/realtime/{client_secrets,sessions,transcription_sessions,translations,translations/client_secrets}`, `GET /v1/realtime/translations`, `POST /v1/realtime/calls/:call_id/{hangup,accept,reject,refer}` | `internal/client/codex/live/*` | Codex realtime | **not portable** (pion WebRTC relay + raw TCP proxy), §9 |
| **`/openai/v1` group (auth)** | | | |
| `POST /openai/v1/videos`, `GET /openai/v1/videos/:video_id`, `GET /openai/v1/videos/:video_id/content` | `VideosCreate/Retrieve/Content` | OpenAI Sora-shaped API backed by xAI video | §2.8 |
| **`/backend-api/codex` group (auth)** — Codex CLI `chatgpt_base_url` aliases | | | |
| `GET /backend-api/codex/responses` (WS), `POST …/responses`, `POST …/responses/compact`, `POST …/alpha/search` | same handlers as `/v1/…` | | (:118-125) |
| **`/v1beta` group (auth)** — Gemini API | | | |
| `GET /v1beta/models` | `geminiModelsHandler` → `GeminiAPIHandler.GeminiModels` | `gemini` list | |
| `GET /v1beta/models/*action` | `GeminiGetHandler` | `gemini` single model | `404 {"error":{"message":"Not Found","type":"not_found"}}` if absent |
| `POST /v1beta/models/*action` | `GeminiHandler` (`gemini/gemini_handlers.go:129`) | `gemini` | action = `<model>:<method>`; methods `generateContent`, `streamGenerateContent`, `countTokens`. Anything else → silently no output (falls through the switch). If `action` doesn't split into exactly 2 parts on `:` → `404 {"error":{"message":"<path> not found.","type":"invalid_request_error"}}` |
| `POST /v1beta/interactions` | `GeminiAPIHandler.Interactions` (`gemini/interactions_handlers.go`) | `interactions` | Google "Interactions" API; §2.5 |
| **OAuth browser callbacks (no auth)** | | | |
| `GET /anthropic/callback`, `/codex/callback`, `/antigravity/callback`, `/callback`, `/devin/callback` | inline | – | write the `code/state/error` into a per-session callback file consumed by the login flow; return a fixed HTML page (`oauthCallbackSuccessHTML`, auto-closes after 5 s) (:152-215). In Workers: store in KV/DO instead of the filesystem. |
| `GET <ws-path>` default `/v1/ws` | `AttachWebsocketRoute` (:547) | AI Studio **wsrelay** gateway | conditional auth (`ws-auth` config); belongs to the aistudio provider (wsrelay), not the main pipeline |
| `NoRoute` | `pluginManagementNoRoute` | | plugin-hosted management routes; ignore |

Not part of the proxy surface: `/v0/management/*`, `/v8/management/*`, `/v0/resource/plugins/*`.

### 1.2 Global middleware & auth

Order (internal/api/server.go:146-169, 232-233): trace-id response-writer wrapper → (optional extra middleware) →
request logger (skipped in `commercial-mode`) → CORS → [`homeHeartbeatMiddleware` — only when external "Home" control
plane is enabled; ignore in port] → [`exampleAPIKeySafeModeMiddleware`].

* **CPA trace header**: every response gets `X-CPA-TRACE-ID` (internal/logging/cpa_trace.go:13) containing the selected
  auth's index (set lazily when a credential is picked via `SelectedAuthIndexCallbackMetadataKey`). Optional for the port.
* **CORS** (`server_middleware.go:132`): on every response
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`,
  `Access-Control-Allow-Headers: *`, `Access-Control-Expose-Headers: X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id`.
  `OPTIONS` → `204` no body (abort). Note SSE handlers additionally set `Access-Control-Allow-Origin: *` themselves.
* **Safe mode** (`server_middleware.go:62-84`): if `api-keys` contains template/example values, all of `/v1*`, `/v1beta*`,
  `/openai/v1*`, `/backend-api/codex*` return `403 {"error":"unsafe_example_api_key","message":"…"}` +
  header `X-CPA-SAFE-MODE: example-api-key`. Can be dropped.
* **Client API-key auth** (`AuthMiddleware` → `sdkaccess.Manager.Authenticate`, `sdk/access/manager.go:45`,
  provider `internal/access/config_access/provider.go:55`):
  * Providers list is tried in order; `NotHandled` → next; `NoCredentials`/`InvalidCredential` are remembered; first success wins.
    If **no providers are configured → all requests allowed** (legacy). If providers exist but none handled → `401 {"error":"Missing API key"}`; invalid → `401 {"error":"Invalid API key"}`; internal → `500 {"error":"Authentication service error"}`.
  * Built-in provider checks, in this candidate order, a constant-set lookup in `config.api-keys`:
    1. `Authorization: Bearer <key>` (case-insensitive "bearer"; a header with no "Bearer " prefix is used verbatim),
    2. `X-Goog-Api-Key`, 3. `X-Api-Key`, 4. query `?key=`, 5. query `?auth_token=`.
    If none of the 5 are present → NoCredentials; present but no match → InvalidCredential.
  * On success gin context gets `userApiKey` (the key), `accessProvider`, `accessMetadata{source: authorization|x-goog-api-key|x-api-key|query-key|query-auth-token}`. `userApiKey` feeds
    (a) usage records (`Record.APIKey`) and (b) `caller_scope` = `sha256("cli-proxy-api:caller-scope:v1\x00"+key)` hex (`sdk/cliproxy/session/identity.go:210`) used to isolate session-affinity state per client key.
  * Error body for the realtime-standard variant: `{"error":{"message","type":"authentication_error"|"server_error","param":null,"code":"invalid_api_key"|"authentication_service_error"}}`; all other routes use the flat `{"error":"<msg>"}`.
* **Request-body decompression**: `handlers.ReadRequestBody` (`request_body.go:16`) honours `Content-Encoding: zstd` (and
  `identity`; comma-separated lists decoded right-to-left; anything else → error "unsupported request content encoding").
  If decoding fails but the raw bytes are valid JSON, raw bytes are used. **Used by**: chat/completions, completions,
  responses, compact, images, speech. **Not used by** `/v1/messages`, `/v1beta/*`, interactions (raw `GetRawData`).
  Workers: no native zstd `DecompressionStream`; use a WASM zstd or reject.

---

## 2. Handler flow (sdk/api/handlers/*)

### 2.1 Shared structure

`BaseAPIHandler{AuthManager, Cfg, PluginHost, ModelRouterHost}` (`handlers.go`). Each protocol handler embeds it and
exposes `HandlerType()` (the entry protocol string: `openai`, `openai-response`, `claude`, `gemini`; interactions handler
uses `interactions`). Plugin interceptors / model routers / lifecycle trackers (`handlers_interceptors.go`,
`handlers_routing.go: applyModelRouter`) are an extension system — **out of scope for the port** unless plugins are wanted;
all pipeline behaviour below holds with no plugins.

Common non-stream handler skeleton (identical across protocols; e.g. `openai_handlers.go:447`):
1. `Content-Type: application/json` set up-front.
2. `cliCtx, cliCancel = GetContextWithCancel(h, c, ctx)` – request-scoped cancel; cancelled when client disconnects.
3. `stopKeepAlive = StartNonStreamingKeepAlive(c, cliCtx)` (§2.3).
4. `ExecuteWithAuthManager(cliCtx, handlerType, model, rawJSON, alt)`.
5. `stopKeepAlive()`; on error → `WriteErrorResponse` (§2.2); else copy filtered upstream headers (§2.3), write body.

Common stream handler skeleton: get `Flusher`; call `ExecuteStreamWithAuthManager` which returns
`(dataChan, upstreamHeaders, errChan)`; **peek the first chunk before committing headers** so an immediate upstream
failure yields a proper HTTP error status + JSON body instead of a 200 SSE stream; then
`h.ForwardStream(...)` pumps remaining chunks (§2.3). If a stream closes without any data and no error: OpenAI-style
handlers send `data: [DONE]\n\n` with SSE headers (Claude/Gemini send just headers).

SSE response headers set by all stream handlers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`, `Access-Control-Allow-Origin: *`; then upstream headers merged in **without overwriting**
(`WriteUpstreamHeaders`, `header_filter.go:~105`: skips any header already set).

### 2.2 Error formatting per protocol

Inner type: `interfaces.ErrorMessage{StatusCode int, Error error, Addon http.Header, DirectResponse bool, Body []byte, Headers http.Header}`.
Conversion from executor/conductor errors: `executionErrorMessage` (`handlers_execution.go:352`):
* `RequestTerminatedError` (plugin) → direct response.
* status = `clienterror.HTTPStatusFromError(err)` (explicit `StatusCode()` method wins; `context.Canceled` → **499**; `DeadlineExceeded` → 504) else **500**.
* error type implementing `DirectResponse()+ResponseBody()` → `DirectResponse=true`, `Body`, `Headers{Content-Type: application/json if valid JSON else sniffed}`: the upstream error body is forwarded **verbatim** (status = upstream status).
* `Addon` = error's `Headers()` clone (used only when `passthrough-headers` enabled).

`enrichAuthSelectionError` (`handlers_errors.go:38`): for conductor errors with `Code ∈ {auth_not_found, auth_unavailable}` (except model-cooldown errors) rewrite message to
`"<msg> (providers=<csv>, model=<model>[; last upstream error: <summary>])"` (+ `"; check Claude auth/key session and cooldown state via /v0/management/auth-files"` when claude is among providers); HTTPStatus default **503**.
Model-not-routable error from resolution: **400** body (already JSON string):
`{"error":{"message":"unknown provider for model <model>","type":"invalid_request_error","code":"model_not_found","param":"model"}}` (`handlers_routing.go:165-235`).

**OpenAI-compatible errors** — `BuildErrorResponseBodyWithError(status, text, err)` (`handlers.go:75`), used by chat/completions/responses/images/…:
* if `err` is a *terminal auth error* (upstream OAuth permanently invalid): `{"error":{"message":<msg>,"type":"authentication_error","code":"upstream_authentication_required","retryable":false}}` (message extracted from JSON text `message` / `error.message` if text is JSON).
* else if `text` is valid JSON → **compacted verbatim** (upstream error JSON passes through).
* else `{"error":{"message":<text>,"type":T,"code":C}}` with `(T,C)` by status:
  | status | type | code |
  |---|---|---|
  | 401 | authentication_error | invalid_api_key |
  | 403 | permission_error | insufficient_quota |
  | 429 | rate_limit_error | rate_limit_exceeded |
  | 404 | invalid_request_error | model_not_found |
  | 408 | server_error | request_timeout |
  | ≥500 | server_error | internal_server_error |
  | other | invalid_request_error | (omitted) |
* Empty text → `http.StatusText(status)`. Status ≤0 → 500.
* `WriteErrorResponse` (`handlers_errors.go:117`): sets `Retry-After` from the error when it carries one (`auth.SafeResponseHeaders`: cooldown/busy errors expose a safe `Retry-After`); copies `Addon` headers only if `passthrough-headers` is on and header is not CPA-reserved; `Content-Type: application/json` if nothing written yet; status = msg status.
* Request-body read/parse failures at the handler: `400 {"error":{"message":"Invalid request: <err>","type":"invalid_request_error"}}`.

**Claude errors** (`claude/code_handlers.go:345-505`): body
`{"type":"error","error":{"type":<t>,"message":<m>[,"details":{"error_code":"thread_not_found"}]}}`.
`t` from status (`claudeErrorTypeFromStatus`): 401 authentication_error, 402 billing_error, 403 permission_error, 404 not_found_error, 413 request_too_large, 429 rate_limit_error, 408/504 timeout_error, 529 overloaded_error, ≥500 api_error, else invalid_request_error.
If the error text is JSON: `error.type` / `error.message` (fallback `error.code`) or top-level `type` (if ≠"error") / `message` override. Uses upstream `ResponseBody()` as text when available. Mid-stream: `event: error\ndata: {…}\n\n` and `c.Status(status)` (status can't actually change after commit).

**Gemini errors**: non-stream and pre-stream errors use the OpenAI-shaped `ErrorResponse` (the Gemini handler reuses `h.WriteErrorResponse`). Mid-stream terminal error: if `alt==""` → `event: error\ndata: <openai error JSON>\n\n`, else raw JSON body appended.
**Interactions**: same as Gemini (`event: error\ndata: <openai error JSON>\n\n`).

**Responses (OpenAI) streaming errors** — see §2.5 (`error` / `response.failed` events with `sequence_number`; error classes: 401 invalid_api_key/invalid_request_error, 403 insufficient_quota, 429 rate_limit_exceeded, 404 model_not_found, 408 request_timeout (server_error), ≥500 internal_server_error (server_error), other ≥400 invalid_request_error, else unknown_error — `openai_responses_stream_error.go:48-80`). Error text is sanitized: truncated to 2048 runes (fields 256), `Bearer <token>` and `api_key|access_token|token|authorization|secret` values redacted.

### 2.3 Streaming mechanics, keep-alive, headers

* **Executor stream contract**: `StreamResult{Headers, Chunks <-chan StreamChunk{Payload []byte, Err error}}`. Each `Payload` is
  one *already-translated, client-format* unit: for OpenAI it is **bare JSON** (handler adds `data: ` + `\n\n`); for Claude/Responses/Interactions it
  already contains `event: …\ndata: …` text (handler writes as-is; Interactions handler adds `data: ` / `\n\n` if missing); for Gemini bare JSON (handler adds `data: ` unless `alt` set).
* `executeStreamWithAuthManagerFormats` (`handlers_stream.go:284`): resolves, calls `AuthManager.ExecuteStream`, then a goroutine
  (a) **reads the first deliverable chunk synchronously (bootstrap)**, optionally retries (b), (c) pumps the rest through
  an unbuffered `dataChan`, a 1-buffered `errChan`.
  * **Bootstrap retries** (`streaming.bootstrap-retries`, default **0**; forced 0 in Home mode): if the *first* chunk is an error and `bootstrapEligible(err)` — status unknown (0), 401, 403, 402, 408, 429, or ≥500 — call `AuthManager.ExecuteStream` again (up to N times). A failed retry that is an auth-selection-unavailable error with original status ≥500 keeps the original error (`handlers_stream.go:528-575`).
  * For `responseProtocol == "openai-response"` an **SSE-JSON validator** (`sseJSONValidationState`, :~429, :733-852) normalizes `\r\n`→`\n`, splits on blank-line frames, and requires every `data:` payload (except `[DONE]`/empty) to be valid JSON; otherwise emits `502` error (`"…"`) — protects against torn upstream frames.
  * Header handling: upstream response headers are only forwarded if `passthrough-headers: true` (default **false**) — and then through `FilterUpstreamHeaders`.
* **`ForwardStream`** (`stream_forwarder.go:65`): select loop over {client ctx done, data chunk, error, keep-alive ticker}.
  * keep-alive: `streaming.keepalive-seconds` (default **0 = disabled**). Writes `: keep-alive\n\n` (override per protocol) then flush. Gemini with `alt` set disables SSE keepalive. Responses handler uses flush that surfaces write errors.
  * data closed → check pending error (`PendingStreamError`), else `CloseError()` validation (OpenAI: fail 502 `"upstream stream closed before any chunk carried finish_reason"` if no choice ever had `finish_reason`; Responses: 502 `"upstream stream closed before a terminal event (last event: X)"`), else `WriteDone` (OpenAI: `data: [DONE]\n\n`; Responses: just `\n`; Claude/Gemini/Interactions: nothing).
  * error → `WriteTerminalError` (protocol-specific, §2.2), flush, cancel.
* **Non-stream keep-alive** (`StartNonStreamingKeepAlive`, `handlers.go:602`): if `nonstream-keepalive-interval` (seconds, default **0 = off**) > 0 and the writer is flushable, a ticker writes a bare `"\n"` and flushes every interval. **Consequence**: the first byte commits status 200 + `Content-Type: application/json`; an error after that can no longer change the status. Leading whitespace before JSON is valid JSON. In Workers: return a streamed `Response` immediately and write `"\n"` on a timer (or skip).
* `GetAlt` (`handlers.go:461`): reads `alt` then `$alt`; returns `""` if `alt=sse`, else the raw value. For Gemini, a non-empty `alt` (e.g. `json`) means *don't wrap in SSE*. `alt` is also reused as an internal route tag: `"responses/compact"` for the compact endpoint.
* **Header sanitising** (`header_filter.go`): `FilterUpstreamHeaders` drops RFC7230 hop-by-hop (`Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization, Te, Trailer, Transfer-Encoding, Upgrade`), `Set-Cookie`, `Content-Length`, `Content-Encoding`, headers named in the upstream `Connection:` list, CPA-reserved (`Access-Control-*`, `X-Cpa-Trace-Id`), and gateway-fingerprint prefixes `x-litellm-`, `helicone-`, `x-portkey-`, `cf-aig-`, `x-kong-`, `x-bt-` (so Claude Code can't detect a gateway). `cf-aig-` matters on Workers.
* `executionPassthroughHeaders(cfg, internal)` = `internal || cfg.passthrough-headers`.

### 2.4 OpenAI Chat Completions & legacy Completions

`ChatCompletions` (`openai_handlers.go:116`):
1. `ReadRequestBody` (zstd aware). `stream = body.stream === true` (strict boolean).
2. **Responses-shape auto-detect** (`shouldTreatAsResponsesFormat`, :151): if no `messages` and (`input` or `instructions` exists) → convert with
   `responsesconverter.ConvertOpenAIResponsesRequestToOpenAIChatCompletions(model, raw, stream)` (the same function registered as translator `(openai-response → openai)`), then `stream = body.stream`.
3. Stream → §2.1 stream skeleton with entry protocol `openai`; chunk writer `data: <json>\n\n`; `CloseError` requires some chunk to have `choices[].finish_reason` non-empty/non-null (`chunkHasFinishReason`, tolerant of leading `data:`).

`Completions` (`:171`): converts to chat (`convertCompletionsRequestToChatCompletions`, :202) →
`{"model":…, "messages":[{"role":"user","content":<prompt or "Complete this:">}]}`; copies `max_tokens,temperature,top_p,frequency_penalty,presence_penalty,stop,stream,logprobs,top_logprobs,echo`; executes as `openai` chat; response converted back (`convertChatCompletionsResponseToCompletions`: `{"id","object":"text_completion","created","model","choices":[{"index","text":<message.content|delta.content>,"finish_reason","logprobs"}],"usage"}`; stream: `convertChatCompletionsStreamChunkToCompletions` drops chunks with neither non-empty `delta.content`, a real `finish_reason`, nor `usage`).
Note `prompt` is read with gjson `.String()`: a string prompt is used as-is; an array/object prompt becomes its **raw JSON text** (arrays are NOT joined or batched); empty/missing → `"Complete this:"`.

### 2.5 Responses API (`POST /v1/responses`, `/v1/responses/compact`) and Interactions

**Responses** (`openai_responses_handlers.go:601`): body → optional Codex-client helpers
(`prepareCodexMultiAgentV2Tools`, `prepareCodexOrphanDelegation` — Codex-CLI-specific rewrites controlled by `client.codex.optimize-multi-agent-v2` and `codex-orphan-delegation-compatibility`; keyed on `User-Agent`/`Originator` — see `helps/codex_multi_agent_v2.go`; port only if Codex CLI multi-agent is targeted) → stream? entry protocol `openai-response`.
* Non-stream: standard skeleton, alt `""`.
* **Compact** (:627): `stream:true` → `400 {"error":{"message":"Streaming not supported for compact responses","type":"invalid_request_error"}}`; an explicit `stream:false` is deleted from body; executes with `alt="responses/compact"` (executors route this to the upstream `/responses/compact` URL).
* **Streaming framer** (`responsesSSEFramer`, `openai_responses_handlers.go:63-500`). Because upstream chunks can be partial or multi-event, every chunk passes through a frame assembler:
  * Buffers until a complete frame (`\n\n`) or a self-sufficient single `data:` line; re-inserts missing line breaks between `event:`/`data:` lines.
  * **Private-event filtering** (`shouldFilterPrivateEvent`): drops frames whose event/`type` starts with `responsesapi.`; and `codex.*` events (but only `codex.rate_limits` is dropped for detected Codex clients, other `codex.*` pass for them). Error events (`response.failed|response.error|error`) are never filtered.
  * **Codex-client detection** (`isCodexResponsesClientRequest`, :869): `User-Agent` matched by `multiagentv2.IsCodexClientUserAgent` OR `Originator` ∈ {`codex desktop`,`codex-tui`,`codex_cli_rs`} or those + `/…` prefix (case-insensitive). Codex clients get terminal failures as `event: response.failed`; others as `event: error`.
  * Terminal events: `response.completed, response.incomplete, response.failed, response.done, response.error, error` → after one is written everything else is dropped.
  * **`response.output` repair**: records `response.output_item.done` items (by `output_index` or unindexed); if the final `response.completed` has an empty/missing `response.output`, it is rebuilt from the recorded items (sorted by index, then unindexed).
  * Error payload normalisation: any payload with `type∈error events`, an `error`/`response.error` object, or `code`+`message` becomes a synthesized
    `event: error|response.failed` with `{"type":"error","error":{…},"sequence_number":N}` / `{"type":"response.failed","sequence_number":N,"response":{"status":"failed","error":{…}}}`; status taken from `status|status_code|error.status|…` (400-599) else **502**; `sequence_number` from payload else `dataFrames-1`.
  * First-chunk gating: the handler buffers into `initialOutput` until the first *data frame* is produced; before that, errors become real HTTP errors (`sanitizeResponsesInitialErrorMessage`); after, they are SSE events. Close without terminal event → 502 (`"upstream stream closed before first payload"` / `"…before a terminal event"`).
  * Ends with `"\n"`, **no `[DONE]`**.

**Interactions** (`gemini/interactions_handlers.go`): body must be valid JSON with **exactly one** of `model` / `agent` (else 400 `invalid request: request requires exactly one of model or agent`); `stream` must be boolean if present (400 `stream must be a boolean`). `models/` prefix stripped from `model`. If `agent` set: `ForcedProvider="gemini-interactions"`, `AuthSelectionModel="gemini-2.5-flash"` (credential chosen as if for that model; execution model = agent name). Executes via `ExecuteProtocolWithAuthManager` / `…Stream…` with entry=exit=`interactions`. `adjustExecutionProvidersForEntryProtocol` (`handlers_routing.go:60`): for entry `interactions` the provider `gemini-interactions` is moved to the front; for entries not in `{interactions, openai, openai-response, claude, gemini}` it is removed. Agent+forced provider with a router/plugin target ≠ forced provider → 400 `agent is only supported for native interactions execution`.

### 2.6 Responses over WebSocket (`GET /v1/responses`, `/backend-api/codex/responses`)

Entry: `ResponsesWebsocket` (`openai_responses_websocket.go:269`, ~3.7 kLOC across `openai_responses_websocket*.go`). gorilla upgrader (`CheckOrigin` always true, 4 KiB buffers), `websocketUpgradeHeaders` echoes `x-codex-turn-state`.
Per-connection state: `passthroughSessionID` (uuid, used as upstream *execution session*), `lastRequest`, `lastResponseOutput`, `lastResponseID`, `lastResponsePendingToolCallIDs`, `pendingPrewarmID`, `pinnedAuthID` + per-provider pinned auth, upstream mode (`websocket`|`http`), observed-compaction state, tool-output caches.

Client → server frames (text/binary JSON): `{"type":"response.create", …responses body…}`, `{"type":"response.append", "input":[…]}`, `{"type":"response.interrupt", …}` (control; forwarded to upstream execution session or handled locally via `responsesLocalInterrupt`). Server → client frames are the Responses SSE events as JSON text frames (`response.created`, …, `response.completed|response.done|response.failed|error`).

Request normalisation (`openai_responses_websocket_requests.go`):
* `normalizeResponseCreateRequest` (:50): `input` if present must be an array (else 400 `websocket request requires array field: input`); strip `type`; force `stream:true`; default `input:[]`; require non-empty `model` (400 `missing model in response.create request`).
* `normalizeResponseSubsequentRequest` (:78): needs prior request (400 `websocket request received before response.create`); `input` must be array; **transcript replacement** detection (compact replays) vs **incremental merge**:
  * v2 mode (upstream supports incremental input via `previous_response_id`): keep `previous_response_id` (fill from `lastResponseID` when the new input satisfies pending tool calls), copy `model`/`instructions` from last request if absent, force `stream:true`.
  * Otherwise merge `lastRequest.input + lastResponseOutput + new input` (dedupe `function_call` items by call_id and items by id), drop `previous_response_id`, inherit `model`/`instructions`.
* **Prewarm** (`response.create` with `generate:false`, local mode only): answered locally with synthetic `response.created` (seq 0) + `response.completed` (seq 1) frames, id `resp_prewarm_<uuid>`; the next request with `previous_response_id == pendingPrewarmID` is merged with the warm-up input; mismatching id → `previous_response_not_found` error.
* Upstream mode selection: if the chosen credential is Codex/xAI with websocket support, requests are **passed through** natively over an upstream WebSocket (execution session = connection id) via `cliproxyexecutor.WithDownstreamWebsocket` / `WithWebsocketInput`; otherwise it falls back to HTTP SSE streaming per request and re-assembles history locally. Switching from WS to a non-passthrough route while a request requires the current upstream socket → closes with reason `upstream requires HTTP replay`.
* Credential pinning: once a credential serves a turn it is pinned to the socket (`WithPinnedAuthID`) as long as it still matches the model/provider; dropped on failure.
* Keepalive: WebSocket **Ping** frames every `streaming.keepalive-seconds` (0 = off). Close reasons truncated to 123 bytes. Upstream transport close codes (e.g. 1009) are mirrored downstream.
* Tool-call repair (`openai_responses_websocket_toolcall_repair.go`): per downstream-session caches (≤256 entries/session, TTL **30 min**) of `function_call_output` / `function_call` items so orphaned outputs/calls in a replayed `input` can be re-attached (`prepareResponsesWebsocketFallbackTurn`).
* Errors: terminal error frame built with the Responses error builders (§2.2) and `status` ≥ 400; certain errors close the socket with mirrored code.
Port note: Workers can accept WebSockets (`WebSocketPair`) and dial upstream WebSockets with `fetch(url,{headers:{Upgrade:"websocket"}})`; the per-connection state above maps naturally onto a **Durable Object** (one per socket). Rules in this section (`generate:false` prewarm, merge/replace logic, pinned auth) are all pure functions of in-memory state.

### 2.7 Images (`/v1/images/generations`, `/v1/images/edits`)

`openai_images_handlers.go` (2 kLOC). `disable-image-generation: true` → `404` empty. Constants (:28-45): default main model `gpt-5.4-mini`, default image model `gpt-image-2`, Codex image-tool models `{gpt-image-1.5, gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2.5}`, xAI image models `{grok-imagine-image, grok-imagine-image-quality, grok-imagine-image-2.0}` (provider prefix `xai|x-ai|grok` allowed), plus any registry model with `type == "openai-image"` (OpenAI-compat image models). Else 400 listing the supported set. Prefix split uses the **last** `/`.
Flow for generations: valid JSON, non-empty `prompt` (400 `Invalid request: prompt is required`), `response_format` default `b64_json`, `stream` bool.
* Codex tool model or OpenAI-compat model → build request (`buildOpenAICompatImagesJSONRequest`: set `model`; `stream:true` or delete) and execute with entry protocol **`openai-image`**, `ExecuteImageWithAuthManager` / stream variant, context flag `WithDisallowFreeAuth` (free-plan Codex credentials are excluded: metadata `disallow_free_auth`). The Codex executor turns that into a Responses call with `tools:[{type:"image_generation",…}]` (`codex_openai_images.go`) and returns an OpenAI Images-API shaped body.
* xAI model → `buildXAIImagesGenerationsRequest` → `{model, prompt, response_format, aspect_ratio (default "1:1"; derived from size), resolution (default "1k"), quality, n}`, executed as `openai-image` on the xAI provider; response converted to `{created,data:[{b64_json|url,revised_prompt}],usage}`.
* Legacy path (`buildImagesResponsesRequest`, :1049): Responses request `{"instructions":"","stream":true,"reasoning":{"effort":"medium","summary":"auto"},"parallel_tool_calls":true,"include":["reasoning.encrypted_content"],"model":<main model>,"store":false,"tool_choice":{"type":"image_generation"},"input":[user message with input_text + input_image parts],"tools":[<image_generation tool>]}` executed as `openai-response`; the `image_generation_call` results are aggregated into the Images response. (Effectively reachable only for tool models not matched earlier; documented for completeness.)
* Streaming: SSE events named `<prefix>.partial_image` (from upstream `response.image_generation_call.partial_image`: `{"type":"<prefix>.partial_image","partial_image_index":N,"b64_json":…}`) and `<prefix>.completed` (from `response.completed`), with prefix `image_generation` (generations) or `image_edit` (edits) (`openai_images_handlers.go:1941,1960`); optional keepalive frames; error → SSE error event.
* Edits accept JSON (`images:[{image_url|file_id}]`) or **multipart** (`image[]`, `mask`, fields) — multipart files are converted to data URLs (`multipartFileToDataURL`). Multipart parsing is needed in the port (Workers `request.formData()` works).

### 2.8 Speech and videos (xAI-backed)

**Speech** (`openai_speech_handlers.go`): `POST /v1/audio/speech` and `/v1/tts`. Body ≤ **1 MiB**. Model mapping (`speechRoutingModel`): `""`, `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `grok-tts` → `grok-tts`; `grok-voice-tts-1.0` stays; prefixes `xai/`,`x-ai/`,`grok/` and a `(suffix)` stripped; anything else → 400 `Model X is not supported on /v1/audio/speech. Use grok-tts.` Payload to xAI: `{"text":<input|text, ≤60000 runes>,"voice_id":<mapped>,"language":<language|"auto">,["speed":>0],["output_format":{"codec","sample_rate"}]}`. OpenAI→xAI voices: alloy→ara, ash→orion, ballad→luna, coral→celeste, echo→rex, fable→sal, onyx→leo, nova→eve, sage→iris, shimmer→aurora, verse→lumen (default `eve`; unknown voice passed through lowercased). `response_format` ∈ {mp3, wav, pcm} (wav/pcm → `output_format{codec,sample_rate default 24000}`), else 400 `response_format must be mp3, wav, or pcm`. Entry protocol `openai-speech` (non-stream); response is raw audio bytes; `Content-Type` from upstream unless it's JSON/octet-stream/text-plain/empty → `audio/mpeg|wav|pcm` by format. Speech-only models (`grok-tts`, `grok-voice-tts-1.0`) are rejected on every other endpoint with 400 (`handlers_routing.go:274`); image-only models (`gpt-image-1.5, gpt-image-2, gpt-image-2.5*, grok-imagine-image*`) are rejected on chat endpoints with **503** `model X is only supported on /v1/images/generations and /v1/images/edits`.

**Videos** (`openai_videos_handlers.go`): constants `defaultOpenAIVideosModel=sora-2`, `defaultXAIVideosModel=grok-imagine-video`, `grok-imagine-video-1.5` (+`-preview` alias), `defaultVideosSeconds="4"`, default size `720x1280`, resolution `720p`, max 7 reference images. Entry protocol `openai-video`.
* OpenAI-shaped (`POST /openai/v1/videos`): `sora-*` or xAI video model accepted; JSON or form; builds xAI `{"model","prompt","duration":<int>,"aspect_ratio","resolution","image":{"url"},"reference_images":[{"url"}…]}`; `image` + `reference_images` together → 400. Response mapped to OpenAI video object; status map: queued/pending→`queued`; in_progress/processing/running→`in_progress`; completed/done/succeeded/success→`completed`; failed/error/expired/cancelled/canceled→`failed`. Failures return a "failed video" JSON (`buildVideosFailedAPIResponse`).
* Native xAI (`/v1/videos`, `/generations`, `/edits`, `/extensions`, `GET /v1/videos/:request_id`): body passthrough with `model` canonicalised; execution model = `routingXAIVideosModel`.
* **Video→credential binding** (in-memory store, TTL `defaultVideoAuthBindingTTL = 3h`, `videoAuthBindingStore`): after create, `video id → selected auth id (+model)` is stored; retrieve/content calls pin to that auth (`WithPinnedAuthID`) and reuse the bound model. **Port: KV/DO with 3 h TTL** (state must survive across isolates).
* `GET /openai/v1/videos/:id/content?variant=video` (only `video` variant): resolves content URL from the xAI payload then **downloads it server-side** (`NewProxyAwareHTTPClient` with the bound credential's proxy settings) and streams it to the client with copied content headers.

### 2.9 Model listing

* `GET /v1/models` (`server_routes.go:384`): precedence — Grok-shell UA → xAI list; `?client_version=…` present → Codex client catalog (`codexmodels.BuildResponseForClient…`, needs a bundled Codex catalog JSON + tool-capability hooks); `Anthropic-Version` header **or** `User-Agent` starts with `claude-cli` → Claude list; else OpenAI list.
* **OpenAI list**: `{"object":"list","data":[{id,object:"model",created?,owned_by?}]}` — only these 4 fields are exposed (`openai_handlers.go:63`). Source: `registry.GetAvailableModels("openai")`: every registered model with ≥1 *available* (non-suspended/quota-recovered) credential (`internal/registry/model_registry.go:1276`, cached per handler type with expiry at the next quota recovery).
* **Claude list**: `{"data":[{id,object,owned_by,created_at(RFC3339),type:"model",display_name,max_input_tokens(default DefaultClaudeMaxInputTokens),max_tokens(default DefaultClaudeMaxOutputTokens)}],"has_more":false,"first_id","last_id"}` sorted by `display_name` then `id`; **cloaking** (unless `claude-code.disable-cloaking-model-list`): ids not starting with `claude-` become `claude-fable-5-dd-` + reverse(id by runes) (`internal/client/claude/models/models.go:12-100`). Inbound `/v1/messages` bodies reverse this via `ResolveClaudeModelIDPrefix` (preserving a `(suffix)`), `claude/code_handlers.go:141`.
* **Gemini list** (`/v1beta/models`): `{"models":[{name:"models/<id>",displayName,description,version,inputTokenLimit,outputTokenLimit,supportedGenerationMethods(default ["generateContent"]),supportedInputModalities,supportedOutputModalities}]}`.
* Detail routes: `/v1/models/<id>`: catalog filtered to the entry whose `id` (or `slug`) equals the requested id → the bare entry, else `404 {"error":{"message":"Model not found","type":"invalid_request_error","code":"model_not_found"}}` (`handlers_interceptors.go:688-727`). All list responses `Content-Type: application/json; charset=utf-8`.
* Model-registry population (what a "registered model" is, prefix/alias expansion, thinking capabilities, excluded models) is covered in the registry/provider research docs; the pipeline only needs `GetModelProviders(model)`, `LookupModelInfo(model, provider)`, and the per-handler list builders above.

### 2.10 `POST /v1/alpha/search` (Codex)

`internal/api/server_routes.go:341-545`: body ≤ **16 MiB**; `prompt_cache_key` and `prompt_cache_retention` stripped; auth selection via `SelectAuthWithCredentialPolicy(ctx,"codex", model, CredentialPolicyCodexAlphaSearchV1, …)` (session affinity key from body `id` as `X-Session-ID`); upstream `POST https://chatgpt.com/backend-api/codex/alpha/search` (OAuth creds; header `Chatgpt-Account-Id` from `metadata.account_id`; base headers `Content-Type/Accept: application/json`, `Originator: codex_cli_rs`, plus pass-through of `Version, User-Agent, Session_id, X-Client-Request-Id`) or `<attributes.base_url>/alpha/search` for API-key creds (model rewritten to the credential's resolved upstream model). Response body ≤ 32 MiB returned with upstream status + `Content-Type`. No translation. 503 `Codex auth unavailable` / `Codex Alpha Search API key base URL unavailable`.

### 2.11 Claude and Gemini handlers (specifics)

* **Claude** (`claude/code_handlers.go`): `stream` absent or `false` → non-stream; otherwise stream. Uses `c.GetRawData()` (no zstd). Non-stream: if the executor returned gzip bytes (magic `1f 8b`) they are transparently decompressed before writing (`:173-221`). Stream: chunks written raw (they already carry `event:` lines); `alt` always `""`; stream with no data → only headers. `count_tokens` → `ExecuteCountWithAuthManager`, writes executor payload.
* **Gemini** (`gemini/gemini_handlers.go:129`): model comes from the URL (`action[0]`), body passthrough. `generateContent` (non-stream keep-alive allowed), `streamGenerateContent` (stream; `alt==""` → SSE framing `data: <chunk>\n\n`, else raw chunks), `countTokens` (`ExecuteCountWithAuthManager`, `Content-Type: application/json`). Model strings may carry thinking suffixes `gemini-2.5-pro(8192)` (the `*action` catch-all keeps them; clients may URL-encode).

### 2.12 Request metadata passed to the executor (`requestExecutionMetadata`, `handlers.go:210`; `executor/types.go` constants)

`Options.Metadata` keys (all string-keyed): `idempotency_key` (header `Idempotency-Key`, only if sent), `request_path` (gin `FullPath()` e.g. `/v1/chat/completions`, used by payload rules and image-gen stripping), `requested_model` (original client string incl. suffix/prefix), `reasoning_effort` (`thinking.ExtractReasoningEffort(body, entryProtocol, model)`, for usage logs), `service_tier` (body `service_tier` else `"auto"`), `generate` (`false` only if body `generate:false`), `pinned_auth_id`, `selected_auth_callback` / `selected_auth_index_callback` (closures that report which credential was picked), `execution_session_id`, `caller_scope`, `disallow_free_auth`, `auth_selection_model`, `request_path`, session-hierarchy keys (`canonical_session_id`, `parent_session_id`, `is_fork`, `is_compaction`, `node_kind`, `lcp_*`, `session_affinity_*`, `derived_session_id`). Session identity extraction (`sdk/cliproxy/session/info.go:96`): priority headers `X-Claude-Code-Session-Id` > Claude Code `metadata.user_id` > `Session-Id`/`Session_id` > `X-Http-Session-Id` > `X-Session-ID`/`X-Session-Affinity`/`X-Slot-Session-Id` > `X-Conversation-Id`/`X-Thread-Id`/`X-Client-Request-Id` > Gemini `cachedContent` > OpenAI `thread_id` > body `session_id|sessionId` > `prompt_cache_key`(`pck:`)/`conversation.id`(`conv:`)/`metadata.user_id`(`user:`) > `conversation_id|chat_id` > `execution_session_id`; parent from ~40 body keys (`parent_session_id`, `parent_thread_id`, `forked_from_id`, …). These feed session-affinity credential stickiness and replay-cache keys (§7) — details belong to the conductor doc.

---

## 3. Handler → Auth manager → Executor interface

### 3.1 Model & provider resolution (`handlers_routing.go:165-235`)

Input `modelName` (client string, may be `provider-prefix/model`, may have `(suffix)`).
1. `thinking.ParseSuffix(model)`: last `(` … trailing `)` → `{ModelName, HasSuffix, RawSuffix}` (§5.1).
2. **`auto` model**: if base == `"auto"`, replace with `registry.GetFirstAvailableModel("")` (first available model of any provider; falls back to `"auto"` itself with a warning) and re-attach `(suffix)`; Home mode skips this.
3. Reject image-only / speech-only models unless the route allows them (§2.8).
4. `providers = util.GetProviderName(baseModel)` = registry `GetModelProviders(model)` (exact; if empty and model has upper-case, retry lower-case — `internal/util/provider.go:46-75`). Fallback: if empty and base≠full string, try the full suffixed string (custom models registered with suffix).
5. Empty providers → 400 `model_not_found` (§2.2). Else `(providers, resolvedModelNameWithSuffix)`. **The thinking suffix stays inside the model string all the way to the executor** (no side-channel metadata).
6. `adjustExecutionProvidersForEntryProtocol` (§2.5). `ForcedProvider`/router-selected provider bypass registry lookup.

**Provider prefixes** (`team-a/gpt-5`): not parsed in handlers. At model *registration* time (`sdk/cliproxy/service_models.go:641 applyModelPrefixes`) each auth with `Auth.Prefix` (trimmed of `/`; from auth file metadata `prefix`) registers additional model IDs `"<prefix>/<id>"` (cloned `ModelInfo` with `MetadataModelID=<id>`); with `force-model-prefix: true` the un-prefixed ID is **not** registered for that auth. Therefore `GetModelProviders("team-a/gpt-5")` resolves. At execution the conductor strips the prefix: `rewriteModelForAuth(model, auth)` (`conductor_models.go:700`) removes `"<auth.Prefix>/"` only if it equals the picked auth's prefix.

**Aliases** (applied in the conductor per picked credential, `conductor_models.go:331-364`, `oauth_model_alias.go`):
* OAuth credentials: config `oauth-model-alias.<channel>: [{name, alias, fork, display-name, force-mapping}]`. Channels: `vertex, claude, codex, aistudio, antigravity, kimi(+kimi-ai/kimi.ai/kimi.com), xai, meta`, plugin providers use their own key; `gemini` API-key auth and any `apikey` auth have **no** OAuth alias channel. Lookup candidates = `[requested, base-without-suffix]` (case-insensitive on alias); result `UpstreamModel=name` with the request's `(suffix)` re-attached unless the target already has a suffix (config suffix wins). If alias target == requested base and `force-mapping` false → no-op. `OriginalAlias` is what the client should see in `model` of the response (`force-mapping` → always the alias; used by `response_model_rewriter.go`). `fork:true` registers the alias as an additional listed model while keeping the original.
* API-key credentials (gemini/claude/codex/openai-compat keys with `models:[{name,alias,…}]`): `applyAPIKeyModelAlias…` same suffix-preserving semantics; openai-compat entries may define a **model pool** (several upstream names per alias, rotated round-robin per request via `nextModelPoolOffset`, tried in order on failure).
* `executionModelForAuthSelection`: when `Metadata.auth_selection_model` ≠ `req.Model` (interactions agents) the *selection* uses the former and the *execution* keeps `req.Model`.

### 3.2 Executor-facing types (`sdk/cliproxy/executor/types.go`)

```go
type Request  struct { Model string; Payload []byte; Format sdktranslator.Format; Metadata map[string]any }
type Options  struct {
  Stream bool; Alt string; Headers http.Header; Query url.Values
  OriginalRequest []byte                 // client body untouched (used for "originalTranslated" in payload rules & usage)
  SourceFormat    Format                 // entry protocol
  ResponseFormat  Format                 // protocol of the response the client wants; defaults to SourceFormat (ResponseFormatOrSource)
  Metadata map[string]any                // §2.12
  RequestAfterAuthInterceptor, WebSocketResponseObserver, ExecutionLifecycle (plugin/ws hooks)
  ProxyURL string                        // per-request proxy override (internal model callbacks only)
}
type Response     struct { Payload []byte; Metadata map[string]any; Headers http.Header }
type StreamChunk  struct { Payload []byte; Err error }
type StreamResult struct { Headers http.Header; Chunks <-chan StreamChunk }
type StatusError interface { error; StatusCode() int }
type RequestScopedError interface { error; IsRequestScoped() bool }   // 4xx caused by the request; must not penalise credential
```
`ProviderExecutor` (`sdk/cliproxy/auth/conductor.go:18`): `Identifier() string; Execute(ctx, auth, req, opts) (Response, error); ExecuteStream(...) (*StreamResult, error); Refresh(ctx, auth) (*Auth, error); CountTokens(...) (Response, error); HttpRequest(ctx, auth, *http.Request) (*http.Response, error)`.
Optional: `APIKeyConfigExecutor.ForAPIKey()`, `RequestAuthPreparer`, `ExecutionSessionCloser.CloseExecutionSession(id)`.

Manager entry points: `Execute`, `ExecuteCount`, `ExecuteStream` (`providers []string, req, opts`). Behaviour needed by the handler layer (details in the conductor research doc):
* `normalizeProviders`; empty → `Error{Code:"provider_not_found"}`.
* Loop: pick credential (`pickNextMixed`: round-robin over providers per model + credential selector), resolve per-credential upstream model(s), call executor, `MarkResult` (cooldown/quota state), on failure retry next credential up to `max-retry-credentials`, then up to `request-retry` rounds waiting for cooldown ≤ `max-retry-interval`; request-scoped errors (`IsRequestScoped`) and plugin terminations stop retries. No credential → `Error{Code:"auth_not_found"|"auth_unavailable", HTTPStatus: 503}`.
* `ExecuteStream` returns once the executor returned a stream; stream-level failures after the first chunk are *not* retried by the conductor (only the handler's bootstrap retry above can).
* Executors publish usage (§8) and call `thinking`, translators, payload rules.

### 3.3 Canonical executor pipeline (reference: `claude_executor_execute.go:40-300`; same skeleton in codex/gemini/openai-compat/kimi/xai/antigravity executors)

1. `baseModel = ParseSuffix(req.Model).ModelName`; `upstreamModel` from alias resolution (`helps.resolve…`).
2. `from = opts.SourceFormat`; `responseFormat = ResponseFormatOrSource(opts)`; `to = "<provider format>"`.
3. `originalTranslated, body = TranslateRequestPairReturningError(ctx, headers, cfg, from, to, baseModel, originalPayload=opts.OriginalRequest|req.Payload, req.Payload, stream, isCompat)` (`helps/codex_multi_agent_v2.go:113`): translates *both* the client's original body and the working body (the first is the baseline for "default" payload rules). `isCompat` = API-key model with `compat` flag → uses compat-aware translators (OpenAI-compat tool-call alignment etc.). Codex-client UA → `NormalizeCodexToolIntegerTypes`.
4. `body.model = upstreamModel`.
5. `ApplyRequestThinking(body, req, opts, from, to, providerKey)` (§5).
6. Provider-specific rewriting (Claude cloaking/billing header/cache_control/tool aliasing; Codex instructions/include; Gemini schema cleaning; antigravity envelope…).
7. **Payload rules** (§6) — last semantic mutation.
8. Serialisation, auth headers, HTTP (`NewUtlsHTTPClient` for Claude: **utls fingerprint**), usage reporter wraps the client (TTFT).
9. Non-stream: upstream JSON → `sdktranslator.TranslateNonStream(ctx, to, responseFormat, req.Model, originalRequest, translatedRequestBody, data, &param)`; if `responseFormat != to` many executors *stream upstream and aggregate* (`upstreamStream := responseFormat != to` in Claude executor) because the response translators are written for events.
   Stream: scan upstream SSE line by line; each line → `TranslateStream(ctx, to, responseFormat, model, originalReq, translatedReq, line, &param)` → 0..n output chunks pushed to `StreamResult.Chunks`.
10. For `openai-response` responses: `helps.EnsureResponsesUsageDetails(out)`.
11. `restoreResponseModel(data, req.Model)` rewrites the `model` in responses to the client-requested alias when `force-mapping`.

Target format per executor: claude→`claude`; codex & xai & meta→`codex`; gemini/vertex/aistudio→`gemini`; antigravity→`antigravity`; openai-compat & kimi→`openai` (openai-compat can choose `openai-response`); gemini-interactions→`interactions` (plus requests that are Interactions-native pass through); devin has its own wire.

### 3.4 Count tokens (`/v1/messages/count_tokens`, `…:countTokens`)

`ExecuteCountWithAuthManager` → `AuthManager.ExecuteCount` → `executor.CountTokens`. Providers: Claude calls upstream `…/v1/messages/count_tokens` (real); Gemini/Vertex call upstream `countTokens`; **Codex/xAI/meta compute locally** with `tiktoken-go/tokenizer` (`helps/token_helpers.go:12`: model prefix → encoding: `gpt-5*`→GPT5(o200k), `gpt-4.1`, `gpt-4o`, `gpt-4`, `gpt-3.5`, `o1`,`o3`,`o4`; default o200k/cl100k) over the translated body, then `TranslateTokenCount(ctx, to, responseFormat, count, usageJSON)`. Token-count response translators exist only for client formats Claude (`{"input_tokens":N}`) and Gemini (`{"totalTokens":N,"promptTokensDetails":[{"modality":"TEXT","tokenCount":N}]}`) (`common/bytes.go`); if no TokenCount transform is registered the provider JSON is returned as-is.

---

## 4. Translator architecture

### 4.1 Registry (`sdk/translator/*`, `internal/translator/translator/translator.go`)

* Format ids (`sdk/translator/formats.go`): `openai`, `openai-response`, `claude`, `gemini`, `codex`, `antigravity`, `interactions` (+ constant `gemini-interactions` = provider key only, `internal/constant/constant.go`). Extra *entry-only* tags without translators: `openai-image`, `openai-video`, `openai-speech`, `codex-alpha-search`, `devin`.
* Types (`types.go`):
  ```go
  type RequestTransform          func(model string, rawJSON []byte, stream bool) ([]byte, error)
  type RequestEnvelopeTransform  func(ctx, RequestEnvelope) RequestEnvelope           // RequestEnvelope{Format,Model,Stream,Body,ModelInfo,ConfigurationUpdatesChanged,Err}
  type ResponseStreamTransform   func(ctx, model string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) [][]byte
  type ResponseNonStreamTransform func(ctx, model string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) []byte
  type ResponseTokenCountTransform func(ctx, count int64) []byte
  type ResponseTransform struct { Stream; NonStream; TokenCount }
  ```
* `Register(from, to, request, response)`: `requests[from][to] = request`; **`responses[from][to] = response`** where `from` = *client* format and `to` = *provider* format at registration (e.g. `Register(OpenAI, Claude, ConvertOpenAIRequestToClaude, {Stream: ConvertClaudeResponseToOpenAI,…})` — request converts client(openai)→provider(claude), the response converters convert provider(claude)→client(openai)).
* **Lookup argument order is inverted for responses** (important): `TranslateStream(ctx, from=PROVIDER, to=CLIENT, …)` reads `responses[to][from]` (`registry.go:251-262`). Executors call `TranslateStream(ctx, to /*provider fmt*/, responseFormat /*client fmt*/, …)`. Requests: `TranslateRequest(from=CLIENT, to=PROVIDER, …)` reads `requests[from][to]`. Port: key both maps by `(clientFormat, providerFormat)`.
* **Fallbacks**: no request transformer → body returned with only `model` forced to `req.Model` (`registry.go:140-146`; the comment notes this strips client-side prefixes like `copilot/gpt-5-mini`). No stream transformer → each upstream chunk passed through unchanged (`[][]byte{body}`); no non-stream → body unchanged; no token-count → raw JSON.
* Request post-processing in `TranslateRequestEnvelope` (:114-170): `summaryConfig = thinking.ExtractTranslatedSummaryConfig(body, from, to)` → run transform → `thinking.ApplySummaryConfigForModel(body, to, model, summaryConfig)` (re-applies reasoning-summary visibility, §5.6) → optional plugin normalizer hooks.
* `RegisterRequestEnvelope` exists for translators needing `ModelInfo` (only `(openai-response → antigravity)`: `ConvertOpenAIResponsesRequestEnvelopeToAntigravity`).
* Optional `Pipeline` (middleware chain around request/response translation, `sdk/translator/pipeline.go`) — used by SDK embedders, not by the built-in executors.
* **Stream state**: `param *any` is allocated by the executor once per request (`var param any`) and passed to every chunk; each translator lazily type-asserts/initialises its own state struct on first call (`*ConvertOpenAIResponseToAnthropicParams`, tool-call accumulators, block indexes, usage, signature buffers, …). OpenAI→OpenAI uses `bool` (done flag). A translator may expose `ToolInputError() error` (retained tool-input parse failures); the registry then suppresses raw-fallback output (`translationToolInputFailed`) and executors return 502. Non-stream converters get the same `param`.
* **Input unit for stream converters**: exactly **one upstream SSE line** as received (e.g. `data: {...}`, `event: x`, blank lines may also arrive; translators trim `data:` and ignore non-data lines) — executors split with a line scanner (see `claude_executor_stream.go:448-469`). Output is zero or more *complete client-protocol chunks*: OpenAI → bare JSON (no `data:`); Claude/Responses/Interactions → `event: <name>\ndata: <json>\n\n` built with `translatorcommon.AppendSSEEventBytes(out, event, payload, trailingNewlines)` (`common/bytes.go:102`); Gemini → bare JSON.
* All translators are written with gjson/sjson on raw bytes (path-based mutation, no struct models). TS port: use a JSON library with path get/set (or typed lightweight models) and preserve **key order & number fidelity**; Go `json.Marshal` HTML-escapes `<>&` (translators sometimes use `SetStringWithoutHTMLEscape` to avoid it).

### 4.2 Registered (client → provider) pairs (all `init.go` under `internal/translator`, imported by `internal/translator/init.go`)

LOC = non-test Go lines in the package directory (request + response + helpers). "Req" = client→provider body converter; "Resp" = provider→client stream+non-stream converters. TC = TokenCount transform registered.

| Client (from) → Provider (to) | Package dir | ~LOC | TC | Notes |
|---|---|---|---|---|
| openai → openai | `openai/openai/chat-completions` | 108 | – | near passthrough (`ConvertOpenAIResponseToOpenAI` strips `data:` / swallows `[DONE]`) |
| openai-response → openai | `openai/openai/responses` | 2795 | – | Responses ⇄ Chat Completions (tools incl. shell/apply_patch, `responses_tool_index.go`); also reused by `/v1/chat/completions` Responses-shape fix-up |
| claude → openai | `openai/claude` | 1679 | claude | Claude Messages ⇄ Chat Completions |
| gemini → openai | `openai/gemini` | 1251 | gemini | |
| interactions → openai (chat) / → openai-response; openai→interactions; openai-response→interactions | `openai/interactions/{chat-completions,responses}` | 1705 + 2911 | – | both directions (4 registrations) |
| openai → claude | `claude/openai/chat-completions` | 1116 | – | |
| openai-response → claude | `claude/openai/responses` | 3766 | – | incl. web_search tool + tool-name mapping |
| gemini → claude | `claude/gemini` | 1215 | gemini | |
| interactions → claude | `claude/interactions` | 1184 | – | |
| claude → codex | `codex/claude` | 2097 | claude | incl. web_search response |
| openai → codex | `codex/openai/chat-completions` | 1702 | – | |
| openai-response → codex | `codex/openai/responses` | 515 | – | Codex *is* Responses-like; request converter is thin |
| gemini → codex | `codex/gemini` | 1065 | gemini | |
| interactions → codex | `codex/interactions` | 1415 | – | |
| claude → gemini | `gemini/claude` | 968 | claude | |
| gemini → gemini | `gemini/gemini` | 374 | gemini | passthrough converters (`PassthroughGeminiResponseStream/NonStream`) |
| openai → gemini | `gemini/openai/chat-completions` | 1116 | – | |
| openai-response → gemini | `gemini/openai/responses` | 5230 | – | biggest pair; `signature_carrier.go`, `trailing_signature.go` (thought-signature handling), web_search |
| interactions → interactions / → gemini; gemini → interactions | `gemini/interactions` (+`gemini/common` safety 47) | 2276 | – | 3 registrations (`gemini-interactions` provider) |
| claude → interactions | `interactions/claude` | 914 | – | |
| claude → antigravity | `antigravity/claude` | 2648 | claude | + `signature_validation.go`, `web_search.go`; uses signature cache (§7) |
| gemini → antigravity | `antigravity/gemini` | 1211 | gemini | |
| openai → antigravity | `antigravity/openai/chat-completions` | 1022 | – | |
| openai-response → antigravity | `antigravity/openai/responses` | 452 | – | registered as **request envelope** (needs ModelInfo) + response transforms |
| interactions → antigravity | `antigravity/interactions` | 1727 | – | |
| *(none)* claude → claude, openai-response → openai-response/codex-native, interactions → interactions (native), gemini → gemini via 374 LOC passthrough | | | | no translator ⇒ §4.1 fallback (set `model`) |

Total ≈ **42.5 kLOC** across 28 packages (+~3-4 kLOC in `internal/translator/common`).
Pairs *not* present: openai-response→codex-via-chat, codex→anything (codex is never a client format), antigravity/gemini as *client* formats other than `gemini` (Gemini API clients), kimi/xai use `openai`/`codex` targets.

Complexity ranking for planning: (1) gemini⇄responses 5.2k, (2) claude⇄responses 3.8k, (3) openai-response⇄openai 2.8k, (4) interactions⇄openai(responses) 2.9k, (5) antigravity/claude 2.6k + interactions 1.7k, (6) codex/claude 2.1k.

### 4.3 Shared helpers (`internal/translator/common`, `internal/translator/gemini/common`)

`bytes.go` (SSE builders, `GeminiTokenCountJSON`, `ClaudeInputTokensJSON`, raw array join/set, `SetStringWithoutHTMLEscape`), `claude_messages.go` (`ClaudeMessageAccumulator`, `AlignClaudeToolResults`), `claude_system.go` (`SystemReminderText`, structured-output instruction), `claude_user_id.go` (`DeriveClaudeUserID`: deterministic Claude-Code-style `user_<hash>_account__session_<uuid>` derived from first stable content), `claude_native_response.go`, `cache_control.go` (carry `cache_control` between protocols), `file_data.go` (`NormalizeOpenAIFileData` → mime+base64), `gemini.go` (merge adjacent contents, reorder user parts, split function-response turns, `$ref` detection, `thought` part check), `openai_tools.go` (`AlignOpenAIToolCallMessages`: pair tool calls/results), `parts.go` (`UnsupportedPartError` → 400 request-scoped; per-turn drop accounting; sendable-part checks), `request.go` (`GenerateClaudeToolCallID`, `RequestModelName`), `responses.go` (Responses tool-call identity/ID normalisation), `antigravity_tools.go` (tool-name mapping to Antigravity intrinsics), `devin_tools.go`, `apply_patch_{events,input,responses}.go` (Codex `apply_patch` custom-tool ⇄ function-call bridging; large), `interactions_usage.go`.
Unsupported content (e.g. audio/video parts a target can't carry) raises `UnsupportedPartError` → HTTP **400** with `IsRequestScoped()==true` (no credential penalty).

---

## 5. Thinking pipeline (`internal/thinking`)

Architecture (must be preserved, AGENTS.md): *parse/extract → canonical `ThinkingConfig` → central normalise/validate against model capabilities → per-provider applier writes provider-specific fields.*

### 5.1 Types & suffix grammar

```go
type ThinkingMode  int  // ModeBudget=0, ModeLevel, ModeNone, ModeAuto
type ThinkingLevel string // none auto minimal low medium high xhigh max
type ThinkingConfig struct { Mode; Budget int; Level ThinkingLevel }
type ThinkingSupport (registry.ModelInfo.Thinking) { Min, Max int; ZeroAllowed, DynamicAllowed bool; Levels []string }
```
`ModelInfo.UserDefined` marks models not in the static catalog (config-defined / unknown) → "user-defined" path.
**Suffix** (`suffix.go`): `model(rawSuffix)` where parenthesis group is the **last** `(` to the final `)` (model must end with `)`). Case-insensitive interpretation order: special `none` → ModeNone/0; `auto` or `-1` → ModeAuto/-1; level word (`minimal,low,medium,high,xhigh,max`) → ModeLevel; non-negative integer → ModeBudget (0 → ModeNone); anything else → empty config (ignored; suffix is still stripped from the upstream model name by callers using `ParseSuffix().ModelName`). **Suffix overrides body config.**

### 5.2 Constants

* `levelToBudgetMap` (`convert.go:11`): none 0, auto −1, minimal 512, low 1024, medium 8192, high 24576, xhigh 32768, max 128000.
* `ConvertBudgetToLevel`: <−1 invalid; −1 auto; 0 none; ≤512 minimal; ≤1024 low; ≤8192 medium; ≤24576 high; else xhigh.
* `MapToClaudeEffort`: minimal→low; low/medium/high same; xhigh/max→`max` if model supports max else `high`; auto→high.
* Standard level order for clamping: minimal < low < medium < high < xhigh < max.

### 5.3 `ApplyThinking` algorithm (`apply.go:206-409`)

Inputs: body (already translated to provider format), model (with suffix), `fromFormat` (client), `toFormat` (provider format; `openai-response`→treated as `codex`), `providerKey` (registry lookup key, e.g. `openrouter`), optional resolved `ModelInfo`.
1. `ParseSuffix(model)`; `modelInfo = registry.LookupModelInfo(base, providerKey)` (or the per-credential resolved info).
2. For Responses-format clients capture source config from `reasoning.effort` and in-turn `configuration_update` input items (Responses "configuration_update" feature) of the *source* body.
3. For Codex/xAI targets strip `configuration_update` items unless `modelInfo.SupportConfigurationUpdate`.
4. Applier lookup by `toFormat` (`gemini, claude, openai, codex, antigravity, kimi(+aliases), xai, interactions`; plugin appliers registered by priority). Unknown provider → passthrough.
5. If native Responses + supportsUpdates and no suffix → return body untouched.
6. **User-defined/unknown model** (`IsUserDefinedModel`: modelInfo nil or `UserDefined`): config = suffix, else source/body config (from-format then to-format); no config → only summary handling; else `normalizeUserDefinedConfig` (level→budget for gemini/antigravity but **not** claude; others keep level) and `applier.Apply(..., modelInfo)` with *no validation* (upstream decides).
7. Known model with `Thinking == nil` ("no thinking support"): if body has thinking config or a summary intent → **strip** it (`StripThinkingConfig` / `stripResponsesEffort`); else passthrough.
8. Config source: suffix wins; else source-body config (when available), else extract from translated body (extractors per provider format below). No config → apply only the reasoning-summary config → return.
9. `shouldMapConfiguredHighIntent`/`mapConfiguredHighIntent`: for level `xhigh`/`max` when crossing families, prefer a supported level in order `[xhigh,max,high]` / `[max,xhigh,high]`.
10. `ValidateConfig` (§5.4); error → returned as `ThinkingError{Code,Message}` with HTTP 400 (`errors.go`: codes `INVALID_SUFFIX, UNKNOWN_LEVEL, THINKING_NOT_SUPPORTED, LEVEL_NOT_SUPPORTED, BUDGET_OUT_OF_RANGE, PROVIDER_MISMATCH`).
11. `applier.Apply(body, validatedConfig, modelInfo)`; then, unless thinking is fully disabled or native Responses, re-apply the summary intent (§5.6).

Config extractors (`apply.go:596-974`):
| Format | Reads |
|---|---|
| claude | `thinking.type`: `disabled`→None; `adaptive|auto` + `output_config.effort` → Level/None/Auto; `thinking.budget_tokens` (0→None, −1→Auto, n→Budget); `enabled` + effort → Level else Auto |
| gemini | `generationConfig.thinkingConfig.thinkingLevel|thinking_level` (none/auto/level) else `thinkingBudget|thinking_budget` (0/−1/n) |
| antigravity | same under `request.generationConfig.thinkingConfig` |
| interactions | `generation_config.{thinking_level,thinkingLevel,thinking_config.*,thinkingConfig.*}` / `…thinking_budget…` |
| openai | `reasoning_effort` (`none`→None else Level) |
| codex/xai/openai-response | `reasoning.effort` (+ `configuration_update` items for usage) |
| kimi | `thinking.type` disabled → None; `thinking.effort`; else `reasoning_effort` |

### 5.4 `ValidateConfig` (`validate.go:38-200`)

* No `Thinking` support: error `THINKING_NOT_SUPPORTED` unless mode None.
* Capability: `Hybrid` (budget range **and** levels), `BudgetOnly` (Min/Max>0, no levels), `LevelOnly`, `None`.
* `allowClampUnsupported = hasLevels && (families differ || modelFamilyMismatch)`; `strictBudget = !fromSuffix && same provider family && !modelFamilyMismatch`. Families: gemini∼antigravity; openai∼openai-response∼codex; `modelFamilyMismatch` when `modelInfo.Type` family ≠ from/to (e.g. Kimi via Claude protocol).
* BudgetOnly + Level → budget via map (Auto kept); LevelOnly + Budget → level via `ConvertBudgetToLevel` then `clampLevel` to nearest supported (ties → lower).
* Normalise: level none→ModeNone; level auto→ModeAuto(−1); budget 0→ModeNone.
* Level support check: unsupported level → clamp (if allowed) else `LEVEL_NOT_SUPPORTED` ("level %q not supported, valid levels: a, b").
* Strict budget range: `Budget<Min || >Max || (0 && !ZeroAllowed)` → `BUDGET_OUT_OF_RANGE` ("budget %d out of range [%d,%d]").
* Auto not allowed (`!DynamicAllowed`): levels-only → `medium`; else `mid=(Min+Max)/2` (→None if ≤0 & ZeroAllowed, `Min` if ≤0, else mid).
* Final clamp of budget into [Min,Max] (−1 preserved; 0 with !ZeroAllowed→Min); level-capable models that can't disable get `Levels[0]`.

### 5.5 Per-provider appliers (`internal/thinking/provider/*/apply.go`)

* **openai** → `reasoning_effort`: Level → value; None → `"none"` if `ZeroAllowed` or `none ∈ Levels`, else configured level, else `Levels[0]`; Auto/Budget ignored for known models. Compat/user-defined: Budget→`ConvertBudgetToLevel`, Auto→`"auto"`.
* **codex** (and **xai** = codex applier) → `reasoning.effort`, same rules.
* **claude**: None → `thinking.type="disabled"`, delete `budget_tokens`, `display`, `output_config.effort` (+ empty `output_config`). Level & model has `Levels` (adaptive-capable) → `thinking.type="adaptive"`, `output_config.effort=<level>`, delete budget; else Level→Budget fallthrough. Budget 0 → disabled; Budget n → `thinking.type="enabled"`, `thinking.budget_tokens=n`, delete `output_config.effort`, then `normalizeClaudeBudget` (sets `max_tokens` to model max if absent; budget capped to `max_tokens-1`; skipped if below model `Min`). Auto → adaptive (if levels) else `enabled` without budget. Compat: Level→adaptive+effort always, Auto→enabled.
* **gemini**: Level → `generationConfig.thinkingConfig.thinkingLevel`; Budget/Auto → `thinkingBudget` (−1 for auto); None → level format if the model has levels else `thinkingBudget:0` (fully disabled with no level → delete `thinkingConfig`); preserves an explicit `includeThoughts`/`include_thoughts` bool.
* **antigravity**: same under `request.generationConfig.thinkingConfig`; Claude-model ids (`contains "claude"`) use `normalizeClaudeBudget` (budget < model Min → drop thinkingConfig; cap to max_output−1; fills `maxOutputTokens` from model).
* **kimi** (+`kimi-ai`, `kimi.ai`, `kimi.com`): `thinking.type="enabled"` + `thinking.effort=<level>` (budget→level, auto→"auto"), deletes `reasoning_effort`; None → `thinking:{type:"disabled"}`.
* **interactions**: strips all legacy thinking fields then sets `generation_config.thinking_level` (levels normalised to supported set) and `generation_config.thinking_summaries` (`auto|none`).
* Strip rules when a model has no thinking support (`strip.go`): claude → `thinking`,`output_config.effort`; gemini → `generationConfig.thinkingConfig`; antigravity → `request.generationConfig.thinkingConfig`; openai → `reasoning_effort`,`reasoning`; kimi → `reasoning_effort`,`thinking`; codex/xai → `reasoning`.

### 5.6 Reasoning-summary visibility (`summary.go`)

Orthogonal to effort: `SummaryConfig{Mode: Unspecified|Disabled|Enabled, Detail}` extracted from the *client* body (OpenAI Chat: any non-`none` `reasoning_effort` ⇒ Enabled/`auto`; `reasoning.exclude`, `include_reasoning`; Responses: `reasoning.summary` / `reasoning.generate_summary`; Claude `thinking.display`; Gemini `includeThoughts`; Interactions `thinking_summaries`) and re-applied to the provider body after the effort is set: claude → `thinking.display = summarized|omitted` (only when thinking active; enabling a summary can activate thinking via `enableClaudeThinkingForSummary`), gemini/antigravity → `…thinkingConfig.includeThoughts`, interactions → `generation_config.thinking_summaries`, codex/openai-response → `reasoning.summary` (`auto|concise|detailed`; disabled ⇒ delete field), openai(chat) → `reasoning.exclude` (OpenRouter) / `include_reasoning`. Hooked in `TranslateRequestEnvelope` **and** in `applyThinking`.

### 5.7 Executor integration

`helps.ApplyRequestThinking(body, req, opts, from, to, providerKey, …)` (`model_capabilities.go:18`) is called by every executor after translation and model rewrite; it uses the exact credential-resolved `ModelInfo` (`cliproxyauth.ResolvedModelInfo(req)` — API-key models can override thinking capabilities) else the registry. Also `thinking.ExtractReasoningEffort` populates `Metadata.reasoning_effort` in handlers (priority: configuration_update → suffix → body → `reasoning.effort`) and `UsageReporter.SetTranslatedReasoningEffort` after final translation.

---

## 6. Payload rules ("payload" config — final barrier)

Implementation: `internal/runtime/executor/helps/payload_helpers.go` (`ApplyPayloadConfigWithTrackedPathsForExecutor`, :54-228), finalizer `payload_finalizer.go`, config `internal/config/config_types.go:439-488`.

### 6.1 Ordering contract (AGENTS.md)

Payload rules **must be the last semantic mutation** of the business payload in every executor path (stream, non-stream, websocket, continuation, retry/fallback, image, count-tokens); afterwards only transport framing/serialization/signing/read-only validation (e.g. Claude: `extractAndRemoveBetas`, `stripPromptCacheOptions`, CCH signing, mid-system validation). Rules run **exactly once** per attempt on a body rebuilt from scratch. Shared builders get `helps.WithPayloadFinalizer(ctx, NewPayloadFinalizer(cfg, executor, model, protocol, root, original, req, opts))` and call `FinalizePayload(ctx, body)` immediately before serialization (Codex/antigravity/websocket paths). Call sites: `grep ApplyPayloadConfig|NewPayloadFinalizer internal/runtime/executor` (≈40 places; claude/codex/gemini/vertex/aistudio/antigravity/kimi/xai/devin/meta/openai-compat incl. token-count and image/speech/media paths).

### 6.2 Schema (`config.yaml` → `payload:`)

```yaml
payload:
  default:       [ {models: [<ModelRule>…], params: {<json-path>: <value>}} ]   # set only if absent in the ORIGINAL (client-translated) payload; first write wins per resolved path
  default-raw:   [ …params values are raw JSON fragments (strings used as-is) ]
  override:      [ …always set; last write wins ]
  override-raw:  [ …raw JSON ]
  filter:        [ {models: [<ModelRule>…], params: [<json-path>…]} ]         # delete paths
# ModelRule:
#   name:          wildcard on model name ('*' only wildcard; "gpt-*", "*-5", "gemini-*-pro", "*")
#   protocol:      target (provider) format, case-insensitive: gemini|claude|codex|openai|openai-response|antigravity|interactions|…  (empty or runtime protocol empty ⇒ ignore)
#   from-protocol: client/source format; aliases openai-response|openai-responses|response → "responses"; empty ⇒ any; if rule set and runtime from empty ⇒ no match
#   headers:       {Header-Name: wildcard}  — ALL must match (case-insensitive name; any value of a multi-valued header)
#   match:         [ {path: value} … ]      — every pair must be present and deep-equal (JSON normalised)
#   not-match:     [ {path: value} … ]      — no pair may match
#   exist:         [path…]   — each must exist and not be null
#   not-exist:     [path…]   — each must be missing or null
```
`models` entries are OR'd; a rule applies when **any** entry matches **any** model candidate.

### 6.3 Evaluation semantics

* **Candidates** (`payloadModelCandidates`, :498): `[upstream baseModel, base of requestedModel, requestedModel-with-suffix (only if it had a suffix)]` deduplicated case-insensitively. `requestedModel` = `Metadata.requested_model` (the original client string) else `req.Model`. If rules exist but both are empty → nothing applied.
* **Root**: `root` is "" for all executors except Antigravity which passes `"request"` (rule paths are relative to the nested `request` object; `buildPayloadPath(root, path)` = `root + "." + path`, a leading `.` trimmed).
* **Order** (fixed): (0) built-in `disable-image-generation` stripping (modes `true`/`chat`; removes `image_generation` tools and tool_choice before user rules so user rules may re-add; `chat` keeps it on `/v1/images/*` paths by `request_path`; `passthrough`/`false` never strip) → `default` → `default-raw` → `override` → `override-raw` → `filter`. Conditions (`match/not-match/exist/not-exist`) are evaluated against the **current `out`** at each rule (so earlier rules affect later conditions).
* `default`/`default-raw`: skip a resolved path if it exists in `original` (the client's body translated to the same provider format with *no* thinking/other mutations; falls back to current payload if no original) **or** was already default-written by an earlier rule (`appliedDefaults`).
* `override*`: always set (`sjson.SetBytes` / `SetRawBytes`); no-op if value deep-equals existing.
* `filter`: delete each resolved path (deletes iterate resolved paths in reverse for array indices).
* **Paths**: gjson/sjson syntax. Query segments `#(expr)` (first match) and `#(expr)#` (all matches) are expanded to concrete index paths against the *current* payload before set/delete (`resolvePayloadRulePaths`, :559-760); expr supports `&&`, `||` and gjson comparison terms (evaluated by wrapping the item in an array and running gjson `#(term)`). Dots inside parentheses/quotes don't split segments. A TS port needs a gjson-compatible path engine (get/set/delete, `#`, `#(…)`, wildcards, `-1` append, escaping).
* `*-raw` values: strings used verbatim as JSON text, other types `json.Marshal`ed; nil skipped.
* Header source: `opts.Headers` (inbound request headers); `Metadata.request_path` for image mode.
* Extra built-ins in the same function: when `User-Agent` indicates a Codex client and the target executor isn't Codex/Codex-websocket, tool JSON-schema integer types are normalised (`NormalizeCodexToolIntegerTypes`, issues #6237/#6244).
* `trackedPaths` (Claude only: `"diagnostics"`) reports whether any applied rule touched a path (so injected Claude diagnostics can be reset).

---

## 7. Signature / replay caches (`internal/cache`, `internal/signature`)

Purpose: providers return opaque cryptographic blobs ("thought signatures", Claude `signature`, Codex/xAI `encrypted_content`, Kimi thinking signatures) that **must be echoed back** verbatim on the next turn or the request is rejected / quality degrades. Because clients (OpenAI/Claude/Gemini SDKs, Responses, Chat) often drop or mangle them, the proxy caches them server-side and re-injects, and validates/sanitises foreign signatures when a conversation hops between providers.

### 7.1 `internal/cache` stores

| Store | Key | Value | TTL | Bounds | KV key (Home mode) |
|---|---|---|---|---|---|
| **Signature cache** (`signature_cache.go`) | `modelGroup` × `sha256(text)[:16 hex]` where `GetModelGroup(model)` = `"gpt"` if contains `gpt`, else `"claude"`, `"gemini"`, else model name | thinking **text → signature** (min len **50**) | **3 h**, sliding (refresh on read); purge every 10 min | unbounded map (per group) | `cpa:signature:<group>:<hash>` |
| Claude thinking replay (`claude_thinking_replay_cache.go`) | `(modelFamily, sessionKey)` | ordered array of assistant `content` JSON arrays (signed turns) + generation/tombstone for compare-and-swap | 1 h | 10 240 entries (evict batch 128), 8 MiB & 64 turns/session, 512 blocks/turn, 256 MiB total | `cpa:claude:thinking-replay:<h(family)>:<h(session)>` |
| Codex reasoning replay (`codex_reasoning_replay_cache.go`) | `(model, sessionKey)` (independent of credential so failover keeps it) | normalised Responses items (`reasoning` w/ `encrypted_content`, `function_call`, `custom_tool_call`) with turn-boundary marker `cpa_codex_replay_turn` | 1 h | 10 240 entries, 256 turns/entry, 16 MiB/entry | `cpa:codex:reasoning-replay:…` |
| xAI reasoning replay | same shape (+ `message` items) | | 1 h | 10 240 | |
| Kimi thinking replay | `(modelFamily, session)` | one signed content array | 1 h | 10 240; 8 MiB/entry, 512 blocks | `cpa:kimi:…` |
| Antigravity reasoning replay | `(model, session)` | thoughtSignature parts / functionCall parts (≥16-char signatures) with generation tokens, CAS replace/delete | 1 h | 10 240; ≤4096 items & 16 MiB/entry | `cpa:antigravity:…` |
| Interactions continuation (`antigravity_interactions_session.go`) | caller+credential+model+conversation+sorted pending call-ids (`InteractionsCallKey`; rejects empty/dup/NUL ids) | `{ID, Environment}` upstream continuation ids | 30 min | 1 024 entries | (local only) |
| Bounded LRU (`bounded_lru.go`) | generic | | | | |

In Home mode these use a Redis-like KV (`SET EX`, `GET`, `EXPIRE`, `DEL`); locally, in-process maps with a janitor goroutine (`CacheCleanupInterval=10 min`, `purgeExpired*`). **Port**: Durable Object storage or KV (with `expirationTtl`); CAS/generation semantics (`…IfUnchanged`) need a DO (KV is not atomic). Consider keying DO by `(caller_scope, sessionKey)`.

Signature-cache behaviour: `GetCachedSignature(model,text)`: empty text → Gemini group returns the sentinel `"skip_thought_signature_validator"`, others `""`; miss → same sentinel for gemini else `""`. `HasValidSignature`: `len ≥ 50` or (sentinel and gemini group). Switches `SetSignatureCacheEnabled` (Antigravity "cache mode" vs "bypass mode", default enabled) and `SetSignatureBypassStrictMode` (strict protobuf-tree validation, default off).
Writers/readers: Antigravity Claude translator (`translator/antigravity/claude/*_request.go:76,119`, `*_response.go:160,203,682,706` — caches signature from streamed thinking blocks keyed by the *thinking text*, looks it up when the Claude client sends thinking blocks back without a valid signature), plus per-executor replay code (`runtime/executor/*_reasoning_replay.go`, `claude_thinking_replay.go`).

### 7.2 `internal/signature` (validation / compatibility, ~6.7 kLOC)

Pure functions, no I/O: classify a signature's provider (`DetectSignatureProvider*` by base64 first char `C E Q R g` + protobuf structure: Claude single-layer `E`/double `R`/CAIS `C`/antigravity CAQS `Q`, Gemini protobuf field-2 vs ascii-UUID, GPT Fernet `0x80`, Grok encrypted_content shape, Kimi, SWE `sealed.v1`), decide `Preserve | DropBlock | DropSignature | ReplaceWithGeminiBypass | NoCompatibleReplacement` for a (target provider, block kind, signature) triple (`DecideSignatureCompatibility*`), and sanitise request bodies (`SanitizeClaudeMessagesSignaturesForTarget`, `StripInvalidClaudeThinkingBlocks`, `SanitizeGeminiRequestThoughtSignatures`, `ValidateGeminiFunctionCallPairing`). Target provider from model name: contains `claude`→Claude; `gemini`→Gemini; `gpt|openai|codex|o1|o3|o4*`→GPT; `kimi|moonshot|k2*|k3*`→Kimi; `grok`→Grok; `swe-`→SWE. Gemini replacement signature: `skip_thought_signature_validator`. These are heavy but deterministic; port the *decision table* first, deep protobuf inspection later (it is used to avoid sending a signature that the target would reject with 400).

---

## 8. Usage accounting hooks

### 8.1 Flow

Executors create `helps.NewExecutorUsageReporter(ctx, executor, model, auth)` (`internal/runtime/executor/helps/usage_helpers.go:75`), `defer reporter.TrackFailure(ctx,&err)`, wrap the upstream `http.Client` with `reporter.TrackHTTPClient` (TTFT: time to first response byte / first token event), feed it usage detail parsed from the upstream response (`Publish(ctx, detail)`; streaming uses `StreamUsageBuffer` keeping the *latest* usage seen) and call `EnsurePublished` so every attempt yields exactly one record (failures too, with `Fail{StatusCode, Body}`). Additional-model records (e.g. image tool model usage) via `PublishAdditionalModel`. Records go to `usage.PublishRecord(ctx, rec)` → `sdk/cliproxy/usage/manager.go:390` `Manager.Publish` → in-memory queue (cond-var worker goroutine, unbounded) → every registered `Plugin.HandleUsage(ctx, Record)` (panics recovered). Stream delivery tracking (`usage/stream_delivery.go`): HTTP consumer acknowledges delivery so a record can distinguish "client got the stream" (cancel/early-terminal accounting); internal executions use `WithoutStreamDelivery`.
Built-in plugin: `internal/redisqueue/plugin.go` (enabled by `usage-statistics-enabled`) enqueues JSON into an in-process queue exposed via a **RESP/Redis-protocol listener** (retention default 60 s, max 3600 s, `queue.go:10-11`) for external collectors; plus plugin adapters (`internal/pluginhost/adapters_usage_translation.go`). **There is no built-in persistent store** — a Workers port should write to D1/Analytics Engine/Queue in `ctx.waitUntil`.

### 8.2 `usage.Record` (`sdk/cliproxy/usage/manager.go:24`)

`RequestID` (uuid v4 per execution; from `WithExecutionRequestID`), `TraceID` (8-hex parent HTTP request id), `Provider`, `BaseURL`, `ExecutorType`, `Model` (billed/upstream-base model), `Alias` (client-requested model: `WithRequestedModelAlias`), `APIKey` (client key, from ctx `userApiKey`), `SessionID`, `ParentSessionID`, `AuthID`, `AuthIndex`, `AccessTokenSHA256` (OAuth token-version fingerprint), `AuthType` (`oauth|apikey|…` = `auth.AuthKind()`), `Source` (account label: vertex project id → `auth.AccountInfo()` value → metadata `email` → `attributes.api_key` → client key), `ReasoningEffort` (translated upstream level), `ServiceTier` (client request tier; default `"auto"` for OpenAI handlers, `"default"` SDK), `ResponseServiceTier`, `ResponseModel` (model name the upstream reported), `Generate *bool` (false only when client sent `generate:false`), `Stream`, `RequestedAt`, `Latency`, `TTFT`, `Failed`, `Fail{StatusCode, Body}`, `Detail`, `ResponseHeaders` snapshot.
`Detail`: `InputTokens, OutputTokens, ReasoningTokens, CachedTokens, CacheReadTokens, CacheCreationTokens, TotalTokens, ResponseServiceTier, TokenBreakdown`.

### 8.3 Token accounting v2 (`usage/accounting.go`, schema version `2`)

`TokenBreakdown{schema_version, quality: complete|inconsistent|unclassified, total_tokens, input{total,uncached,cache_read,cache_write}, output{total,non_reasoning,reasoning}, unclassified_tokens}` with invariants `input.total = uncached+cache_read+cache_write`, `output.total = non_reasoning+reasoning`. Constructors by provider semantics (`tokenAccountingSemanticsFor(provider, executorType)`, :340):
* **Subset** (`openai, codex, xai, grok, kimi, qwen, deepseek, openrouter`, openai-compat executor/providers): `input_tokens` includes cached; `output_tokens` includes reasoning.
* **Independent** (`claude`/`anthropic`): cache read/creation are separate from `input_tokens`; `total = input+output+cache_read+cache_creation`; thinking is a subset of `output_tokens`.
* **SeparateReasoning** (`gemini, aistudio, antigravity, vertex, interaction*`): `candidatesTokenCount` excludes `thoughtsTokenCount`.
* Unknown → `unclassified` with lower-bound total.
Parsers (`usage_helpers.go`): OpenAI-style `parseOpenAIStyleUsageNode` (:998: `prompt_tokens|input_tokens`, `completion_tokens|output_tokens`, `total_tokens`, `*_tokens_details.cached_tokens`, `…cache_creation_tokens|cache_write_tokens`, `…reasoning_tokens`), Claude `parseClaudeUsageNode` (:1117: `input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens`, reasoning from `output_tokens_details.thinking_tokens|reasoning_tokens|thinking_tokens`), Gemini-family `parseGeminiFamilyUsageDetail` (:1167: `promptTokenCount (+toolUsePromptTokenCount)`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `cachedContentTokenCount`), Interactions, Antigravity, Codex (`response.usage` in `response.completed`), plus `ParseOpenAIStreamUsage`/`ParseClaudeStreamUsage`/… for stream lines.

### 8.4 Queue/export JSON (`internal/redisqueue/plugin.go:165`)

`{timestamp, latency_ms, ttft_ms, source, auth_index, access_token_sha256?, client_ip, resolved_client_ip, x_forwarded_for, user_agent, tokens{input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_read_tokens,cache_read_tokens_present,cache_creation_tokens,total_tokens}, failed, generate, stream, fail{status_code,body}, response_headers?, accounting_version:2, token_breakdown, provider, executor_type, model, alias, endpoint ("METHOD /route"), auth_type, api_key, request_id, execution_id?, trace_id?, session_id?, parent_session_id?, node_kind?, is_fork?, is_compaction?, reasoning_effort, service_tier, response_service_tier?, response_model?}`. Failed ⇒ `fail.status_code` = record status ?? HTTP response status ?? 500; success ⇒ 200. Session ids are normalised to canonical UUIDs (parent cleared if equal).

---

## 9. What cannot run as-is on Cloudflare Workers

| Go feature | Where | Used for | Workers replacement |
|---|---|---|---|
| Goroutine background loops / tickers (`time.NewTicker`, `sync.Cond` workers) | usage manager, signature/replay janitors, keep-alive tickers, auto-refresh loops | async dispatch, TTL purge, keepalives | `ctx.waitUntil`, TTL on KV/DO storage, DO alarms / cron triggers; keep-alive via `setInterval` inside the streaming Response (alive while client connected) |
| Local listeners: gin `http.Server`, RESP/Redis queue listener, pprof, wsrelay `/v1/ws` | `server.go`, `redisqueue`, `wsrelay` | HTTP, usage queue export, AI Studio relay | Worker `fetch` handler; replace RESP queue with D1/Queues/Analytics Engine/HTTP export; wsrelay needs a DO holding the browser socket |
| `utls` TLS fingerprinting (`helps/utls_client.go`, `NewUtlsHTTPClient`) | Claude (and Anthropic OAuth) upstream requests | mimic Claude Code/Chrome JA3/ALPN | **Impossible** — Workers `fetch` has a fixed TLS stack. Anthropic fingerprint-sensitivity must be handled by headers only, or by an external proxy |
| Per-credential `proxy-url` (HTTP/SOCKS) transports, `RoundTripper` injection, `transport_cache` | `sdk/proxyutil`, `executor/helps/proxy_helpers.go` | egress through proxies | Not supported in Workers (no CONNECT). Drop or route via a forwarding service |
| Raw TCP/UDP: pion WebRTC media relay, `tcp_proxy.go` | `internal/client/codex/live/*` (`/v1/live`, `/v1/realtime*`) | Codex realtime WebRTC bootstrap + media relay | Not portable (Workers has `connect()` TCP sockets but no UDP/WebRTC listener). Out of port scope; could proxy only the HTTP SDP exchange |
| Filesystem | `auths/`, OAuth callback files (`WriteOAuthCallbackFileForPendingSession`), request-log files, config.yaml, git/pg stores | credential store, login callbacks, logs | KV/D1/R2/DO; callback state in KV with short TTL |
| In-process LRU/maps, `sync.Map` caches | §7 caches, video-auth binding, websocket tool caches, session affinity | continuity | DO storage (strong consistency / CAS) or KV for best-effort |
| `zstd` request decoding (`klauspost/compress`) | `ReadRequestBody` | Codex CLI sends zstd bodies | WASM zstd (fzstd/zstd-wasm) — `DecompressionStream` lacks zstd |
| `tiktoken-go/tokenizer` | Codex/xAI/meta count_tokens | local token counting | `js-tiktoken`/`gpt-tokenizer` (bundle size!) or approximate |
| gjson/sjson path engine | everywhere (translators, thinking, payload rules) | JSON manipulation | need a gjson-compatible TS implementation (esp. for payload rules `#(…)` queries) — or a typed rewrite of translators |
| gorilla/websocket server+client | `/v1/responses` WS, Codex/xAI upstream WS | duplex Responses | Workers `WebSocketPair` (inbound) and `fetch()` with `Upgrade: websocket` (outbound); state in a DO |
| Wall-clock cooldown waits in handlers (`waitForCooldown` up to `max-retry-interval`) | conductor retry | wait for credential cooldown | bound by Worker duration/CPU limits; prefer returning 429/503 + `Retry-After`; subrequest limits (50/1000) cap retry loops |
| "Home" control plane (`internal/home`, `HomeEnabled()` branches) | everywhere | external scheduler + shared KV | Ignore; every `HomeEnabled()` branch can be deleted in the port |
| Plugin host (`pluginhost`, interceptors, model routers, plugin executors) | handlers + conductor | extensibility | Ignore unless plugins required |

---

## 10. Port checklist (pipeline-relevant)

1. **Router**: implement §1.1 routes (minus realtime/live/management/home/wsrelay); gate `/v1*`, `/v1beta*`, `/openai/v1*`, `/backend-api/codex*` with the 5-source API-key check; CORS exactly as §1.2.
2. **Resolution**: `ParseSuffix` → `auto` → provider lookup via registry (model → providers[], thinking support) → per-credential alias/prefix handling inside the credential picker.
3. **Executor interface** per §3.2; keep `Options.SourceFormat/ResponseFormat/OriginalRequest/Metadata` semantics; executors own translate→thinking→provider tweaks→payload rules→send.
4. **Streaming** as `ReadableStream`: async-iterable of `Uint8Array|string` chunks; bootstrap-peek first chunk to choose HTTP error vs SSE; per-protocol `writeChunk/terminalError/done` (§2.2/2.3); keepalive optional.
5. **Error bodies** exactly per protocol (OpenAI table, Claude mapping, Responses `error`/`response.failed` builders + sanitiser).
6. **Translator registry** keyed `(client, provider)`; request fn `(model, body, stream) → body`; response fns `(ctx, model, originalReq, translatedReq, line, state) → chunks[]`; implement the 28 pairs by priority: openai→{openai-compat passthrough, claude, codex, gemini}, claude→{claude passthrough, codex, gemini, openai}, openai-response→{codex, claude, gemini, openai}, gemini→{gemini, claude, codex, openai}, then antigravity & interactions.
7. **Thinking**: port `ParseSuffix`, the 8 extractors, `ValidateConfig`, and 8 appliers + summary config verbatim — they are small and well specified (§5).
8. **Payload rules**: gjson-compatible path layer + matcher + the fixed 5-phase order (§6); add a regression test that the finalizer runs last in each executor path (AGENTS.md requirement).
9. **State**: signature/replay caches and video↔auth binding in DO/KV with the TTLs/bounds in §7/§2.8; Responses-WS per-socket state in a DO.
10. **Usage**: build one `Record` per upstream attempt with the fields in §8.2 and the provider-specific token semantics in §8.3; publish via `waitUntil` to D1/Queues.
