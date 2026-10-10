# Providers: Claude, Codex, OpenAI-compatible — executor behaviour reference

Scope: behaviour of `internal/runtime/executor/claude_*.go`, `codex_*.go`, `openai_compat_executor.go`, the relevant `helps/` files, `internal/auth/claude`, `internal/auth/codex`. Read-only research for the Workers/TypeScript rewrite. Paths below are relative to `internal/` unless they start with `sdk/`. Line numbers are from the current tree (may drift ±few lines).

Legend: **[CF-BLOCKER]** = cannot work as-is on plain Cloudflare Workers. **[CF-OK]** = portable with `fetch`.

## 0. Cross-cutting summary / Cloudflare blockers

| Item | What Go does | Used for | CF Workers status |
|---|---|---|---|
| utls ClientHello spoofing (Claude Code Node/OpenSSL profile) | `helps/utls_client.go:268-430` custom `tls.ClientHelloSpec` over raw `net.Conn` | Make `api.anthropic.com` Messages/count_tokens traffic look like Claude Code 2.1.x TLS (cipher order, ext order, ALPN `http/1.1`, no h2) | **[CF-BLOCKER]** `fetch()` cannot control JA3/JA4, ALPN, header casing/order. Port must accept loss of TLS fingerprint; keep header *names/values* (casing is lost on h2/Workers: `fetch` lowercases/normalises). |
| utls Chrome fingerprint (`tls.HelloChrome_Auto`) | `helps/utls_client.go:30-160`, used for host `chatgpt.com` only (`fallbackRoundTripper`, `utls_client.go:~377`) | Cloudflare bot-protection on `chatgpt.com/backend-api/codex/*` | **[CF-BLOCKER]** Workers' own egress TLS is Cloudflare's; may get challenged. Mitigate with realistic headers (see §Codex) – cannot replicate JA3. |
| Ordered raw HTTP/1.1 header writer (`httpwire.NewOrderedRequestConn`) | `helps/utls_client.go` header-order lists, `auth/claude/utls_transport.go` | Header order fingerprint | **[CF-BLOCKER]** (order not controllable). |
| Claude OAuth control-plane utls profile (no ALPN, HTTP/1.1, Axios header order) | `auth/claude/utls_transport.go` | token exchange / refresh / profile / roles on `platform.claude.com`, `api.anthropic.com/api/oauth/*` | **[CF-BLOCKER]** for TLS fp only; endpoints are plain HTTPS JSON and work from `fetch` (may be Cloudflare-challenged on `platform.claude.com`; unknown). |
| Outbound proxy dialers (SOCKS5/HTTP CONNECT via `proxyutil.BuildDialer`, `buildProxyTransport`) | `helps/proxy_helpers.go`, `utls_client.go` | per-credential `proxy_url` | **[CF-BLOCKER]** raw TCP. Drop or replace with a forwarding service. |
| Local OAuth callback listeners | `auth/claude/oauth_server.go` (port **54545**, `/callback`), `auth/codex/oauth_server.go` (port **1455**, `/auth/callback`) | CLI login flow | **[CF-BLOCKER]** local listener. Replace with Worker route that receives the redirect or "paste-the-redirect-URL" flow. Redirect URIs registered at the IdP are `http://localhost:54545/callback` and `http://localhost:1455/auth/callback`, so a Worker can only use them via manual copy/paste of the failed-redirect URL. |
| Goroutine background loops | in-memory TTL caches with cleanup tickers (`user_id_cache.go` 15min ticker, `session_id_cache.go`, `claude_diagnostics.go`, `claude_device_profile.go`), token refresh scheduler (conductor), Codex websocket pools/health, wsrelay | caches, refresh, ws liveness | Replace with KV/DO storage with TTL; refresh via cron/alarms. |
| Codex **WebSocket upstream** (`wss://chatgpt.com/backend-api/codex/responses`) client | gorilla/websocket with custom dialer, + local downstream WS server | lower latency / continuation (`previous_response_id`) | **[CF-OK with caveat]** Workers can open outbound WS only via `fetch()` with `Upgrade: websocket` (to an `https://` URL). Custom headers are allowed. Cannot set `Sec-WebSocket-Extensions`, TLS fp. Durable Object is the natural holder of session state. |
| Filesystem (`auths/*.json`, token storage) | file-backed credential store | credentials | Replace with D1/KV/DO. |
| `home` KV (`homekv.CurrentKVClient`) | optional remote control-plane KV used for claude device pool, user id, session id, profile cache, refresh | multi-node coordination | Map to DO/KV. |
| tiktoken tokenizer (`github.com/tiktoken-go/tokenizer`) | `helps/claude_input_tokens.go` | local Claude `count_tokens` when not hitting Anthropic | need WASM/JS tokenizer (e.g. `gpt-tokenizer`) or call upstream. |
| xxHash64 (seed `0x4D659218E32A3268`) | `claude_signing.go` | Claude Code billing "cch" body signature | need a pure-JS xxh64 (BigInt) – OK. |
| `golang.org/x/sync/singleflight`, in-process mutexes | refresh dedup, device pool | dedup concurrent refreshes | use DO per credential. |


---

# PART A — CLAUDE (Anthropic Messages)

Files: `runtime/executor/claude_executor.go`, `claude_executor_execute.go`, `claude_executor_stream.go`, `claude_executor_tokens.go`, `claude_executor_request.go` (betas/headers/tool alias), `claude_executor_cloaking.go` (system injection/cache control), `claude_signing.go` (CCH), `claude_fingerprint_policy.go`, `claude_executor_auth.go`, `claude_executor_fast_error.go`, `claude_executor_diagnostics.go`, `claude_executor_compaction.go`, `claude_thinking_replay.go`; `helps/claude_*.go`, `helps/user_id_cache.go`, `helps/session_id_cache.go`, `helps/cloak_utils.go`, `helps/utls_client.go`; `auth/claude/*`.

## A1. Endpoints / base URLs

| Purpose | Method + URL | Source |
|---|---|---|
| Messages (stream & non-stream) | `POST {base}/v1/messages?beta=true`, default `{base}=https://api.anthropic.com` | `claude_executor_execute.go:34-37`, `claude_executor_stream.go:32-35` |
| Count tokens | `POST {base}/v1/messages/count_tokens?beta=true` (only when `apiKey != ""` AND base is first-party Anthropic; otherwise local tiktoken estimate) | `claude_executor_tokens.go` (`shouldUseClaudeUpstreamTokenCount`, `countTokensUpstream`) |
| OAuth authorize (browser) | `https://claude.ai/oauth/authorize` | `auth/claude/anthropic_auth.go:25` |
| OAuth token exchange **and** refresh | `POST https://platform.claude.com/v1/oauth/token` (JSON body) | `anthropic_auth.go:28-30` |
| OAuth profile | `GET https://api.anthropic.com/api/oauth/profile` | `:31` |
| OAuth roles (native client calls it after exchange; result discarded except JSON-validity) | `GET https://api.anthropic.com/api/oauth/claude_cli/roles` | `:34` |

`base_url` per credential comes from `auth.Attributes["base_url"]` (API-key entries in `claude-api-key` config; Kimi/other Anthropic-compatible gateways also route through ClaudeExecutor). `api_key` from `auth.Attributes["api_key"]`, else `auth.Metadata["access_token"]` (OAuth). (`claudeCreds`, `claude_executor_request.go:1528`.)

"First-party Anthropic" test (`helps/claude_upstream.go`): `https`, hostname == `api.anthropic.com` (case-insens), no userinfo, port empty or 443. **Every Claude-specific fingerprint rule is keyed on this**.

## A2. Credential types and auth header

- OAuth token detection `isClaudeOAuthToken(apiKey)` (`claude_executor_request.go:1645`): `strings.Contains(apiKey, "sk-ant-oat")`.
- `PrepareRequest` / `applyClaudeHeaders` (`claude_executor.go:~232`, `claude_executor_request.go:1069+`):
  - If API-key credential (`AuthKind==api_key` or `Attributes.api_key` non-empty and the token is not an OAuth token) **and** target is first-party Anthropic → `x-api-key: <key>` and delete `Authorization`.
  - Otherwise (OAuth, or API key to a third-party gateway) → `Authorization: Bearer <token>`, delete `x-api-key`.
  - `claudeCredentialUsesOAuth` (`:1016`): OAuth token ⇒ true; `AuthKind==api_key` ⇒ false; no `api_key` attribute ⇒ true (file-based delegated providers still use Bearer).
- `Content-Type: application/json` always.
- Custom per-credential headers (`auth.Attributes["header:*"]`, via `util.ApplyCustomHeadersFromAttrs`) are applied last; on first-party Anthropic the final `Anthropic-Beta` and transport (Accept/Accept-Encoding) are re-forced afterwards so operators cannot corrupt them; on third-party gateways streaming Accept is re-forced only.

### A2.1 "Fingerprint policy" (what gets the Claude Code wire profile) — `claude_fingerprint_policy.go`
```
authIsOAuth          = isClaudeOAuthToken(apiKey)
profile              = auth.Attributes["fingerprint_profile"] | metadata["fingerprint_profile"|"fingerprint-profile"] | config claude-api-key[].fingerprint-profile   // only value: "claude-code-cli"
ProfileClaudeCodeCLI = authIsOAuth || profile=="claude-code-cli"
UseOAuthBetas = ApplyCLIIdentity = MCPAlias = InjectDiagnostics = ProfileClaudeCodeCLI
SynthesizeIdentity   = ProfileClaudeCodeCLI && !authIsOAuth
OAuthCancellation    = authIsOAuth
```
Default API-key credentials are **caller-owned** (pass caller headers/body through; see A4.3). Real OAuth tokens always get the strict Claude Code CLI profile.

### A2.2 Wire/cloak policy — `resolveClaudeWirePolicy` (`claude_executor_cloaking.go:1469`)
`cloakMode` precedence: default `"auto"`; `cfg.DisableClaudeCloakMode` → `"never"`; `auth.Attributes/metadata cloak_mode`; then config `claude-api-key[].cloak.mode`. `policy.Cloak = (ProfileClaudeCodeCLI || cloakConfigured) && !confirmedClaudeCode`; mode `"always"` forces true, `"never"` forces false; a **confirmed native Claude Code client is never cloaked** (pass-through). Other cloak settings: `cloak_strict_mode` ("true"), `cloak_sensitive_words` (comma list), `cloak_cache_user_id` ("true").

## A3. Detection of a *real* Claude Code client (`helps/claude_client_detection.go`)
`DetectClaudeCodeRequest(headers, payload, countTokens)`:
- `XAppCLI`: header `X-App == "cli"`.
- `UserAgent`: matches `(?i)^claude-cli/\d+.\d+.\d+ \(external, <entrypoint>(, agent-sdk/x.y.z)?\)$` (native pattern) and `plausibleClaudeCodeUserAgent` (version ≥ configured baseline).
- `BetasPresent`: `Anthropic-Beta` contains `claude-code-20250219`.
- `MetadataUserID`: body `metadata.user_id` is a string that parses as JSON `{device_id: 64-hex, account_uuid: ""|uuid, session_id: uuid}`.
- `NativeClient`: UA entrypoint ∈ {`cli`, `sdk-cli`, `claude-vscode`} (map `nativeClaudeEntrypoints`). Other entrypoints (sdk-ts, sdk-py, mcp, remote …) are known but **not** confirmed → get cloaked.
- `StrongSignals = XAppCLI && UserAgent && BetasPresent && (countTokens || MetadataUserID)` or a measured *Haiku helper* profile (model `claude-haiku-4-5-20251001`, no `claude-code` beta, exact beta lists in `measuredClaudeCodeHelperBetaProfiles`).
- `Confirmed = StrongSignals && NativeClient`.

Confirmed ⇒ pass caller's Anthropic-Beta/identity headers through (`misc.EnsureHeader` prefers incoming value) and don't touch system prompt/cache_control.

## A4. Request headers (non-confirmed / cloaked / OAuth path) — `applyClaudeHeadersWithNativeProfile` (`claude_executor_request.go:1069-1475`)

### A4.1 Fixed values (Claude Code 2.1.280 / `@anthropic-ai/sdk` 0.112.1 profile)
| Header (wire casing on first-party) | Value |
|---|---|
| `Anthropic-Version` (`anthropic-version`) | `2023-06-01` |
| `Anthropic-Dangerous-Direct-Browser-Access` (`anthropic-dangerous-direct-browser-access`) | `true` |
| `X-App` (`x-app`) | `cli` |
| `X-Stainless-Retry-Count` | `0` |
| `X-Stainless-Runtime` | `node` |
| `X-Stainless-Lang` | `js` |
| `X-Stainless-Timeout` | cfg `claude-header-defaults.timeout` or `600` (omitted on count_tokens) |
| `X-Stainless-Package-Version` | cfg `.package-version` or `0.112.1` |
| `X-Stainless-Runtime-Version` | cfg `.runtime-version` or `v26.3.0` |
| `X-Stainless-Os` (`X-Stainless-OS`) | cfg `.os` or `MacOS` (legacy path maps GOOS: darwin→MacOS, windows→Windows, linux→Linux, freebsd→FreeBSD, else `Other::<goos>`) |
| `X-Stainless-Arch` | cfg `.arch` or `arm64` (amd64→x64, 386→x86, else `other::<goarch>`) |
| `User-Agent` | cfg `.user-agent` or `claude-cli/2.1.280 (external, cli)` |
| `Connection` | `keep-alive` |
| `Accept` | `application/json` (first-party always; non-first-party stream: `text/event-stream`) |
| `Accept-Encoding` | `gzip, deflate, br, zstd` (first-party; non-first-party stream: `identity`) |
| `X-Claude-Code-Session-Id` | the agent-session UUID (A5.1) |
| `x-client-request-id` | fresh `uuid.New()` v4 per request, **only if first-party** (or helper with an incoming one) |

(`defaultClaudeFingerprint*` consts in `helps/claude_device_profile.go:19-26`.) Setting `claude-header-defaults.stabilize-device-profile: true` enables per-credential device profile learning (stored 7-day TTL, lock 5s) from confirmed real clients (`helps/claude_device_profile.go`); off by default → legacy path above. Wire-casing map (`claudeWireHeaderCasing`, first-party only): `X-Stainless-Os→X-Stainless-OS`, `Anthropic-Beta→anthropic-beta`, `Anthropic-Version→anthropic-version`, `X-App→x-app`, `X-Client-Request-Id→x-client-request-id`, `Anthropic-Dangerous-Direct-Browser-Access→anthropic-dangerous-direct-browser-access`. Native header order for Messages (utls conn writer): `Accept, Authorization, Content-Type, User-Agent, X-Claude-Code-Session-Id, X-Stainless-Arch, -Lang, -OS, -Package-Version, -Retry-Count, -Runtime, -Runtime-Version, -Timeout, anthropic-beta, anthropic-dangerous-direct-browser-access, anthropic-version, x-app, x-client-request-id, Connection, Host, Accept-Encoding, Content-Length` (count_tokens: same minus `X-Stainless-Timeout`). **Not reproducible on Workers.**

Pass-through headers copied from caller only when present (`claude_executor_request.go:1347-1385`): `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`, `X-Claude-Remote-Container-Id`, `X-Claude-Remote-Session-Id`, `X-Client-App`, `X-Anthropic-Additional-Protection`; and (confirmed client only) `X-Claude-Code-Request-Class`, `-Agent-Type`, `-Prev-Tool-Durations`, `-Compaction`, `-Context-Compacted`; `X-Stainless-Async: async` (confirmed only).

### A4.2 `Anthropic-Beta` assembly (`claudeCodeCLIBetas`, `:179-284`) — ordered list for cloaked/OAuth requests
Constants (`:36-62`): `claude-code-20250219`, `oauth-2025-04-20`, `context-1m-2025-08-07`, `interleaved-thinking-2025-05-14`, `redact-thinking-2026-02-12`, `thinking-token-count-2026-05-13`, `context-management-2025-06-27`, `prompt-caching-scope-2026-01-05`, `mid-conversation-system-2026-04-07`, `per-turn-control-2026-07-01`, `timing-2026-09-09`, `mid-conversation-tool-changes-2026-07-01`, `inline-tools-2026-09-15`, `advisor-tool-2026-03-01`, `advanced-tool-use-2025-11-20`, `mid-conversation-system-clear-at-2026-08-21`, `dangerous-tool-use-2026-09-03`, `effort-2025-11-24`, `server-side-fallback-2026-06-01`, `fallback-credit-2026-06-01`, `structured-outputs-2025-12-15`, `thinking-binding-controls-2026-08-01`, `thinking-display-updates-2026-08-18`, `thinking-resumption-2026-07-17`, `fast-mode-2026-02-01`, `afk-mode-2026-01-31`, `extended-cache-ttl-2025-04-11`, `prompt-caching-evict-2026-05-12`, `cache-diagnosis-2026-04-07`, `token-counting-2024-11-01`.

Order & conditions (`requested` = betas from caller `Anthropic-Beta` header + `betas` body array):
1. `claude-code-20250219` always
2. `oauth-2025-04-20` if `UseOAuthBetas`
3. `context-1m-2025-08-07` if requested
4. `interleaved-thinking-2025-05-14` always
5. `redact-thinking-2026-02-12` unless body `thinking.display` is set
6. `thinking-token-count-2026-05-13`, 7. `context-management-2025-06-27`, 8. `prompt-caching-scope-2026-01-05` always
9. if model NOT in legacy-system-reminder list (A6.2): `mid-conversation-system-2026-04-07`; then `per-turn-control-2026-07-01` (model `claude-opus-5-5*` or `claude-fable-5-1*`, or requested); `timing-2026-09-09` (model opus-5-5/fable-5-1/mythos-5-1 AND body has `output_config.timing`, or requested); `mid-conversation-tool-changes-2026-07-01` unless model is sonnet-5 (non-5.5); `inline-tools-2026-09-15` if any message content block `type=tool_addition` with `tool.definition`, or requested. (Legacy models: only per-turn-control/timing when applicable.)
10. `advisor-tool-2026-03-01` if requested or tools include an advisor tool
11. `advanced-tool-use-2025-11-20` if requested or any tool has `type` prefix `tool_search_tool_`, `defer_loading`, `input_examples`, or `allowed_callers`
12. `mid-conversation-system-clear-at-2026-08-21` (non-legacy model) if requested, or model uses progress display (opus-5-5/fable-5-1/sonnet-5/sonnet-5-5), or any message has `clear_at`
13. `dangerous-tool-use-2026-09-03` if requested or body has `safeguards`
14. `effort-2025-11-24` unless probe/helper, haiku model, or `thinking.type=="disabled"`
15. `server-side-fallback-2026-06-01` if not probe/helper and (requested or body `fallbacks`); 16. `fallback-credit-2026-06-01` if requested or body `fallback_credit_token` or (OAuth and `fallbacks`); 17. `structured-outputs-2025-12-15` if requested
18. `thinking-binding-controls-2026-08-01` if requested or `thinking.block_binding` or (progress-display model && `thinking.type=="adaptive"`)
19. `thinking-display-updates-2026-08-18` if not probe/helper, `thinking.type!="disabled"`, and (requested or `thinking.display=="updates"`)
20. `thinking-resumption-2026-07-17` if requested; 21. `fast-mode-2026-02-01` if requested or body `speed=="fast"`; 22. `afk-mode-2026-01-31` if requested
23. `extended-cache-ttl-2025-04-11` if not probe/helper AND ((OAuth && not subagent) or requested or any `cache_control.ttl=="1h"` in body)
24. `prompt-caching-evict-2026-05-12` if requested or body contains `"evict_on_complete"`; 25. `cache-diagnosis-2026-04-07` if body has object `diagnostics`.

Post-processing (`applyBetaHeader`, `:1245-1290`): remove `effort` if unsupported; for probe/helper (non-helper-profile) remove `server-side-fallback`, `thinking-display-updates`, `extended-cache-ttl`; `thinking.type=="disabled"` removes display-updates; subagent without explicit 1h removes `extended-cache-ttl`; non-probe non-count_tokens with a `1h` TTL in the body adds `extended-cache-ttl`; haiku without `fallbacks` (and not helper profile) removes `server-side-fallback`.

Caller betas: on first-party Anthropic with a non-confirmed caller, any caller beta in the "managed" set is dropped; unknown (not managed) betas are forwarded verbatim (#5738); `betas` lifted from the body (`extractAndRemoveBetas`: deletes body field `betas`, array or string) are appended only for non-first-party. Confirmed client: its own `Anthropic-Beta` is used verbatim, plus `oauth-2025-04-20` (inserted at position 2) and `extended-cache-ttl-2025-04-11` (unless subagent-without-1h/probe) added when we are using an OAuth credential. Count-tokens beta list: `claude-code-20250219[,oauth-2025-04-20],interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01` (+ advisor if needed).

### A4.3 Caller-owned (default API-key) mode
When not (ProfileClaudeCodeCLI or cloak) and not confirmed: copy caller headers `accept`, `accept-encoding`, `user-agent`, `x-app`, `x-client-request-id`, `anthropic-*`, `x-stainless-*`, `x-client-app`, `x-anthropic-additional-protection` (and `x-claude-code-*`/`x-claude-remote-*` only if confirmed); defaults `Anthropic-Version: 2023-06-01`, `Accept: application/json` (stream non-first-party: `text/event-stream`), `Accept-Encoding: gzip, deflate, br, zstd` (stream non-first-party: `identity`), `User-Agent: CLIProxyAPI/<version>` when the caller sent none. Betas: caller betas verbatim (+`fast-mode` if `speed=fast`, +body `betas`; OAuth adds oauth beta; advisor beta if needed).

## A5. Body pipeline for `/v1/messages` (order matters; `claude_executor_execute.go:24-300`, stream identical `claude_executor_stream.go`)

0. `EnsureSessionContext`. If a Responses-compaction trigger (`opts.Alt=="responses/compact"` or `compaction` item) → §A10.
1. `baseModel = thinking.ParseSuffix(model).ModelName` (suffix like `(8192)`/`(high)` for thinking). `upstreamModel` via optional normalizer (Kimi etc.).
2. Translate request from source format → Claude (`TranslateRequestPair…`) — translator package, out of scope. `body.model = upstreamModel`.
3. `ApplyRequestThinking` (canonical thinking → Claude `thinking`/`output_config.effort`).
4. `rebuildMidSystemMessagesToTopLevel` only if auth attr `rebuild_mid_system_message=="true"` or config flag.
5. **Cloaking** (`applyCloakingInternal`) when `policy.Cloak` — A6.
6. If cloaked && first-party base: inject `context_management` = `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` only if absent and `thinking.type ∈ {enabled, adaptive}`; and (non-probe) `diagnostics` = `{"previous_message_id":null|"msg_…"}` (A5.2).
7. `ensureModelMaxTokens`: if no `max_tokens`, set from registry `max_completion_tokens` for the model (provider "claude"), else **1024** (`defaultModelMaxTokens`).
8. `disableThinkingIfToolChoiceForced`: `tool_choice.type ∈ {any, tool}` → delete `thinking`, `output_config.effort` (and empty `output_config`).
9. `normalizeClaudeSamplingForUpstream`: non-native: delete `temperature`, `top_p` (+`top_k` if thinking active enabled/adaptive/auto). Native-confirmed: with thinking active drop temperature≠1, top_p<0.95, top_k; else if both temperature and top_p drop `top_p`.
10. Cache control (A7): `ensureCacheControl` when CPA owns placement; `enforceCacheControlLimit(4)`; strip `prompt_cache_options`; 1h TTL upgrade for OAuth/CLI profile; `normalizeCacheControlTTL`.
11. `stream` field set to `upstreamStream`.
12. Tool-name aliasing (A8) if `MCPAlias && cloaked`.
13. `sanitizeClaudeMessagesForClaudeUpstream` (drop foreign/invalid `thinking` signatures when model's signature provider is Claude; drop empty `allowed_domains`/`blocked_domains` arrays on `web_search_*` tools).
14. `applyClaudeCLIIdentity` → `metadata.user_id` (A5.1).
15. Sensitive-word obfuscation if configured (zero-width-char insertion via `helps.ObfuscateSensitiveWords`, `helps/cloak_obfuscate.go`).
16. CCH billing placeholder (A9) when signing enabled.
17. User payload rules (config `payload`) applied **once, last** — AGENTS.md barrier; then `extractAndRemoveBetas`, strip `prompt_cache_options`, then **sign CCH** (final bytes).
18. `validateClaudeMidSystemMessageModel` read-only (400, request-scoped error if a `role:"system"` message goes to a model in the legacy list on first-party/confirmed).
19. Build request, headers (A4), send.

`upstreamStream = responseFormat != claude`: downstream Claude non-stream requests use a JSON upstream call; any other downstream format (OpenAI chat/responses/Gemini) always streams upstream, even for non-stream downstream calls — the whole SSE is read into memory, validated (`validateClaudeStreamingResponse`: needs ≥1 `data:` line, valid JSON each, no `type:"error"` event [→502], `message_start` having non-empty `message.id` and `message.model`, and a `message_delta`; otherwise 502 `claude executor: …`), then handed to `TranslateNonStream`.

### A5.1 `metadata.user_id` / session / device identity
- Agent session UUID (`ClaudeAgentSessionUUIDForRequest`, `helps/claude_credential_identity.go:28-86`): from header `X-Claude-Code-Session-Id` / payload `metadata.user_id.session_id` (only if confirmed native), else protocol session ids (`cliproxyauth.ExtractSessionID`), else exec-session metadata; if value is `claude:<uuid>` or a UUID → use; else `uuidv5(NameSpaceOID, "cli-proxy-api\x00claude\x00agent-conversation\x00"+identity)`; if none → random v4.
- Cloaked OAuth/CLI-profile body: `metadata.user_id` = JSON string (compact) `{"device_id":"<64 hex>","account_uuid":"<uuid>","session_id":"<uuid>"[,extras…]}` built by `rebuildClaudeMetadataUserID` (extras of an existing JSON user_id are preserved after the three keys; duplicates → 400-ish request error). `device_id` = the credential's single stored device ID (`claude_device_ids` metadata, pool size **1**, 32 random bytes hex = 64 chars, generated at login) via `SelectDeviceID`. `account_uuid` from metadata `account_uuid|accountUuid`; if empty → error "account UUID is empty" (so OAuth credentials must have it; see below).
- Non-OAuth CLI-profile (API key / Kimi): synthesized: `device_id = hex(sha256("cpa-claude-code-cli-device|"+seed))`, `account_uuid = uuidv5(ns 6ba7b812-9dad-11d1-80b4-00c04fd430c8, "cpa-claude-code-cli-account|"+seed)`; seed = apiKey (Kimi: `auth-id|<id>` / `auth-index|…`/`auth-file|…`).
- Legacy (cloak configured but not CLI profile) fake user id (`injectFakeUserID`, `helps/cloak_utils.go`): `{"device_id":hex(32 random bytes),"account_uuid":"","session_id":uuid}`; cached per apiKey for 1h (`userIDTTL`) when `cloak_cache_user_id` (key sha256(apiKey)); session id cached per apiKey 1h (`sessionIDTTL`).
- `PrepareRequestAuth` (`claude_executor_auth.go`, `claude_executor.go:339-395`) is run before OAuth requests when the account UUID or device pool is missing: ensure device pool; if setup-token (metadata `skip_account_profile|is_setup_token|setup_token` true, `auth_kind` attr `setup_token`, or scopes lacking `user:profile`/`user:office`) → account_uuid = `StableClaudeCLIAccountUUID(seed)`; else `GET /api/oauth/profile` (timeout **10 s**) → store `account_uuid`, `email`, `organization_uuid`, `organization_name`, `claude_account_profile_checked_at`; on 403 / scope errors / empty UUID fall back to the stable UUID.

### A5.2 Continuity / diagnostics (in-memory, `helps/claude_diagnostics.go`)
Key = sha256(`credentialIdentity \0 sessionID`); TTL 1 h, max 4096 entries, evict batch 256, cleanup 15 min. Stores `previousMessageID` (`msg_…`), `previousRequestID` (response header `request-id` matching `^req_[A-Za-z0-9_-]{1,36}$`), `promptID` (UUID per user-turn), `pinnedDate`. Committed only after a complete response (`message_stop` seen / non-stream success) — so partial streams don't advance. Used for: body `diagnostics.previous_message_id`, billing header tags `cc_prev_req`, `cc_prompt_id`, and pinning the `currentDate` reminder date per session. Port to a DO/KV keyed by the same hash.

## A6. Cloaking (system prompt injection) — `checkSystemInstructionsWithSigningModeAt` (`claude_executor_cloaking.go:403`)
Applies only when `policy.Cloak`. Skipped entirely (payload untouched) for confirmed Claude Code.

Resulting top-level `system` (array): 
1. **Billing block** (no cache_control): text `x-anthropic-billing-header: cc_version=<ver>.<fp>; cc_entrypoint=cli;[ cch=00000;][ cc_workload=<w>;][ cc_is_subagent=true;][ cc_prev_req=<req_id>;][ cc_prompt_id=<uuid>;][ cc_turn_origin=human;]` — `cch`, `cc_prev_req`, `cc_prompt_id`, `cc_turn_origin` only when CCH signing is on. `ver` = version parsed from UA (default `2.1.280`). `fp` = 3 hex chars: `sha256("59cf53e54c78" + c[4] + c[7] + c[20] + ver)[:3]` where `c` = text of the first non-`<system-reminder>` text block of the first user message, indexed by **UTF-16 code unit**, missing index → `"0"`.
2. **Identity block**: `{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude.","cache_control":{"type":"ephemeral"}}` (no cache_control in explicit-cache mode).
3. For model `fable-5-1|fable-5.1|mythos-5-1|mythos-5.1` (non-probe): a third block with the "# Reporting outcomes …" paragraph (`claudeCodeFableReportingOutcomes`, `:309`).
- Caller `system` (string or text blocks; skipping empty, attribution blocks, and the identity text) is **relocated** (not kept top-level) unless `strictMode` (dropped): each block becomes its own mid-conversation message `{"role":"system","content":[{"type":"text","text":…,"cache_control":{"type":"ephemeral"}}]}` inserted after the first user turn(s) (`insertClaudeMidConversationSystemBlocks`, skips consecutive user msgs; idempotent if already present). For legacy models (A6.2) instead wrapped as `<system-reminder>\n<text>\n</system-reminder>` text blocks prepended to the first user message (after leading `tool_result` blocks). If history contains an advisor call/result, or OAuth=false and system messages already at end, blocks are kept top-level appended to `system`. For OAuth credentials caller top-level prompts are never kept top-level (triggers Anthropic third-party classifier, #6432).
- Then `injectClaudeCodeCurrentDate`: first user message gets a leading text block:
```
<system-reminder>
As you answer the user's questions, you can use the following context:
# currentDate
Today's date is YYYY-MM-DD.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>

```
  (date = session-pinned local date in tz from auth attr/metadata `timezone` / cfg `claude-header-defaults.timezone`/local; existing date reminders replaced; placed after leading tool_result blocks; the first real text block gets `cache_control:{"type":"ephemeral"}` unless explicit mode; string content → array `[dateBlock, {text, cache_control}]`.)
- JSON text blocks are serialized **without HTML escaping** (`marshalJSONStringWithoutHTMLEscape`) — required for byte-exact CCH.
- Also while cloaking: add `fallbacks:[{"model":"claude-opus-4-8"}]` for opus-5-5 and `[{"model":"claude-opus-5"}]` for fable-5-1 (non-probe, if absent); `thinking.display="updates"` for progress-display models when thinking adaptive/enabled and no display; strip cache TTLs for probes/subagents.
- `misc.ClaudeCodeInstructions` (`misc/claude_code_instructions.txt`: `[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude.","cache_control":{"type":"ephemeral"}}]`) is embedded but **not referenced** by the current executor path — legacy.

### A6.1 Probe / helper / subagent classification (`helps/claude_diagnostics.go`)
- Probe: `max_tokens==1`, no tools, and (no messages, or exactly one `user` message whose content is `quota|test|.|probe`).
- Title helper: structured output schema `output_config.format.schema.properties` having only `title`, with system instruction containing "naming a coding session"/"Return a short title"/"Write the title in the predominant language".
- Subagent: header `X-Claude-Code-Agent-Id` or `X-Claude-Code-Parent-Agent-Id` set, or `metadata.user_id` has `parent_session_id`, or `system[0].text` contains `cc_is_subagent=true`.

### A6.2 Legacy-system-reminder model list (reject mid-conversation `role:system`)
`claude-3-5-haiku-20241022|-latest`, `claude-3-7-sonnet-20250219|-latest`, `claude-haiku-4-5[-20251001]`, `claude-opus-4[-20250514]`, `claude-opus-4-1[-20250805]`, `claude-opus-4-5[-20251101]`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-4[-20250514]`, `claude-sonnet-4-5[-20250929]`, `claude-sonnet-4-6` (prefix before `/` stripped, lower-cased). Everything else (incl. unknown/future IDs) is treated as supporting role=system mid-conversation (`claude_executor_cloaking.go:524-556`).

## A7. cache_control handling (`claude_executor_cloaking.go:1664-2415`)
- Explicit mode: `prompt_cache_options.mode=="explicit"` in any of original/translated/final payload ⇒ CPA doesn't place breakpoints (and doesn't normalise TTL); `prompt_cache_options` is always stripped before sending.
- `shouldEnsureCacheControl`: not explicit AND not confirmed-native AND (cloaked OR body has 0 `cache_control`). Then `ensureCacheControl`: breakpoint on last tool *only if no cacheable system*, on **last system block**, and on the **last cacheable message** (rolling; user turns always eligible; assistant turns eligible if string content or last block isn't thinking-like; special case: final `system` message with non-empty string content is converted to a text block carrying the marker). Default marker `{"type":"ephemeral"}`.
- `enforceCacheControlLimit(max 4)` (3 if body has `thread`): strip order — system blocks earliest-first (keep last), tools earliest-first (keep last), message blocks earliest-first, then last system, last tool.
- 1h TTL: if CPA owns placement && CLI profile && (not subagent or subagent asked 1h) && not probe → every marker without `ttl` gets `"ttl":"1h"`; subagent-without-1h / probe → strip ttl from all markers.
- `normalizeCacheControlTTL`: in evaluation order tools→system→messages a 1h block must not follow a 5m block (later 1h markers downgraded: remove `ttl`).

## A8. Tool name aliasing ("OAuth tool names" / MCP alias) (`claude_executor_request.go:1649-2660`, `helps/claude_mcp_alias.go`)
Applies when `MCPAlias && cloaked` (OAuth or CLI profile). Purpose: Anthropic fingerprints non-Claude-Code tool names on OAuth traffic; every client tool name is rewritten to look like a Claude Code MCP tool and restored in responses.
- Server tools (type prefixes `advisor_`, `agent_toolset_`, `bash_`, `code_execution_`, `computer_`, `memory_`, `text_editor_`, `tool_search_tool_`, `web_fetch_`, `web_search_`) and names already matching `mcp__<server>__<tool>` (≤64 chars, `[A-Za-z0-9_-]`) are passthrough; reserved built-in names `web_search, code_execution, text_editor, computer`.
- Alias: `mcp__<w1>_<w2>__<w3>_<semantic>` where `secret` = downstream API key (`APIKeyFromContext`) or `"cpa-claude-mcp-default-caller"`; `digest(purpose,orig)=HMAC-SHA256(key=secret, "cpa-claude-mcp-alias-v2\0"+purpose+"\0"+orig)`; server words: BIP-39 English word index `BE16(digest("server","")[0:2]) % 2048` and `BE16(digest[2:4]) % 2048`; tool word index `BE16(digest("tool",orig)[0:2]) % 2048` linearly probed (+1 mod 2048) until the alias isn't reserved; `<semantic>` = original name sanitised to `[A-Za-z0-9_-]` (runs of other chars → `_`), truncated to `64 - len("mcp__"+server+"__"+word+"_")`, trimmed of `_-`, empty → `tool`. Needs the BIP-39 wordlist (`helps/claude_bip39_words.txt`, 2048 words, embedded).
- Rewrites: `tools[].name` (and deletes a `type` field on client tools such as `custom`), `tool_choice.name`, historical `tool_use.name` in messages, `tool_reference` blocks, etc. Reverse map restores names in non-stream JSON and in each SSE `data:` line (`content_block_start.content_block.name`); alias map remembered by message id so follow-up turns map back (`rememberClaudeOAuthToolAliases`, bounded in-memory store).

## A9. CCH body signing (`claude_signing.go`)
- Enabled when: OAuth token (always, any upstream) or Vertex; or API-key/delegated with CLI profile AND upstream first-party (https, default port).
- Algorithm (mimics Claude Code 2.1.220): ensure `system[0].text` starts with `x-anthropic-billing-header:` and contains `cch=00000;` (inserted right after `cc_entrypoint=<x>;`; if no billing block, prepend fallback one from A6 with `cchSigning=true`). After **all** body mutations (incl. payload rules, betas removal): take the exact final JSON bytes, replace the 5 digits with `00000`, build the hash input by (a) emptying the string value of every `"model"` member (at any depth *not* inside excluded members) and (b) removing top-level-of-each-object members named `max_tokens`, `fallbacks`, `fallback_credit_token` (with comma handling — when ≥2 consecutive excluded members are last in an object the preceding comma is intentionally kept), **without re-serialising**; `cch = lowerhex5( xxHash64(seed=0x4D659218E32A3268, normalizedBytes) & 0xFFFFF )` zero-padded to 5 chars; write back into the same 5-byte slot. Byte positions in the outgoing body must stay identical (so serialise the body once, no key reordering after signing).

## A10. Non-stream & stream handling
- Non-stream (downstream=claude): `io.ReadAll` of decoded body (Go decodes gzip/deflate/br/zstd per `Content-Encoding` *and* by magic bytes — `decodeResponseBody`, `claude_executor_request.go:888+`; on Workers `fetch` auto-decodes), set `model` back if a normalizer was used (`model`, `message.model`), restore tool names, `reporter.Publish(ParseClaudeUsage)`; response headers cloned and returned to the client.
- Stream (downstream=claude): line-oriented pass-through: scanner buffer **50 MB**; events are flushed per blank line; each line goes through tool-name restore + model restore; completion = `data:` line with JSON `type=="message_stop"`; loop breaks after the event containing it. If the upstream closes early (no `message_stop`) the scanner error (if any) is emitted as error chunk; continuity is committed only on completion.
- Stream (other downstream): same loop but `TranslateStream(claude→format)` per line.
- Usage observation: `StreamUsageBuffer.ObserveClaudeStream` collects `message_start.message.usage`/`message_delta.usage` (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens); published at stream end (also on failure).
- SSE `error` events mid-stream are not special-cased in the pass-through path (forwarded).

## A11. Error classification (`claude_executor_request.go:659-730`, `helps/claude_ratelimit.go`)
On non-2xx: body decoded + read; `classifyClaudeUpstreamErrorWithCooling(status, headers, body, modelLevelCooling)`:
- Every status 4xx/5xx: `retryAfter = ParseClaudeRateLimitReset(headers, now)` → `statusErr{code, msg: body, retryAfter}`.
- **429**: 
  - if `!modelLevelCooling` (config `claude.model-level-cooling` false) and unified-rate-limit rejection headers → `claudeRateLimitError{credentialScoped:true}` (the whole credential is cooled down).
  - elif body (lower-cased `error.message` or whole body) contains `"fast request rejected"` or (`"fast"` and (`"usage credits"` or `"credits are required"`)) → `claudeEntitlementError` (request-scoped: do **not** rotate/cool credential).
  - else `claudeRateLimitError{credentialScoped:false}` (model-level 429).
- Other statuses: plain `statusErr`.
- `ClaudeHeadersIndicateUnifiedRateLimitRejection`: headers (case-insens) `Anthropic-Ratelimit-Unified-5h-Status == rejected` or `…-7d-Status == rejected` ⇒ true; else if `Anthropic-Ratelimit-Unified-Status == rejected` ⇒ true unless it's an overage/Fable-only rejection (`…-7d_oi-Status`, `…-Overage-Status == rejected`, `…-Overage-Disabled-Reason` non-empty, or `…-Representative-Claim` contains `overage`, while shared windows are `allowed`/`allowed_warning` or have utilization in [0,1)).
- `ParseClaudeRateLimitReset`: candidate deadlines = `Retry-After` (seconds float or HTTP-date/RFC3339; skipped for overage-only rejections) + `Anthropic-Ratelimit-Unified-5h-Reset` (if 5h rejected) + `…-7d-Reset` (if 7d rejected) + `…-7d_oi-Reset` (if rejected & not overage-only) + `…-Unified-Reset` (if unified rejected, and not equal to `…-Overage-Reset` when claim is overage). Values are unix seconds (float) / RFC3339 / HTTP-date. Drop deadlines ≤ now or > **7 days + 1 h**; take the **latest**; cooldown = (deadline − now) + random fuzz **1–30 s** (inclusive, crypto-rand). None → `nil` (conductor uses its exponential backoff).
- Fast mode (`speed:"fast"` body or `fast-mode-2026-02-01` beta, first-party only): errors are wrapped as request-scoped (`claudeFastRequestError`), and non-2xx upstream responses are returned as `RequestTerminatedError` carrying the **upstream status, headers (minus Content-Encoding/Content-Length) and raw body** to the client unchanged (`claude_executor_fast_error.go`) — no retry on another credential unless the 429 is credential-scoped.
- OAuth cancellation: for OAuth creds, `context.Canceled` errors are wrapped request-scoped (`claudeOAuthCancellationError`) so client disconnects never cool the credential.
- 403 on profile lookup is "scope" error → fallback identity (A5.1).
- The conductor (not in this file set) treats: 401 ⇒ refresh-and-retry; 429/5xx cooldown etc. — see the conductor research doc.

## A12. Count tokens
- Upstream when `apiKey != ""` and base is first-party: same translation/cloaking policy but `system` is **not** replaced by the billing/identity blocks (caller system relocated into messages, `metadata`/`context_management`/`diagnostics` deleted; CLI-profile also strips attribution system text); extra beta `token-counting-2024-11-01`; reply `input_tokens` read from JSON. Headers via `applyClaudeHeaders` with the count-tokens beta list; no `X-Stainless-Timeout`.
- Local (otherwise): validates (messages non-empty array, roles user/assistant, content string or typed blocks; else 400 request-scoped), then `CountClaudeInputTokens` = tiktoken-based estimate (`helps/claude_input_tokens.go`), returned as `{"input_tokens":N}` translated to the response format.

## A13. OAuth lifecycle (`auth/claude/anthropic_auth.go`)
| Item | Value |
|---|---|
| Public client id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Authorize URL params | `code=true&client_id&response_type=code&redirect_uri=http://localhost:54545/callback&scope=user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload&code_challenge&code_challenge_method=S256&state` |
| Code exchange body (JSON) | `{grant_type:"authorization_code", code, redirect_uri, client_id, code_verifier, state}`; pasted code may be `code#state` (split on `#`) |
| Refresh body (JSON) | `{"client_id":…,"grant_type":"refresh_token","refresh_token":…,"scope":"<same scope string>"}` |
| Request headers (all OAuth calls) | `Accept: application/json, text/plain, */*`, `Content-Type: application/json`, `User-Agent: axios/1.15.2`, `Accept-Encoding: gzip, compress, deflate, br`, `Connection: close`; GETs add `Authorization: Bearer <token>`, `Cache-Control: no-cache` |
| Token response | `access_token, refresh_token, token_type, expires_in (sec), organization{uuid,name}, account{uuid,email_address}`; expiry stored as RFC3339 `expired` = now+expires_in |
| Refresh policy | `RefreshLead` = **4 h** before expiry (`sdk/auth/claude.go:34`); executor `Refresh` uses `RefreshTokensWithRetry(max 3)`: sleep `attempt` seconds between attempts; retries only for HTTP ≥500 (transport errors are NOT retried — refresh tokens are single-use); on 429 stores a per-refresh-token block until `Retry-After`/`Retry-After-Ms` (clamped **5 s – 5 min**, default 5 s) and fails non-retryable; singleflight keyed by refresh token; context timeout **30 s** (handshake 10 s). If response lacks `refresh_token`, old one is kept. After refresh it calls `/api/oauth/profile` best-effort (warn on failure) to fill email/account_uuid/org. |
| Stored credential JSON fields (`ClaudeTokenStorage`, `auth/claude/token.go`) | `id_token, access_token, refresh_token, last_refresh, email, account_uuid, organization_uuid, organization_name, claude_device_ids[], type:"claude", expired` |
| After code exchange | generate device pool (1 id), fetch profile + roles (best-effort) |
| PKCE | S256, verifier = base64url(96 random bytes) (`auth/claude/pkce.go:41`) |
| Refresh in `Refresh()` | writes metadata `access_token, refresh_token, email, account_uuid, organization_uuid, organization_name, expired, type="claude", last_refresh` (never erases previously resolved identity if empty) |

## A14. Misc
- Thinking replay (`claude_thinking_replay.go`): only for **API-key + compat-model + Claude-format source + non-OAuth key**: caches the assistant `thinking` content per (model family, session key) in a bounded LRU and re-injects it on the next request (used for Kimi-style Anthropic-compatible upstreams); cleared after certain errors.
- Responses compaction (`claude_executor_compaction.go`): Responses `compaction` items with CPA/Antigravity capsule format are expanded into plain context before translation; foreign compaction items are dropped (warning); a `compaction` trigger (`opts.Alt=="responses/compact"`) runs a summarisation request through Claude (`executeClaudeCompaction[Stream]`) and re-encodes a capsule (`helps.ExpandAntigravityCompactionCapsules`).
- `X-Claude-Code-Session-Id` etc. forwarded as above; `ScrubProxyAndFingerprintHeaders` (`misc/header_utils.go`) is for Antigravity, not Claude.
- Claude executor `Identifier()` = `"claude"`; `SupportsApplyPatch()=true` (translator converts Responses `apply_patch`).

---

# PART B — CODEX (ChatGPT backend "Codex" Responses API)

Files: `runtime/executor/codex_executor*.go` (`_execute`, `_stream`, `_request`, `_auth`, `_terminal`, `_reasoning`, `_tokens`), `codex_openai_images.go`, `codex_websockets_*.go`; `helps/codex_*.go`, `helps/cache_helpers.go`, `helps/derived_session.go`, `util/codex.go`, `util/header_helpers.go`; `auth/codex/*`; translator defaults `translator/codex/openai/chat-completions/codex_openai_request.go`.

## B1. Endpoints

Default `baseURL = "https://chatgpt.com/backend-api/codex"` (from `auth.Attributes["base_url"]`, else this) — `codex_executor_execute.go:30-32`. A `codex-api-key` entry may point to any OpenAI-Responses-compatible base URL (`Attributes.api_key` + `base_url`); then it is treated as API-key auth (different headers, see B3).

| Purpose | Request |
|---|---|
| Streaming and non-stream chat | `POST {base}/responses` (always `stream:true` upstream; non-stream callers aggregate SSE until terminal event) |
| Compaction (`opts.Alt=="responses/compact"`) | `POST {base}/responses/compact`, **non-stream**, `Accept: application/json`, target format `openai-response`, `stream` field deleted; response body is JSON and translated (usage via `ParseOpenAIUsage`). Streaming compact → 400 `"streaming not supported for /responses/compact"`. WS executor always uses HTTP for compact. |
| Image generation (OpenAI Images API compat) | via Responses with `image_generation` tool (B9) or direct `{base}/images/generations`, `{base}/images/edits` |
| Upstream WebSocket | `wss://chatgpt.com/backend-api/codex/responses` (http→ws, https→wss of `{base}/responses`) |
| Token counting | **local only** (no upstream endpoint): tiktoken (B8) |
| OAuth | `https://auth.openai.com/oauth/authorize`, `https://auth.openai.com/oauth/token` (B10) |

## B2. Which transport is used (`codex_websockets_executor.go:47-150`)
`CodexAutoExecutor` (the registered "codex" executor): 
- **Upstream WebSocket is used only if** the downstream client connected over WebSocket (`cliproxyexecutor.DownstreamWebsocket(ctx)`, i.e. the client hit the Responses WS endpoint) **and** the credential enables websockets (`auth.Attributes["websockets"]` parsed bool, else `auth.Metadata["websockets"]` bool/string).
- Otherwise ordinary HTTP SSE (`CodexExecutor`). If `RequiredUpstreamWebsocket(ctx)` (a continuation that must reuse an existing upstream socket) but WS isn't possible ⇒ returns `UpstreamWebsocketReplayRequiredError` (downstream replays full context).
- WS handshake `426 Upgrade Required` ⇒ falls back to HTTP executor when not in a WS lifecycle; other handshake HTTP statuses are classified by `newCodexStatusErrWithCooling`.
- `CountTokens` and `Refresh` always go to the HTTP executor.

## B3. Headers (`applyCodexHeadersFromSources`, `codex_executor_request.go:195-260`)
Order: base → client-forwarded → defaults → custom → cloaking.

| Header | Value / rule |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <access_token or api key>` (`codexCreds`: `Attributes.api_key` else `Metadata.access_token`) |
| `Accept` | `text/event-stream` (stream) / `application/json` (compact, direct images non-stream) |
| `Connection` | `Keep-Alive` |
| `User-Agent` | OAuth creds: `cfg.codex-header-defaults.user-agent` → client's UA → fixed `codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)` (`codexUserAgent`). API-key creds: cfg default ignored; client UA else fixed. **Then "cloaking" overrides**: unless `disable-codex-cloaking` (global `codex.disable-codex-cloaking`, per-key `disable-codex-cloaking`, or auth attribute `disable_codex_cloaking`) the UA is forced to the fixed string and `Originator: codex-tui` — only when `cfg != nil`. Also model-level `override_header` in the registry (`models.json` `config.override_header` has `user-agent` and `originator` for several codex models) is applied last (`applyModelHeaderOverrides`). |
| `Originator` | client's `Originator` if sent, else `codex-tui` for OAuth creds (not set for API-key creds); cloaking forces `codex-tui` |
| `Chatgpt-Account-Id` | OAuth creds only: `auth.Metadata["account_id"]` (from id_token claim `https://api.openai.com/auth`.`chatgpt_account_id`) |
| `Session-Id` | the prompt-cache id (`cache.ID`, B4) set in `cacheHelper`; a non-empty client `Session-Id` header **overrides** it (`misc.EnsureHeader` prefers the source header); if the UA contains "Mac OS" and the model has an override and no session header is present: `Session_id: <uuid v4>` |
| `X-Codex-Beta-Features` | copied from client if present (cfg `codex-header-defaults.beta-features` used only on WS path) |
| Pass-through from client if present | `Version`, `X-Codex-Turn-Metadata`, `X-Codex-Turn-State`, `X-Client-Request-Id`, `X-Codex-Window-Id`, `Thread-Id`, `Session-Id`, `X-Openai-Internal-Codex-Responses-Lite` |
| `X-Codex-Routing-Hint` | OAuth creds only: `model=<baseModel>` + `;tier=<service_tier>` when the final body has a string `service_tier` (e.g. `model=gpt-5.5;tier=priority`); operator `header:X-Codex-Routing-Hint` attr wins; API-key creds: none |
| custom headers | `auth.Attributes["header:<Name>"]=value`; value starting with `$NAME` copies the client's header `NAME` (omitted if absent); `$CPA-SESSION-ID` expands to the internal session id (`util/header_helpers.go`) |

Direct `/images/*` calls do **not** forward the client `User-Agent` ("to reduce Cloudflare 1010 blocks"). `X-Openai-Internal-Codex-Responses-Lite: true` (header, or body `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite`) marks a "responses-lite" native Codex request: skips image-generation tool injection and forces `parallel_tool_calls=false`.

**TLS/CF:** requests to host `chatgpt.com` use a uTLS Chrome fingerprint (`tls.HelloChrome_Auto`, ALPN-driven h2/http1.1; one connection per request) — `helps/utls_client.go:fallbackRoundTripper`. Purpose: avoid Cloudflare bot challenges (error 1010 / 403) on chatgpt.com. On Workers this cannot be reproduced; keep the official-client headers above (UA, Originator, account id) as the only mitigation.

## B4. Request body pipeline (HTTP) — `codex_executor_execute.go:Execute` / `codex_executor_stream.go:ExecuteStream`
1. Translate source→codex (`translator/codex/...`). Codex-format defaults from the OpenAI-chat translator: `{"instructions":"", "stream":…, "parallel_tool_calls":true, "include":["reasoning.encrypted_content"], "store":false, "model":…, "reasoning.effort": <req or "medium">, "service_tier": …}`; **temperature/top_p/max_output_tokens are intentionally not forwarded** (backend rejects). System messages become `developer` role messages.
2. `ApplyRequestThinking` (canonical thinking → `reasoning.effort`/`summary`).
3. `model = baseModel` (suffix stripped), `stream=true`; **delete** `previous_response_id`, `generate`, `prompt_cache_retention`, `safety_identifier`, `stream_options` (in stream path `stream_options.reasoning_summary_delivery` is re-added if the caller sent it).
4. `normalizeCodexInstructions`: if `instructions` missing/null → `""` (skipped for native Codex/Responses requests).
5. `ensureImageGenerationTool` (unless `disable-image-generation` ≠ off, lite requests, model suffix `spark`, free-plan creds i.e. `Attributes.plan_type=="free"`): append tool `{"type":"image_generation","output_format":"png"}` if no image_generation tool (or `image_gen.imagegen` function/namespace) present.
6. `sanitizeOpenAIResponsesReasoningEncryptedContent`: drop/repair `reasoning` input items whose `encrypted_content` is foreign/invalid for this provider (signature provider detection in `internal/signature`), promote `reasoning_text` content → `summary_text`, strip orphan reasoning `id`s when `store` is not true (otherwise backend says "Item with id … not found. Items are not persisted when store is set to false").
7. `normalizeCodexParallelToolCalls`: drop `parallel_tool_calls` if no tools; lite request ⇒ false.
8. `NormalizeCodexToolSchemas` (`helps/codex_tool_schema.go`): collapse pure-constant `oneOf/anyOf` unions (≥ threshold branches, e.g. MCP enums) into `enum`, sanitize unsupported schema patterns.
9. `OptimizeCodexMultiAgentV2RequestForAuth` (`helps/codex_multi_agent_v2.go`, `internal/.../multiagentv2`): config-gated rewrite of official-Codex multi-agent (`spawn_agent`/collab namespace) tools and `agent_message` items; response events restored via `RestoreCodexMultiAgentV2Response`.
10. Reasoning replay (Claude-source only, B7).
11. `cacheHelper`: determine `prompt_cache_key` (`cache.ID`):
    - source Claude: `uuidv5(NameSpaceOID, "cli-proxy-api:codex:claude-code\0<model>\0<executionScope>")` where executionScope = Claude Code session id (header `X-Claude-Code-Session-Id` or `metadata.user_id` suffix `_session_<id>`/JSON session_id) + agent id (`X-Claude-Code-Agent-Id`, else `main`);
    - source OpenAI-Responses: client's `prompt_cache_key`;
    - source OpenAI chat: client's `prompt_cache_key`, else `ProviderSessionUUID("codex", metadata)`, else `uuidv5(OID,"cli-proxy-api:codex:prompt-cache:"+downstreamAPIKey)`;
    - fallback: `ProviderSessionUUID("codex", req.Metadata)` = `uuidv5(NameSpaceOID, "cli-proxy-api\0codex\0execution-session|derived-session\0<id>")`.
    - Sets body `prompt_cache_key`, header `Session-Id`.
12. `SanitizeCodexInputItemIDs`: input item `id`s normalised by prefix (`msg`, `rs`, `fc`, `ctc`, `ctco`), limit **64** chars; encrypted reasoning items with >64-char ids are dropped; other overlong ids deterministically shortened (sha256-based) with collision handling.
13. Payload finalizer (user `payload` rules) is applied last (`helps.FinalizePayload`).
14. Send POST; no client timeout after connect.

## B5. Response handling
### Non-stream (`Execute`)
Read full SSE body; for each `data:` line: `response.output_item.done` events are collected by `output_index` (fallback list when no index); terminal failures (B6) abort; on first `response.completed`/`response.incomplete`: if empty-incomplete (B6) → error; else patch `response.output` from collected items when upstream's `output` array is empty (`patchCodexCompletedOutput`; also hydrates empty item ids by index), translate with `TranslateNonStream`, publish usage (`ParseCodexUsage`) and image-tool usage. Missing terminal → `408 "stream error: stream disconnected before completion: stream closed before response.completed"` (request-scoped).
### Stream
`bufio.Scanner` buffer 50 MB; each line: `data:` → trim, restore multi-agent-v2, observe TTFT/model, detect terminal failure/empty-incomplete, collect `output_item.done`, on `response.completed|response.incomplete|response.done` → `response.done` renamed to `response.completed` (`normalizeCodexWebsocketCompletion`), patch output (unless native Codex passthrough), publish usage, cache reasoning replay, then translate and stop. Non-`data:` lines (event:, comments, blank) pass through the translator unchanged. Stream ends without terminal: if nothing emitted → `502 "upstream stream closed before first payload"`; else `408` incomplete-stream error as in-stream chunk.
Usage fields (`helps.ParseCodexUsage`): from `response.usage` (`input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`) + image tool usage `response.tool_usage.image_gen`.
### Bootstrap buffering (optional, `codex.stream-bootstrap-buffering`, default **false**)
Purpose: ChatGPT sends overload rejections *inside an HTTP-200 stream* right after handshake frames; buffering keeps downstream headers uncommitted so the conductor can fail over. Hold only "bufferable" events: empty `data:`, `response.created`, `response.in_progress`, `codex.rate_limits`, `codex.response.metadata`, `keepalive`, `response.output_item.added` of empty message/reasoning(no encrypted_content)/function_call(no args)/custom_tool_call(no input), `response.content_part.added` / `response.reasoning_summary_part.added` with empty text/refusal part; non-data SSE lines held with their frame. Limits: **48 frames** (`codexBootstrapMaxBufferedFrames`), **1 MiB** (`codexBootstrapMaxBufferedBytes`), optional `codex.stream-bootstrap-timeout` (default 0 = unlimited; accepts Go durations or seconds). If a terminal failure arrives while buffering and `isCodexOverloadBootstrapFailure` (capacity msg, `error.type=="service_unavailable_error"`, `error.code=="server_is_overloaded"`, `rate_limit_error`/`rate_limit_exceeded`, or server_error containing "you can retry your request") and time budget not exhausted → fail the *attempt* with HTTP **503** statusErr (so conductor retries another credential); otherwise the failure is delivered in-stream. Stream closing during bootstrap → "upstream stream closed before first payload" 502 as empty closed stream result, or incomplete error.

## B6. Error classification (`codex_executor_terminal.go`, `codex_websockets_errors.go`)
HTTP non-2xx: `newCodexStatusErrWithCooling(status, body, modelLevelCooling)`:
- `isUsageLimit` = body `error.type` or `type` == `usage_limit_reached` (case-insens). `credentialScoped = isUsageLimit && !cfg.codex.model-level-cooling`.
- if usage-limit **or** "model capacity" (`error.message`/`message`/body contains "model is at capacity", "model_at_capacity", "model_is_at_capacity", or ("model" and "at capacity")) ⇒ status forced to **429**.
- Body rewrite (`classifyCodexStatusError`) to `{"error":{"message","type","code"}}` when:
  - 413, or code `context_length_exceeded`/`context_too_large`, or invalid-request with message containing context length/window/too many tokens ⇒ code `context_too_large`, type `invalid_request_error`;
  - body contains "invalid signature in thinking block" / "invalid_encrypted_content" ⇒ `thinking_signature_invalid` (also clears the reasoning replay cache for the session);
  - `previous_response_not_found` ⇒ same code;
  - 401 / `authentication_error` / `invalid_api_key` / "invalid or expired token" / refresh-token phrases ⇒ `auth_unavailable`, type `authentication_error`.
- `retryAfter` (only for 429 + `usage_limit_reached`): `error.resets_at` (unix seconds, if in the future) → `resets_at − now`; else `error.resets_in_seconds` → seconds. (No `Retry-After` header parsing for Codex.)
In-stream failures (`error` event and `response.failed`): `codexTerminalFailureBody` normalises to `{"error":{…},"sequence_number"}`; handled terminal conditions (`codexTerminalStreamErrShouldHandle`): context-length, usage-limit, model-capacity, thinking_signature_invalid → status 400 base (then rewritten to 429 for limit/capacity); all other terminal failures get status from `error.status_code|status` (400–599) else mapped from type/code: `cyber_policy`→400, `not_found_error|not_found|model_not_found`→404, `authentication_error|invalid_api_key|unauthorized`→401, `permission_error|forbidden|permission_denied`→403, `rate_limit_error|rate_limit_exceeded`→429, `invalid_request_error|bad_request_error`→400, default **502**.
Empty incomplete: `response.incomplete` with no non-empty text/reasoning/arg deltas, no output items, `response.usage.output_tokens` exactly integer `0` ⇒ 502 `"stream error: upstream terminated with incomplete empty response (0 tokens)"` (request-scoped).
Request-scoped errors (don't cool credential): incomplete stream (408), empty-incomplete (502), WS message-too-big.
Codex quota/rate-limit event `codex.rate_limits` (WS path and HTTP SSE) is parsed by `helps.ParseCodexQuotaEventHeaders` into headers `X-Codex-{Primary,Secondary}-{Used-Percent,Window-Minutes,Reset-After-Seconds,Reset-At}`, `X-Codex-Allowed`, `X-Codex-Limit-Reached`, `X-Codex-Additional-<limit>-…` (max 8), `X-Codex-Plan-Type`, `X-Codex-Credits-*`, `Retry-After`, `X-Ratelimit-*` for the quota state; source JSON paths `rate_limits.{allowed,limit_reached,primary|secondary.{used_percent,window_minutes,reset_after_seconds,reset_at}}`, `additional_rate_limits` (object or array).

## B7. Reasoning replay cache (Claude-format callers only) — `codex_executor_reasoning.go`
For source=Claude (Claude Code via Codex backend): caches Codex `reasoning`, `function_call`, `custom_tool_call` output items from each completed response keyed by (model, sessionKey) with a marker item `{type: CodexReasoningReplayTurnType, id: sha256(requestFingerprint|assistantFingerprint|callIds|items), assistant_fingerprint, request_fingerprint, call_ids[]}`; on the next request, inserts cached items back into `input` at the anchor found by matching prefix fingerprints (incremental sha256 over input items) and aligns tool-call ids (shortening ids >64). Session key priority: Claude Code execution scope; `execution:<exec-session-id>`; payload `prompt_cache_key`/`session`-like fields; headers (`Session-Id`, `X-Codex-Turn-Metadata`.session id); (OpenAI source) `prompt-cache:<uuidv5>`. Storage: bounded cache (`internal/cache`), optional "home" KV. Cleared when upstream says `thinking_signature_invalid`. Port: DO/KV with TTL.

## B8. Count tokens
No upstream call. `tokenizerForCodexModel`: `gpt-5*`→GPT5 encoding, `gpt-4.1*`, `gpt-4o*`, `gpt-4*`, `gpt-3*`, default cl100k_base; counts text of the translated codex body (instructions, input items, tools) and returns `{"response":{"usage":{"input_tokens":N,"output_tokens":0,"total_tokens":N}}}` then translated to the downstream format.

## B9. Images
- Source format `openai-image` with request path ending `/v1/images/generations` or `/v1/images/edits` (`codex_openai_images.go`).
- **Direct path** (model ∈ `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.5`, optional `provider/` prefix and thinking suffix stripped): `POST {base}/images/generations` or `{base}/images/edits`; body = caller's JSON (or multipart for edits, converted to JSON when needed: `images[]`, `mask` as data URLs/`image_url`) with `model` set; stream flag set per request; same Codex headers via `applyCodexDirectImageHeaders` (no client UA). Response returned as-is (OpenAI `{created,data:[{b64_json|url}],usage}`); usage via `ParseOpenAIUsage`; errors via `newCodexStatusErrWithCooling`.
- **Responses-tool path** (other models, e.g. route model via `gpt-image-2` tool): builds Responses request  
  `{"instructions":"","stream":true,"reasoning":{"effort":"medium","summary":"auto"},"parallel_tool_calls":true,"include":["reasoning.encrypted_content"],"model":"<main model>","store":false,"tool_choice":{"type":"image_generation"},"tools":[{"type":"image_generation","action":"generate"|"edit","model":<image model, default "gpt-image-2">, size,quality,background,output_format,moderation (strings), output_compression,partial_images (ints)}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":prompt},{"type":"input_image","image_url":"<data URL or URL>"}…]}]}` with main model `cfg.gpt-image-2-base-model` (must start with `gpt-`) else `gpt-5.4-mini`; POST `{base}/responses` (SSE). Results = `image_generation_call` items (`result`=base64, `revised_prompt`, `output_format`, `size`, `background`, `quality`) → OpenAI Images response `{"created": response.created_at|now, "data":[{"b64_json"|"url":"data:<mime>;base64,…","revised_prompt"}], "usage": response.tool_usage.image_gen}`; streaming emits SSE `event: image_generation.partial_image` / `image_edit.partial_image` (`partial_image_index`, `b64_json|url`) and `….completed`. `response_format=url` yields data URLs.
- Uses `helps.NewProxyAwareHTTPClient` (not uTLS) for the images calls.

## B10. OAuth lifecycle (`auth/codex/openai_auth.go`)
| Item | Value |
|---|---|
| Client id (public) | `app_EMoamEEZ73f0CkXaXp7hrann` |
| Authorize | `https://auth.openai.com/oauth/authorize?client_id&response_type=code&redirect_uri=http://localhost:1455/auth/callback&scope=openid email profile offline_access&state&code_challenge&code_challenge_method=S256&prompt=login&id_token_add_organizations=true&codex_cli_simplified_flow=true` |
| Code exchange | `POST https://auth.openai.com/oauth/token`, `application/x-www-form-urlencoded`: `grant_type=authorization_code, client_id, code, redirect_uri, code_verifier`; `Accept: application/json` |
| Refresh | same URL, form: `client_id, grant_type=refresh_token, refresh_token, scope="openid profile email"` |
| Token response | `access_token, refresh_token, id_token, token_type, expires_in` |
| id_token | JWT decoded **without signature verification** (`jwt_parser.go`): `email`, claim `https://api.openai.com/auth`.{`chatgpt_account_id`, `chatgpt_plan_type`, `organizations[]`, …} → stored `account_id`, `plan_type` (default `free`), `email`; expiry = now + expires_in (RFC3339 `expired`) |
| Refresh policy | `RefreshLead` = **24 h** (`sdk/auth/codex.go:34`); `RefreshTokensWithRetry(max 3)`, sleep `attempt` s between; non-retryable only if error text contains `refresh_token_reused`; singleflight by refresh token; 30 s timeout. On success updates metadata `id_token, access_token, refresh_token (if non-empty), account_id, email, expired, type="codex", last_refresh, plan_type` and `Attributes.plan_type`. If the refresh token is empty returns auth unchanged. |
| Stored file JSON | `id_token, access_token, refresh_token, account_id, last_refresh, email, type:"codex", expired, plan_type` |
| PKCE | S256, verifier base64url(96 random bytes) |
| Login | local callback server port 1455 path `/auth/callback` **[CF-BLOCKER]** |
Plain `application/x-www-form-urlencoded` POSTs with no special headers — port as `fetch`.

## B11. WebSocket transport (upstream) — `codex_websockets_*.go`
**When:** B2. **Why:** keeps one upstream socket per execution session so the client can send `previous_response_id` continuations and response steering without resending history.

- URL: `wss://chatgpt.com/backend-api/codex/responses` (scheme swap of the HTTP URL; `base_url` override honoured).
- Handshake headers (`applyCodexWebsocketHeaders`): `Authorization: Bearer …`; `OpenAI-Beta: responses_websockets=2026-02-06` (client value kept only if it already contains `responses_websockets=`); `User-Agent` (OAuth: cfg → client → fixed codex-tui UA; API key: client only); `Originator` (client or `codex-tui` for OAuth); `ChatGPT-Account-ID: <account_id>` (OAuth only; **note exact casing** — preserved via direct map write); `session_id: <uuid>` (lower-case, underscore; from cache id / client `Session-Id|Session_id|session_id`; fallback random uuid when UA contains "Mac OS"; `Session-Id` hyphen form is removed); `Conversation_id: <cache id>` (when cache id known); pass-through from client: `x-codex-beta-features` (cfg default first), `x-codex-turn-state`, `x-codex-turn-metadata`, `x-client-request-id`, `x-responsesapi-include-timing-metrics`, `Version`, `X-Openai-Internal-Codex-Responses-Lite` (native only); `X-Codex-Routing-Hint` as B3; custom `header:*`; cloaking UA/Originator override as B3. When cloaking disabled and request native: `session_id`/`conversation_id`/`thread-id`/`x-codex-routing-hint`/`x-codex-window-id` come from the client verbatim.
- Dialer: gorilla, handshake timeout **30 s**, per-message-deflate negotiated (outbound compression disabled), TCP dial timeout/keepalive 30 s, proxy per-credential (SOCKS5/HTTP) **[CF-BLOCKER]**.
- Framing: text frames only; binary frame = error "unexpected binary message" (session invalidated). Client→upstream: the Responses request JSON with an added top-level `"type":"response.create"` (`frameCodexWebsocketRequestBody`), after `SanitizeCodexInputItemIDs` and payload finalizer (framing added last). Body differs from HTTP: `previous_response_id` and `generate` are **kept** (only `prompt_cache_retention`/`safety_identifier` removed), `stream:true`. Large messages written in **32 KiB** chunks via a single message writer. Control frames forwarded from client: `response.append`, `response.interrupt` (written verbatim, no payload-rule rewriting), steering.
- Upstream→client events: JSON text frames identical to SSE `data:` payloads (`response.created`, `response.output_text.delta`, `response.output_item.done`, `response.completed` / `response.done` (renamed to completed) / `response.incomplete` / `response.failed`, `error`, `codex.rate_limits`, …). Each frame is re-emitted downstream as `data: <json>` (`encodeCodexWebsocketAsSSE`) for HTTP/SSE downstreams, or forwarded as WS frames.
- `error` frames: `{"type":"error","status"|"status_code":429,"error":{…}|"body":{"error":…},"headers":{…}}` → `statusErrWithHeaders` (status required > 0; headers filtered to quota/ratelimit names); `websocket_connection_limit_reached` ⇒ retryAfter 0 (immediate retry/other credential); usage-limit retry-after as B6; close code 1009 (message too big) ⇒ 413 `{"error":{"message":"upstream websocket message too big","type":"invalid_request_error","code":"message_too_big"}}` (request-scoped).
- Liveness: read deadline **5 min** (`codexResponsesWebsocketIdleTimeout`) re-armed before every read; upstream pings answered with pong (10 s write deadline); no client-initiated pings. Idle sockets are kept per execution session until `CloseExecutionSession`, auth change (target change: authID/wsURL/proxy) or error. Ephemeral session (no execution session id) = one socket per request, closed afterwards.
- Session store: process-global `map[executionSessionID]*session` with per-session request mutex (`reqMu`), active-read channel, last-event tracking; `UpstreamDisconnectChan` notifies the downstream WS handler. On send failure with a retained socket: invalidate, redial once and resend (unless request-scoped); with `RequiredUpstreamWebsocket` instead return replay-required.
- Terminal events (`isTerminalEvent`): `response.completed|done|incomplete|failed`, `error`.
- Non-stream over WS (`Execute`): same collect-until-terminal logic as HTTP.
- **Response steering / full duplex** (`codex.response-steering`, default false; `codex_websockets_duplex.go`): downstream WS may send `response.create`/`response.append` while a response is running; limits "too many outstanding response.create requests"; tracks `previous_response_id` chains; no redial/replay. Treat as optional/advanced.
- Codex Live WebRTC media relay (`codex.live-media-relay`) is a separate local UDP feature **[CF-BLOCKER]** — out of scope.
- **Workers mapping:** outbound WS via `fetch(url, {headers:{Upgrade:'websocket',…}})` returns `response.webSocket`; a Durable Object per execution session can own the socket (hibernation not usable for outbound sockets). TLS fp/`Sec-WebSocket-Extensions` not controllable.

---

# PART C — OPENAI-COMPATIBLE (`OpenAICompatExecutor`, `runtime/executor/openai_compat_executor.go`)

One executor instance per configured provider (`openai-compatibility[]` entry in config, e.g. "openrouter"); `Identifier()` = provider name. Everything is plain `fetch`-able **[CF-OK]** (no utls; uses `helps.NewProxyAwareHTTPClient`, per-credential proxy optional **[CF-BLOCKER only for proxy]**).

## C1. Config schema (`config/config_types.go:836-935`)
`openai-compatibility[]`: `name`, `priority` (int), `disabled`, `prefix` (model alias namespace e.g. `teamA/kimi-k2`), `base-url`, `api-key-entries[]` {`api-key`, `weight` (default 1; ≤0 excludes; max 1,000,000 — weighted round-robin), `proxy-url`}, `models[]` {`name` (upstream), `alias` (client-facing), `display-name`, `max-context-length`, `force-mapping` (rewrite response `model` back to alias), `image` (callable via /v1/images/*), `input-modalities[]`, `output-modalities[]`, `is-compat` (preserve Claude thinking blocks for compatible upstream), `use-max-completion-tokens`, `thinking` (registry ThinkingSupport; default levels low/medium/high)}, `headers{}` (extra upstream headers → stored as auth attribute `header:<name>`), `support-prompt-cache-key`, `disable-cooling` (*bool), `request-retry` (*int; nil/negative → global), `request-scoped-errors[]` {`status`, `match[]` substrings, `match-regexr[]`, `action`: `stop`|`stop-and-cooldown`|`continue`|`continue-and-cooldown`} (classification applied by the conductor).
Resolved per attempt: `auth.Attributes.base_url`, `auth.Attributes.api_key` (`resolveCredentials`); missing base URL ⇒ `401 "missing provider baseURL"`. Compat config lookup order: `config_index` attr (config-sourced auths) → `compat_name` / `provider_key` attrs / `auth.Provider` matched case-insensitively with `name` (skipping disabled).

## C2. Endpoints & headers
| Purpose | Request |
|---|---|
| Chat (stream & non-stream) | `POST {base-url trimmed of trailing "/"}/chat/completions` |
| Responses compaction (`opts.Alt=="responses/compact"`, source Responses) | `POST {base}/responses/compact` (target format `openai-response`; `stream` deleted; reasoning encrypted_content sanitised) — non-stream only |
| Images | `POST {base}/images/generations` or `/images/edits` (source format `openai-image`; request path suffix decides, default generations); multipart for edits |
| Token counting | local tiktoken (no upstream call) |

Headers: `Content-Type: application/json` (images: caller's content-type, or the rebuilt multipart boundary); `Authorization: Bearer <api_key>` (omitted if empty); `User-Agent: cli-proxy-openai-compat` (fixed); stream: `Accept: text/event-stream`, `Cache-Control: no-cache`; then custom headers (`header:*` attrs, `$ClientHeader` / `$CPA-SESSION-ID` dereferencing, same helper as Codex B3) which may override anything. **No** Anthropic/OpenAI-org specific headers.

## C3. Request shaping (Execute / ExecuteStream)
1. Translate source→`openai` (chat completions). Thinking applied by the canonical pipeline (`internal/thinking`) → `reasoning_effort` etc.
2. If the model config says `input-modalities` excludes images: `NormalizeOpenAIToolResultsTextOnly` — tool message content flattened to strings; image parts replaced with `[image omitted: unsupported by upstream]` (Claude tool-result-image relay notices `Images returned by the preceding tool call(s):` / `[Tool returned image content; the images follow in the next user message.]` handled).
3. `NormalizeOpenAIMaxTokens(useMCT)`: model `use-max-completion-tokens: true` ⇒ rename `max_tokens`→`max_completion_tokens` (delete the other); false ⇒ the reverse. Not applied for compact.
4. `prompt_cache_key` (only when `support-prompt-cache-key`): precedence — client's `prompt_cache_key` (req payload / original / translated) → (Claude source) `uuidv5(OID,"cli-proxy-api:codex:claude-code\0model\0scope")` → `uuidv5(OID, "cli-proxy-api:openai-compat:prompt-cache\0<provider lc>\0<model lc>\0<source format lc>\0<provider session uuid>")` where session uuid = `ProviderSessionUUID(provider, opts.Metadata, req.Metadata)`.
5. Streaming only: `stream_options.include_usage = true` forced.
6. User `payload` config rules applied last (`ApplyPayloadConfigWithRequest`).
7. No client-side timeout once connected; `http.Client` has no overall timeout.

## C4. Response handling
- **Non-stream:** read body; `reporter.ObserveResponseModel`; translate `openai`→source via `TranslateNonStream`; usage from `usage` (`ParseOpenAIUsage`: `prompt_tokens|input_tokens`, `completion_tokens|output_tokens`, `total_tokens`, `*_tokens_details.cached_tokens`, `*cache_write/creation_tokens`, `reasoning_tokens`, + response `service_tier`).
- **Stream:** SSE frame parser (`bufio.Scanner`, 50 MB max line). Frame = optional `event:` + one or more `data:` lines, flushed on blank line; comment lines `:`, `id:`, `retry:` ignored; a bare `{`/`[` line (non-SSE JSON error body inside a 200) ⇒ stream error 502 with the JSON as message. Frame rules: no data + error-named event (`error`, `response.error`, `response.failed`) ⇒ 502 `"upstream error event ended without data"`; multiple data lines containing `[DONE]` ⇒ 502 "ended with incomplete data before [DONE]"; non-JSON data (and not `[DONE]`) ⇒ 502 "incomplete SSE data frame"; data payload that is an error (`error`/`response.error` non-null, `type` ∈ error/response.error/response.failed, error-named event, or top-level `code`+`message`) ⇒ statusErr with status from `status|status_code|error.status|error.status_code|response.error.status[_code]` in 400–599 else 502, message = raw payload (logged redacted as "upstream stream returned an error payload"). Otherwise forwarded as `data: <payload>` to the translator. `[DONE]` ends the stream. Missing `[DONE]`: for Responses downstream ⇒ 502 `"upstream stream closed before [DONE]"` (unless the translator can finalize); other protocols get a synthesized `[DONE]` (tolerates providers omitting it). Read error before `[DONE]` ⇒ error chunk.
- Images stream: raw byte passthrough in 32 KiB reads with response-model observer; non-2xx → `statusErr{code, body}` without Retry-After parsing.

## C5. Errors / retry-after (`newOpenAICompatStatusError`, `openAICompatRetryAfter`)
`statusErr{code: status, msg: body}`; for **429 only**: `Retry-After` seconds (integer ≥0) → duration; else HTTP-date → `max(0, date−now)`; else if body `error.code` (lower) contains `tpmratelimitexceeded` or `error.message` contains "tokens per minute" + "limit" + "exceeded" ⇒ **60 s** fallback (`openAICompatTPMFallbackRetryAfter`); else nil (conductor backoff). No credential-scoped/request-scoped distinction here (config `request-scoped-errors` rules do that in the conductor). Network errors returned as-is.

## C6. Count tokens (`helps.TokenizerForModel`, `CountOpenAIChatTokens`, `BuildOpenAIUsageJSON`)
Translate to openai chat, thinking, payload finalizer, then local BPE count by model (tiktoken-go `tokenizer`; GPT-family encodings, fallback cl100k) → `{"usage":{"prompt_tokens":N,...}}` translated back. Port with a WASM/JS tokenizer (`js-tiktoken`/`gpt-tokenizer`).

## C7. Refresh
No-op for API-key creds; if metadata has `refresh_token`/`refreshToken` → error "openai compat executor cannot refresh oauth credentials for provider X".

---

# APPENDIX — Porting checklist / gotchas

1. **Executor-scoped error contract** (consumed by the conductor): `statusErr{code, msg, retryAfter *Duration, credentialScoped bool}` plus optional interfaces `IsRequestScoped()`, `IsCredentialScoped()`, `RetryAfter()`, `StatusCode()`, `Headers()`. Claude: 429 unified-rejection ⇒ credential-scoped with computed cooldown; fast-mode credits / OAuth cancellation / mid-system-message-model / token-count validation / MCP alias restore ⇒ request-scoped; Codex: `usage_limit_reached` ⇒ credential-scoped (unless `codex.model-level-cooling`) with `resets_at`/`resets_in_seconds`; incomplete/empty-incomplete streams ⇒ request-scoped; OpenAI-compat ⇒ unscoped, 429 Retry-After only.
2. **Never re-serialise the Claude body after signing** (CCH) and build text blocks with JSON.stringify-style escaping (no `\u003c` HTML escaping). In JS `JSON.stringify` already matches; avoid key reordering of caller JSON (use raw string splicing for edits like the Go code or ensure stable key order).
3. **UTF-16 indexing** for the Claude billing fingerprint (`c[4], c[7], c[20]`): JS strings are UTF-16 natively — direct port is trivial.
4. **xxHash64** seed `0x4D659218E32A3268`, take low 20 bits (`& 0xFFFFF`), format `%05x`.
5. **uuid v5** with `NameSpaceOID` (`6ba7b812-9dad-11d1-80b4-00c04fd430c8`) for all derived session/cache ids (note: `uuid.NameSpaceOID` = 6ba7b812-9dad-11d1-80b4-00c04fd430c8; the Claude CLI account-uuid namespace constant in `claude_cli_identity_seed.go` is the same value).
6. **State needing durable storage** (all in-memory/home-KV in Go): Claude user-id cache (1 h, key sha256(apiKey)), session-id cache (1 h), continuity map (1 h, ≤4096 entries; key sha256(credIdentity\0sessionID)), device-profile cache (7 d), OAuth tool alias map (bounded, by message id), thinking replay (bounded LRU), Codex prompt cache (1 h), Codex reasoning replay (bounded), Codex WS sessions (live sockets), OAuth refresh single-flight and per-refresh-token 429 block (Claude, 5 s–5 min). Map to DO (per credential / per session) or KV with `expirationTtl`.
7. **Refresh scheduling**: Claude refresh lead **4 h**, Codex **24 h** before `expired` (conductor schedules; replace with cron/alarm). Claude refresh tokens are single-use → never retry on transport errors; serialise refreshes per credential (DO).
8. **Streaming**: Go uses scanner with 50 MB max line; in Workers use a `TransformStream` line splitter; do not buffer the whole body except for the "non-stream downstream but upstream streams" case (Claude non-Claude formats, Codex all non-stream).
9. **Content-Encoding**: Go manually decodes gzip/deflate/br/zstd for Claude because it sets `Accept-Encoding` itself; Workers `fetch` decodes automatically and you generally cannot set `Accept-Encoding` — send the header value only if the runtime allows, else rely on defaults.
10. **Header casing / order / TLS fingerprint** (Claude, chatgpt.com) are best-effort only on Workers. Keep header *values* identical; expect higher risk of `403` / Cloudflare challenges on `chatgpt.com` and possible Anthropic fingerprint-based flags on OAuth traffic.
11. **Model-specific constants to keep data-driven** (they change with Claude Code releases): UA `claude-cli/2.1.280 (external, cli)`, SDK `0.112.1`, Node `v26.3.0`, beta strings, `cc_version` default `2.1.280`, legacy-model list, `fallbacks` defaults, Codex UA `codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)`, `OpenAI-Beta: responses_websockets=2026-02-06`, default image main model `gpt-5.4-mini`, `gpt-image-2`. Put them in config/KV (Go also lets `claude-header-defaults` / `codex-header-defaults` override UA etc.).
12. **Functions/tests worth reading before porting** (they encode the edge cases): `claude_executor_test.go`, `claude_fingerprint_policy_test.go`, `claude_executor_beta_policy_test.go`, `claude_cloaked_cache_repro_test.go`, `claude_executor_ratelimit_test.go`, `helps/claude_ratelimit_test.go`, `codex_stream_bootstrap_buffering_test.go`, `codex_executor_terminal*.go` tests, `codex_websockets_executor_test.go`, `openai_compat_executor_*_test.go`.
13. **Not covered here** (other docs): the translators (`internal/translator/**`), `internal/thinking`, conductor/selector/cooldown logic, usage reporting plumbing (`helps.UsageReporter`), payload-rule engine (`helps.ApplyPayloadConfig*`), model registry, devin/kimi/xai/gemini executors (Kimi and custom gateways reuse `ClaudeExecutor` via `upstreamModelNormalizer`; xAI/Kimi `thinking replay` helpers are shared).
