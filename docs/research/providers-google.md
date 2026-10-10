# Google-family providers — porting reference

Scope: `gemini` (API key, generativelanguage), `gemini-interactions`, `vertex` (service-account JWT + API-key), `aistudio` (browser WebSocket relay), `antigravity` (Google OAuth → Cloud Code `v1internal`). There is **no gemini-cli / Code Assist (`gemini-cli` OAuth) code** in this repo (grep for `geminicli|codeassist` only hits Antigravity); the `cloudcode-pa` endpoints are used solely by Antigravity.

All paths relative to repo root. "Executor dir" = `internal/runtime/executor/`. Request/response *protocol translation* (OpenAI/Claude/Responses ⇄ Gemini) lives in `internal/translator/**` and is out of scope here except where the executor post-processes. The canonical wire shape every Google executor targets is the **Gemini `generateContent` JSON** (`contents[]`, `systemInstruction`, `generationConfig`, `tools`, `toolConfig`, `safetySettings`); Antigravity additionally wraps it in an envelope.

---

## 0. Workers feasibility summary (read first)

| Item | Where | Used for | Workers verdict |
|---|---|---|---|
| Local OAuth loopback listener `:51121/oauth-callback` | `sdk/auth/antigravity.go:208-244`, mgmt `auth_files_provider_oauth.go:359+` (callback forwarder + `.oauth-antigravity-<state>.oauth` file polling in `AuthDir`, 500 ms poll, 5 min deadline) | Antigravity login | ✗ Replace with a Worker route (`/oauth/antigravity/callback`) + state stored in KV/DO. Redirect URI registered with the public client is `http://localhost:51121/oauth-callback` — Google only allows localhost for this installed-app client ID, so a hosted callback needs a **manual paste-the-URL flow** (the CLI already supports this: prompt after 15 s, parse `code`/`state`/`error` from pasted URL). Keep redirect_uri = `http://localhost:51121/oauth-callback` and have the admin UI accept the pasted final URL. |
| HTTP/1.1-only, no-ALPN, per-credential connection pools (`cloneTransportWithHTTP11`, `antigravityTransports` LRU 8192, idle 30 s, cap 210 s) | `antigravity_executor.go:120-330` | Fingerprint parity with native Antigravity client (TLS 1.3, **no ALPN extension**, HTTP/1.1, no `Connection` header) and to avoid stale GFE connections | ✗ Not controllable with `fetch()`. Workers will negotiate h2/h3 and send its own TLS ClientHello. Accept the deviation (just don't set `Connection`). Default config is already "short mode" (pooling disabled). |
| `utls` fingerprinting | not used by Google providers | — | n/a |
| `time.AfterFunc`/goroutine background loops | `misc/antigravity_version.go` (version poller every 3 h), `sdk/cliproxy/antigravity_models.go` (`runAntigravityModelRefresh` minute scan, 2-4 workers), credits-hint refresh goroutines, `rememberStopWithoutUsage` 10 min TTL map | UA version, model catalog, credits balance | Replace with Cron Triggers / DO alarms / lazy-on-read with KV TTL (details per section). |
| In-process `sync.Map`/LRU state (short cooldowns, credits balance/hint, replay ledger, refresh singleflight, interactions sessions) | various | Per-auth cooldown/credits/replay | Must move to DO storage or KV (keys documented below; the Go "Home" mode already persists these in a KV with the key names listed — reuse those names). |
| gorilla/websocket **server** at `/v1/ws` with per-session pending-request map | `internal/wsrelay/*` | AI Studio relay (browser tab executes the request) | Possible only via **Durable Object WebSocket hibernation** (one DO per channel). See §4. |
| Filesystem auth JSON files | `internal/auth/*`, vertex `SaveTokenToFile` | Credential storage | → D1/KV/R2 (schemas below). |
| `golang.org/x/oauth2/google` service-account flow | `gemini_vertex_executor.go:1256` | Vertex bearer token | Re-implement with WebCrypto RS256 (§3.2). |
| `bufio.Scanner` with 50 MiB buffer (`helps.StreamScannerBuffer = 52_428_800`) | `helps/gemini_interactions.go:21` | SSE line splitting | Use a streaming line splitter; no hard limit needed but long lines (inline base64 images) are normal. |
| `time.Sleep(2s)` polling in onboardUser | `internal/auth/antigravity/auth.go:418` | LRO polling | OK in Worker (`await scheduler.wait`/setTimeout within a request) — keep to ≤5 attempts. |

No Google provider needs raw TCP. The only "unusual" outbound call is a `HEAD` (no redirect follow) to `https://vertexaisearch.cloud.google.com/grounding-api-redirect/*` (§2.12) — `fetch(url,{method:"HEAD",redirect:"manual"})` works.

---

## 1. Gemini API-key executor (`gemini`, `gemini-interactions`)

Source: `internal/runtime/executor/gemini_executor.go` (all line refs below are this file unless noted).

### 1.1 Endpoints / auth
| Item | Value | Ref |
|---|---|---|
| Base URL | `https://generativelanguage.googleapis.com` (`glEndpoint`, :31); per-credential override `auth.Attributes["base_url"]` (trim trailing `/`) | :803 |
| API version | `v1beta` (`glAPIVersion`) | :34 |
| Non-stream | `POST {base}/v1beta/models/{baseModel}:generateContent` (`:countTokens` if `req.Metadata["action"]=="countTokens"`) ; if `opts.Alt != ""` and action≠countTokens append `?$alt={alt}` | :126-180 |
| Stream | `POST {base}/v1beta/models/{baseModel}:streamGenerateContent?alt=sse` (if `opts.Alt != ""` → `?$alt={alt}` instead) | :256-300 |
| Count tokens | `POST {base}/v1beta/models/{baseModel}:countTokens` body = translated request with `tools`, `generationConfig`, `safetySettings` removed, `model` set to base model | :689-770 |
| Interactions | `POST {base}/v1beta/interactions` (stream sets body `"stream":true`); extra header `Api-Revision: 2026-05-20` (`helps.GeminiInteractionsAPIRevision`) unless already set; client `Api-Revision` header forwarded if present | :427-640; `helps/gemini_interactions.go:19,115-132` |
| Auth | header `x-goog-api-key: <api_key>` (from `auth.Attributes["api_key"]`); `Authorization` is deleted. **No query-string key.** | :80-90, :803 |
| Content-Type | `application/json` | |
| Extra headers | `auth.Attributes` entries prefixed `header:` (config `headers:` map) + client-header passthrough via `util.ApplyCustomHeadersFromAttrs` (supports `$CPA-SESSION-ID` magic var) — `internal/util/header_helpers.go:54`, `watcher/synthesizer/helpers.go:155` | |
| User-Agent | not set by executor (Go default) | |

Model name: `thinking.ParseSuffix(req.Model).ModelName` strips the `(…)` thinking suffix; upstream always receives the base model. Credentials are synthesized from config (`gemini-api-key:` list → attrs `api_key`, `base_url`, `priority`, `weight`, `header:*`, `models_hash`; metadata `disable_cooling`, `request_retry`, …) in `internal/watcher/synthesizer/config.go:66-134`. `interactions-api-key:` list produces provider `gemini-interactions` with the same executor (`NewGeminiInteractionsExecutor`, identifier `gemini-interactions`).

### 1.2 Request shaping pipeline (non-stream, in order) — :126-215
1. translate `from → gemini` (also translate original request for payload-rule baseline).
2. `ApplyRequestThinking` (suffix / canonical thinking config → `generationConfig.thinkingConfig`).
3. `fixGeminiImageAspectRatio` (:978): only for model `gemini-2.5-flash-image-preview` with `generationConfig.imageConfig.aspectRatio` and no `inlineData` anywhere: prepend to `contents[0].parts` a text part *"Based on the following requirements, create an image within the uploaded picture. The new content *MUST* completely cover the entire area of the original picture, maintaining its exact proportions, and *NO* blank areas should appear."* + a generated white PNG `inlineData` (`util.CreateWhiteImageBase64(aspectRatio)`), set `generationConfig.responseModalities=["IMAGE","TEXT"]`; always delete `generationConfig.imageConfig`.
4. set `model` = base model (body field; harmless to API).
5. `capGeminiMaxOutputTokens` (:958): if `generationConfig.maxOutputTokens` numeric and registry model (`provider gemini`) has `OutputTokenLimit` (else `MaxCompletionTokens`) smaller → clamp.
6. `SanitizeGeminiRequestThoughtSignatures(body,"contents")` (`internal/signature/gemini_sanitize.go:33`): keep valid Gemini signatures on their parts; **only first functionCall of a model turn without a valid signature gets `"skip_thought_signature_validator"`**; strip signatures from `functionResponse` parts; foreign-provider (Claude/GPT) signatures are replaced/dropped.
7. `EnsureGeminiLeadingUserContent` (if first content role == `model`, prepend `{"role":"user","parts":[{"text":""}]}`) and, unless countTokens, `EnsureGeminiTrailingUserContent` (append the same empty user turn if last role is `model`/`assistant` and last content has no `functionResponse`). Stream uses `EnsureGeminiBoundaryUserContent` (both). `helps/gemini_content_turns.go:10-100`.
8. delete body key `session_id`.
9. user payload rules applied last (`ApplyPayloadConfigWithRequest`) — per AGENTS.md this is the final semantic barrier.

### 1.3 Response handling
- Non-2xx: error = `{code: status, msg: raw body}`; no body rewriting. Retry-after is **not** parsed for Gemini API-key (conductor uses generic handling).
- Non-stream 2xx: translate `gemini → responseFormat`; usage from `usageMetadata` (see §6.1).
- Stream: SSE (`data: {json}` lines). Per line: `FilterSSEUsageMetadata` (§2.9), `JSONPayload` (strip `data:`; ignore `event:`/`[DONE]`/non-`{`), capture usage, translate per-chunk, finally on clean EOF translate a synthetic `[DONE]` (lets translators emit final events). Scanner errors → `StreamChunk{Err}`.
- Native Interactions SSE: frames separated by blank line; payload = concatenated `data:` lines (or raw `{…}` frame); `[DONE]` detected via `GeminiInteractionsSSEDone`. If client asked for Interactions format frames are re-emitted verbatim + `\n\n`. Interactions body shaping: `SanitizeGeminiInteractionsUnsupportedInputIDs` (`function_call` needs `id`, rejects `call_id`; `function_result` needs `call_id`, rejects `id`; other steps no `id`). Antigravity-model continuation cache (`PrepareAntigravityInteractions`, `cache.NewInteractionsSessionCache`) only when model starts with `antigravity`.

### 1.4 Token counting
`POST …:countTokens` → response `{"totalTokens": N, …}`; executor reads `totalTokens` only and `sdktranslator.TranslateTokenCount` renders it for the client format (:689-770). Vertex/AI Studio identical shape.

### 1.5 Refresh / models
`Refresh` is a no-op (API key). Model list comes from static registry (`registry.GetGeminiModels`) or per-key `models:` config; no upstream probe.

---

## 2. Antigravity (Cloud Code `v1internal`)

Files: `antigravity_executor.go` (+`_auth`,`_request`,`_execute`,`_stream`,`_tokens`,`_credits`,`_reasoning_replay`), `internal/auth/antigravity/*`, `sdk/auth/antigravity.go`, `internal/misc/antigravity_version.go`, `sdk/cliproxy/antigravity_models.go`, `sdk/cliproxy/auth/antigravity_credits.go`, `sdk/cliproxy/auth/conductor_home.go:1279-1480`.

### 2.1 OAuth constants (public installed-app client; embedded in source)
| Const | Value | Ref |
|---|---|---|
| client_id | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` | `internal/auth/antigravity/constants.go:6`, `antigravity_executor.go:36` |
| client_secret | `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` (public, embedded) | same |
| Callback | port `51121`, path `/oauth-callback`, `redirect_uri = http://localhost:51121/oauth-callback` | constants.go:8 |
| Scopes (space-joined) | `https://www.googleapis.com/auth/cloud-platform`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`, `…/auth/cclog`, `…/auth/experimentsandconfigs` | constants.go:12 |
| Auth endpoint | `https://accounts.google.com/o/oauth2/v2/auth` | |
| Token endpoint | `https://oauth2.googleapis.com/token` | |
| Userinfo | `GET https://www.googleapis.com/oauth2/v2/userinfo?alt=json` (`Authorization: Bearer`, UA short) → `{"email":…}` | auth.go:235 |
| API hosts | prod `https://cloudcode-pa.googleapis.com`, daily `https://daily-cloudcode-pa.googleapis.com`, sandbox `https://daily-cloudcode-pa.sandbox.googleapis.com` (only used by the model-dump tool), API version `v1internal` | constants.go:28; executor.go:34-36 |

### 2.2 Login flow (auth URL, exchange, discovery)
1. State = random (misc.GenerateRandomState). Auth URL = `AuthEndpoint?access_type=offline&client_id=…&prompt=consent&redirect_uri=…&response_type=code&scope=<scopes space-joined>&state=…` (`BuildAuthURL`, auth.go:174).
2. Callback validated: `error` param → fail; `state` must equal; `code` required. Timeouts: overall 5 min; manual-paste prompt offered after 15 s (`sdk/auth/antigravity.go:90-144`).
3. **Token exchange**: `POST https://oauth2.googleapis.com/token`, `Content-Type: application/x-www-form-urlencoded`, body `code, client_id, client_secret, redirect_uri, grant_type=authorization_code`. Response `{access_token, refresh_token, expires_in, token_type}` (non-2xx → error with ≤8 KiB body, status preserved) (auth.go:190).
4. **Userinfo** → email (must be non-empty).
5. **Project discovery** `FetchProjectID` (auth.go:281):
   - `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`; headers `Authorization: Bearer <at>`, `Accept: */*`, `Content-Type: application/json`, `User-Agent: <short UA>`; body `{"metadata":{"ideType":"ANTIGRAVITY"}}`.
   - Project id = first non-empty of response keys `cloudaicompanionProject` | `projectId` | `project`; each may be a string or `{ "id": "…" }` (auth.go:93).
   - If empty → **onboardUser**: `tierID` = first `allowedTiers[i]` with `isDefault:true` and non-empty `id`; else `currentTier.id`; else `"free-tier"` (auth.go:114).
   - `POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser` (note: **daily host**), headers `Authorization`, `Accept: */*`, `Content-Type: application/json`, `User-Agent: <long UA>`, `X-Goog-Api-Client: gl-node/22.21.1`; body `{"tier_id":"<tier>","metadata":{"ide_type":"ANTIGRAVITY","ide_version":"<version from UA>","ide_name":"antigravity"}}`.
   - Poll up to **5 attempts**, each request with 30 s timeout, 2 s sleep between while 200 and `done != true`. When `done:true` → project from `response` object via same extractor; missing → error `no project_id in response`. Non-200 → `HTTPStatusError{status, "http N: <first 200 chars>"}` (immediately, no retry). After 5 attempts → `onboard user did not complete after 5 attempts`.
   - Empty project after both → login fails (`project ID discovery returned empty project`).
6. Stored credential (file name `antigravity-<email>.json`, auth ID = file name; `sdk/auth/antigravity.go:309`, `filename.go`):
```json
{ "type":"antigravity","access_token":"…","refresh_token":"…","expires_in":3599,
  "timestamp":<unix ms>,"expired":"<RFC3339 = now+expires_in>","email":"…","project_id":"…" }
```
   Optional metadata/attrs read at runtime: `base_url` (attrs then metadata; trims `/`), `user_agent` (attrs then metadata), `proxy_url`, `disable_cooling`, `excluded_models`.
7. Refresh lead: manager refreshes **30 min before expiry** (`AntigravityAuthenticator.RefreshLead`, sdk/auth/antigravity.go:30). Independent per-request safety window **5 min** (`antigravityRequestTokenSafetyWindow`).

### 2.3 Token refresh (`antigravity_executor_auth.go`)
- `ensureAccessToken` (:72): use `metadata.access_token` if present and `expiry > now+5min` (expiry from JWT `exp` if parseable, else `metadata.expired`/timestamp — `sdk/cliproxy/auth/types.go:621`; a `RejectedAccessToken` equal to current token forces expiry=epoch). Otherwise refresh. Refresh runs on a detached context (only the custom roundtripper is carried over).
- Refresh request (:153): `POST https://oauth2.googleapis.com/token` form `client_id, client_secret, grant_type=refresh_token, refresh_token`; headers `Content-Type: application/x-www-form-urlencoded`, `Host: oauth2.googleapis.com`, **`User-Agent: Go-http-client/2.0`** (deliberately mimicking native). Single-flight keyed by refresh token (`antigravityRefreshGroup`), shared work bounded by **30 s** (`antigravityCredentialAcquisitionTimeout`) and not cancelled by caller. → In Workers: DO-per-credential mutex.
- On non-2xx: `statusErr{code, body}`; on 429 also parse retry delay (§2.8). Missing refresh token → 401 `"missing refresh token"`.
- On success write back: `access_token`, `refresh_token` (only if returned), `expires_in`, `timestamp` (ms), `expired` (RFC3339), `type="antigravity"`; if `project_id` missing call project discovery (failure only warns); then `queueAntigravityCreditsRefresh` (§2.9).
- Pre-request hook `PrepareRequestAuth` (:41): only when `project_id` is empty — ensure token, run discovery, error `antigravity auth missing project_id: <cause>` (HTTP 400 unless cause carries a status). `projectIDForRequest` hard-fails 400 `antigravity auth missing project_id` if still empty.

### 2.4 User-Agent / client metadata (`internal/misc/antigravity_version.go`)
| Thing | Value |
|---|---|
| Fallback client version | `2.9.1` (Cloud Code **rejects newer models for clients < 2.9.0**; floor must stay ≥ 2.9.0) |
| Platform | `darwin/arm64` |
| Short UA (generate/stream/countTokens/models/loadCodeAssist/userinfo/credits) | `antigravity/hub/<version> darwin/arm64` |
| Long UA (onboardUser only) | short UA + ` google-api-nodejs-client/10.3.0` |
| Per-credential override | `attributes.user_agent`/`metadata.user_agent`; if it is an antigravity-family UA with ` google-api-nodejs-client/` suffix, the suffix is stripped for the short UA; version for onboard metadata parsed from it (`antigravity/hub/<ver>` or legacy `antigravity/<ver>`) |
| `X-Goog-Api-Client` | `gl-node/22.21.1` — sent **only on onboardUser** |
| Version source | `GET https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml` with `User-Agent: electron-builder`, `Cache-Control: no-cache`, 10 s timeout, ≤4096 B, YAML `version: x.y.z` (strict 3 numeric parts). Cache TTL 6 h; poller ticks every 3 h (TTL/2); failure keeps cached value until expiry, then falls back to `2.9.1`. → Workers: Cron every 3 h writing KV `antigravity:version`; read-through default `2.9.1`. |

Request headers for generate calls are a **whitelist** (`HttpRequest`, antigravity_executor.go:936 strips all inbound headers): `Content-Type: application/json`, `Authorization: Bearer <token>`, `User-Agent: <short UA>`, `Host` = base host, plus `header:*` attribute headers. No `Accept`, no `X-Goog-Api-Client`, no `Connection`.

### 2.5 Endpoint selection
`resolveAntigravityRequestBaseURL` (request.go:391): `attributes.base_url` → `metadata.base_url` → **daily** `https://daily-cloudcode-pa.googleapis.com`. **No cross-tier fallback/racing** ("Racing catalogs from different endpoints can grant incompatible entitlements"). `loadCodeAssist` (credits balance) uses `base_url` else **prod** `https://cloudcode-pa.googleapis.com`. Model catalog uses `base_urls` (comma list) → first only, else `base_url`, else daily.

Paths: `/v1internal:generateContent`, `/v1internal:streamGenerateContent`, `/v1internal:countTokens`, `/v1internal:fetchAvailableModels`, `/v1internal:loadCodeAssist`, `/v1internal:onboardUser`.
Query: stream → `?alt=sse` (or `?$alt=<alt>` when `opts.Alt` set); non-stream → `?$alt=<alt>` only if set; countTokens → `?$alt=` only if set.

### 2.6 Request envelope (`geminiToAntigravity`, request.go:461 + translator `internal/translator/antigravity/gemini/antigravity_gemini_request.go:34`)
Translator output (Gemini→Antigravity): `{"project":"","request":{<gemini body, without top-level model>},"model":"<model>"}`; renames `request.system_instruction→systemInstruction`; `generationConfig.responseJsonSchema`→`responseSchema`; normalizes roles (non user/model → user if functionResponse or after model, else model); renames `functionDeclarations[].parameters → parametersJsonSchema`, de-duplicates function names (sanitized), drops empty function tools; sanitizes thought signatures (Claude targets use a Claude-specific sanitizer); attaches default `request.safetySettings` (later removed by executor).

Executor then (per request):
```jsonc
{
  "model": "<baseModel>",              // SetStringIfDifferent
  "userAgent": "antigravity",
  "requestType": "agent" | "image_gen" | <existing, e.g. "web_search">,   // "image_gen" if model name contains "image"
  "project": "<project_id>",           // deleted if empty (but empty → 400 earlier)
  "requestId": "agent-<uuid>" | "image_gen/<unixMs>/<uuid>/12",   // omitted when requestType=="web_search"
  "request": {
     "sessionId": "<existing request.sessionId> | derived-session | stable '-<int63>' ",  // omitted for image models & web_search
     "contents": [...], "systemInstruction": {...}, "generationConfig": {...}, "tools": [...],
     "toolConfig": {...}               // top-level toolConfig is moved under request
     // request.safetySettings DELETED
  },
  "enabledCreditTypes": ["GOOGLE_ONE_AI"]  // only on credits retry (§2.9)
}
```
- `generateStableSessionID` (request.go:520): first `request.contents[*]` with `role=="user"` and non-empty `parts.0.text` → `sha256(text)`, first 8 bytes big-endian uint64 `& 0x7FFFFFFFFFFFFFFF` → string `"-" + decimal`. Fallback random `"-" + rand(0..9e18)`. Derived downstream session id (`helps.DerivedAntigravitySessionID`) wins over stable hash; explicit `request.sessionId` wins over both.
- `maxOutputTokens` cap: if > registry `MaxCompletionTokens` for (model,"antigravity") → clamp. **Then**: Claude models → `request.toolConfig.functionCallingConfig.mode="VALIDATED"`; non-Claude → **delete `request.generationConfig.maxOutputTokens`** entirely (request.go:70-110).
- Schema sanitization runs only if `request.tools.0` exists or a generation-config response schema exists; `useAntigravitySchema = model contains "claude" | "gemini-3-pro" | "gemini-3.1-pro"`. Tool declaration schemas cleaned with `util.CleanJSONSchemaForAntigravityTool(schema, requirePlaceholder=useAntigravitySchema)` (rename `parametersJsonSchema→parameters`; drop unsupported keywords with description hints; flatten `anyOf/oneOf/allOf`; resolve local `$ref`; all enums → strings; add placeholder required prop for empty schemas when VALIDATED; `internal/util/gemini_schema.go:44-112`), applied *only* to schema locations (never to functionCall args in history); `request.generationConfig.{responseSchema,responseJsonSchema,response_*}` cleaned via `CleanJSONSchemaForAntigravityResponse` (keeps `additionalProperties:false`).
- Final: `helps.FinalizePayload` (user payload rules; last step) then send. Optional `antigravity.sensitive-words` config obfuscates words in `systemInstruction` with zero-width chars before this (`helps.ObfuscateSensitiveWordsInSystemInstruction`).
- Pre-envelope content fixes (all models, run in order in Execute/ExecuteStream): `validateAntigravityRequestSignatures` (Claude-source thinking blocks: Gemini models drop non-Gemini signatures; Claude models drop empty/non-Claude-signature thinking blocks, strict bypass mode optional) → translate → thinking → sensitive words → `sanitizeAntigravityGeminiRequestSignatures` (Gemini models: signature sanitizer + `normalizeAntigravityGeminiFunctionResponseRoles`: repair missing/`"unknown"` functionResponse names from matching call id, reorder responses to call order, set role `model` for response-only turns!) → delete `request.stream` (stream path) → credits injection → reasoning replay (§2.10) → `ensureAntigravityGeminiBoundaryUserContent` (leading+trailing empty user turn; **skipped for Claude** because adapter rejects empty text parts; countTokens: leading only) → `buildRequest`.

### 2.7 Execution paths & response unwrapping
- **Dispatch** (`Execute`, execute.go:26-58): models containing `claude`, `gemini-3-pro`, or `gemini-3.1-flash-image` are executed **non-stream by calling the stream endpoint and aggregating** (`executeClaudeNonStream`, :261). Everything else uses `:generateContent`.
- Short-cooldown pre-check (§2.8) happens before any work; returns local `429` with `retryAfter` so the conductor switches credential.
- **Response envelope**: every upstream JSON is `{"response":{<gemini GenerateContentResponse>},"traceId":"…"}` (stream: one such object per SSE `data:` line). Translators read from `response.*` (`response.candidates.0.finishReason`, `response.usageMetadata`, `response.modelVersion`, `response.responseId`); the Gemini-format translator unwraps `response` and also tolerates unwrapped `candidates` (`antigravity_gemini_response.go`). If upstream ends cleanly without a terminal chunk the Gemini translator synthesizes `{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],usageMetadata…}`.
- **Stream→non-stream aggregation** (`convertStreamToNonStream`, execute.go:480): iterate lines (valid JSON only), take last `response` as template, track `traceId`, `candidates.0.content.role`, `finishReason`, `modelVersion`, `responseId`, last `usageMetadata`; coalesce adjacent text parts and adjacent thought parts (thought keeps last `thoughtSignature`; empty-text parts dropped unless thought with signature); `functionCall`/`inlineData` parts flushed individually (normalizes `thought_signature→thoughtSignature`, `inline_data→inlineData`); default usage zeros; output `{"response":{…},"traceId":"…"}`.
- **Stream** (`ExecuteStream`, stream.go:26): SSE lines. Handles split JSON across lines (`pendingJSON` accumulation until `gjson.Valid`). A JSON object with top-level `error` mid-stream → `statusCode = error.code` if 400..599 else 502, error forwarded as `newAntigravityStatusErr`. Terminal detection: `candidates.0.finishReason` / `response.candidates.0.finishReason` non-empty, or translated chunk contains `[DONE]`, `type ∈ {response.completed, message_stop}`, or `choices.0.finish_reason`. After a terminal chunk a client-cancel is not an error. EOF without error → feed `[DONE]` to translator (synthesizes terminal events); with scanner error **no** synthetic terminal.
- **Usage filtering** (`helps.FilterSSEUsageMetadata`, `usage_helpers.go:1404`): usage is retained only on terminal chunk (one with non-empty finishReason); non-terminal `usageMetadata`/`response.usageMetadata` is **renamed** `cpaUsageMetadata`/`response.cpaUsageMetadata` (translators read both). Special case: a finishReason chunk **without** usage is swallowed and its `traceId` remembered (10-minute TTL); the next chunk with same `traceId` that carries usage is also swallowed (usage taken by accounting) — see `isStopChunkWithoutUsage`/`rememberStopWithoutUsage`. Usage accounting is captured *before* the rename (`ParseAntigravityStreamUsage`).
- Web-search grounding: when a Claude request has tool type `web_search_20250305|web_search_20260209` or a Responses request has `web_search|web_search_2025_08_26|web_search_preview|web_search_preview_2025_03_11` **and** translated request has `request.tools[].googleSearch`, response `…candidates.0.groundingMetadata.groundingChunks[].web.uri` values that are `https://vertexaisearch.cloud.google.com/grounding-api-redirect/*` are resolved with `HEAD` (no redirect follow, 3xx `Location` must be https) via the credential proxy (`helps/antigravity_grounding_urls.go`).
- Compaction (`/responses/compact` or `compaction_trigger` input item): not sent upstream as such; the executor runs a normal non-stream summarization with an appended user message *"Please provide a concise and comprehensive summary of the preceding conversation and task progress so far, including user goals, key findings, actions taken, and current status, so that work can continue smoothly."*, then seals the summary into an opaque capsule `cpa-ag-compact-v1:` + base64url(raw)( `nonce(12) ‖ AES-256-GCM(key = SHA-256("CLIProxyAPI"), plaintext = {"summary","model","created_at"(unix s)})` ) and returns it as a Responses `compaction` item; incoming `compaction` items are unsealed back into text (`helps/antigravity_compaction.go`). Streaming `/responses/compact` → 400.

### 2.8 429 classification, cooldowns, retry delays
`decideAntigravity429(body)` (credits.go:226) — applies only to HTTP 429:
| Condition | Decision | Action |
|---|---|---|
| empty body | `soft_retry` | normal error |
| `error.status != "RESOURCE_EXHAUSTED"` (case-insens.) | `soft_retry` | |
| `error.details[]` with `@type=="type.googleapis.com/google.rpc.ErrorInfo"` and `reason=="QUOTA_EXHAUSTED"` | `full_quota_exhausted` | close idle conns; if `reason` is `INSUFFICIENT_G1_CREDITS_BALANCE` & credits request → mark credits disabled |
| ErrorInfo `reason=="RATE_LIMIT_EXCEEDED"` and no retry delay | `soft_retry` | |
| …with delay `< 3 s` (`antigravityInstantRetryThreshold`) | `instant_retry_same_auth` (declared; the executors currently perform **one upstream try per credential**, conductor owns retries) | |
| …delay `< 5 min` (`antigravityShortQuotaCooldownThreshold`) | `short_cooldown_switch_auth` | record per-(auth,model) short cooldown for `retryAfter`; return 429 |
| …delay `≥ 5 min` | `full_quota_exhausted` | |
| body (lowercased) contains `quota_exhausted` or `quota exhausted` | `full_quota_exhausted` | |
| otherwise | `soft_retry` | |

Retry delay parse (`helps/json_retry_helpers.go:27`, also used for the token endpoint 429): 1) `error.details[]` `@type …RetryInfo` → `retryDelay` (Go duration string like `"3.5s"`; **note Google emits `"3.500s"`, handled by `time.ParseDuration`**); 2) `ErrorInfo.metadata.quotaResetDelay`; 3) `error.message` regex `after\s+(\d+)s\.?`; 4) `after\s+((?:\d+h)?(?:\d+m)?(?:\d+s)?)\.?` (lowercased). Result becomes `statusErr.retryAfter`.

Short cooldown state: key `"<authID>|<model>|sc"` in-process; Home/KV key `cpa:antigravity:short-cooldown:<authID>:<HashKeyPart(model)>` value = unix **nano** deadline as decimal string, TTL = duration + 5 s. Checked at the start of Execute/ExecuteStream/executeClaudeNonStream; if in cooldown and not bypassed → synthetic `429 "auth in short cooldown, <remaining> remaining"` with `retryAfter=remaining`. Bypass: credits request in progress with `quota-exceeded.antigravity-credits` enabled. Disabled per-auth via `disable_cooling`/config (`QuotaCooldownDisabledForAuthWithConfig`). If the KV is unavailable (Home mode) → `503 "home kv store unavailable"`.

Other error handling: 4xx/5xx → `statusErr{code, msg: raw body}`. 400 whose body contains `thoughtsignature`/`thought_signature`/`signature` → delete replay ledger entry (§2.10). Terminal read error with ctx cancelled is not reported as failure.

### 2.9 Credits ("Google One AI credits") — `antigravity_executor_credits.go`, `sdk/cliproxy/auth/antigravity_credits.go`
Config gate: `quota-exceeded.antigravity-credits: true` (`internal/config/config_types.go:345`). **Claude models only.**
- **Fallback orchestration** (conductor, non-Home mode only): after the normal rotation fails (`shouldAttemptAntigravityCreditsFallback`: last error status 429 or 503, or `auth_not_found|auth_unavailable|model_cooldown`; not request-terminated), and provider list includes antigravity, `tryAntigravityCreditsExecute[Stream]` (`conductor_home.go:1279-1480`): candidates = auths with provider antigravity, enabled, route model contains `claude`, honoring pinned auth; split by hint: known-available first, unknown next (sorted by auth ID), known-unavailable skipped. For each: ctx flag `WithAntigravityCredits`, `prepareRequestAuth`, execute with model candidates. Home mode returns `503 home_fallback_unsupported`.
- **Request mutation**: executor, when ctx flag && config → `injectEnabledCreditTypes`: set top-level body field `"enabledCreditTypes":["GOOGLE_ONE_AI"]` (on valid JSON); `helps.MarkCreditsUsed(ctx)` flags billing/usage; success → `clearAntigravityCreditsFailureState`.
- **Exhaustion signal**: 429 `QUOTA_EXHAUSTED` category with ErrorInfo `reason == "INSUFFICIENT_G1_CREDITS_BALANCE"` (case-insens.) while credits were requested → `markAntigravityCreditsPermanentlyDisabled`: state `{PermanentlyDisabled, ExplicitBalanceExhausted}`, balance `{CreditAmount:0, MinCreditAmount:1, Known:true}`, hint `{Known,Available:false,…}`. Cleared when a later balance probe shows `creditAmount >= minimumCreditAmountForUsage`.
- **Balance probe** (`updateAntigravityCreditsBalanceForTask`, credits.go:507): `POST {prodOrBaseURL}/v1internal:loadCodeAssist` (headers `Authorization`, `Accept: */*`, `Content-Type: application/json`, short `User-Agent`), body `{"metadata":{"ideType":"ANTIGRAVITY"}}`. Parse `paidTier.id`; `paidTier.availableCredits[]` entry with `creditType` ==(ci) `GOOGLE_ONE_AI`: `creditAmount` and `minimumCreditAmountForUsage` (strings → float). `Available = creditAmount >= minimumCreditAmountForUsage`. If `availableCredits` isn't an array → hint `{Known:true, Available:false}`. Non-2xx/transport errors: silent (debug).
- **Probe scheduling**: `maybeRefreshAntigravityCreditsHint` on every request where token still valid (skipped if hint already known): in-process 5 s timeout, per-auth min interval **10 min** (`antigravityCreditsHintRefreshInterval`), epoch-fenced; also queued right after each token refresh (no timeout, lifecycle-bound). Home mode: `SETNX cpa:antigravity:credits-refresh-lock:<authID>` TTL 10 min.
- **State/keys**: balance `cpa:antigravity:credits-balance:<authID>` JSON `{CreditAmount,MinCreditAmount,PaidTierID,Known}` TTL **30 min**; hint `cpa:antigravity:credits-hint:<authID>` JSON `{Known,Available,CreditAmount,MinCreditAmount,PaidTierID,UpdatedAt}` TTL 30 min. Unknown balance ⇒ **optimistic** (assume available). → Workers: KV or DO storage with same TTLs; run probe lazily with `ctx.waitUntil`.

### 2.10 Reasoning replay (Gemini-on-Antigravity thought-signature ledger) — `antigravity_reasoning_replay.go` (2.7k lines)
Purpose: Claude Code / Responses / OpenAI clients can't round-trip Gemini's opaque `thoughtSignature` and original functionCall identity, but Gemini **rejects** model turns whose first functionCall lacks a valid signature. The proxy stores signatures from each upstream response and re-injects them into the next request.
- **Applies to** models (lower-cased) not containing `claude` and containing `gemini`, `flash`, or `agent` (`antigravityUsesReasoningReplayCache`, :2742). Claude models have a separate path (Claude-format signatures; `helps` thinking replay).
- **Scope/session key** (`antigravityReasoningReplayClientSessionKey`, :137), first match wins: Claude Code execution scope (+`:context:<sha256-16B of normalized system minus cache_control>` lane) → header `Session-Id`/`Session_id` → `responses:<id>`; body `session_id`/`metadata.session_id` → `responses:<id>`; execution-session metadata → `execution:<id>`; `prompt_cache_key` → `prompt-cache:<k>`; derived session → `derived:<id>`; else payload `sessionId`/`session_id`/`request.sessionId` or stable hash → `session:<id>`. Ledger key = (modelName, sessionKey).
- **Ledger store** (`internal/cache/antigravity_reasoning_replay_cache.go`): TTL **1 h**, max 10 240 entries in-process (evict batch 128), per entry ≤ **4096 items** and ≤ **16 MiB** (serialized ≤ 24 MiB). Compare-and-swap semantics (`ReplaceAntigravityReasoningReplayItemsIfUnchanged` / `Delete…IfUnchanged` with snapshot; tombstones) so concurrent turns can't clobber each other; Home KV key `antigravityReasoningReplayKVKey(model,session)` using `KVCompareAndSwap`/`KVExpire`. → Workers: **one DO per (model, session)** (or per credential) with transactional storage; TTL via alarm/`expiresAt` check. A replay-store failure must **degrade** (log, continue without replay), never fail the request.
- **Item types** (stored JSON): `thought_signature` items `{contentIndex, partIndex, thoughtSignature, targetKind: "text"|"thought", targetHash(sha256(kind\0text)), targetOccurrence, contextHash}` and `function_call_part` items `{contentIndex, partIndex, targetOccurrence, functionCall{name,args,id}, thoughtSignature, contextHash}`. `contextHash` = rolling hash of preceding contents so a replay is only applied when the request history matches.
- **Capture** (`antigravityReasoningReplayAccumulator`, :2263): observes each response payload (`response.candidates.0.content.parts[]` and `finishReason`); signature != `""` and != `"skip_thought_signature_validator"` counts as native; detached signatures are bound to the next/previous functionCall or text/thought part; commit only if a terminal `finishReason` was seen (partial streams contribute nothing); overflow → delete ledger. For Responses output the commit waits for translated `response.completed`.
- **Apply** (`prepareAntigravityGeminiReasoningReplayPayload`, :257): load items → insert/merge signatures and functionCall parts into matching model turns (match by call id → else name+args occurrence; arg normalization against tool schemas for Claude-origin requests) → `normalizeAntigravityGeminiFunctionResponseRoles` → if reserved Claude-facing tool-use ids remain (`util.IsGeminiClaudeToolUseID`) rewrite them to synthetic ids (degraded, warn) → `antigravityRepairUnsignedFirstFunctionCalls` (re-assert "first functionCall in model turn signed" with `skip_thought_signature_validator`) → `ValidateGeminiFunctionCallPairing`; if replay broke pairing and original was valid → delete ledger and fall back to original payload; if pairing invalid and replay not the cause → 400 `antigravity executor: invalid Gemini function call history: …`.
- **Invalidate**: HTTP 400 and body (lowercased) contains `thoughtsignature`, `thought_signature`, or `signature` → CAS-delete the entry used for the request.
- A Workers port can ship a simplified v1: signature-only capture/restore keyed by (model, session, contentIndex, part fingerprint) plus the "first functionCall gets `skip_thought_signature_validator`" repair; the full item/contextHash machinery exists to be byte-faithful for Claude Code transcripts.

### 2.11 Token counting (`antigravity_executor_tokens.go`)
`POST {base}/v1internal:countTokens[?$alt=…]`. Body = translated + thinking + signature-sanitized payload, with replay applied and `ensureAntigravityGeminiLeadingUserContent` only, then **delete** `project`, `model`, `request.safetySettings`, `request.toolConfig`, `request.labels`, `request.sessionId` (so body is `{"request":{contents,…}}`). Headers: `Content-Type`, `Authorization: Bearer`, `User-Agent` (short), `Host`, custom attr headers. Response `{"totalTokens": N}`; 429 → parse `retryAfter`, close idle conns. (Claude-style `input_tokens` is rendered by `TranslateTokenCount`.)

### 2.12 Model catalog / probes (`sdk/cliproxy/antigravity_models.go`)
- Probe: `POST {firstBaseURL}/v1internal:fetchAvailableModels`, `Content-Type: application/json`, `Authorization: Bearer`, `User-Agent: antigravity/hub/<ver> darwin/arm64` (always the global UA, ignores per-auth override), body `{"project":"<project_id>"}`; read ≤ **8 MiB**. 401/403 → `auth_error`; other non-2xx/parse errors → `transient`. Response `{ "models": {"<id>": {...}, …}, "webSearchModelIds": ["…"] }`. IDs lower-cased+trimmed. `models` map keys = entitlement set; **registered models = static registry list ∩ fetched keys** (`filterAntigravityModels`); `webSearchModelIds` ⇒ `SupportsWebSearch=true`. Legacy responses without `models` only update web-search flags, never revoke models.
- Cache: key `(authID, registrationEpoch, project_id, endpoint, proxy)`, TTL = `registry.ModelsRefreshInterval`; failures keep last good catalog; backoff per (key, sha256(access_token)): failures 1..5 → window `min(2m·2^(n-1), 30m)` = 2,4,8,16,30 min with **equal jitter** (`half + rand[0..half]`); failure counter resets if last failure older than 2×TTL. Concurrency cap `modelRegistrationMaxWorkersPerCategory`; singleflight per key. Scan interval 1 min (`antigravityRefreshScanInterval`). → Workers: cron every minute (or DO alarm per credential) reading KV `ag:models:<authId>` (+ `nextRetry`).
- Executor itself never probes before sending; unknown/unsupported models simply 4xx upstream.
- Dev tool `cmd/fetch_antigravity_models/main.go` tries bases in order daily, prod, sandbox (30 s timeout) — not a runtime path.

### 2.13 Connection/transport specifics worth noting
- `HttpRequest` sets `httpReq.Close=false`, never sets `Connection`. Execution never imposes a client timeout (timeout 0) per repo rule; only credential acquisition (refresh, project discovery, credits probe) is bounded (30 s / 5 s).
- Pool config knobs (`antigravity.connection-pool.{enabled,idle-conn-timeout,max-idle-conns-per-host}`) are irrelevant on Workers.
- Custom `proxy-url` per credential applies to all Antigravity calls (not available on Workers; drop).

---

## 3. Vertex AI (`vertex` provider)

File: `gemini_vertex_executor.go`; credentials: `internal/auth/vertex/{vertex_credentials.go,keyutil.go}`, import handler `internal/api/handlers/management/vertex_import.go`.

### 3.1 Credential types
1. **Service-account (file) credential** — auth JSON (written by import endpoint; file `vertex-<sanitized project_id>.json`, `/ \ :`→`_`, space→`-`; label `"<project> (<email>)"`):
```json
{ "type":"vertex","service_account":{<full SA JSON>},"project_id":"…","email":"<client_email>","location":"us-central1","prefix?":"teamA","label":"…" }
```
   `vertexCreds` (:1190): requires `project_id` (fallback key `project`) and `service_account` object; `location` default `us-central1`; SA private key normalized (`NormalizeServiceAccountMap`, §3.3).
2. **API-key credential** (config `vertex-api-key:` list → provider `vertex`, attrs `api_key`, `base_url`, `interactions:"true"` optional, `header:*`; label `vertex-apikey`) — `vertexAPICreds` (:1230) also falls back to `metadata.access_token` as API key.
Choice: API key (if present) **first**, else service account.

### 3.2 Service-account → access token (WebCrypto JWT flow)
Go uses `google.CredentialsFromJSON(ctx, saJSON, "https://www.googleapis.com/auth/cloud-platform")` (`vertexAccessToken`, :1256) → x/oauth2 JWT-bearer grant. **No caching in the executor** (a new credentials object, hence a new token request, is built on *every* call); the port should cache per credential until `exp − 60 s`. Token exchange uses the credential/global proxy, not the per-request execution proxy.

Exact flow to implement:
1. JWT header: `{"alg":"RS256","typ":"JWT","kid":"<service_account.private_key_id>"}` (kid included when present).
2. Claims: `{"iss":"<client_email>","scope":"https://www.googleapis.com/auth/cloud-platform","aud":"<token_uri>","iat":<now s>,"exp":<now+3600>}` — `aud` = SA JSON `token_uri` (normally `https://oauth2.googleapis.com/token`; default to that if missing). (`sub` only for domain-wide delegation; not used.)
3. Sign `base64url(header).base64url(claims)` with RSASSA-PKCS1-v1_5 / SHA-256 using the SA `private_key`; append `.base64url(sig)` (no padding, URL-safe).
4. `POST <token_uri>` `Content-Type: application/x-www-form-urlencoded` body `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`.
5. Response `{"access_token":"ya29…","expires_in":3599,"token_type":"Bearer"}`; use `Authorization: Bearer <access_token>`. (x/oauth2 treats tokens as expired 10 s early.)
6. WebCrypto note: `crypto.subtle.importKey("pkcs8", der, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"])` accepts **only PKCS#8**. Google SA keys are normally `-----BEGIN PRIVATE KEY-----` (PKCS#8) → strip header/footer/whitespace, base64-decode. If the key is `-----BEGIN RSA PRIVATE KEY-----` (PKCS#1) wrap the DER into a PKCS#8 `PrivateKeyInfo` (version 0, `rsaEncryption` OID 1.2.840.113549.1.1.1 + NULL, OCTET STRING of the PKCS#1 DER) before import.
7. Token errors surface to client as `500 "internal server error"` (logged), missing token → 401 `missing access token`.

### 3.3 Private-key normalization (`keyutil.go`) — port these tolerances
`sanitizePrivateKey`: CRLF/CR→LF; strip ANSI escape sequences (ESC `]…BEL|ESC\` and ESC `[…letter`); drop invalid UTF-8; trim; if not PEM-decodable, `rebuildPEM`: pick kind `RSA PRIVATE KEY` if the text contains it else `PRIVATE KEY`, extract between markers, filter to base64 alphabet `[A-Za-z0-9+/=]`, decode, re-wrap. Then Go re-encodes everything to **PKCS#1 `RSA PRIVATE KEY`** (tries PKCS#1, then PKCS#8 RSA; other formats → `private_key uses unsupported format`). Missing/empty `private_key` → error `service account missing private_key`. (In TS, normalize to PKCS#8 instead — it's what WebCrypto needs.)

### 3.4 Endpoints
| Case | URL |
|---|---|
| SA, base | `vertexBaseURL(location)`: `""`→`us-central1`; `global` → `https://aiplatform.googleapis.com`; else `https://{location}-aiplatform.googleapis.com` (:1246) |
| SA generate/stream/count | `{base}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:{generateContent\|streamGenerateContent\|countTokens\|predict}` |
| API key | `{base_url or https://aiplatform.googleapis.com}/v1/publishers/google/models/{model}:{action}` (no project/location) |
| Stream query | `?alt=sse` (or `?$alt=<alt>`); Imagen `:predict` gets no query |
| Non-stream alt | `?$alt=<alt>` if `opts.Alt` set and action ≠ countTokens |
| Interactions | `{base_url or https://aiplatform.googleapis.com}/v1beta1/projects/{project}/locations/global/interactions` (no project → `/v1beta1/interactions`), `?alt=sse` when streaming; only when `auth.attributes.interactions=="true"|"1"` or metadata `interactions`/`native_interactions` true **and** source format is Interactions (`:1313-1356`) |
Auth header: SA → `Authorization: Bearer <token>`; API key → `x-goog-api-key: <key>` (API-key Vertex calls do **not** use Bearer). Same `header:*` custom headers and client-header passthrough as Gemini. Interactions add `Api-Revision: 2026-05-20`.
Vertex API version const `v1` (`vertexAPIVersion`, :35).

### 3.5 Request shaping (differences from §1.2)
Same pipeline (translate → thinking → `fixGeminiImageAspectRatio` → model → `SanitizeGeminiRequestThoughtSignatures` → leading/trailing user turn → delete `session_id` → payload rules) plus:
- `helps.StripVertexOpenAIResponsesToolCallIDs` (only when source format is `openai-response`): delete `functionCall.id` and `functionResponse.id` from all parts (Vertex rejects them).
- **No** `capGeminiMaxOutputTokens`; **no** `FilterSSEUsageMetadata`; stream lines are passed to translator raw (`bytes.Clone(line)`).
- **Imagen models** (name contains `imagen`, case-insens.): action `predict`; request converted (`convertToImagenRequest`, :143) from Gemini to `{"instances":[{"prompt":"<first contents[0].parts[0].text | first non-empty messages[].content | prompt>","negativePrompt?":…}],"parameters":{"sampleCount":1|payload.sampleCount,"aspectRatio?":payload.aspectRatio}}`; response `predictions[].{bytesBase64Encoded,mimeType(default image/png)}` converted (`convertImagenToGeminiResponse`, :89) to a Gemini response `{candidates:[{content:{role:"model",parts:[{inlineData:{mimeType,data}}…]},finishReason:"STOP"}],responseId:"imagen-<unixnano>",modelVersion:<model>,usageMetadata:{0,0,0}}` so the normal translators apply. Imagen "streaming" is a single non-SSE call.
- Stream terminal detection (`isGeminiVertexTerminalStreamChunk`, :56): translated chunk containing `[DONE]`, `type ∈ {response.completed,response.incomplete,response.done,message_stop}`, or any finish reason path (`choices.0.finish_reason`, `candidates.0.finishReason`, `response.…`); a cancel after terminal delivery is swallowed.
- Count tokens: same URL pattern with action `countTokens`; body with `tools`, `generationConfig`, `safetySettings` removed; response `totalTokens`.
- Errors: non-2xx → `statusErr{code, raw body}` (no quota parsing). Refresh: no-op.
- No Claude-on-Vertex (`publishers/anthropic`, `rawPredict`) support exists.

---

## 4. AI Studio (`aistudio`) — browser WebSocket relay

Files: `aistudio_executor.go`, `internal/wsrelay/{manager,session,http,message}.go`, `sdk/cliproxy/service_auth.go:271-340`, `internal/api/server_routes.go:547`.

**Concept:** there is *no server-side credential*. A browser userscript/tab on aistudio.google.com opens a WebSocket to the proxy; the proxy sends it an HTTP-style request envelope and the page executes the real `generativelanguage` fetch using the user's logged-in AI Studio session, relaying the response back.

### 4.1 Server side
- Route `GET /v1/ws` (Gin) behind the normal API-key auth middleware unless config `ws-auth: false` (`oauth.providers.aistudio.ws-auth` in v8 config); websocket upgrade with `CheckOrigin = true`.
- Each connection gets provider/channel id `aistudio-<16 random [a-z0-9]>` (no `ProviderFactory` configured) → registers runtime-only auth `{ID:channelID, Provider:"aistudio", Attributes:{runtime_only:"true"}, Metadata:{email:channelID}}` (`wsOnConnected`); on disconnect (except "replaced by new connection") auth is deleted. Registered executor per auth: `NewAIStudioExecutor(cfg, authID, relay)`; identifier `aistudio`.
- Limits/timers: read limit **64 MiB** per message, read deadline **60 s** (refreshed on pong), server ping control frame every **30 s** (payload `"ping"`), write deadline **10 s**, per-request response channel buffer 64. Client JSON `{"type":"ping","id":…}` is answered `{"id":…,"type":"pong"}`.
- Wire protocol (JSON text frames), `Message{id, type, payload}`:
  - proxy→browser: `type:"http_request"`, `payload:{method,url,headers:{Name:[values]},body:"<string>",sent_at:RFC3339Nano}`.
  - browser→proxy: `http_response` `{status,headers(map name→string|[string]),body:string}` (terminal); `stream_start` `{status,headers}`; `stream_chunk` `{data:"<text>"}`; `stream_end` (terminal); `error` `{error:"msg",status:int}` (terminal). Messages are correlated by `id` (uuid per request). Duplicate ids rejected.
- Non-stream: collects `stream_*` into body if the browser streamed; returns `http_response` or aggregated stream. Stream: first event decides — if `status` present and non-2xx before any chunk, drain the rest into an error body and fail with `statusErr{status,body}`; otherwise forwards `stream_chunk` payloads (SSE text, may contain `data:` lines) through `FilterSSEUsageMetadata` → translators; `stream_end` → synthetic `[DONE]`; `http_response` mid-stream is treated as a final buffered body (non-2xx → error); `error` → `wsrelay: <msg> (status=N)`.
- Workers mapping: a **Durable Object per channel** terminating the hibernatable WebSocket (`state.acceptWebSocket`), request IDs → pending `TransformStream`/`ReadableStream` controllers held in the DO's memory (note: a DO with an open request cannot hibernate; fine). Heartbeat via `ws.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"…}', …))` or alarm-based ping. Enforce single connection per channel (replace old). Only one such executor per session — the worker's `/v1/chat/completions` handler must call the DO stub; since the DO stores which channel IDs are alive, keep a KV/DO registry list of connected `aistudio-*` channels for credential selection.

### 4.2 Request shaping (`translateRequest`, :522)
Source → gemini translation, `ApplyThinkingWithSourcePayload`, `fixGeminiImageAspectRatio`, then **delete** `generationConfig.maxOutputTokens`, `generationConfig.responseMimeType`, `generationConfig.responseJsonSchema`, delete `session_id`, leading/trailing user-turn fixes (trailing skipped for countTokens), `normalizeAIStudioThinkingLevel` (:575: `generationConfig.thinkingConfig.thinkingLevel` string upper-cased if in {MINIMAL,LOW,MEDIUM,HIGH}; upstream is case-sensitive, lowercase → 400), countTokens: delete `generationConfig`, `tools`, `safetySettings`; payload rules last. `action = generateContent | streamGenerateContent | countTokens`.
- URL placed in the envelope (`buildEndpoint`, :599): `https://generativelanguage.googleapis.com/v1beta/models/{model}:{action}`; stream → `?alt=sse` (or `?$alt=<urlenc alt>`); non-stream with alt → `?$alt=…`; countTokens no query. Envelope headers: `Content-Type: application/json` + `header:*` attrs/client passthrough. **No API key header** — the browser adds its own auth.
- Responses re-emitted through `ensureColonSpacedJSON` (:615: re-serialize via `MarshalIndent("", "  ")` then strip newlines and indentation outside strings, yielding compact JSON with `": "` after keys, `, ` separators → matches AI Studio's formatting). Only cosmetic; safe to skip or implement as `JSON.stringify` + regex only if clients depend on it.
- `CountTokens`: requires `totalTokens > 0` else error `wsrelay: totalTokens missing in response`.
- `HttpRequest` (generic passthrough used by the management API tools) forwards any request through the relay.

---

## 5. Cross-cutting Google details

### 5.1 Usage mapping (Gemini family; `helps/usage_helpers.go:1167`)
From `usageMetadata` (Antigravity: `response.usageMetadata` → `usageMetadata` → `usage_metadata`; also `cpaUsageMetadata` in translators):
`input = promptTokenCount + toolUsePromptTokenCount(or tool_use_prompt_token_count)`; `output = candidatesTokenCount`; `reasoning = thoughtsTokenCount`; `cached = cachedContentTokenCount` (also cacheRead); `total = totalTokenCount` (if 0: input+output+reasoning). Overflowing sums → invalid breakdown (total only). Reasoning tokens are *separate* from output (`NewSeparateReasoningTokenBreakdown`).

### 5.2 Error → client semantics
- Upstream error bodies are passed through verbatim as `statusErr.msg` with the upstream HTTP status; conductor uses status (429/5xx/401/403) + `retryAfter` for cooldown/rotation (shared logic, other doc).
- Antigravity-specific: `retryAfter` only on 429; `QUOTA_EXHAUSTED`/long `RATE_LIMIT_EXCEEDED` → treated as full quota exhaustion; 400+signature → replay invalidation; stream mid-flight `error` objects mapped as in §2.7.
- Gemini/Vertex/AI Studio: no body-level quota inspection in the executor.

### 5.3 Streaming formats summary
| Provider | Upstream format | Per-chunk unwrap |
|---|---|---|
| gemini | SSE `data: {GenerateContentResponse}` (`alt=sse`) | none |
| vertex | SSE (`alt=sse`), raw lines to translator | none |
| antigravity | SSE `data: {"response":{…},"traceId":…}`; JSON may be split over several lines | unwrap `response`; handle top-level `error` |
| aistudio | whatever the browser returns in `stream_chunk.data` (SSE text) | none |
| interactions (gemini/vertex) | SSE frames (blank-line separated) with `data:` JSON, `[DONE]` | frame parser |
No Google path uses the JSON-array streaming format (`alt` absent); everything is requested with `alt=sse`.

### 5.4 Reasoning / thinking
Canonical thinking config is applied centrally by `internal/thinking` (`ApplyRequestThinking`) → `generationConfig.thinkingConfig.{thinkingBudget|thinkingLevel,includeThoughts}`; AI Studio additionally upper-cases `thinkingLevel`. Antigravity Gemini models need the signature ledger (§2.10); Claude-on-Antigravity uses Claude-format thinking signatures (validated/stripped per §2.6).

### 5.5 What NOT to port (or replace)
- Home/Home-KV branches (`homekv.*`, `RefreshAuthViaHome`, `currentAntigravityKVClient`) — control-plane integration; in the port replace with DO/KV directly (key names above are a good starting schema).
- `helps.WithAntigravityHTTPClientTrace` (connection-trace debug), `RecordAPIRequest/Response*` logging, `reporter.*` (usage reporter; port as a usage event emitter).
- `antigravity_executor_keepalive_test.go`-style keepalive: no non-test keepalive code exists in stream path (no SSE heartbeat is sent to clients by this executor).

---

## 6. Quick constant table

| Constant | Value | Source |
|---|---|---|
| Gemini base / version | `https://generativelanguage.googleapis.com` / `v1beta` | gemini_executor.go:31-34 |
| Vertex version / default location | `v1` / `us-central1` | gemini_vertex_executor.go:35,1246 |
| Vertex scope | `https://www.googleapis.com/auth/cloud-platform` | :1256 |
| Interactions Api-Revision | `2026-05-20` | helps/gemini_interactions.go:19 |
| Antigravity daily/prod/sandbox | see §2.1 | antigravity_executor.go:34-36 |
| Antigravity request token safety | 5 min | :41 |
| Antigravity credential acquisition timeout | 30 s | antigravity_executor_auth.go:20 |
| Credits hint refresh interval / timeout | 10 min / 5 s | antigravity_executor.go:42-43 |
| Instant retry threshold / short cooldown threshold | 3 s / 5 min | :44-45 |
| Credits balance/hint KV TTL | 30 min | credits.go:761, auth/antigravity_credits.go:41 |
| Short-cooldown KV TTL | duration + 5 s | credits.go:729 |
| Replay ledger TTL / max entries / items / bytes | 1 h / 10 240 / 4096 / 16 MiB | internal/cache/antigravity_reasoning_replay_cache.go:23-43 |
| Onboard poll | 5 attempts, 2 s sleep, 30 s per-request | internal/auth/antigravity/auth.go:359-418 |
| Version cache TTL / fetch timeout / fallback | 6 h / 10 s / `2.9.1` | misc/antigravity_version.go:22-27 |
| Model-catalog failure backoff | 2,4,8,16,30 min + equal jitter; scan 1 min | sdk/cliproxy/antigravity_models.go:29-33,69-76 |
| Model-catalog max body | 8 MiB | :250 |
| WS relay read/write/ping | 60 s / 10 s / 30 s, 64 MiB msg | internal/wsrelay/session.go:14-20 |
| SSE scanner buffer | 50 MiB | helps/gemini_interactions.go:21 |
| Compaction capsule | prefix `cpa-ag-compact-v1:`, AES-256-GCM, key=SHA256("CLIProxyAPI"), base64url no pad | helps/antigravity_compaction.go:20-146 |
| Native signature bypass sentinel | `skip_thought_signature_validator` | internal/cache/signature_cache.go:175 |
