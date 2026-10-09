# Providers: xAI, Kimi, Devin, Meta (+ API-key scoping)

Scope: `internal/runtime/executor/{xai_*,kimi_*,devin_*,meta_*,oauth_scope_executor}.go`,
`internal/runtime/executor/helps/{xai_version,devin_*,kimi_responses,meta_tools}.go`,
`internal/auth/{xai,kimi,devin,meta}`, `sdk/auth/{xai,kimi,devin,meta}.go`.
All paths relative to repo root. Line numbers are from the checked-out tree; "~" = approximate.
No secrets are recorded; only public OAuth client IDs embedded in source.

Legend – **CFW** = Cloudflare-Workers implication.

---

## 0. Cross-cutting facts used by all four providers

| Topic | Behaviour | Source |
|---|---|---|
| Credential model | `Auth{ID, Provider, Attributes map[string]string, Metadata map[string]any, Storage, ProxyURL, Quota}`. Executors read the token from `Attributes` first, then `Metadata` (details per provider below). Persisted JSON file = Metadata (+ storage fields). | per-provider |
| Error type | `statusErr{code int, msg string, retryAfter *time.Duration, credentialScoped bool}`; `Error()` returns `msg` (upstream body verbatim) or `"status N"`. The conductor (not covered here) uses `code`, `retryAfter`, `credentialScoped`/`IsRequestScoped()` to rotate credentials, cool down auth/model, or surface the error. | `internal/runtime/executor/openai_compat_executor.go:1104-1115` |
| `retryAfter` semantics | Hint for auth cooldown; `nil` ⇒ conductor default backoff. | same |
| Per-API-key config scoping (`oauth_scope_executor.go`) | Executors implementing `ForAPIKey() ProviderExecutor` are cloned (value receiver) with `cfg = cfg.ForAPIKey()` when the selected auth is an API-key auth (`auth.AuthKind()==AuthKindAPIKey`). `Config.ForAPIKey()` zeroes every config field that was set under the v8 `oauth.providers.*` YAML paths (`OAuthOnlyFields`), so "OAuth-only" payload rules/overrides do not apply to API-key credentials. Shared transport/session stores are preserved (shallow copy). Implemented for Codex, Claude, Gemini, GeminiVertex, OpenAICompat, **Meta, XAI, XAIWebsockets, XAIAuto, Kimi** (Kimi also scopes its embedded ClaudeExecutor). Devin has **no** `ForAPIKey`. | `internal/runtime/executor/oauth_scope_executor.go:1-74`; `internal/config/oauth_scope.go:13-27`; `sdk/cliproxy/auth/conductor_execution.go:474-480`; `kimi_executor.go:1396-1400` |
| Port note for scoping | In TS: `resolveConfig(auth) = auth.kind==="api_key" ? stripOauthOnly(cfg) : cfg`. No executor state needed. | |
| Outbound proxy | Every executor uses `helps.NewProxyAwareHTTPClient(ctx,cfg,auth,timeout)` (per-auth `proxy_url`, global `proxy-url`, per-request override). **CFW: cannot do (no outbound proxies / raw sockets). Drop or restrict to "forward via a user-supplied relay Worker".** | |
| No upstream timeouts after connect | Credential-acquisition HTTP calls use 30 s client timeout; chat/stream calls use timeout `0`. (Exceptions: Codex/xAI websocket liveness.) | `AGENTS.md`; each client constructor |
| Payload config barrier | Every executor applies user "payload rules" (`helps.NewPayloadFinalizer` / `ApplyPayloadConfigWithRequest`) **last**, after all built-in shaping, exactly once. Port must keep this ordering. | `xai_executor_request.go:~87`; `kimi_executor.go:~182`; `meta_executor_execute.go:78` |

Things that cannot run on Workers (summary; details in each section):

| Item | Used for | Replacement |
|---|---|---|
| Local HTTP listener on `127.0.0.1:port` | Devin OAuth callback (`OAuthServer`) | Use Worker route (`/auth/devin/callback`) if Devin accepts the redirect, else headless paste flow (see §4) |
| `os.Hostname()`, `os.ReadFile(~/.local/share/kimi/device_id)` | Kimi `X-Msh-Device-*` headers | Static/stored values (see §3) |
| Goroutine ticker polling (device-code `PollForToken`, npm version updater every 3h) | login completion, xAI client-version | DO alarm / Cron Trigger / client-driven polling endpoint |
| `singleflight` refresh dedupe (xAI, Kimi, Meta) | Prevent concurrent refresh-token reuse | One DO per credential (serialize refresh) |
| gorilla/websocket client with per-session goroutine reader, ping/pong handler | xAI Responses websocket | `fetch(url,{headers:{Upgrade:"websocket",...}})` → `response.webSocket` inside a Durable Object; see §1.8 |
| In-process LRU/TTL caches (xAI reasoning replay 1 h/10240, Kimi thinking replay 1 h, Devin session-turn LRU 5000) | stateless replay | DO storage / KV with TTL |
| tiktoken `o200k_base` | xAI/Meta `/count_tokens` | JS port (e.g. `gpt-tokenizer`) or estimator |
| utls fingerprinting | **not used by these four** (Devin only disables gzip + strips UA; no utls in `NewDevinHTTPClient`) | – |

---

## 1. xAI (Grok)

Files: `xai_executor.go`, `xai_executor_auth.go`, `xai_executor_execute.go`, `xai_executor_stream.go`, `xai_executor_request.go`, `xai_executor_response.go`, `xai_executor_media.go`, `xai_executor_speech.go`, `xai_executor_tokens.go`, `xai_reasoning_replay.go`, `xai_websockets_executor.go`, `helps/xai_version.go`, `internal/auth/xai/*`, `sdk/auth/xai.go`.

### 1.1 Credential types and base-URL routing

Two credential kinds, discriminated by `auth_kind`/`using_api`:

| | OAuth (Grok CLI login) | API key (`xai-api-key` config) |
|---|---|---|
| token | `Metadata.access_token` | `Attributes.api_key` |
| `auth_kind` | `"oauth"` (attribute and metadata) | absent/other |
| `using_api` default | **false** | **true** |
| chat/media base URL | `https://cli-chat-proxy.grok.com/v1` (when `base_url` is empty or equals `https://api.x.ai/v1`); an explicit non-default `base_url` wins | `base_url` or `https://api.x.ai/v1` |

`xaiCreds`: token = `Attributes["api_key"]` → else `Metadata["access_token"]`; baseURL = `Attributes["base_url"]` → else `Metadata["base_url"]` (`xai_executor_request.go:199-217`).

`xaiUsingAPI(auth)` precedence (`:220-259`): `Attributes["using_api"]` (ParseBool) → `Metadata["using_api"]` (bool or string) → `Attributes["auth_kind"]` (`!= "oauth"`) → `Metadata["auth_kind"]` (`!= "oauth"`); nil auth ⇒ true.

Base-URL helpers (`:261-300`):

| Helper | Used by | Result |
|---|---|---|
| `xaiChatBaseURL` | `POST /responses` (HTTP chat), `/images/*`, `/videos*` | `using_api` ⇒ `base_url` or `https://api.x.ai/v1`; else non-default `base_url` or **`https://cli-chat-proxy.grok.com/v1`** |
| `xaiCompactBaseURL` | `/responses/compact`, `/tts` | `base_url` unless empty **or equal to the cli-chat-proxy URL** → `https://api.x.ai/v1` (cli-chat-proxy 404s on compact and `/tts`, and a 404 would cool the whole auth pool) |
| websocket | Responses WS | `base_url` or `https://api.x.ai/v1`, `http→ws`, `https→wss` (cli-chat-proxy returns 405 on upgrade) |

URLs compared after `TrimRight(TrimSpace(url),"/")`.

Constants (`internal/auth/xai/types.go:10-32`): `DefaultAPIBaseURL=https://api.x.ai/v1`, `CLIChatProxyBaseURL=https://cli-chat-proxy.grok.com/v1`, `Issuer=https://auth.x.ai`, `DiscoveryURL=Issuer+/.well-known/openid-configuration`, public `ClientID=b1a00492-073a-47ea-816f-4c329264a828`, `Scope="openid profile email offline_access grok-cli:access api:access"`, device grant `urn:ietf:params:oauth:grant-type:device_code`, default poll 5 s, `MaxPollDuration=30m`, http timeout 30 s, `refreshLead=5m`.

### 1.2 Login flow: OAuth2 Device Authorization Grant (RFC 8628) — no localhost redirect

`internal/auth/xai/xai.go`, `sdk/auth/xai.go:46-132`.

1. **Discovery** `GET https://auth.x.ai/.well-known/openid-configuration` (`Accept: application/json`) → uses `device_authorization_endpoint` and `token_endpoint` (`xai.go:68-112`). Both validated: must be `https` and host `x.ai` or `*.x.ai` (`:48-66`).
2. **Device code** `POST {device_authorization_endpoint}` form-urlencoded `client_id=<ClientID>&scope=<Scope>`; headers `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`. Response JSON: `device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval`. Must contain `device_code`, `user_code`, and one of the verification URIs (`:124-177`). The `token_endpoint` is carried alongside (not part of JSON).
3. Show `verification_uri_complete || verification_uri` + `user_code`; optionally open browser.
4. **Poll** `POST {token_endpoint}` form `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…` (`:265-340`).
   - Poll immediately once, then every `interval` (min 5 s; if `interval<=0` ⇒ 5 s). Deadline = min(30 min, `expires_in`).
   - Body `error` handling (checked **before** HTTP status): `authorization_pending` ⇒ continue; `slow_down` ⇒ interval += 5 s; `expired_token` ⇒ fail "xai device code expired"; `access_denied` ⇒ fail; other ⇒ fail with `error[: description]`.
   - Success: needs `access_token`; fields `access_token, refresh_token, id_token, token_type, expires_in`. `email` and `sub` parsed from the **unverified** `id_token` JWT payload (base64url, pad to 4, `claims.email`, `claims.sub`). `expired = now + expires_in` (RFC3339 UTC).
5. **Persist** (`CreateTokenStorage`, `:426-446`; `sdk/auth/xai.go:90-130`): JSON file `xai-<email|sub|unixmillis>.json` (sanitised: `[A-Za-z0-9@._-]` else `-`, trimmed of `-`) with:
   `type:"xai", access_token, refresh_token, id_token, token_type, expires_in, expired, last_refresh, email, sub, base_url:"https://api.x.ai/v1", token_endpoint, auth_kind:"oauth"` (+ `redirect_uri` unused). Attributes: `auth_kind:"oauth"`, `base_url`. Label = email or `"xAI"`.

**CFW**: Device flow is fully Workers-compatible. Move polling to a client-driven endpoint (`POST /auth/xai/poll`) or a DO alarm; store `{device_code, token_endpoint, interval, deadline}` in DO/KV.

### 1.3 Token refresh

- `RefreshLead = 5 min` before `expired` (`xai.go` Authenticator `RefreshLead`; `types.go:32`).
- `Refresh` (`xai_executor_auth.go:~13-75`): no `refresh_token` ⇒ return auth unchanged. Token endpoint = `Metadata.token_endpoint` else re-discover. `POST {token_endpoint}` form `grant_type=refresh_token&client_id=<ClientID>&refresh_token=…` (no client secret, no Basic auth), `Accept: application/json`. Non-200 ⇒ error `"xai token request failed with status N: body"`.
- Dedupe: `singleflight` keyed by refresh token (`xai.go:343-371`, uses `context.WithoutCancel`). **CFW: serialize per credential in a DO.** Refresh tokens may rotate: only overwrite `refresh_token` if the response has a non-empty one (same for `id_token`, `token_type`, `expires_in`, `expired`, `email`, `sub`).
- Updates metadata: `type, auth_kind, access_token, [refresh_token,id_token,token_type,expires_in,expired,email,sub], token_endpoint, base_url (default api.x.ai/v1 if empty), last_refresh`, attributes `auth_kind`, `base_url` default.
- Reactive path: 403 with "bad-credentials" body is **remapped to 401** so the conductor's "refresh once and retry on 401" runs (see 1.9).

### 1.4 Request headers

`applyXAIDefaultHeaders` (`xai_executor_request.go:321-337`): `Content-Type: application/json`; `Authorization: Bearer <token>` (deleted if empty); `Accept: text/event-stream` (stream) else `application/json`; `Connection: Keep-Alive`; `x-grok-conv-id: <sessionID>` if non-empty.

`applyXAIChatHeaders` (`:352-367`) for `POST /responses` only:
- `using_api==true` ⇒ default headers + custom headers.
- else defaults, and **if resolved chat base URL is exactly the cli-chat-proxy URL** add:
  - `X-XAI-Token-Auth: xai-grok-cli`
  - `x-grok-client-version: <ver>`
  - `User-Agent: xai-grok-workspace/<ver>`
  - `x-grok-client-identifier: grok-shell`
  - `x-authenticateresponse: authenticate-response`
  - then custom headers.
- `applyXAIHeaders` (images/videos/speech/compact) = defaults + custom headers only (no CLI identity headers, even for OAuth).
- Custom headers: `util.ApplyCustomHeadersFromAttrs(req, auth.Attributes, clientHeaders...)` — attributes keys of form `header:<Name>` plus pass-through of allowed client headers (port from `internal/util`, not in scope here).
- Speech overrides `Accept: */*`.

**Client version** (`helps/xai_version.go`): fallback `1.0.46` (`DefaultXAIFallbackClientVersion`); cli-chat-proxy returns **HTTP 426** below floor `1.0.13`. Background updater: on start and every **3 h** `GET https://registry.npmjs.org/@xai-official/grok/latest` (`Accept: application/json`, `User-Agent: CLIProxyAPI`, 10 s timeout, 1 MiB cap) → `version`; accepted only if strict numeric `x.y.z` and ≥ floor; failure keeps cached. **CFW: Cron Trigger every 3 h writing to KV; read KV (fallback constant) at request time.**

### 1.5 `POST {base}/responses` (chat) — request shaping

Upstream protocol is OpenAI **Responses** API; the proxy translates inbound (OpenAI chat/Claude/Gemini/Responses) to the internal "codex" Responses shape (`sdktranslator.FormatCodex`; translators are out of scope) and then applies this xAI-specific pipeline (`prepareResponsesRequestTo`, `xai_executor_request.go:65-177`). Order matters:

1. `baseModel = ParseSuffix(req.Model).ModelName` (strip `(...)` thinking suffix); apply thinking config via central `ApplyRequestThinking`.
2. Preserve client output controls for chat/responses sources: `max_output_tokens` (from `max_completion_tokens`‖`max_tokens` for OpenAI source; from `max_output_tokens` for Responses source), `temperature`, `top_p`, `top_k` (`:555-592`).
3. Force `model=baseModel`, `stream=<bool>`; delete `previous_response_id`, `prompt_cache_retention`, `safety_identifier`, `stream_options`; delete `stop` (unsupported by Responses) later.
4. Multi-agent-v2 input rewrite + apply_patch normalization (shared helpers).
5. **Tools** (see 1.6).
6. Reasoning replay injection (1.7).
7. `normalizeXAIInputCustomToolCalls`, `normalizeXAIInputNamespaceToolCalls`, `normalizeXAIInputReasoningItems` (drop `content:null`/`encrypted_content:null` on `reasoning` items; merge adjacent reasoning summaries), `sanitizeXAIInputEncryptedContent` (1.7), `normalizeCodexInstructions`, `normalizeXAIImageRefs`.
8. `prompt_cache_key = sessionID` when a session id exists. Session id = execution-session metadata key → `prompt_cache_key` in payload → derived UUID (`helps.DerivedSessionUUID("xai",…)`); for models with prefix **`grok-composer-`** an isolated conversation id is required (cached Claude-Code prompt-cache id or `uuid4`) (`:315-349`). Also sent as `x-grok-conv-id`.
9. User payload rules via `finalizePayload` last.

`CountTokens` (`xai_executor_tokens.go`): no upstream call; `o200k_base` tokenizer count over `instructions`, `input` (message text parts, function_call name+arguments, function_call_output, reasoning summary text, image_url/file ids as text), function tool `name/description/parameters`, `text.format.name/schema`; returns `{"response":{"usage":{"input_tokens":N,"output_tokens":0,"total_tokens":N}}}` translated to source format.

### 1.6 Tool normalization (xAI quirks)

`normalizeXAITool*` etc. (`xai_executor_request.go:1112-1730`, constants `xai_executor.go:20-65`):

- **Max 200 tools** (`xaiMaxTools`). If the flattened count (namespace children counted individually, `additional_tools` input items counted, +1 if x_search will be injected) exceeds 200 ⇒ "fold": each `namespace` tool becomes **one dispatcher function** named `<namespace>` with description = namespace description + catalog (`- name: desc\n  Parameters: <inlined schema>`) and parameters `{type:object, properties:{name:{type:string, enum:[children…], description:"Child tool name to execute in namespace X"}, arguments:{type:object, additionalProperties:true, description:"Arguments object matching…"}}, required:["name"]}`. Responses are un-folded by `xaiNamespaceRestorer` (unwrap `arguments.name`/`arguments.arguments` back to namespaced call). `clampXAIToolsLimit` then keeps dispatchers first, then regular tools, up to 200, and prunes orphaned `tool_choice`.
- Not folded: namespace children are flattened, function names qualified `"<ns>__<name>"` (unless name starts with `mcp__` or already has prefix; prefix gets `__` appended if missing).
- Per tool: drop `type:"tool_search"`; drop `image_generation` unless model supports it (**native image_generation only for `grok-X.Y` ≥ 4.6; `grok-4.20*` excluded**; model name lowercased, last `/` segment) — when kept, forced tool choice rewritten to `"required"` and tools reduced to that hosted tool; `custom` ⇒ `function`; `web_search` loses `external_web_access`; function without `parameters` gets `{"type":"object","properties":{}}`; local `$ref`s inlined and `$defs`/`definitions` removed; root unions (`oneOf/anyOf`) get `type:"object"` per branch; schemas needing simplification (Codex Desktop `codex_app.automation_update`, root unions with non-object branches) replaced by `{"type":"object","properties":{},"additionalProperties":true}` and `strict:false` (that schema otherwise makes xAI accept the request but never emit SSE).
- `input[].type=="additional_tools"` items are hoisted into top-level `tools` (xAI rejects them).
- Client function named `web_search` is aliased to `clientfn_web_search` (unique if collision) outbound and restored on responses, so it does not collide with the hosted `web_search`.
- `tool_choice`/`parallel_tool_calls` deleted when no tools remain. Orphaned `tool_choice` (pointing at removed tool, incl. `allowed_tools`) pruned.
- **x_search injection**: if `cfg.xai.inject-x-search` and not already declared and tool_choice isn't forced to a single hosted tool, append `{"type":"x_search"}` to `tools` (and to `tool_choice.tools` for `allowed_tools`). When x_search is present, the response filter hides server-side X-Search traces: output items of type `function_call`/`custom_tool_call` named `x_user_search|x_semantic_search|x_keyword_search|x_thread_fetch` (no namespace), or any with `call_id` prefix `xs_call`, unless the client declared a same-name tool of matching kind (`xai_executor_response.go:104-279`). Dropped output indexes are compacted in later events.

### 1.7 Reasoning / encrypted_content handling

- **Event normalization** (`xai_executor_response.go:863-1028`): xAI emits `response.reasoning_text.delta|done` and `content_part.added|done` with `part.type=="reasoning_text"`; rewrite to `response.reasoning_summary_text.delta`, `response.reasoning_summary_part.done|added` with `part.type:"summary_text"` (for `.done`: move `text`→`part.text`, delete `text`), normalize `summary_index`, and rewrite reasoning output items in `item`/`response.output`. SSE `event:` lines renamed likewise.
- **Inbound sanitation** `sanitizeXAIInputEncryptedContent` (`:680-760`): for `input` items of type `reasoning`/`compaction` with `encrypted_content`: validate with `InspectGrokEncryptedContent`; invalid ⇒ **drop the whole `compaction` item; for `reasoning`, delete only `encrypted_content`**; then merge adjacent reasoning summaries. Validation (`internal/signature/grok_validation.go:45-110`): non-empty; ≤ 8 MiB; no leading/trailing whitespace; no `=` padding; only unpadded standard-base64 alphabet; no known other-provider cache prefix; reject Claude (strict thinking signature / CAIS), Gemini thoughtSignature, GPT `gAAAA…`, Kimi signature-length blobs; decoded length ≥ 32 bytes; Shannon entropy ratio ≥ 0.85.
- **Replay cache** (`xai_reasoning_replay.go`, `internal/cache/xai_reasoning_replay_cache.go`): for Claude and OpenAI-Responses sources (stateless clients). On `response.completed` store the final output items of type `reasoning|message|function_call|custom_tool_call`, keyed by (modelName, sessionKey); TTL **1 h**, max 10240 entries (evict batch 128). On next request, inject matching items into `input` (filtered by what the client already sent). Session key is isolated per downstream API key: `"caller:" + hex(sha256(apiKey)[:8]) + ":" + sessionKey` (execution-scoped keys `execution:*` kept as is; no API key ⇒ replay disabled). Not stored on `response.incomplete`; cleared if a completed turn has no replayable state; cleared after successful compaction. Skipped for downstream-websocket requests that carry `previous_response_id`. **CFW: KV (TTL 3600) or DO storage.**

### 1.8 Streaming / non-streaming `/responses`

- **Streaming** (`xai_executor_stream.go`): `Accept: text/event-stream`; line-scan SSE (buffer cap 50 MiB). `event:` lines buffered and paired with the following `data:` line (event name re-derived from normalized `type`). Per data line: reasoning-summary normalization → namespace restore → web_search alias restore → x_search filter → apply_patch bridge → `response.output_item.done` items collected by `output_index`; on `response.completed|incomplete` patch empty `response.output` from collected items (`xaiPatchCompletedOutput`, sorted by index then fallbacks), `EnsureResponsesUsageDetails`, cache replay (completed only) → translate to client format (OpenAI chat chunk / Claude / Gemini / Responses). Usage from `response.completed|incomplete` (`ParseCodexUsage`).
- **Non-stream `Execute`** (`xai_executor_execute.go:~15-100`): **still sends `stream:true` upstream** (`prepareResponsesRequest(...,true)`), reads the whole SSE body, finds first `response.completed|incomplete`, patches output, translates non-stream. If neither: error `statusErr{408, "xai stream error: stream disconnected before response.completed or response.incomplete"}`.
- Upstream `2xx` required; otherwise `xaiStatusErr(code, body)` (1.9).

### 1.9 Error classification (`xai_executor_response.go:1086-1144`)

| Condition | Result |
|---|---|
| 403 and body is "bad credentials" (`code`/`error.code`/`body.error.code` contains `bad-credentials`, or `error`/`error.message`/`message`/`body.error[.message]` contains `access token could not be validated`, or raw body lowercased contains either) | code rewritten to **401** (triggers OAuth refresh+retry) |
| 429 where `code` contains `free-usage-exhausted`, or `error`/raw body contains `free-usage-exhausted` or `included free usage` | `retryAfter = 24h` |
| other 429 | no `retryAfter` (conductor backoff) |
| everything else | `statusErr{code, msg=body}` |
| Stream truncated | 408 as above |
| apply_patch bridge/translation failure | 502 `helps.ApplyPatchUpstreamErrorMessage` |

### 1.10 Compaction (`POST {compactBase}/responses/compact`)

`xai_executor_execute.go:~100-330`. `opts.Alt=="responses/compact"` ⇒ non-stream compact; streaming compact ⇒ 400 `"streaming not supported for /responses/compact"`. A *streaming* request whose `input` contains an item with `type:"compaction_trigger"` is executed via compact and **re-emitted as a synthetic SSE** (`response.created`, `response.in_progress`, output item added/done, `response.completed`) (`xaiBuildCompactionTriggerStreamChunks`, `xaiBuildSSEFrame`: `event: <name>\ndata: <json>\n\n`).
Compact body = prepared Responses body (`to=openai-response`) with `stream`, `tools`, `max_output_tokens`, `temperature`, `top_p`, `top_k`, `stop` deleted, `compaction_trigger` items removed, `previous_response_id` re-added if the client sent one; tool_choice/parallel_tool_calls dropped. Headers: `applyXAIHeaders` (no CLI identity). Response ids: `resp_<id>` (strip `cmp_`), compaction item id `cmp_<suffix>`; fallback `resp_xai_compaction_<unixnano>`. After success, reasoning replay cache for the scope is deleted.

### 1.11 Images / videos / speech (special endpoints)

Routing is by inbound handler type (`opts.SourceFormat`): `openai-image`, `openai-video`, `openai-speech` (`xai_executor.go:21-23`). All are non-streaming: whole body read, returned verbatim with upstream headers; usage published via `EnsurePublished`.

| Feature | Upstream | Base | Notes |
|---|---|---|---|
| Image generations | `POST {chatBase}/images/generations` | `xaiChatBaseURL` (so OAuth ⇒ cli-chat-proxy) | Chosen when inbound `request_path` ends `/images/generations` (default). |
| Image edits | `POST {chatBase}/images/edits` | same | Inbound path suffix `/images/edits`. |
| Video generate | `POST {chatBase}/videos/generations` | same | suffix `/videos/generations` (also default for POST). |
| Video edit | `POST {chatBase}/videos/edits` | same | suffix `/videos/edits`. |
| Video extend | `POST {chatBase}/videos/extensions` | same | suffix `/videos/extensions`. |
| Video poll | `GET {chatBase}/videos/{url.PathEscape(request_id)}` | same | When none of the above suffixes match and payload has `request_id`; no body. |
| TTS | `POST {compactBase}/tts` | **official API only** (never cli-chat-proxy) | Raw audio returned; `Accept: */*`. `ExecuteStream` ⇒ 400 `"streaming not supported for /audio/speech"`. |

Image/video payload shaping (`normalizeXAIImageRefs`, `xai_executor_request.go:428-503`): walk the whole JSON; for keys `image` (object), `images[]`, `reference_images[]`: objects get `url` = first non-empty of `url`, `image_url` (string) or `image_url.url`; `image_url` key deleted. Chat content parts `{"type":"image_url","image_url":{…}}` are not touched (only keys named exactly `image|images|reference_images`). Then payload rules (provider id `xai`, protocol `openai`). Model = `payload.model` or `req.Model`. Video POST adds `x-idempotency-key` from `opts.Metadata["idempotency_key"]` or inbound `x-idempotency-key` header.

Speech error handling (`xai_executor_speech.go`): wrap result as `xaiSpeechRequestError` (`IsRequestScoped()==true` ⇒ no retry on other credentials, no cooldown) **only when** status is 404 and body does *not* indicate model unavailability (case-insensitive substrings in `code, error.code, type, error.type, error, error.message, message, detail` or raw body if not JSON: `model_not_found`, `model_not_supported`, `model is not supported`, `model is unsupported`, `model not supported`, `unsupported model`, `model is not available`, `model not available`, `model is unavailable`, `model unavailable`, `not available for your plan`, `not available for your account`). 400/422 stay plain (conductor already treats them as request faults). Other codes use `xaiStatusErr`.

### 1.12 Responses WebSocket transport (`xai_websockets_executor.go`)

When used: `XAIAutoExecutor` (`:1770-1886`) routes `ExecuteStream` to the WS executor **only if** the *downstream* client is a websocket (`DownstreamWebsocket(ctx)`) **and** auth has `Attributes["websockets"]` (or `Metadata["websockets"]`) = true; otherwise HTTP. `Execute`, `Refresh`, `CountTokens`, `HttpRequest` always HTTP. If the conductor requires an upstream websocket that doesn't exist ⇒ `NewUpstreamWebsocketReplayRequiredError` (tell caller to replay with full input).

- URL: `{base_url or https://api.x.ai/v1}/responses` with scheme `http→ws`, `https→wss`.
- Handshake headers (`applyXAIWebsocketHeaders`, `:1596-1620`): `Content-Type: application/json`, `Authorization: Bearer <token>`, `x-grok-conv-id: <sessionID>`, plus custom attribute headers. **No** CLI identity headers. Handshake timeout 30 s (`codexResponsesWebsocketHandshakeTO`, `codex_websockets_connection.go:28`); idle timeout constant 5 min (`:27`); permessage-deflate negotiated but write-compression disabled.
- Request frame (`buildXAIWebsocketRequestBody`, `:1556-1572`): the prepared Responses body with `type:"response.create"`, `stream`/`stream_options`/`background` deleted, **`store:true`**, `instructions` deleted when `previous_response_id` present; payload rules applied; `type` re-forced to `response.create` afterwards. Client-sent `type:"response.append"` is supported (id-mapper below).
- Events are JSON text frames, same event schema as SSE `data:`; binary frame ⇒ error; terminal events: `response.completed`, `response.done`, `error` (and `response.incomplete`/`response.failed` when apply_patch bridge active). Per-event pipeline identical to HTTP stream (reasoning normalize, namespace restore, x_search filter, apply_patch bridge, completed-output patch, replay-cache write). If downstream is WS: forward JSON events (with `EnsureResponsesUsageDetails` and ID rewriting); else wrap as SSE and translate.
- **Warm-up requests** (`generate:false`): upstream replies `response.created`; the proxy synthesizes a `response.completed` with empty output and zero usage (`buildXAIWebsocketWarmupCompletedPayload`, `sequence_number+1`) and ends the turn.
- **Upstream error frames** (`parseXAIWebsocketError`, `:1094-1142`): Codex-style `{"type":"error","status":N,…}` or bare `{"error":{…}}`; status from `status`/`status_code`/`error.code`/`error.status`/`code`; fallback 400 if message contains `"code":"400"` or `Request validation error`, else 500. Passed through `xaiStatusErr` (403 bad-credentials→401, free-usage 24h cooldown). Upstream conn is invalidated on error.
- Handshake rejection: HTTP status from the failed upgrade response ⇒ `xaiStatusErr(status, body)`.
- **Session & ID state** (`xaiWebsocketIDState`, `:45-345`): per session id: `downstreamToUpstream` map; transcript of all request inputs+outputs; flag `replayCompactedTranscriptOnReset`. When the upstream connection/auth target changes (auth id, wsURL, proxy) the upstream `previous_response_id` is dropped and the full transcript is prepended to `input` ("replay"). Downstream response ids that would repeat an upstream id are suffixed `-xai-<seq>`. `response.append` with no previous id after compaction prepends the compacted transcript.
- **Compaction over WS**: `compaction_trigger` in input is executed over HTTP `/responses/compact` using the stored transcript (`buildXAIWebsocketCompactionPayload`: `input = transcript`, delete `previous_response_id`), the returned first `output` item must be `type:"compaction"` with non-empty `encrypted_content` (else 502 `"xai websocket compaction response is missing compacted state"`); transcript replaced by that single item; mapped id → `""`; result streamed as synthetic SSE.
- Connection lifecycle: reader goroutine per upstream conn; ping handler replies pong immediately; connections closed on auth change/refresh (`CloseXAIWebsocketSessionsForAuthID`), execution-session close, read/send errors (one transparent redial+resend on send error when allowed).
- **CFW**: Workers can open outbound WS (`fetch` with `Upgrade: websocket` and arbitrary headers incl. `Authorization`; read `resp.webSocket`, call `.accept()`). Put each execution session (conn + ID map + transcript) in a Durable Object; use hibernation-compatible handlers; implement ping/idle handling manually (no gorilla); permessage-deflate is handled by the runtime. Transcript can be large — persist in DO storage. A downstream WS endpoint is also a DO (WebSocketPair).

### 1.13 Misc

- `HttpRequest`/`PrepareRequest` (used by the generic "api call" tooling): set `Authorization: Bearer <token>` (or delete) then custom headers (`xai_executor.go:99-131`).
- `SupportsApplyPatch() == true`.

---

## 3. Kimi (Moonshot "Kimi Code")

Files: `kimi_executor.go`, `kimi_thinking_replay.go`, `helps/kimi_responses.go`, `internal/auth/kimi/{kimi,token}.go`, `sdk/auth/kimi.go`.

### 3.1 Domains and base URLs

Two variants, selected per auth (`internal/auth/kimi/kimi.go:26-215`):

| | `kimi.com` (provider `kimi`) | `kimi.ai` (provider `kimi-ai`, alias `kimi.ai`) |
|---|---|---|
| OAuth host | `https://auth.kimi.com` | `https://auth.kimi.ai` |
| API base | `https://api.kimi.com/coding` | `https://api.kimi.ai/coding` |
| file prefix | `kimi-<unixmillis>.json` | `kimi-ai-<unixmillis>.json` |

Domain resolution order (`ResolveKimiDomainFromAuth`): `Attributes.domain` → `Attributes.base_url` host → `Metadata.domain` → `Metadata.base_url` → `Metadata.type` → storage domain/base_url/type → `auth.Provider` → file name contains `kimi-ai`/`kimi.ai` ⇒ ai; default `.com`. "ai" domain tokens: `kimi.ai|ai|kimi-ai|*.kimi.ai`; "com": `kimi.com|com|kimi|*.kimi.com`.

API base for requests (`helps/kimi_responses.go:15-56`): `Attributes.base_url` → `Metadata.base_url` (trim trailing `/`) → `.ai` default or `.com` default. Derived: chat = base + (`/chat/completions` if base ends `/v1` else `/v1/chat/completions`); responses = same pattern with `/responses`; Claude-messages base = base with trailing `/v1` trimmed.

### 3.2 Login: OAuth2 Device Authorization Grant (RFC 8628)

`kimi.go:289-575`; `sdk/auth/kimi.go:~54-166`.

- public `client_id = 17e5f671-d194-4dfb-9706-5516cb48c098` (`kimiClientID`, `kimi.go:28`).
- `POST {oauthHost}/api/oauth/device_authorization`, form `client_id`. `POST {oauthHost}/api/oauth/token` for polling/refresh. Headers on all three: `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, plus **device headers**:
  `X-Msh-Platform: CLIProxyAPI`, `X-Msh-Version: <build version>`, `X-Msh-Device-Name: <hostname>`, `X-Msh-Device-Model: "macOS arm64"|"Windows amd64"|"Linux amd64"|"<goos> <goarch>"`, `X-Msh-Device-Id: <uuid v4 per login>` (`commonHeaders`, `:400-409`).
- Device response: `device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval`.
- Poll: form `client_id, device_code, grant_type=urn:ietf:params:oauth:grant-type:device_code`. **Kimi returns HTTP 200 for pending too**; look at `error`: `authorization_pending` ⇒ continue; `slow_down` ⇒ continue (interval **not** actually increased — fixed ticker); `expired_token`; `access_denied`; other ⇒ fail. Interval = max(`interval`,5 s); deadline min(15 min, `expires_in`); `time.Ticker` (first poll after one interval). Success fields: `access_token, refresh_token, token_type, expires_in (float), scope` ⇒ `expires_at = now + expires_in`.
- Persist (`token.go`): `{access_token, refresh_token, token_type, scope, device_id, expired (RFC3339), type: "kimi"|"kimi-ai", domain, base_url}`; metadata additionally `timestamp` (ms). Attributes `base_url`, `domain`. Label `"Kimi User"`/`"Kimi.ai User"`.
- The login-time `device_id` is stored and **must be reused** for chat requests (`X-Msh-Device-Id`) and refresh.

### 3.3 Token refresh

- `RefreshLead` 5 min (`sdk/auth/kimi.go:17`); `IsExpired` = expiry within 300 s; `NeedsRefresh` requires a refresh token.
- `Refresh` (`kimi_executor.go:1044-1118`): needs `Metadata.refresh_token`. `POST {oauthHost}/api/oauth/token` form `client_id, grant_type=refresh_token, refresh_token` (+ same X-Msh headers using stored `device_id`). 401/403 ⇒ `"kimi: refresh token rejected (status N)"`; non-200 ⇒ error with body; needs `access_token`. Singleflight key = `tokenURL + ":" + refreshToken`. Writes `access_token`, `refresh_token` (if returned), `expired`, defaults `type`, `domain`, `base_url`, `last_refresh`.

### 3.4 Request routing by inbound format (`kimi_executor.go:55-62, 99-411`)

| Inbound format | Upstream | Path |
|---|---|---|
| OpenAI chat (default) | OpenAI-compatible Chat Completions | `{base}/v1/chat/completions` |
| OpenAI Responses | Responses API (passthrough with fixes) | `{base}/v1/responses` (`/responses/compact` ⇒ 501 non-stream, 400 stream) |
| Claude | **Anthropic Messages** via embedded `ClaudeExecutor` with `base_url` rewritten to Claude base (`…/coding`) ⇒ `…/coding/v1/messages?beta=true`; Bearer auth (non-Anthropic host ⇒ `Authorization: Bearer`, not `x-api-key`); `Accept: text/event-stream` + `Accept-Encoding: identity` when streaming; default Claude-Code attribution system block is stripped (`stripDefaultKimiClaudeCodeAttribution`) | `claude_executor_execute.go:34,238`, `claude_signing.go:158-178` |
| `CountTokens` | Anthropic `count_tokens` via Claude executor with Claude base | `kimi_executor.go:756-772` |

Headers (OpenAI/Responses paths) `applyKimiHeaders` (`:1121-1136`): `Content-Type: application/json`; `Authorization: Bearer <token>`; `User-Agent: CLIProxyAPI/<version>`; `X-Msh-Platform: CLIProxyAPI`; `X-Msh-Version: <version>`; `X-Msh-Device-Name`; `X-Msh-Device-Model: "<goos> <goarch>"`; `X-Msh-Device-Id` (auth `Metadata.device_id` → storage `device_id` → local kimi-cli file `~/.local/share/kimi/device_id` (macOS `~/Library/Application Support/kimi/device_id`, Windows `%APPDATA%/kimi/device_id`) → `"cli-proxy-api-device"`); `Accept: text/event-stream` or `application/json`; then custom attribute headers. **CFW: no hostname/filesystem ⇒ use constants or stored per-credential values; keep `device_id` from login.**

Token: `Metadata.access_token` → `Attributes.access_token` → `Attributes.api_key` (`kimiCreds`, `:1227-1247`).

### 3.5 Chat-completions path shaping

1. Translate inbound → OpenAI chat (`to="openai"`), thinking config applied with provider `kimi`.
2. Model: `normalizeKimiUpstreamModel` (`:1264-1287`): trim; split `(...)` thinking suffix (kept and re-appended); lowercase; strip trailing `[1m]`; aliases `kimi-k2.8|k2.8|kimi-k2.8-code|k2.8-code|kimi-k2.8-preview|k2.8-preview|kimi-k2.7-code|k2.7-code|kimi-for-coding|for-coding` ⇒ **`kimi-for-coding`**; `kimi-k2.7-code-highspeed|k2.7-code-highspeed|kimi-for-coding-highspeed|for-coding-highspeed` ⇒ **`kimi-for-coding-highspeed`**; else strip leading `kimi-` (e.g. `kimi-k3` ⇒ `k3`).
3. Streaming: `stream_options.include_usage = true`.
4. `normalizeKimiToolMessageLinks` (`:774-1040`): drop assistant messages with no content, no tool calls/function_call and no reasoning; for `tool` messages with missing `tool_call_id` copy from `call_id`, else infer when exactly one pending assistant tool call is unmatched (warn if ambiguous); for assistant messages with `tool_calls` lacking usable `reasoning_content` set it to last usable reasoning seen, else the message's own text content, else the literal `"[reasoning unavailable]"`.
5. `normalizeKimiTools`: for `tools[].function.parameters` (or `.parameters`) and legacy `functions[].parameters`: inline local `$ref`s, delete `$defs`/`definitions`, add `type:"object"` if absent.
6. `normalizeKimiTemperature`: if `temperature` present: with `thinking.type=="disabled"` keep only `0.6`, else only `1.0`; any other value ⇒ delete field (upstream 400s otherwise).
7. Payload rules last.
8. Response: non-stream parse with `ParseOpenAIUsage`; stream = standard OpenAI SSE chunks translated to the client format.
- Responses path (`:413-755`): body kept as Responses, `model` normalized, `stream` forced, thinking applied (format `codex`), apply_patch normalization, `helps.NormalizeKimiResponsesInput` (when parallel `function_call`/`custom_tool_call` items are emitted, Kimi requires all matching `*_output` items to follow contiguously; intervening non-tool items are deferred until the batch's outputs are emitted), tool schema normalization, temperature normalization.

### 3.6 Thinking replay for Claude-format (`kimi_thinking_replay.go`, `internal/cache/kimi_thinking_replay_cache.go`)

Kimi returns signed `thinking` blocks together with `tool_use`; Claude Code clients drop them. Cache last assistant `content` array when it has a `thinking` block with non-empty `signature` **and** a `tool_use` with `id` (`kimiThinkingReplayContentIsReplayable`); key = (modelFamily, sessionKey) with family `k3` for `k3|k3-256k`, else normalized model; session key isolated by downstream API key like xAI; **TTL 1 h**. On next request, find the latest assistant message without thinking whose non-thinking parts are canonical-JSON-equal to the cached ones and replace its `content` with the cached content. After a 400/422 from upstream that used a replay, delete the entry. Compare-and-swap semantics (`ReplaceKimiThinkingReplayIfUnchanged`). Stream is wrapped to accumulate text/thinking/signature/tool input blocks and store at end. **CFW: KV w/ TTL 3600 + optimistic version token; DO if CAS needed.**

### 3.7 Errors

All upstream non-2xx ⇒ `statusErr{code, msg=body}` (no special mapping) for the OpenAI/Responses paths; Claude path uses Claude executor error handling.

---

## 4. Devin (Cognition / Codeium "chisel")

Files: `devin_executor.go`, `helps/{devin_wire,devin_models,devin_payload,devin_user_turn}.go`, `helps/proxy_helpers.go:63-130`, `internal/auth/devin/*`, `sdk/auth/devin.go`, `cmd/fetch_devin_models/main.go`.

Devin is **not** an HTTP/JSON API: it speaks **Connect-RPC with protobuf** to `server.codeium.com`, emulating the native `devin-cli` ("chisel" client). The proxy translates inbound requests to an internal "Interactions" format (`sdktranslator.FormatInteractions`; Gemini-Interactions-like), then hand-encodes protobuf.

### 4.1 Credentials

Session token (non-expiring): format `devin-session-token$<jwt eyJ…>`; `FormatSessionToken` prepends the prefix if the raw token starts with `eyJ` (`devin_auth.go:186-195`). Stored in both `Attributes` and `Metadata`: `api_key`, `session_token`, `user_name`, `user_id`, `org_id`, `auth_kind:"oauth"`, `email`, `plan`; attribute `base_url = https://server.codeium.com`; optional `device_seed`. `devinAuthCredentials` (`devin_executor.go:2530-2567`): apiKey = `Attributes.api_key` → `.session_token` → `.token` → `Metadata.api_key` → `.session_token`; baseURL default `https://server.codeium.com` overridden by attrs/metadata; `device_seed` from attrs/metadata (used to derive a stable device fingerprint; empty ⇒ **random fingerprint per request**).

`Authenticator.RefreshLead() == nil` (permanent token). `Refresh` is only a **quota/profile refresh**: calls `GetUserStatus` (4.3) and updates `email,user_name,user_id,team_id,plan,org_id,org_name` and `Quota.Signals` (`plan`, `daily_quota_remaining_percent` "N%", `weekly_quota_remaining_percent`, `*_reset_at`, `plan_start`, `plan_end` RFC3339), `Quota.ObservedAt`, `LastRefreshedAt` (`:143-228`). **CFW: Cron Trigger per credential for quota refresh.**

### 4.2 Login: PKCE authorization-code with loopback redirect (or headless paste)

`sdk/auth/devin.go:48-304`, `internal/auth/devin/{devin_auth,pkce}.go`.

- PKCE: verifier = base64url-nopad(64 random bytes); challenge = base64url-nopad(SHA-256(verifier)); method `S256`. `state` = random.
- Authorization URL (param order matters; matches CLI): `https://app.devin.ai/auth/cli/continue?` `[redirect_uri=<enc>&][state=<enc>&]prompt=select_account&code_challenge=<enc>&code_challenge_method=S256[&cli_pkce_marker=1 only when no redirect_uri]`.
  - **Browser mode**: redirect_uri = `http://127.0.0.1:<port>/callback` (port = `--oauth-callback-port` or ephemeral); local `net/http` listener on `127.0.0.1` serving `/callback` (reads `code, state, error, error_description`; returns an HTML success/failure page; 10 s read/write timeouts); wait ≤ **5 min**; check `state` equality (CSRF). After 5 s with an interactive prompt available, also asks user to paste callback URL/code/token.
  - **Headless / `--no-browser`**: no redirect_uri, adds `cli_pkce_marker=1`; user pastes an authorization **code**, a full callback URL, or a ready session token. `parseDevinManualPaste` (`:~285-304`): strips quotes; starts with `devin-session-token$` or `eyJ` ⇒ raw token; parseable callback URL ⇒ code (+ state must match if present); a bare token-like string without ` \t\r\n/?#=` ⇒ treated as code.
- Token exchange: `POST https://api.devin.ai/auth/cli/token` JSON `{"code":"…","code_verifier":"…"}` (`Content-Type/Accept: application/json`) ⇒ `{"token":"…"}` (1 MiB cap). → `FormatSessionToken`.
- Profile enrichment (best-effort): `GET https://api.devin.ai/v3/self` with `Authorization: Bearer <sessionToken>` ⇒ `user_name, user_id, org_id`; and Connect `GetUserStatus` (4.3) ⇒ email, plan, quotas.
- File name `devin-<identifier>.json` with identifier = user_name → user_id → `user-<hex(sha256(token)[:8])>`; non-`[A-Za-z0-9-_.@]` chars or length > 160 ⇒ hashed `user-<hex8>`. Label `Devin (<id>[ - <email>])`.
- **CFW**: No localhost listener. Options: (a) headless paste flow (works as-is; needs a small UI/endpoint accepting code/URL/token); (b) hosted callback route if Devin's server accepts a non-loopback `redirect_uri` (unverified — the CLI only ever uses `127.0.0.1`). Keep PKCE verifier/state in KV/DO with TTL ≈ 10 min.

### 4.3 `GetUserStatus` (Connect unary, protobuf)

`user_status.go:20-377`. `POST {serverBase}/exa.seat_management_pb.SeatManagementService/GetUserStatus`. Headers: `Authorization: Basic <token>-<token>` (the literal session token twice, no base64), `Connect-Protocol-Version: 1`, `Content-Type: application/proto`, `Accept: */*`, **`User-Agent` header present but empty** (Go idiom `Header["User-Agent"]=[""]` suppresses the default). Body = protobuf `Request{ field1 = ClientMetadata }` (below) — **no 5-byte envelope** for unary. Response protobuf parsed by hand:

```
Response.1 (bytes) UserStatus:
  3 user_name, 5 team_id, 7 email, 36 user_id,
  13 (bytes) PlanStatus:
     1 (bytes) PlanInfo: 2 plan(string), 33 (bytes){4 org_id, 8 org_name}
     2 (bytes){1: varint seconds} plan_start
     3 (bytes){1: varint seconds} plan_end
     14 varint daily_quota_remaining_percent
     15 varint weekly_quota_remaining_percent
     17 varint daily_quota_reset_at (unix s)
     18 varint weekly_quota_reset_at (unix s)
```

ClientMetadata (`BuildDevinClientMetadataBytes`, `devin_wire.go:254-285`), all strings: `1="chisel"`, `2="3000.10.21"`, `3=<sessionToken>`, `4="en"`, `5=<os name: runtime.GOOS, e.g. "linux">`, `7="3000.10.21"`, `12="chisel"`, `31=<device fingerprint>`. **Device fingerprint** = exactly 732 hex chars: empty seed ⇒ 366 random bytes hex; else concat `hex(sha256("<seed>-<counter>"))` for counter 0,1,… truncated to 732 (`devin_wire.go:128-148`; for `GetUserStatus` with empty seed it is derived from the token: `GenerateDeviceFingerprint(sessionToken)`).

### 4.4 Chat: `POST {base}/exa.api_server_pb.ApiServerService/GetChatMessage` (server-streaming Connect)

Headers (`PrepareRequest`, `devin_executor.go:97-125`): `Authorization: Basic <token>-<token>`; `Content-Type: application/connect+proto`; `Connect-Protocol-Version: 1`; `Accept: */*`; `Sentry-Trace: <32hex>-<16hex>-1` (streaming chat only, not unary calls); `User-Agent` suppressed (empty). HTTP client disables compression (`Accept-Encoding: identity`, `DisableCompression`). **CFW risk:** `fetch` always sends its own `User-Agent`; verify whether upstream tolerates it. Also Workers fetch controls `Accept-Encoding`.

**Body**: 5-byte Connect envelope `[flag=0x00][u32 BE length][protobuf]` (`WrapConnectEnvelope`).

`GetChatMessageRequest` protobuf (`BuildDevinGetChatMessageRequest`, `devin_wire.go:288-520`):

| Field | Wire | Content |
|---|---|---|
| 1 | bytes | ClientMetadata (above) |
| 2 | string | system prompt (sanitized, omitted if empty) |
| 3 (repeated) | bytes | Prompt: `1` id (uuid if empty), `2` source varint (1=user, 2=assistant, 4=tool; default 1), `3` content string, `6` repeated ToolCall{`1` id,`2` name,`3` arguments JSON string}, `7` tool_call_id, `10` repeated Image{`1` base64 data,`2` mime (default `image/png`)}, `11` thinking text, `12` signature **bytes**, `18` signature_type string |
| 7 | varint | constant `5` |
| 8 | bytes | completion config: `1`=1, `2`=max_tokens (default 128000; clamped to model `MaxCompletionTokens`), `3`=400, `5` fixed64 temperature (default 1.0), `7`=40 (top_k), `8` fixed64 `float64(float32(0.95))` (top_p) |
| 10 (repeated) | bytes | Tool: `1` name, `2` description, `3` parameters (JSON schema bytes) — skips empty names and Codex `automation_update`; rewrites "Takes a task_id parameter identifying the task"→"taskId"; `SanitizeDevinToolDescription` |
| 15 | bytes | thread meta: `1` session uuid, `2` turn index varint (per-session counter, omitted when 0; process-local LRU 5000 sessions), `3`=4, `4`=14 (only when last prompt is a user turn and (turn==0 or previous prompt not user)) |
| 16 | string | cascade id (= session id when not supplied) — prompt-cache key |
| 20 | varint | constant 1 |
| 21 | string | `chat_model_uid` |

Session/cascade ids: from interactions `session_id|sessionId|conversation_id|previous_interaction_id` → context session → canonical session id from headers/metadata; non-UUID strings are mapped to **UUIDv5(NameSpaceOID, string)**; empty ⇒ random uuid4 (`resolveDevinSessionAndCascadeIDs`, `:2587-2615`). **The per-session turn counter is stateful ⇒ DO/KV on CFW.**

**Inbound mapping** (`parseInteractionsPayload`, `:1510-1850`): `system_instruction|systemInstruction` → field 2; `generation_config{temperature,max_output_tokens,thinking_level,thinking_config.thinking_budget}`; `input[]` steps `user_input` (text+images; data-URL images → base64; remote URIs/audio/video/docs are dropped and, if a user turn would be empty, rejected via `CheckDevinUserTurns` with an "unsupported content part" error), `model_output` (assistant, with `signature`/`thought_signature`), `thought` (attached to preceding assistant prompt as thinking+signature), `function_call` (assistant ToolCall), `function_result` (source 4 with `tool_call_id`; orphaned results downgraded to user text). Empty tool result placeholder `"{}"`. Thought signatures are reconstructed from the original request (`supplementSignaturesFromOriginal`, `detectSignatureType`).
System-prompt sanitation (`SanitizeDevinSystemPrompt`): drop lines that are Claude-Code attribution, start with `You are Claude Code`, contain `authorized security testing`, `destructive techniques, DoS attacks`, `Claude Code is available as a CLI`, `Fast mode for Claude Code`, `Codex refers to the open-source agentic coding interface`, or the ANSI-escape guideline sentence, or match a configured sensitive word; then zero-width-space (`U+200B`) obfuscate remaining sensitive words (`cfg.devin.sensitive-words`, regex `(?i)` longest-first, words ≥ 2 runes).

**Model UID resolution** (`helps.ResolveDevinChatModelUID`, `devin_models.go:94-250`): strip `devin/`; if already ends with a known effort suffix (`-none,-low,-medium,-high,-xhigh,-max,-fast,-slow,-priority,-*-priority,-*-fast,-thinking(-1m),-max-1m,-none-1m,_none…_max,_thinking`) use as-is; else parse effort from `(suffix)`/`:suffix`/`thinking_level`/budget (≤4096 low, ≤16384 medium, ≤32768 high, else max; `auto|adaptive`→high; `off|disabled`→none); special aliases `claude-haiku-4-5→MODEL_PRIVATE_11`, `gpt-4-1→MODEL_CHAT_GPT_4_1_2025_04_14`, `sonnet-4-5→MODEL_PRIVATE_3` (thinking) / `MODEL_PRIVATE_2`, `gemini-3-flash→gemini-3-8-flash`, `MODEL_GPT_5_2_<LEVEL>`, `MODEL_GOOGLE_GEMINI_3_0_FLASH_<LEVEL>`, `MODEL_CLAUDE_4_5_OPUS[_THINKING]`, `swe-1-7[-medium]`, `swe-1-6[-fast]`, `glm-5-2[-none|-max][-1m]`, `claude-(opus|sonnet)-4-6[-thinking][-1m]`; otherwise look up catalog (`devin_models.json`; model `Thinking.Levels`) and append `-<clamped effort>`; models without levels stay bare; default effort rules (`swe-2`→high; gpt-5.x with none+low→low; gemini/grok/glm/deepseek/kimi/nemotron→high; else medium/high/low/first). Clamp picks nearest standard level (`minimal<low<medium<high<xhigh<max`), ties go higher. Empty model ⇒ `swe-2-high`. The catalog is generated offline by `cmd/fetch_devin_models` (`POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs`, `application/proto` body = Request{1=ClientMetadata}, Basic auth as above) and embedded; port it as static JSON, refreshed by cron if desired.

**Payload rules** operate on the *protobuf business fields* via a JSON view (`helps/devin_payload.go` field-name map: `system_prompt, prompts[{id,source,content,tool_calls,tool_call_id,images,thinking,signature(binary),signature_type}], completion_config{enabled,max_tokens,parameter_3,temperature,top_k,top_p}, tools[{name,description,parameters(json)}], cascade_id, model`), applied after all built-in shaping and before framing (provider `devin`, protocol `devin`).

**Response stream** = sequence of Connect frames `[flag][u32 BE len][payload]`: flag bit 0x01 = gzip-compressed payload (limit decompressed 64 MiB), bit 0x02 = **end-stream trailer** (JSON). Max frame length 16 MiB. Invalid flag ⇒ error. (`ReadConnectFrame`, `devin_wire.go:207-250`.) **CFW**: use `DecompressionStream("gzip")`; implement a streaming 5-byte-header frame reader over `response.body`.

Frame payload protobuf (`ParseDevinFrame`, `:524-620`):

| Field | Wire | Meaning |
|---|---|---|
| 1 | string | output id |
| 2 | varint or bytes{1:varint} | timestamp (seconds) |
| 3 | string | text delta (concatenated per frame; UTF-8 split buffer across frames) |
| 4 | varint | delta tokens |
| 5 | varint | stop reason (`1`=INCOMPLETE,`3`=MAX_TOKENS→finish "length"; `11`=CONTENT_FILTER→"content_filter"; `2/4`=stop; `10`=tool_calls) |
| 6 | bytes | tool-call delta {`1` id,`2` name,`3` arguments (string chunk),`4` invalid_json_str,`5` invalid_json_err,`6` varint is_custom_tool_call} |
| 7 | bytes | usage: `2` prompt (uncached input) varint, `3` output, `4` cache-write, `5` cache-read, `6` status code, `8` repeated header{1 key,2 value} (`x-request-id`/`request-id` ⇒ request id), `9` model name |
| 9 | string | thinking delta |
| 10 | bytes | thought-signature delta (concat) |
| 12 | fixed64 | latency |
| 17 | string | message id |
| 21 | string | signature type |
| 28 | bytes (repeated) | response dimension groups: fallback token usage (input/output/cached) when field 7 is missing/zero |

Usage totals: `total_input = prompt + cached`, `total_output = completion`, plus cache_write.

**Trailer** (flag 0x02): JSON `{}` (ok) or `{"error":{"code":"…","message":"…"}}` ⇒ HTTP status mapping (`ParseDevinTrailerError`, `:972-1030`): `invalid_argument`→400 (502 if message contains "internal error"); `internal`→502; `unauthenticated`→401; `permission_denied`→403 (429 if message contains "high demand"); `resource_exhausted`→429; `unavailable`→503; `canceled`→499; `deadline_exceeded`→504; `failed_precondition`→429 if message contains `quota|credit|acu|exhausted|limit` else 400; unknown→502. Error message `"devin upstream error (<code>): <message>"`.

Stream rules (`streamDevinFrames`, `:488-1146`): emits intermediate Interactions SSE events (`interaction.created`, `step.start{type: thought|model_output|function_call}`, `step.delta{thought_summary|thought_signature|text|arguments…}`, `step.stop`, `interaction.completed` with `usage{total_input_tokens,total_output_tokens,total_cached_tokens,[cache_write_tokens],total_tokens}`, `status` completed|incomplete) which are then translated to the client format; terminates with `data: [DONE]`. Notable behaviours: text after tool calls is buffered and flushed when tools close (Responses clients need tools first); thinking/tool/text ordering with deferred thought-stops so signatures can arrive late; for non-OpenAI formats text waits behind pending thought; max **128** tool calls (`maxDevinToolCalls`); failed event before any content is suppressed so a proper HTTP error status can be returned; **stream must end with EOS trailer** else error `"devin stream terminated prematurely before EOS trailer"` (code `stream_truncated`); mid-stream read error ⇒ `response.failed` code `stream_read_error`. Non-stream `Execute` consumes the same frames via `consumeDevinFramesToInteractions` and translates once.

HTTP-level errors: non-2xx ⇒ `newDevinStatusError` (`:2512-2528`): body ≤1 MiB; for **429** parses `Retry-After` (seconds or HTTP-date) into `retryAfter`.

`CountTokens`: estimate `len(payload)/4` ⇒ `{"total_tokens":N,"input_tokens":N}` (`:230-236`).

---

## 5. Meta (Muse, `api.meta.ai`)

Files: `meta_executor.go`, `meta_executor_execute.go`, `meta_executor_stream.go`, `helps/meta_tools.go`, `internal/auth/meta/meta.go`, `sdk/auth/meta.go`.

### 5.1 Login: OAuth2 Device Authorization Grant + API-key minting

- Public `ClientID = 1031625952748946` (Muse CLI), host `https://auth.meta.com`.
- `POST https://auth.meta.com/oidc/device/authorization/` form `client_id`; headers `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, **`User-Agent: muse-code/1.0.2`** (`meta.go:259-307`). Response needs `device_code` & `user_code`.
- Poll `POST https://auth.meta.com/oidc/device/token/` form `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code&client_id`, same headers; `time.Ticker` at `interval` (default 5 s); overall deadline = min(15 min, `expires_in`); network/read errors are retried; HTTP 200 ⇒ success; otherwise JSON `error`: `authorization_pending` continue, `slow_down` ⇒ interval += 5 s, `access_denied`, `expired_token`, other ⇒ fail (`:309-423`). Success token body: `access_token` (this is a **DCA token**, prefix `dca:`), `token_type`, `expires_in`.
- **Mint API key**: immediately `POST https://api.meta.ai/muse-code/key` (override via `META_MINT_URL` env) with `Authorization: Bearer <dca_token>`, `User-Agent: muse-code/1.0.2`, JSON body `{"dca_token":"<dca_token>"}` ⇒ `{api_key, base_url, user_email, user_full_name, subs_tier_name, subs_tier_id, is_subs_active, has_payment_method, require_payment, can_subscribe}` (`:425-483`). Failure at login is a warning (DCA-only credential is saved and minted lazily).
- Storage (`MetaTokenStorage`): `type:"meta", auth_kind:"oauth", access_token (= api_key when minted, else DCA token), dca_token, api_key, token_type, expires_in, expired (empty when api_key minted; DCA expiry otherwise), dca_expired, dca_expires_at, last_refresh, base_url (minted base_url or https://api.meta.ai/v1), email, name`; metadata adds `subs_tier_name, subs_tier_id, is_subs_active, has_payment_method`. File `meta-<sanitized email ≤120>-<hex(sha256(email)[:8])>.json` (or `meta-<hash(dca)>.json`, or `meta-oauth.json`). Label = email or `"Meta"`.
- Default base URL `https://api.meta.ai/v1`. `RefreshLead() == nil` — no scheduled refresh.

### 5.2 Credential resolution and lazy refresh

`metaCreds` (`meta_executor.go:298-343`): base URL = `Attributes.base_url` → `Metadata.base_url|api_base_url` → `Storage.BaseURL` → default; token = `Attributes.api_key` → `Attributes.access_token` → `Metadata.api_key` → `Metadata.access_token` → `Storage.APIKey` → `Storage.AccessToken` — **any value starting with `dca:` is never used as a bearer token**. `extractDCAToken` = `dca_token` (attrs/metadata/storage) or an `access_token` starting `dca:` (not for config API-key auths).

`Refresh` (`:87-184`) = mint: if no DCA token and a usable token exists ⇒ no-op; no token at all ⇒ 401 `"meta executor: missing API key or DCA token"`; else `MintAPIKey` (singleflight per DCA token ⇒ **DO per credential**), then set `api_key`, `access_token`, `dca_token`, `base_url`, `email`, `name`, subscription fields, `type:"meta"`, `last_refresh`, delete `expired`. `ShouldPrepareRequestAuth`: DCA token present and no API key; `PrepareRequestAuth` mints before the first request (conductor installs & persists). `ensureAuth` in `Execute/ExecuteStream/CountTokens/HttpRequest` mints on demand; on missing token: config `meta-api-key` auth ⇒ 401 `"meta executor: meta-api-key requires a valid API key (DCA tokens require OAuth storage)"`, else 401 `"meta executor: missing API key or access token"`. No periodic refresh exists; there is no refresh-token grant.

### 5.3 Requests: `POST {base}/responses` (OpenAI Responses), streaming always

- Always sends `stream:true` upstream even for non-stream clients (`Execute` uses `prepareResponsesRequest(…, true)` then aggregates); `opts.Alt=="responses/compact"` ⇒ 501 `"/responses/compact not supported"`.
- Headers (`applyMetaAPIHeaders`, `meta_executor_execute.go:277-297`): `Content-Type: application/json`; `Authorization: Bearer <api_key>`; **`User-Agent: muse-build/1.3.0 (interactive; macos-aarch64; build ac7280f2aca67769d1455a8847bb502b617d50f6)`**; **`X-Client-Id: tbh:tui`**; stream: `Accept: text/event-stream`, `Cache-Control: no-cache` (else `Accept: application/json`); then custom attribute/client headers. (`PrepareRequest` sets UA and `X-Client-Id` too.)
- Body shaping (`prepareResponsesRequest`, `:34-87`): translate inbound → `codex` (Responses) format; thinking applied; `model=baseModel`; `stream` set; delete `generate, prompt_cache_retention, safety_identifier, stream_options, client_metadata`; apply_patch normalization; `normalizeCodexInstructions`; `sanitizeOpenAIResponsesReasoningEncryptedContentKeepForeign` (keeps other providers' reasoning blobs); `SanitizeMetaWebSearchTools` (delete `search_content_types` from `web_search` tools incl. inside `namespace.tools[]`; Meta rejects it on `web_search`, only valid on `web_search_preview`); `NormalizeCodexToolIntegerTypes`; payload rules last.
- Non-stream aggregation (`translateMetaCompleted`, `:175-233`): scan SSE `data:` lines; error events; first `response.completed|incomplete` (output patched from `response.output_item.done` items via `patchCodexCompletedOutput`); fallback: if the whole body is a JSON response object (`type` completed/incomplete, or `object=="response"` or has `output`) wrap as `{"type":"response.completed","response":<body>}`; else 408 `"meta stream error: stream disconnected before response.completed or response.incomplete"`.
- Streaming (`meta_executor_stream.go`): line scanner (50 MiB buffer); non-`data:` lines pass through; `data:` events: error check, `response.output_item.done` collected, `response.completed|incomplete` output patched, usage via `ParseCodexUsage`; translated to client format.
- `CountTokens`: local `o200k_base` estimate (`countCodexInputTokens`), same response shape as xAI.

### 5.4 Error classification (`meta_executor_execute.go:299-332`, `meta_executor.go:345-385`)

| Condition | Result |
|---|---|
| any non-2xx | `statusErr{code, msg=body}` |
| 429 or 404 with `error.resets_at` (unix s) in the future | `retryAfter = resets_at − now` |
| 404 without usable `resets_at` | `retryAfter = 5 min` (`metaNotFoundCooldown`) — treated like "model/credential temporarily unavailable" |
| 429 and (`error.message` contains `subscription quota` or `quota exhausted`, or `error.code` is `rate_limit_exceeded` or contains `quota` **and** `error.resets_at` exists) | `metaRateLimitError{credentialScoped:true}` (`IsCredentialScoped()` ⇒ cool down the whole credential, not just the model) |
| SSE/JSON event `type:"error"` or `"response.failed"` | status = `error.code` if 400–599 else 502; passed through the same wrapper (stream aborted with that error) |

---

## 6. Provider-level comparison (for the TS design)

| | xAI | Kimi | Devin | Meta |
|---|---|---|---|---|
| Login | Device code (OIDC discovery) | Device code | PKCE auth-code, loopback redirect or manual paste | Device code + key mint |
| Refresh | refresh_token grant, lead 5 m | refresh_token grant, lead 5 m | none (permanent); cron quota refresh | none; lazy mint of API key from DCA token |
| Upstream proto | OpenAI Responses (SSE or WS) | OpenAI Chat / Responses / Anthropic Messages | Connect-RPC protobuf streaming | OpenAI Responses (SSE) |
| Non-stream implemented as | upstream stream + aggregate | native non-stream | stream frames + aggregate | upstream stream + aggregate |
| Special headers | CLI identity set on cli-chat-proxy | X-Msh-* device set | Basic `<tok>-<tok>`, Connect headers, empty UA | `muse-build` UA, `X-Client-Id: tbh:tui` |
| State needing storage | reasoning replay (1 h), WS transcript/ID map, client version | thinking replay (1 h), device id | per-session turn counter | none |
| Cross-credential retry hints | 24 h free-usage; 403→401 | none | `Retry-After` on 429; trailer-code→HTTP map | `resets_at`, 5 m 404 cooldown, credential-scoped quota |

## 7. Suggested Workers decomposition

- **Per-credential DO**: serialize token refresh/mint (replaces `singleflight`), hold Devin per-session turn counters, xAI WS sessions (+ID maps/transcripts), Kimi/xAI replay caches if CAS is needed.
- **KV (TTL)**: xAI reasoning replay (3600 s), Kimi thinking replay (3600 s), xAI CLI client version, device-flow state, PKCE state.
- **Cron**: xAI npm version (every 3 h), Devin `GetUserStatus` quota refresh, optional Devin model-catalog refresh.
- **Static assets/embedded JSON**: Devin model catalog (`devin_models.json`), fallback client versions.
- **Protobuf**: implement minimal varint/bytes/fixed64 writer+reader (≈150 LOC) for Devin; wire layouts above are complete for what the Go code uses (unknown fields must be skipped, not rejected).
- **Streaming**: all providers can be streamed via `fetch` + `ReadableStream`; Devin needs a binary Connect frame parser; xAI/Meta/Kimi need an SSE line parser with up to 50 MiB line buffers (tool arguments / encrypted content can be multi-MB).
- **Hash/crypto**: SHA-256 (WebCrypto) for PKCE, fingerprints, file names, cache-key isolation; UUIDv5 (SHA-1) for Devin session ids; base64url without padding.
