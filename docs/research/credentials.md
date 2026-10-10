# Credentials & the Auth Conductor — Behaviour Reference for the Workers Port

Scope: everything that decides *which credential* serves a request and *what happens to that credential afterwards*
(on-disk schema, config→credential synthesis, selection, cooldowns/quota, token refresh, persistence).
All paths are relative to repo root. Line numbers refer to the current tree (they drift; grep the symbol if off by a few lines).
No secrets from `auths/` or `config.yaml` are included — only schemas. Public OAuth client IDs embedded in source are listed.

Terminology: **Auth** = one credential record (Go `coreauth.Auth`, `sdk/cliproxy/auth/types.go:48`). **Manager** = the conductor (`sdk/cliproxy/auth/conductor*.go`).

---

## 0. Executive summary / what the port must reproduce

1. Credentials come from **two sources** merged into one in-memory map keyed by `Auth.ID`:
   (a) OAuth/service-account **JSON files** in `auth-dir`, (b) **API keys synthesised from config** (`claude-api-key`, `codex-api-key`, `gemini-api-key`, `interactions-api-key`, `vertex-api-key`, `xai-api-key`, `meta-api-key`, `openai-compatibility[]`). Plus one runtime-only source: AI Studio websocket relay channels.
2. Per request: filter candidates (provider, model support, not-tried, not-cooling) → keep only the **highest `priority` tier** → pick with **round-robin (default) / weighted-round-robin / fill-first**, optionally wrapped by **session affinity** → execute → report a `Result` → `MarkResult` mutates per-(auth, model) cooldown state → on failure the conductor **retries on the next credential in the same round**, then does extra **retry rounds** (`request-retry`) waiting for the nearest cooldown (≤ `max-retry-interval`).
3. A background loop refreshes OAuth tokens ahead of expiry (per-provider lead time); a 401 at request time triggers one inline refresh+retry.
4. Almost all runtime state (cooldowns, quota, counters, session bindings, rotation cursors) is **in-memory only**; only token material + a few user flags are written back to the auth JSON. Cooldown state can optionally be persisted (`save-cooldown-status`).

### 0.1 Things that cannot run on plain Workers (and what they do)

| Go thing | Used for | Where | Workers consequence |
|---|---|---|---|
| `refraction-networking/utls` custom TLS ClientHello (Firefox/Node profile) | Claude OAuth control plane (`platform.claude.com/v1/oauth/token`, `api.anthropic.com/api/oauth/profile`, `.../claude_cli/roles`) to dodge Cloudflare TLS fingerprinting; also header **order** pinning (`claudeOAuthRefreshHeaderOrder`, `claudeOAuthInspectHeaderOrder`), `Connection: close`, HTTP/1.1 w/o ALPN | `internal/auth/claude/utls_transport.go` (whole file), `anthropic_auth.go:187-228` | Impossible: Workers `fetch` controls TLS/H2/header order. Refresh will use a normal fetch with the same headers/body; may be challenged by Cloudflare (`cf-mitigated`). Treat as risk; consider running Claude refresh through an external relay if blocked. |
| Raw TCP/SOCKS/HTTP proxies (`proxy-url`, per-auth `proxy_url`, `golang.org/x/net/proxy`) | Egress via proxy for every upstream + token call | `sdk/proxyutil`, `helps.NewProxyAwareHTTPClient`, `NewClaudeAuthWithProxyURL`, `NewCodexAuthWithProxyURL`, … | No proxies on Workers. `proxy_url` field can be stored but not honoured (or implemented via a tiny HTTP relay). |
| Filesystem (`auth-dir`, `.cds` files, `os.ReadDir`, fsnotify watcher) | Credential storage, hot reload | `sdk/auth/filestore.go`, `internal/watcher/*`, `sdk/cliproxy/auth/cooldown_state.go` | Replace with D1/KV/R2 + explicit "reload" on write. |
| Goroutine background loops | auto-refresh loop (`auto_refresh_loop.go`), session cache cleanup (`session_cache.go:410`), Antigravity version updater (`internal/misc/antigravity_version.go`, 6h), model catalog updaters | many | Use Durable Object alarms / Cron Triggers (min 1 min granularity on cron; DO alarms are finer). |
| Local HTTP listeners for OAuth callbacks (`:54545` Claude, `:1455` Codex, `:51121` Antigravity) | Browser login flows | `internal/auth/*/oauth_server.go`, `sdk/auth/*.go` | Worker route for callback (or paste-the-code flow; Claude already supports `code#state` paste, `anthropic_auth.go:352`). |
| `singleflight.Group` (per refresh token) + `sync.Mutex` per auth | de-dup concurrent refreshes | `claudeRefreshGroup`, `codexRefreshGroup`, `kimiRefreshGroup`, `xaiRefreshGroup`, `antigravityRefreshGroup`, `metaRefreshGroup`, `Manager.refreshLocks` | Needs a DO (single-writer) per auth or per pool; in-isolate Maps are not enough across isolates. Refresh tokens are **single-use/rotating** (Claude, Codex) so a lost race = `invalid_grant`. |
| RESP/Redis protocol client to "CLIProxyAPIHome" control plane (`internal/home`, `cfg.Home.Enabled`) | Optional external dispatcher: when enabled the local conductor does **no** selection/cooldown/refresh (`quotaCooldownDisabledForAuthWithConfig`: `Home.Enabled → true`) | `sdk/cliproxy/auth/conductor_home*.go`, `home_*.go`, `internal/home` | **Out of scope; do not port.** Ignore every `Home*` code path. |
| Dynamic plugins (`sdk/pluginapi`, `PluginAuthParser`, `PluginScheduler`) | Third-party providers / schedulers | `file.go:107-165`, `conductor_selection.go:853-1000` | Out of scope. |
| `gorilla/websocket` Codex/xAI WS transport, `wsrelay` AI Studio | Not credential logic; but AI Studio credentials only exist while a browser websocket is connected | `internal/wsrelay`, `sdk/cliproxy/service_auth.go:270-340` | AI Studio = runtime-only credential; needs a DO holding the WS. |

---

## 1. Core data model

### 1.1 `Auth` (`sdk/cliproxy/auth/types.go:48-113`)

| Field | JSON (internal/mgmt API) | Persisted to auth file? | Notes |
|---|---|---|---|
| `ID` | `id` | derived from file path | Stable key. File auths: path relative to `auth-dir` (lower-cased on Windows). Config auths: `"<kind>:<12-hex>"` (see §4.3). |
| `RegistrationEpoch` | `registration_epoch` | no | Monotonic per ID across unregister/re-register. Fences stale async results. |
| `CredentialVersion` | `credential_version` | no | +1 whenever token/api key/id_token changes (`CredentialsChanged`, `conductor_refresh.go:~300`). Stale `Result`s (older version) are ignored (`isStaleExecutionResult`, `conductor_cooldown.go:752`). |
| `Generation` | `generation` | no | Monotonic mutation counter for scheduler snapshot races. |
| `Index` | – | no | `sha256(seed)[:8]` hex; seed = `"<type>:<abs file path>"` for files, `"<apiPrefix>:<baseURL>+<apiKey>"` for api keys, else `"id:<ID>"` (`types.go:323-436`). Exposed as `auth_index` to management/UI. |
| `Provider` | `provider` | `type` field in file | lower-case provider key. |
| `Prefix` | `prefix` | `prefix` | Model namespace, see §6.7. |
| `FileName`, `Storage`, `Runtime` | – | – | Go-only plumbing. |
| `Label` | `label` | – | file: `email` else provider; config: e.g. `claude-apikey`. |
| `Status` | `status` | – | `unknown|active|pending|refreshing|error|disabled` (`status.go`). |
| `StatusMessage` | | no | e.g. `unauthorized`, `payment_required`, `quota exhausted`, `transient upstream error`, `token expired`, `invalid grant (retrying)`, `disabled (invalid grant)`. |
| `Disabled` | `disabled` | **yes** (`disabled` bool in JSON) | |
| `Unavailable` | `unavailable` | no | Aggregate "all models cooling". |
| `ProxyURL` | `proxy_url` | yes | |
| `Attributes` | `attributes` map[string]string | no (derived) | Immutable routing/exec config: `api_key`, `base_url`, `priority`, `weight`, `header:<Name>`, `excluded_models`, `auth_kind`, `source`, `path`, `plan_type`, … (§1.3). |
| `Metadata` | `metadata` map[string]any | **yes — the whole JSON file *is* Metadata** | Tokens, expiry, email, flags. |
| `Quota` (`QuotaState`) | `quota` | no (optionally `.cds`) | §1.2 |
| `LastError` | `last_error` `{code,message,retryable,http_status}` | no | |
| `CreatedAt/UpdatedAt` | | | file mtime on load |
| `LastRefreshedAt` | | no (derived from metadata `last_refresh`) | |
| `NextRefreshAfter` | | no | Refresh back-off / pending marker. |
| `NextRetryAfter` | `next_retry_after` | no (optionally `.cds`) | Credential-wide cooldown deadline. |
| `ModelStates` | `model_states` map[model]→`ModelState` | no (optionally `.cds`) | Per-model cooldown; the primary cooldown mechanism. |
| `RefreshFailures` | – | no | consecutive `invalid_grant` count. |
| `RejectedAccessToken` | – | no | token string upstream 401'd; forces `ExpirationTime()` = epoch 0 until it changes. |
| `Success`, `Failed`, `recentRequests` | – | no | counters, 20×10-min ring (§8.6) |

`Error` (`errors.go`): `{code?: string, message: string, retryable: bool, http_status?: int}`. Well-known codes: `request_scoped`, `connection_lifecycle`, `transient_transport`, `force_cooldown`, `auth_not_found`, `auth_unavailable`, `model_cooldown`, `provider_not_found`, `executor_not_found`, `unauthorized`, `empty_stream`, `model_not_found`.

### 1.2 `QuotaState` / `ModelState` (`types.go:179-228`)

```
QuotaState { exceeded: bool, reason?: "quota"|"credential_quota"|"cloudflare challenge",
             next_recover_at: time, backoff_level?: int,
             observed_at?: time, signals?: map<string,string> }   // signals = passive header snapshot (§8.5)
ModelState { status, status_message?, unavailable: bool, next_retry_after: time,
             last_error?: Error, quota: QuotaState, updated_at: time }
```
`applyCooldownFields` (`quota_signals.go:81`) writes only `{exceeded, reason, next_recover_at, backoff_level}` so cooldown transitions never erase `observed_at/signals`.

### 1.3 Attribute keys (`classification.go:5-26`, `types.go:115-120`, `priority.go:9`)

`api_key`, `auth_kind` (`apikey|oauth`), `base_url`, `codex_alpha_search`, `codex_disable_cloaking`, `config_index`, `path`, `runtime_only`, `source`, `source_backend` (`config|file|git|memory|objectstore|postgres`), `weight`, `priority`, `file_priority`, `excluded_models` (comma list, lower-case, sorted), `excluded_models_hash`, `models_hash`, `model_aliases` (JSON string of `[{name,alias,fork,force-mapping,display-name}]`), `header:<Header-Name>`, `plan_type`, `websockets`, `provider_key`, `compat_name`, `fingerprint_profile`, `rebuild_mid_system_message`, `interactions`, `note`, `email`, `domain`, `using_api` (xAI), `auth_index_seed|plugin_virtual|virtual_source` (plugins).

### 1.4 Classification helpers (`classification.go:29-107`)

* `AuthKind()`: `Attributes["auth_kind"]` → `Metadata["auth_kind"]` → (`Attributes["api_key"]` non-empty ⇒ `apikey`) → (metadata has any of `access_token, refresh_token, id_token, email, token_type, expires_at, expired`, or `token` map ⇒ `oauth`) → `""`. Normalisation accepts `api_key|api-key|apikey`, `oauth|oauth2`.
* `AuthSourceKind()`: `runtime_only=true`⇒memory; else `source_backend`; else `source` prefix `config:` ⇒ config; else file.
* `IsConfigAPIKeyAuth` = kind apikey ∧ source config (`config_apikey.go`). Config api-key auths are **never persisted** (`conductor_lifecycle.go:529`).

---

## 2. On-disk auth JSON

### 2.1 Generic rules (apply to every file)

* Location: `auth-dir` (default `~/.cli-proxy-api`, `internal/config/config_defaults.go:6`), recursive walk (`FileTokenStore.List`, `sdk/auth/filestore.go:~150`), only `*.json` (case-insensitive). Empty files and unparsable JSON are skipped silently. A file is **one flat JSON object**; the object is loaded as `Auth.Metadata` verbatim (unknown keys preserved and re-written).
* `type` (string, case-insensitive, trimmed) selects the provider. Missing/empty ⇒ file ignored by the synthesizer (`file.go:121`) (FileTokenStore labels it `unknown`). **`type: "gemini"`/`"gemini-cli"` files are ignored entirely** (Gemini-CLI OAuth was removed; `file.go:107,121`, `filestore.go:~213`). Providers that have an executor: `claude, codex, antigravity, kimi (kimi-ai, kimi.ai, kimi.com), xai, devin, meta, vertex` plus plugin types.
* ID = path relative to `auth-dir` (e.g. `claude-ab12cd34-me@x.com.json`); `Attributes.path/source = <abs path>`, `source_backend=file`.
* Key normalisation on load/save (`NormalizeCredentialMetadata`, `metadata_keys.go`): legacy dashed keys are renamed to snake_case unless the snake key already exists: `api-key→api_key, base-url→base_url, disable-cooling→disable_cooling, excluded-models→excluded_models, fingerprint-profile→fingerprint_profile, model-aliases→model_aliases, proxy-url→proxy_url, request-retry→request_retry, request-scoped-errors→request_scoped_errors, tool-prefix-disabled→tool_prefix_disabled`.
* Universal optional keys read by the synthesizer from *any* file (`file.go:121-240`):

| Key | Type | Effect |
|---|---|---|
| `disabled` | bool | `Disabled=true`, `Status=disabled`. **Written back on every save** (`filestore.go:~115`: `Metadata["disabled"]=auth.Disabled`). |
| `proxy_url` | string | `Auth.ProxyURL` |
| `prefix` | string | trimmed, `/` stripped both sides; **ignored if it still contains `/`** |
| `priority` | number or numeric-string | → `Attributes.priority` (+`file_priority=true`). Higher = preferred. Non-numeric ⇒ ignored (`priority.go`). |
| `weight` | integer (number/string/json.Number) | validated by `credentialweight` (§6.4); invalid ⇒ whole file **rejected** (`invalid auth weight`). → `Attributes.weight` |
| `note` | string | → `Attributes.note` |
| `headers` | `{name: value}` | each non-empty pair → `Attributes["header:"+name]` (extra request headers) (`custom_headers.go`) |
| `excluded_models` (alias `excluded-models`) | string[] | per-account model exclusion; merged with global `oauth-excluded-models[provider]` (§6.6) |
| `model_aliases` (alias `model-aliases`) | `[{name, alias, fork?, force-mapping?, display-name?}]` | per-account OAuth model aliases (§6.8) |
| `disable_cooling` | bool/"true"/number | per-credential cooling override (`DisableCoolingOverride`, `types.go:474`) |
| `request_retry` | int ≥0 | per-credential retry-round override (`RequestRetryOverride`, `types.go:511`); negative ⇒ unset |
| `request_scoped_errors` | `[{status, match[], match-regexr[], action}]` | per-credential error rules (§8.4) |
| `fingerprint_profile` | string | Claude request fingerprint opt-in (copied to attribute, lower-cased) |
| `tool_prefix_disabled` | bool | Claude tool-name prefix skip |
| `refresh_interval_seconds` (`refreshIntervalSeconds`, `refresh_interval`, `refreshInterval`) | number/duration string | overrides lead-time logic: refresh when `now-last_refresh ≥ interval` or within `interval` of expiry (`conductor_refresh.go:authPreferredInterval`) |
| `email` | string | label, `AccountInfo()` |
| `label` | string | `FileTokenStore.labelFor`: `label` → `email` → `project_id` |

* Expiry parsing (`Auth.ExpirationTime`, `types.go`): (1) if `access_token` is a JWT (3 dot-parts) use its `exp` claim (seconds, or ms if >1e12) — **JWT exp wins**; (2) else first present of `expired, expire, expires_at, expiresAt, expiry, expires` parsed as RFC3339 / RFC3339Nano / `2006-01-02 15:04:05` / `2006-01-02 15:04` / unix s|ms (number or numeric string); (3) else `expires_in|expiresIn` (>0 s) + `timestamp|issued_at|issuedAt`; (4) recurse into `token`/`Token` sub-object. If `RejectedAccessToken == access_token` ⇒ treated as expired at epoch 0. Unix >1e12 ⇒ ms.
* `last_refresh` (`lastRefresh, last_refreshed_at, lastRefreshedAt`) → `LastRefreshedAt` fallback (`authLastRefreshTimestamp`).
* File writes: mode `0600`, dir `0700`. If `Storage` exists it serialises its struct fields and **merges `Metadata` on top** (`misc.MergeMetadata`: struct JSON first, then every Metadata key overrides). Disabled auth whose file was deleted is not recreated unless `WithAuthCreationIntent`.

### 2.2 Per-provider schemas

Tags below are exact JSON field names. "(omitempty)" = omitted when empty.

#### claude (`internal/auth/claude/token.go:14-45`; filename `claude-<sha256(orgUUID|accountUUID)[:8]>-<email>.json`, legacy `claude-<email>.json`: `claude/filename.go:19-31`)
```
type, access_token, refresh_token, id_token, last_refresh (RFC3339), email,
expired (RFC3339), account_uuid?, organization_uuid?, organization_name?,
claude_device_ids?: [ "<64 lowercase hex>" ]   // exactly 1 entry (ClaudeDevicePoolSize=1, 32 random bytes hex) 
```
Extra keys the executor adds/reads: `claude_account_profile_checked_at`, `skip_account_profile|is_setup_token|setup_token` (bool), `scopes|scope` (string), `fingerprint_profile`, `tool_prefix_disabled`. OAuth token ⇔ access token contains `sk-ant-oat` (`claude_executor_request.go:1645`). "Setup token" = OAuth token without `user:profile`/`user:office` scope (or flagged) ⇒ profile lookup skipped.
`claude_device_ids` is generated by `ensureDeviceIDPoolLocked` (`identity.go:237`) when missing/invalid; valid = 64 lowercase hex.

#### codex (`internal/auth/codex/token.go:20-40`; filename `codex[-<hash>]-<email>[-<plan>].json`, `codex/filename.go`)
```
type:"codex", id_token, access_token, refresh_token, account_id, last_refresh, email, expired, plan_type? ("free"|"plus"|"pro"|"team"|"business"|"go"...)
```
`plan_type` is copied to `Attributes.plan_type` at load: metadata `plan_type` else JWT claim `https://api.openai.com/auth`.`chatgpt_plan_type` from `id_token` else `"free"` (`file.go:228-240`, `jwt_parser.go:104-117`). `account_id` = claim `https://api.openai.com/auth`.`chatgpt_account_id`. Plan type selects the model catalogue (`service_models.go`): `pro`→pro, `plus`→plus, `team|business|go`→team, `free`→free, else pro.

#### antigravity (built in `sdk/auth/antigravity.go:300-340`; filename `antigravity-<email>.json`)
```
type:"antigravity", access_token, refresh_token, expires_in (int s), timestamp (unix ms at issue), expired (RFC3339),
email?, project_id?   // GCP project from loadCodeAssist/onboardUser
```
Missing `project_id` is discovered lazily (§9.5, `PrepareRequestAuth`).

#### kimi (`internal/auth/kimi/token.go:15-41`; filename `kimi-<unixMilli>.json` or `<prefix>-<unixMilli>.json`)
```
type: "kimi" | "kimi-ai" (also accepted: "kimi.ai","kimi.com"), access_token, refresh_token, token_type, scope?, device_id?,
expired? (RFC3339), domain? ("kimi.com"|"kimi.ai"), base_url?
```
At load: `Attributes.domain` = normalised `domain` (anything `kimi.ai`/`ai`/`kimi-ai`/`*.kimi.ai` ⇒ `kimi.ai`, else `kimi.com`); `Attributes.base_url` = metadata `base_url` or `https://api.kimi.com/coding` / `https://api.kimi.ai/coding` (`kimi.go:28-50,93-135`, `file.go:196-219`). `device_id` is replayed as `X-Msh-Device-Id`.

#### xai (`internal/auth/xai/token.go:15-34`; filename `xai-<email>.json` | `xai-<sub>.json` | `xai-<unixMilli>.json`)
```
type:"xai", auth_kind?:"oauth", access_token, refresh_token, id_token?, token_type?, expires_in?, expired?, last_refresh?, email?, sub?,
base_url?, redirect_uri?, token_endpoint?, using_api? (bool)
```
`token_endpoint` is cached from OIDC discovery and reused for refresh. `using_api` (attr or metadata): true ⇒ official `https://api.x.ai/v1`; absent ⇒ OAuth default **false** ⇒ `https://cli-chat-proxy.grok.com/v1` (`xai_executor_request.go:218-262`).

#### devin (`internal/auth/devin/record.go:84-132`; filename `devin-<identifier>.json`, identifier sanitised to `[A-Za-z0-9-_.@]`, hashed `user-<sha256[:8]>` if altered or >160 chars)
```
type:"devin", auth_kind:"oauth", api_key, session_token  // both = "devin-session-token$<jwt>"  (FormatSessionToken: prefix added if raw starts with "eyJ")
user_name, user_id, org_id, email?, plan?   // optional: base_url, device_seed, team_id, org_name
```
No expiry, no refresh token (permanent session token). The executor reads `api_key` / `session_token` / `token` from Attributes first, then Metadata.

#### meta (`internal/auth/meta/meta.go:88-106`; filename `meta-<sanitised email>-<sha256(email)[:8]>.json` | `meta-<hash>.json` | `meta-oauth.json`)
```
type:"meta", auth_kind:"oauth", access_token, dca_token?, api_key?, token_type?, expires_in?, expired? (only when no minted key),
dca_expired?, dca_expires_at? (unix s), last_refresh?, base_url? (default https://api.meta.ai/v1), email?, name?,
subs_tier_name?, subs_tier_id?, is_subs_active?, has_payment_method?
```
`dca_token` = `dca:...` device token (OAuth device flow). `api_key` = LLM key minted from it. When `api_key` exists `access_token = api_key` and `expired` is absent (key treated as non-expiring). On user-edit merges, `api_key, dca_token, dca_expired, dca_expires_at` are never copied from an old file (`metadata_merge.go:27`).

#### vertex (`internal/auth/vertex/vertex_credentials.go:14-40`)
```
type:"vertex", service_account: { ...full Google service-account JSON incl. private_key, client_email, token_uri... },
project_id, email (client_email), location? (default "us-central1"), prefix?
```
Executor: `project_id` (fallback key `project`), `location`, `service_account` (object) → `NormalizeServiceAccountMap` repairs `private_key` (CRLF→LF, strip ANSI, rebuild PEM if headers broken, convert PKCS#8→PKCS#1 "RSA PRIVATE KEY") (`keyutil.go`). Token = Google OAuth2 JWT-bearer grant with scope `https://www.googleapis.com/auth/cloud-platform` via `google.CredentialsFromJSON` (`gemini_vertex_executor.go:1256`). **No Auth-level refresh** (`Refresh` is a no-op); the token is minted per request by the Google lib (cached in its TokenSource; Workers port should cache the 1h access token itself: POST `token_uri` `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, RS256 JWT with `iss=client_email, scope, aud=token_uri, iat, exp=iat+3600`; WebCrypto needs PKCS#8 so convert from PKCS#1). Base URL: `https://{location}-aiplatform.googleapis.com`, or `https://aiplatform.googleapis.com` when `location=="global"`; API version `v1`.

#### aistudio — **no file**. Runtime-only (`sdk/cliproxy/service_auth.go:285-325`)
Created when a browser connects to `/v1/ws` relay with channel id `aistudio-<hex>`: `Auth{ID: channelID, Provider:"aistudio", Label: channelID, Status: active, Attributes:{runtime_only:"true"}, Metadata:{email: channelID}}`; deleted on disconnect. No tokens; `ws-auth` config toggles auth on the websocket. Not persisted (`runtime_only`).

#### openai-compat / api-key auths: **no file** — see §4.

#### gemini (OAuth/Gemini-CLI) — legacy files skipped; gemini API keys come from config only.

---

## 3. File → Auth synthesis (`internal/watcher/synthesizer/file.go`, `sdk/auth/filestore.go:readAuthFiles`)

Two code paths produce nearly identical results (watcher synthesizer at runtime; `FileTokenStore.List` at `Manager.Load`). Behaviour to reproduce (synthesizer version, the richer one):

1. Parse JSON → map; `NormalizeCredentialMetadata`; `ValidateAuthWeight` (error ⇒ file skipped with warning).
2. `provider = lower(trim(type))`; `gemini→gemini-cli`; empty or `gemini-cli` ⇒ no auth.
3. `label = email || provider`; `id = path relative to authDir`.
4. `prefix`: trimmed, `/` trimmed; kept only if it contains no `/`.
5. `status = disabled` if `disabled==true` else `active`.
6. `Attributes = {source:<path>, path:<path>, source_backend:"file"}`; then `priority` (+`file_priority`), `weight`, `note`, `header:*`, `model_aliases` (sanitised JSON), `excluded_models/excluded_models_hash/auth_kind="oauth"` (`ApplyAuthExcludedModelsMeta(auth, cfg, perAccount, "oauth")`), `fingerprint_profile`; kimi attrs; codex `plan_type`.
7. `FileTokenStore.List` additionally sets `Attributes.email` and uses file mtime for `CreatedAt/UpdatedAt`.

`ApplyAuthExcludedModelsMeta` (`helpers.go:58-110`): collect per-account list ∪ (for oauth only) `cfg.OAuthExcludedModels[provider]`, lower-case, trim, dedupe, sort; `excluded_models = join(",")`, `excluded_models_hash = sha256-based`, `auth_kind = authKind`. For `apikey` kind only the per-key list is used.

Sanitisation of `model_aliases` (`SanitizeOAuthModelAlias`, `config_normalization.go:64-106`): drop empty name/alias; drop `name == alias` (case-insens.); dedupe by lower-cased alias (first wins); channel keys lower-cased.

---

## 4. Config API keys → Auth entries (`internal/watcher/synthesizer/config.go`)

Call order (determines nothing functional except ID counters): gemini, interactions, claude, codex, xai, meta, openai-compat, vertex-compat. `ValidateCredentialWeights` failure ⇒ *whole* synthesis fails.

### 4.1 Common behaviour for every key entry
* Entry skipped if `api-key` **and** `base-url` are both empty after trim (except openai-compat, see 4.4).
* `Status=active`, `CreatedAt=UpdatedAt=now`, `Prefix` (already normalised by config sanitiser: trimmed, slashes stripped, dropped if contains `/`: `normalizeModelPrefix`), `ProxyURL` (trimmed).
* `Attributes`: `source = "config:<name>[<hash12>]"`, `config_index = <index in its list>`, `api_key` (if non-empty), `base_url` (if non-empty), `priority` (only if ≠0), `weight` (only if set; values ≤0 normalised to `"0"`), `models_hash`, `header:<k>` for each non-empty header, `excluded_models`/`excluded_models_hash`/`auth_kind="apikey"` (not for openai-compat, see 4.4).
* `Metadata` (omitted if empty): `disable_cooling` (bool, only if explicitly set), `request_retry` (int ≥0), `request_scoped_errors` (rules list).
* `AuthKind()` resolves to `apikey` (explicit attr or via `api_key` attr).

### 4.2 Per-family specifics

| Config list | Provider | `Label` | ID kind (`idKind`) | Extra attrs |
|---|---|---|---|---|
| `gemini-api-key` | `gemini` | `gemini-apikey` | `gemini:apikey` | – (source name `gemini`) |
| `interactions-api-key` | `gemini-interactions` | `interactions-apikey` | `gemini-interactions:apikey` | – |
| `claude-api-key` | `claude` | `claude-apikey` | `claude:apikey` | `rebuild_mid_system_message=true`, `fingerprint_profile` (lower-cased) |
| `codex-api-key` | `codex` | `codex-apikey` | `codex:apikey` | `websockets=true`, `codex_alpha_search=true`, `codex_disable_cloaking=<bool>` |
| `xai-api-key` | `xai` | `xai-apikey` | `xai:apikey` | `websockets=true` (same struct as codex) |
| `meta-api-key` | `meta` | `meta-apikey` | `meta:apikey` | `websockets=true` |
| `vertex-api-key` | `vertex` | `vertex-apikey` | `vertex:apikey` | `provider_key="vertex"`, `interactions="true"` if set; **no `request_scoped_errors`** metadata |
| `openai-compatibility[]` | `openai-compatible-<name>` | `<compat.Name>` | `openai-compatibility:<name>` | `compat_name`, `provider_key` |

### 4.3 Stable ID generation (`helpers.go:StableIDGenerator.Next`)
`sha256( kind || 0x00 || trim(part1) || 0x00 || trim(part2) … )` hex → first 12 chars = `short`. A per-run counter map keyed `kind:short` appends `-<n>` for the n-th duplicate (n≥1). ID = `kind:short`. Parts per family: gemini/claude/codex-style: `(api-key, base-url, proxy-url, prefix, FormatSortedHeaders(headers))`; openai-compat: `(api-key, base-url, proxy-url)` (fallback entry: `(base-url)`); vertex: `(api-key, base-url, proxy-url)`. Consequence: **changing any hashed field changes the credential ID** (cooldown/session state is lost); duplicates across list get `-1`, `-2`. (`FormatSortedHeaders` lives in `internal/config`; sorted `k:v` pairs.)

### 4.4 `openai-compatibility` specifics
Per compat entry (skipped if `disabled: true`): `providerName = lower(trim(name))` (default `"openai-compatibility"`); `provider_key = util.OpenAICompatibleProviderKey(name)` = `"openai-compatible-"+name` unless already prefixed/`openai-compatibility` (`internal/util/provider.go:15-27`). One Auth **per `api-key-entries[]`** element (own `proxy-url`, `weight`); if there are none, one key-less Auth (`attrs.api_key` absent). `priority`, `disable-cooling`, `request-retry`, `request-scoped-errors`, `headers`, `prefix` come from the compat *group*, `weight`/`proxy-url` from the key entry. No `excluded-models`, no `auth_kind` attribute (kind inferred from `api_key`; the key-less variant has **no kind**). `attrs.base_url = base-url` always set (even empty). Executor key (`executorKeyFromAuth`, `conductor_execution.go:1794`): `provider_key`/`compat_name` ⇒ `OpenAICompatibleProviderKey`; `kimi.com→kimi`, `kimi.ai→kimi-ai`.

### 4.5 Config struct fields (per key; YAML names)
Common: `api-key`, `priority` (int), `weight` (*int; omitted⇒1, ≤0⇒excluded from weighted RR, max 1,000,000), `prefix`, `base-url`, `proxy-url`, `models: [{name, alias, display-name?, max-context-length?, force-mapping?, is-compat?, thinking?}]`, `headers`, `excluded-models`, `disable-cooling` (*bool), `request-retry` (*int; nil/<0 ⇒ global), `request-scoped-errors`.
Provider extras: claude `rebuild-mid-system-message, cloak, fingerprint-profile, experimental-cch-signing`; codex/xai/meta `websockets, alpha-search, disable-codex-cloaking`; models of codex add `support-configuration-update`; vertex `interactions`; openai-compat model adds `image, input-modalities, output-modalities, use-max-completion-tokens`; compat group adds `support-prompt-cache-key`, `disabled`, `api-key-entries[{api-key, weight, proxy-url}]`. (`internal/config/config_types.go:515-960`, `vertex_compat.go`.) The "v8" config layout renames these paths (`internal/config/config_v8.go:64-118`: e.g. `claude-api-key`→`claude` family, `request-retry`→`routing.retry.request-retry`, `disable-cooling`→`routing.cooldown.disable-cooling`, `oauth-excluded-models`→`oauth.excluded-models`, `oauth-model-alias`→`oauth.model-alias`); flat legacy keys are still accepted.
Dedup on config load: gemini/interactions key entries uniq by `(api-key, base-url, proxy-url, prefix, headers)` (`config_normalization.go:339-362`); empty key+base dropped.

---

## 5. Identity & ID summary

| Source | ID | Example |
|---|---|---|
| OAuth file | relative path | `claude-1a2b3c4d-me@x.com.json` |
| config key | `kind:hash12[-n]` | `claude:apikey:9f86d081884c` ⇒ ID string is literally `claude:apikey:9f86d081884c` |
| AI Studio | channel id | `aistudio-<hex>` |

---

## 6. Selection

Entry points: `Manager.Execute / ExecuteCount / ExecuteStream(ctx, providers[], req, opts)` (`conductor_execution.go:122,182,235`). `providers` = list of provider keys able to serve the model (from the model registry). `routeModel` = model as requested by the client (may include thinking suffix `name(8192)`; may include `prefix/`).

### 6.1 Candidate set
For each Auth in the manager map (`pickNextMixedLegacy`, `conductor_selection.go:2044-2155`; the scheduler fast-path is a precomputed equivalent):
1. not `Disabled`; if a **pinned auth** id is in `opts.Metadata["pinned_auth_id"]` only that one.
2. `authSelectionEligibility.allows` (`conductor_selection.go:78-120`): optional required `AuthKind`, optional **credential policy** (`codex_alpha_search_v1`: provider codex ∧ (oauth ∨ api-key with `codex_alpha_search=true`)), and "disallow free Codex" (`isFreeCodexAuth`: codex, plan_type free) when request metadata says so.
3. `executorKeyFromAuth(auth)` ∈ requested provider set; an executor is registered for it.
4. Not in the per-round `tried` set.
5. **Model support**: global model registry says this client (auth ID) supports `canonicalModelKey(routeModel)` — or the alias-resolved key (`authSupportsRouteModel`, `:999-1012`). The registry is filled when an Auth is registered (`sdk/cliproxy/service_models.go registerModelsForAuth`): catalogue per provider (+ plan_type for codex) → `applyExcludedModels` → `applyOAuthModelAliasForAuth` → `applyModelPrefixes`. For API-key auths with `models:` configured, the catalogue is replaced by those entries (name/alias).
`canonicalModelKey` = strip the trailing `(…)` thinking suffix (`thinking.ParseSuffix`: last `(` and string ends with `)`).

### 6.2 Availability filter (`isAuthBlockedForModel`, `selector.go:823-883`; `availabilityBlock` `:885-910`)
Given `checkModel = selectionModelForAuth(auth, routeModel)` (= strip `auth.Prefix + "/"` then apply OAuth model alias; `conductor_models.go:204`):
1. `Disabled` or `Status==disabled` ⇒ blocked (reason *disabled*).
2. `hasUnauthorizedAuthFailure` (terminal 401: `Unavailable ∧ Status==error ∧ NextRefreshAfter==0 ∧ NextRetryAfter==0 ∧ LastError(401|code "unauthorized")`) ⇒ blocked.
3. Access-token expired (`AccessTokenExpirationTime ≤ now`) ⇒ blocked. (**Selector never hands out an expired OAuth token** — the refresh loop must keep ahead.)
4. Credential-wide quota (`Quota.Exceeded ∧ Reason=="credential_quota" ∧ NextRecoverAt>now`) ⇒ blocked (*cooldown*, until `NextRecoverAt`).
5. If `model != ""`:
   * if `ModelStates` non-empty: find states whose `canonicalModelKey(key)==canonicalModelKey(model)`; none matched ⇒ **available** (unmatched models stay schedulable); matched: any `status==disabled` ⇒ blocked; else per-state `availabilityBlock(state.Unavailable, state.Quota.Exceeded, state.NextRetryAfter, state.Quota.NextRecoverAt, now)`; the blocking result with the *latest* `next` wins.
   * else (no model states) fall back to credential-level `availabilityBlock(auth.Unavailable, auth.Quota.Exceeded, auth.NextRetryAfter, auth.Quota.NextRecoverAt)`.
6. `model == ""`: credential-level, but if per-model states exist and quota reason isn't `credential_quota` and `!auth.Unavailable`, ignore the aggregated `Quota.Exceeded`.

`availabilityBlock(unavailable, quotaExceeded, nextRetry, nextRecover, now)`: not blocked if neither flag; `next = max(candidates>now)`; if `next` exists ⇒ blocked (*cooldown* if quotaExceeded else *other*); else if either timestamp was set but is past ⇒ **available** (lazy expiry — nothing needs to clear the flags); else (flag set with no timestamp) ⇒ blocked forever (*other*).

### 6.3 Priority tiers
`authPriority` = `int(Attributes["priority"])` (0 if absent/invalid). Among *available* candidates only the **highest priority value** tier is passed to the selector; lower tiers are used only when higher tiers are entirely unavailable/tried (`availableAuthsFromPriorityBuckets`, `selector.go:552-583`). Candidates are sorted by `ID` ascending (stable ring order). Exception: session-affinity selector receives all tiers (§6.9).
Mixed providers: the best *priority number across all providers* decides which providers participate (`scheduler.go pickMixedWithStrategy:441-640`).

### 6.4 Strategies (`routing.strategy`; aliases `weightedroundrobin|wrr`, `fillfirst|ff`; default `round-robin`) (`service_config.go:44-52`)
* **round-robin** (`selector.go:614`): ring over ID-sorted available auths; remembers `lastPicked` **auth ID** (not an index) per key and picks the first ID strictly greater than it, wrapping (`successorIndex`). Fast-path key = (provider, model shard, priority bucket); legacy-path key = `"<provider>:<canonicalModel>"` (for built-in selectors the model arg is blanked, so effectively `"mixed:"`). Keyed maps are cleared when >4096 keys.
* **fill-first**: first available auth by ID order.
* **weighted-round-robin** (smooth/nginx style, `selector.go:673-810`): weight = `Attributes.weight` (parsed; invalid ⇒0) else `Metadata.weight` else **1**; weight ≤0 ⇒ excluded. State per key: `current[id]`, `weights[id]`. Each pick: `current[id] += weight` for every candidate; pick max `current` (first wins ties in ID order); `current[picked] -= totalWeight`. `prepare` resets `current` only if some candidate's configured weight *changed* (not when the candidate set shrinks); prunes stale IDs only when a map exceeds 1024 entries; saturating int64 arithmetic.
* **Weight validation** (`internal/credentialweight/weight.go`): `Default=1`, `Max=1_000_000`; integer only (floats must be whole); `≤0 ⇒ 0` (valid, excluded); `>Max ⇒ error`; string: trimmed, empty ⇒ default.
* **Mixed multi-provider round-robin** (`scheduler.go:571-625`): when several providers qualify, cursor per `"<providers joined>,:<model>"`; each provider's slot count = number of ready auths at best priority; `startSlot = cursor % totalSlots`; pick from that provider via its own RR; cursor = slot+1. Fill-first picks first provider (in given order) having a ready auth at best priority. Weighted: one smooth-WRR over the union sorted by ID.
* Codex websocket preference: for downstream-websocket requests to `codex`, prefer auths with `websockets=true` (attr or metadata) when any exist (`selector.go:413-467`).

### 6.5 Errors when nothing is selectable (`selector.go:83-165, 349-362`; `errors.go:212-231`)
* All candidates cooling *and* an earliest recovery known ⇒ `model_cooldown` error, **HTTP 429**, headers `Content-Type: application/json`, `Retry-After: ceil(resetSeconds)`, body:
  `{"error":{"code":"model_cooldown","message":"All credentials for model <m> are cooling down[ via provider <p>][ (last error: <summary>)]","model":"<m>","reset_time":"<Go duration rounded to s, ≥1s if >0>","reset_seconds":<ceil>,"provider":"<p>?","last_upstream_error":"<summary>?"}}`.
* Otherwise `auth_unavailable` "no auth available" (HTTP 503 + retryable + `Retry-After` when a future recovery exists; plain error otherwise). If **all** candidates are terminally unauthorized ⇒ terminal (non-retryable) 503 `auth_unavailable` with cause.
* No candidates ⇒ `auth_not_found` "no auth available"; no providers ⇒ `provider_not_found`; missing executor ⇒ `executor_not_found`.
* Upstream-error summaries embedded in messages go through `ExtractUpstreamErrorSummary` (`selector.go:189-347`): parse JSON `error.message`/`message`, strip secrets (Bearer/Basic, `sk-…`, `ghp_…`, key/token/password KV pairs, URLs with creds, cookies, file paths), truncate to 256 runes (`253+"..."`). Port at least the redaction behaviours.

### 6.6 Model exclusion
`excluded_models` patterns (lower-cased) support `*` wildcards anywhere (`matchWildcard`, `service_models.go:689`; case-insensitive; `"gpt-*"`, `"*-preview"`, `"a*b"`). Applied to the catalogue when registering the auth's models:
* OAuth/file auths: per-file list ∪ `oauth-excluded-models[provider]` (pre-merged into `Attributes.excluded_models`; if the attribute exists it **replaces** the global list).
* API-key auths: **only** the per-key `excluded-models`.
Excluded models simply aren't registered for that auth ⇒ step 5 of §6.1 filters it out.

### 6.7 Prefix (`Auth.Prefix`, `force-model-prefix`)
Registered model IDs for an auth with prefix `P`: `P/<id>` always, plus bare `<id>` unless `force-model-prefix` (kept if `P == id`) (`applyModelPrefixes`, `service_models.go:641`). At execution `rewriteModelForAuth` strips `P/` if present (`conductor_models.go:700`).

### 6.8 Model aliases (client-visible alias → upstream name)
Resolution at execution (`executionModelCandidatesWithAlias`, `conductor_models.go:331-364`):
1. `requested = rewriteModelForAuth(routeModel, auth)`.
2. Alias resolution depends on credential type:
   * **OAuth/file auths** (`modelAliasChannel`: provider, with `kimi.com/kimi.ai`→own names, `gemini`⇒none; apikey kind ⇒ none): first per-account `Attributes.model_aliases`, then global `oauth-model-alias[channel]` table (channel = provider key lower-case; compiled reverse map alias(lower)→{name, forceMapping}). Candidate lookups try the full requested string, then the base name without `(suffix)`.
   * **API-key auths**: the owning config entry's `models: [{name, alias, force-mapping}]` (entry resolved by `config_index`+credential match, else key/base/prefix/proxy match: `resolveAPIKeyConfig`, `conductor_models.go:780-824`).
3. Match semantics (`resolveModelAliasResultFromConfigModels` / `resolveUpstreamModelFromAliases`): alias compared case-insensitively; result `UpstreamModel = name` with the request's thinking suffix re-attached **unless `name` already has a suffix** (config suffix wins). If `name == base(requested)` and **not** `force-mapping` ⇒ no-op. `OriginalAlias` = requested model, or the configured alias text when `force-mapping`.
4. **force-mapping**: after the upstream responds, rewrite the `model` field in the response (non-stream JSON, and every SSE `data:` chunk via `StreamRewriter`, 1 MiB pending-buffer cap) back to `OriginalAlias` (`response_model_rewriter.go`, `conductor_models.go:536-566`).
5. **OpenAI-compat model pools**: if several `models[]` entries share the same alias, they form a pool; order rotated by a per-(auth|provider|model) counter (`nextModelPoolOffset`, wraps at ~2.1e9) so successive requests start on different upstream models; each upstream model is tried in turn within the same auth (`for _, upstreamModel := range models` in `executeMixedOnce`); models currently cooling (state keyed by the upstream model) are skipped (`filterExecutionModels`).
6. Cooldown state key for results = `stateModelForExecution`: the selection model key (alias-resolved) for normal auths; the *upstream* model for pooled aliases.
`oauth-model-alias` sanitisation as in §3. `fork: true` only affects catalogue listing (adds alias as extra model).

### 6.9 Session affinity (`routing.session-affinity`, TTL `session-affinity-ttl` default `1h`, min 1 s; `session-affinity-subagents` default true) (`selector.go:912-1560`, `session_cache.go`, `sdk/cliproxy/session/*`)
Wraps the base strategy. Not a "built-in" selector ⇒ the legacy candidate path is used (no scheduler fast path).
1. Session ID extraction (`session.ExtractSessionInfo`, `session/info.go:78-…`) in priority order: `X-Claude-Code-Session-Id` (+ `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`) → Claude `metadata.user_id` session → `Session-Id`/`Session_id` → `X-Http-Session-Id` → `X-Session-ID`/`X-Session-Affinity`/`X-Slot-Session-Id` → `X-Conversation-Id`/`X-Thread-Id`/`X-Client-Request-Id` → Gemini `cachedContent` → OpenAI `thread_id` → body `session_id|sessionId` → `prompt_cache_key` (`pck:` prefix) / `conversation.id` (`conv:`) / `metadata.user_id` (`user:`) → `conversation_id|chat_id` → execution-session metadata → derived identity (`derived:<id>`) → message-content hash (system+first user+first assistant, `computeSessionHash`). Parent/fork session keys listed at `session/info.go:117-156`. IDs: control chars rejected, trimmed, >256 bytes ⇒ reject (explicit) / `BoundSessionIdentity` (>256 ⇒ `prefix190 + "#" + sha256hex`).
2. If an explicit ID exists it is authoritative; otherwise an **LCP (Merkle longest-common-prefix) matcher** over canonical conversation turns (`session/lcp.go`, `pickLCP`) binds conversations without IDs; (complex; port optional — fall back to message-hash).
3. Cache key `provider + "::" + sessionID + "::" + canonicalModel`; value auth ID; TTL refreshed on hit; default capacity 65 536 entries; cleanup every TTL/2.
4. Pick: availability across **all priority tiers**; cached auth available ⇒ use it (**binding outranks priority**); cached but unavailable ⇒ re-pick via fallback selector from highest tier and rebind; no hit ⇒ fork/parent alias lookup (`fallbackKey` = parent id; subagents inherit parent's credential when `session-affinity-subagents`), else fallback pick + bind.
5. `OnResult`: failure attributed to credential (not request-scoped/lifecycle) ⇒ compare-and-delete bindings for that auth; success ⇒ touch (extend TTL). Auth removal/replacement invalidates its bindings (`invalidateSessionAffinity`).
(All in-memory.)

### 6.10 Per-request selection metadata
`opts.Metadata` carries: `pinned_auth_id`, `requested_model`, canonical/parent session IDs, LCP fingerprints, caller scope, `disallow_free_auth`, "selected auth" publication (`publishSelectedAuthMetadata`), attempted-auth tracker. These are internal plumbing; port only the semantics above.

---

## 7. Execution & retry loop (`conductor_execution.go`, `conductor_selection.go:1089-1520`)

Settings: `request-retry` (R, default **0 when key absent**; `config.example.yaml` shows 3), `max-retry-credentials` (K; ≤0 = unlimited), `max-retry-interval` seconds (W; ≤0 ⇒ never wait). Negative values clamp to 0 (`SetRetryConfig`, `conductor_lifecycle.go:17`). Per-credential override `request_retry` (metadata) replaces R for that credential.

```
for round = 0; ; round++:
    tried = { auths whose effective request-retry < round }          // credentials "age out" of later rounds
    attempted = {}
    loop (inside executeMixedOnce):
        if K>0 and |attempted| >= K: return lastErr
        auth = pickNextMixed(providers, routeModel, tried)           // §6; error ⇒ return lastErr if any else error
        tried += auth.ID
        models = executionModelCandidates(auth)  (alias/pool, skipping cooling ones); if empty: continue
        attempted += auth.ID
        auth = prepareRequestAuth(...)  (§9.5); on error: MarkResult(fail), lastErr=err, continue
        for upstreamModel in models:
            resp, err = executor.Execute(...)
            if err and 401 and auth has refresh credential and not yet tried: refresh once; retry same request once (§9.4)
            build Result{AuthID, Provider, Model=stateModel, RouteModel, Success, Error, RetryAfter, CredentialScope, ...}
            if err:
                 apply request-scoped rules (§8.4);  MarkResult(result) (or availability-neutral for responses/compact faults)
                 action stop*  → return err (wrapped as request-stop, no more retries)
                 request-invalid / compact-fault → return err immediately (no rotation, no penalty)
                 CredentialScope → break out of model pool (credential-wide)
                 else continue to next upstreamModel / next auth
            else MarkResult(success); rewrite force-mapped model; return resp
    if success return
    if terminated/stop error return
    (wait, retry) = shouldRetryAfterError(...)       // below
    if !retry break
    sleep(wait)  (cancelable by ctx)
```
Streaming: same, but a stream is only "successful" after the first **non-empty payload chunk** arrives (`readStreamBootstrap`, `conductor_stream.go:91`): errors/empty before that ⇒ failover to next credential (and one inline 401 refresh); an error after bytes were forwarded is passed to the client and `MarkResult(failure)` is recorded (`wrapStreamResult`). Empty stream ⇒ `Error{code:"empty_stream", retryable:true}`.

### 7.1 `shouldRetryAfterErrorWithAttempted` (non-Home path, `conductor_selection.go:1340-1408`)
Return (wait, retry):
1. err nil / status 200 / request-invalid (`isRequestInvalidError`) / request-stop ⇒ **no retry**.
2. Not a **retry-round error** ⇒ no retry. Retry-round errors = HTTP status ∈ {403, 408, 429, 500, 502, 503, 504} **or** transient transport error (`isCredentialRetryRoundStatus`, `isRequestRetryRoundError`, `:1455-1484`). (Note: 401/402/404/520-526 do not open new rounds.)
3. `retryAllowed(round)`: exists an auth (enabled, provider ∈ providers, eligible, supports model) with `round < effectiveRetry(auth)` and `retryRoundAvailabilityForAuth` true. That function (`:1127-1166`) treats a blocked auth as retry-eligible only if it has a known future recovery time AND its last error (credential or model level) is one of the retry-round statuses (or it has `quota.exceeded` with no error).
4. `closestCooldownWait`: min over eligible auths of `(next − now)`; **zero wait** if some eligible auth is already available; special case: an auth already attempted in the round that just failed with **429** and cooling enabled must not give a zero-wait retry ⇒ wait = max(next−now, **10 s** (`minQuotaCooldownFloor`)) (`:1255-1268`).
5. If a wait was found: `wait > 0 && (W ≤ 0 || wait > W)` ⇒ **give up** (no retry); else retry after `wait`. If no wait found but the error carries `RetryAfter` (`<0` or `>W` ⇒ give up) use it; else retry immediately.
6. `waitForCooldown`: sleep `wait + rand(0, min(wait/4, 2 s))`, further capped so total ≤ W (`jitteredCooldownWait`, `:1486-1514`; cancelled by request ctx).
After exhausting rounds the *preferred upstream error* (last error that actually reached an upstream; `preferredExecutionAttemptError`) is returned to the client, else the last error.

### 7.2 Antigravity credits fallback (`quota-exceeded.antigravity-credits`, `conductor_home.go:1352-1447`)
After all rounds fail with 429/503 (or auth_not_found/auth_unavailable/model_cooldown) and the model name contains `claude` and some antigravity auth has a known AI-credits hint (`SetAntigravityCreditsHint`, in-memory map, set by the Antigravity executor): re-run on those auths with context flag `WithAntigravityCredits` ⇒ executor injects `enabledCreditTypes` into the payload. Results still `MarkResult`.

---

## 8. Result handling: cooldowns, quota, error classification

### 8.1 Constants (`conductor_refresh.go:27-47`)
| Name | Value | Use |
|---|---|---|
| `quotaBackoffBase` | 1 s | first 429 cooldown without hint |
| `quotaBackoffMax` | 30 min | ceiling of exponential ladder |
| `minQuotaCooldownFloor` | **10 s** | minimum when upstream gives `RetryAfter` (and wait floor, §7.1) |
| `transientErrorCooldown` | **1 min** | default for 408/5xx; override `transient-error-cooldown-seconds` (0 = default, <0 = disabled, >0 seconds) |
| 401/402/403 cooldown | **30 min** | hard-coded |
| 404 cooldown | **12 h** (or `RetryAfter`) | hard-coded |
| model-support error cooldown | **12 h** (or `RetryAfter`) | |
| invalid_grant (request path) | 30 min | |
| `refreshCheckInterval` | 5 s | loop default |
| `refreshMaxConcurrency` | 16 | workers (`auth-auto-refresh-workers`) |
| `refreshPendingBackoff` | 1 min | |
| `refreshFailureBackoff` | 5 min | |
| `invalidGrantBackoffBase/Max` | 1 min / 30 min | |
| `refreshIneffectiveBackoff` | 30 s | |
| `maxRefreshTimerWait` | 30 s | |

Exponential ladder (`nextQuotaCooldown`, `conductor_cooldown.go:2408`): `cooldown = 1s << level`, capped 30 min (level not incremented once capped); returns `(cooldown, level+1)`. `quotaCooldownAfterFailure` (`:2395`): if a quota window is still open (`NextRecoverAt>now`) reuse it and **do not escalate** (a burst of concurrent 429s advances the ladder once per window); else new window `now + ladder(level)`.
`disable-cooling` precedence (`quotaCooldownDisabledForAuthWithConfig`, `:56`): Home ⇒ true; per-auth metadata `disable_cooling`; per-openai-compat-provider `disable-cooling`; global config `disable-cooling`; global atomic flag. When disabled, NextRetryAfter stays zero and `Unavailable/Quota.Exceeded` are cleared (unless error code `force_cooldown`).

### 8.2 `MarkResult` (`conductor_cooldown.go:762-1081`) — the state machine
Preconditions: apply optional `ResultPolicy`; `modelKey = canonicalModelKey(result.Model)` (fallback: selection key of `RouteModel`); **stale** results (`result.CredentialVersion < current.CredentialVersion` (with `result.CredentialVersion>0 || current>1`) or `result.RegistrationEpoch < current`) are ignored except hook/event publication. Always: `recordRecentRequest(now, success)`, `Success++/Failed++`.

**Success**:
* if terminal-unauthorized: reset that model's state only.
* else if auth has active `credential_quota` window: leave as is.
* else if `modelKey != ""`: `resetModelState` (status active, clear flags/error/quota cooldown fields), `updateAggregatedAvailability`; if no model has an error left ⇒ `auth.LastError=nil, StatusMessage="", Status=active`.
* else `clearAuthStateOnSuccess`.

**Failure with a model key** (normal path; skipped entirely when `shouldSkipCredentialCooldown`, i.e. request-scoped / connection-lifecycle / transient-transport errors, unless `code==force_cooldown`):
`state := ModelStates[modelKey]` (created `status=active`); `state.Unavailable=true; Status=error; LastError=result.Error; StatusMessage=error.Message; auth.LastError/StatusMessage updated (unless terminal-unauthorized)`. Then `NextRetryAfter` by first matching row:

| # | Condition | `state.NextRetryAfter` | Quota fields on state |
|---|---|---|---|
| 1 | model-support error (explicit model-not-found; or HTTP 400/404/422 + message matches "model_not_supported", "requested model is (not supported\|unsupported\|unavailable)", "model is not supported", "model not supported", "unsupported model", "model unavailable", "not available for your plan", "not available for your account") | `now+RetryAfter` if given else **now+12 h** (`disable_cooling` ⇒ none) | – |
| 2 | Cloudflare challenge (msg contains `challenge-platform`, `cf-mitigated`, `cloudflare challenge`, or "just a moment"+"cloudflare"; and HTTP status < 500) | ladder: `max(10 s, 1s<<level)`; `StatusMessage="cloudflare challenge"` | `exceeded=true, reason="cloudflare challenge", next_recover_at, backoff_level` |
| 3 | invalid_grant in code/message with status 0/400/401 | now+30 min | – |
| 4 | HTTP 401, 402, 403 | now+30 min | – |
| 5 | HTTP 404 | `now+RetryAfter` else now+12 h | – |
| 6 | HTTP 429 | see below | `exceeded=true, reason="quota", next_recover_at=next, backoff_level` |
| 7 | 408, 500, 502, 503, 504, 520–526 | `recoverableFailureRetryAfterWithHint`: `now+RetryAfter` if hint>0, else 60 s / configured seconds; disabled if configured <0 | – (`Unavailable = NextRetryAfter≠0`) |
| 8 | anything else | 60 s / configured (same as 7 without hint) | – |

429 detail: `backoff = state.Quota.BackoffLevel` (credential-scope: 0 or the auth-level level). If cooling enabled: `RetryAfter` given ⇒ `next = now + max(RetryAfter, 10 s)`; else `next, backoff = quotaCooldownAfterFailure(quota, now)`. `next = max(next, state.Quota.NextRecoverAt)` when still in future.
**CredentialScope** (e.g. Anthropic 5h/7d unified limit, Codex `usage_limit_reached`, see §8.3): additionally every *other* model state is marked `Unavailable, Status=error`, `Quota{exceeded, reason:"credential_quota", next_recover_at = max(credentialNext, other.next), backoff_level}` with `NextRetryAfter` extended (never shortened), and the auth gets `Unavailable=true, Quota{exceeded, "credential_quota", next}` and `NextRetryAfter=next`. Selector then blocks the whole credential (§6.2.4).
Afterwards: `if disableCooling ∧ both deadlines zero ⇒ Unavailable=false, Quota.Exceeded=false`; `force_cooldown` with zero deadline ⇒ now+1 min; **a later failure never shortens a live cooldown** (`prevModelRetryAfter` kept if later); `auth.Status=error`; `updateAggregatedAvailability`.

**Failure with no model key** → `applyAuthFailureState` (`:2280-2393`): same table at credential level with `StatusMessage`s: `cloudflare challenge`, `invalid_grant`, `unauthorized` (401), `payment_required` (402,403), `not_found` (404), `quota exhausted` (429; `Quota.Exceeded, reason "quota"`), `transient upstream error` (408/5xx/520-526), else `request failed` (error message). Same never-shorten rule.

Post-processing: `auth.Generation++`; `ObserveResponseHeadersForProvider` (§8.5) on auth and model quota; `persistLocked` (re-saves the auth file: for map-only auths a no-op when JSON is deep-equal (`jsonEqual`), for Storage-backed auths the file is rewritten; only `disabled`+tokens are persistable so the port can skip this on result marking); scheduler snapshot update (only the affected model shards unless CredentialScope); if cooldown records changed ⇒ persist `.cds` store; registry projection (`ClientModelProjection{suspended, suspendReason, quotaExceeded}`) so `/v1/models` can hide cooling models; hook `OnResult`; error event publication; session-affinity `OnResult`.

`updateAggregatedAvailability` (`:1371-1455`): terminal unauthorized ⇒ `Unavailable=true`; active `credential_quota` ⇒ `Unavailable=true`; no model states ⇒ clear; else `Unavailable = all model states unavailable` (states whose deadline passed are auto-cleared here), `NextRetryAfter = earliest retry` (when all unavailable); `Quota` aggregated from model states (exceeded if any, reason "quota", recover = earliest, level = max).

### 8.3 Provider-specific error parsing (executors → `statusErr{code,msg,retryAfter,credentialScoped}`)

**Claude** (`internal/runtime/executor/claude_executor_request.go:697-715`, `helps/claude_ratelimit.go`):
* `retryAfter = ParseClaudeRateLimitReset(headers, now)` for 429 and any 4xx/5xx: collect deadlines from `Retry-After` (seconds/HTTP-date; skipped for "overage/Fable-only" rejections), `Anthropic-Ratelimit-Unified-5h-Reset` (only if `…-5h-Status: rejected`), `…-7d-Reset` (if `…-7d-Status: rejected`), `…-7d_oi-Reset`, and `Anthropic-Ratelimit-Unified-Reset` (if unified rejected and it isn't the overage billing boundary). Reset values: unix seconds (float) or RFC3339/HTTP-date. Drop deadlines in the past or **> 7 d + 1 h** away. Take the **latest** deadline; cooldown = `deadline-now + random fuzz 1–30 s`. No deadline ⇒ nil (falls back to exponential ladder).
* `credentialScoped = true` iff 429 ∧ unified headers declare a rejected shared window: `5h-Status==rejected` or `7d-Status==rejected` or (`Unified-Status==rejected` ∧ not overage/Fable-only). Overage-only = `7d_oi rejected` / `Overage-Status rejected` / `Overage-Disabled-Reason` present / representative-claim contains "overage" while 5h/7d are `allowed|allowed_warning` (or absent with utilisation <1.0).
* 429 with body mentioning fast-mode credits ⇒ entitlement error ⇒ request-scoped (no cooldown) (`claudeBodyIndicatesFastModeCredits`).
* Config `claude.model-level-cooling` (`internal/config/config_types.go:116`) and `codex.model-level-cooling` (`:212`) force `credentialScoped=false` (cooldown stays on the requested model).

**Codex** (`codex_executor_terminal.go:316-445`): body `error.type == "usage_limit_reached"` (or top-level `type`) ⇒ status forced to 429, `credentialScoped = !modelLevelCooling`, `retryAfter` = `resets_at` (unix s, if future) else `resets_in_seconds`. "model is at capacity" messages ⇒ 429 (model-scoped).

**Generic / Gemini-style** `retryDelay` etc: `helps.ParseRetryDelay(body)` for Antigravity/Gemini 429 (google.rpc.RetryInfo); not reproduced here — owned by executor research.

### 8.4 Request-scoped error classification (no credential penalty, no rotation)
* `clienterror.IsRequestFault(status, err)` (`internal/clienterror/client_error.go:70-115`): false for 402/429; false for 401 with `authentication_error` body; true for Claude "thread state/previous_message_id" 404; false if body code is `model_not_found(_error)`; true if body `error.code|code|response.error.code|body.error.code` ∈ {`cyber_policy, context_length_exceeded, message_too_big, string_above_max_length, invalid_prompt, invalid_value, unsupported_value, invalid_request_error, previous_response_not_found`} or `…type` ∈ {`invalid_request, invalid_request_error, bad_request_error, invalid_prompt`}; true for plaintext "item with id … not found … items are not persisted when `store` is set to false"; else true for HTTP **400, 409, 413, 422**.
* `isRequestInvalidError` = request-scoped marker ∨ (not cloudflare-challenge ∧ not invalid_grant ∧ not model-support error ∧ `IsRequestFault`). ⇒ returned to the client at once; MarkResult records it as failure *without* cooldown (`shouldSkipCredentialCooldown`).
* Skipped-cooldown classes (`shouldSkipCredentialCooldown`, `:1587`): request-scoped; **connection lifecycle** (ctx cancelled/deadline, EOF, `websocket: close 1000|1001|1006`, only when no HTTP status); **transient transport** (no HTTP status: DNS temp/timeout errors, net timeouts, ECONNREFUSED/RESET/ABORTED/ETIMEDOUT/EHOSTUNREACH/ENETUNREACH/EPIPE, or message contains tls handshake/refused/reset/i-o timeout/no such host/server misbehaving/unreachable/broken pipe/aborted/closed connection/unexpected eof). Transient transport *does* count as a retry-round error (§7.1) but never cools the credential. A Workers `fetch` rejection (TypeError: Network connection lost, etc.) should map to transient-transport; AbortSignal ⇒ lifecycle.
* **Per-credential rules** (`request-scoped-errors`, `conductor_request_scoped_errors.go`): list of `{status, match[], match-regexr[], action}`; first rule with `status == error status` and (any substring of the **response body** (or error text) matches or any regex matches) wins; actions: `stop` (return to client, mark request_scoped = no penalty), `stop-and-cooldown` (return to client, code `force_cooldown` ⇒ cooled), `continue` (try next credential, no penalty), `continue-and-cooldown` (next credential + cooled). Rules source: auth metadata `request_scoped_errors` → for OAuth auths `oauth-request-scoped-errors[provider]` → for key auths the owning config entry.
* Also request-fault for `/responses/compact`: 400/404/405/409/413/422/501 or fault body ⇒ returned without rotation; availability-neutral (counts request but no cooldown).
* `count_tokens` endpoint 404 (not model-not-found) is not a credential fault (`isCountTokensEndpointNotFoundError`).

### 8.5 Passive quota signals (`quota_signals.go`)
Only for providers `claude`, `codex`, `devin` (`ProviderSupportsQuotaObservation`). On each result (unless `SkipQuotaObservation`, e.g. count_tokens) the **response header snapshot replaces** `Quota.Signals` (and `ObservedAt`) if at least one matching header exists: `Retry-After` (claude, codex), `anthropic-ratelimit-unified-*` (claude), `x-codex-*` families (codex: `x-codex-active-limit`, `x-codex-plan-type`, `x-codex-credits-*`, `…-allowed|-limit-reached|-limit-name|-used-percent|-window-minutes|-reset-after-seconds|-reset-at|-over-secondary-limit-percent`), `x-ratelimit-*` (codex, inert). Keys stored canonical-cased (`Anthropic-Ratelimit-Unified-5h-Utilization`), last header value, max **64** headers, value ≤512 chars and no control chars; retention rank for truncation: retry-after/anthropic > codex plan/credits > allowed/primary/secondary > code-review > other x-codex > additional-*. Used by the management UI only; not by selection. Devin writes signals itself (§9.6).

### 8.6 Recent-requests ring (`types.go:158-292`)
20 buckets × 600 s (200 min), `bucketID = unix/600`, slot `bucketID % 20`; bucket reset when id differs. Snapshot returns 20 entries oldest→newest with label `"HH:MM-HH:MM"` (local tz). In-memory only; carried across `Update` (`auth.recentRequests = existing.recentRequests`), lost on restart/`Load`.

### 8.7 Cooldown persistence (`save-cooldown-status`, default false) (`cooldown_state.go`, `conductor_cooldown.go:571-731`)
Record (JSON, per auth+model; auth-level when `model` empty):
```
{ "provider","auth_id","model?","status":"cooling","next_retry_after":RFC3339,
  "reason","quota":{exceeded,reason,next_recover_at,backoff_level},"last_error":{code,message,retryable,http_status},"updated_at" }
```
File envelope: `{"version":1,"auth_id","provider","updated_at","records":[…sorted by model]}`; one `.cds` file per auth, placed next to the auth file (`<authfile>.cds`-style relative path under `auth-dir`, name sanitised `[^A-Za-z0-9._-]+→_`), atomic temp-file write, stale `.cds` files deleted. Only **unexpired** cooling records are saved; saved whenever the set of records changes. On start (`RestoreCooldownStates`) records with future `next_retry_after` are re-applied to registered auths unless disabled/cooling-disabled/terminal-unauthorized; auth-level records applied after model-level. Config reload with cooling disabled clears states. Port: store as rows in D1 (or DO storage) keyed `(auth_id, model)`.

---

## 9. Token refresh

### 9.1 Which auths refresh (`nextRefreshCheckAt`, `auto_refresh_loop.go:~345-430`; `shouldRefresh`, `conductor_refresh.go:~100-170`)
Never refreshed: `AuthKind==apikey`; terminal-unauthorized (`hasUnauthorizedAuthFailure`); disabled-with-invalid_grant; `NextRefreshAfter` in the future (then scheduled for that time). Otherwise (`Runtime` `RefreshEvaluator` hook aside):
1. If `refresh_interval*` set: due when expired / within interval of expiry / never refreshed / `now-last ≥ interval`.
2. Else provider **lead** (`ProviderRefreshLead`): *no lead ⇒ never auto-refreshed*. Due when `expiry - now ≤ lead`; if no expiry known: `now - last_refresh ≥ lead` (or immediately if never refreshed).
Leads (`sdk/auth/*.go RefreshLead`, registered `sdk/auth/refresh_registry.go:10-21`): 

| Provider | Lead |
|---|---|
| `codex` | **24 h** |
| `claude` | **4 h** |
| `antigravity` | **30 min** |
| `xai` | **5 min** (`xaiauth.refreshLead`) |
| `kimi`, `kimi-ai`, `kimi.ai` | **5 min** (note: provider `kimi.com` has no registered lead ⇒ never auto-refreshed) |
| `devin` | none (permanent token) |
| `meta` | none (mint on demand: when `api_key` missing, or after a 401) |
| `vertex`, `gemini`, `aistudio`, openai-compat, plugins | none |

### 9.2 Loop mechanics (`auto_refresh_loop.go`, `conductor_refresh.go:50-95,300-330`)
* Started at service start with `interval=15 min` (`service_lifecycle.go:98`), but `interval` is only the *re-check spacing* when an auth can't be refreshed now; the loop is a **min-heap keyed by next due time**; the timer sleeps `min(next-now, 30 s)` (cap so suspend/resume is noticed). Rebuild at start from all auths; targeted re-schedule via `queueRefreshReschedule(id)` on every Register/Update/refresh result.
* When due: `markRefreshPending` (skip if a job exists / `NextRefreshAfter` future / epoch mismatch): creates job, sets `NextRefreshAfter = now+1 min` (pending marker). Job pushed into a buffered channel (cap `max(workers*4, 64)`) consumed by `N=16` workers (`auth-auto-refresh-workers`); channel full ⇒ job dropped, retry at `now+interval`. No executor registered ⇒ re-check at `now+interval`.
* Worker: `refreshAuthForRequestAtEpoch(id, "", epoch)` then `finishRefreshJob` (clears the pending marker only if unchanged).
* Refresh itself (`conductor_refresh.go:refreshAuthForRequestAtEpoch`):
  1. strips request proxy from ctx; `markRejectedAccessToken` if called due to 401 (only when token has no JWT/expiry info);
  2. **per-auth mutex** (`refreshLocks`); reload clone; verify executor and epoch; refuse if terminal-unauthorized or disabled-invalid_grant (unless `ForceRefresh`);
  3. if `failedAccessToken != ""` and the stored access token differs ⇒ someone else already refreshed ⇒ return it;
  4. `exec.Refresh(ctx, clone)`; on `context.Canceled`: `NextRefreshAfter = now+1 s`; on success commit through `UpdateRefreshedAuth` (merge three-way vs concurrent edits, `MergeRefreshedAuth`): sets `LastRefreshedAt=now`, `NextRefreshAfter=0`, clears `LastError/StatusMessage/Unavailable/RefreshFailures/RejectedAccessToken`, `Status=active` if it was `error`/empty, clears unauthorized model states; **if the refreshed auth would still need refresh ⇒ `NextRefreshAfter = now+30 s`** (ineffective-refresh guard). The commit uses `context.WithoutCancel` so a rotated refresh token is never lost to a client cancel; persist failure is warned (a restart would then hit `invalid_grant`).
  5. After commit, registry projections are re-applied.
* Failure handling (same function): classify `unauthorized` (HTTP 401 / "status 401") and `invalid_grant` (message contains `invalid_grant` ∧ status ∈ {0,400,401}); write `LastError = {message, http_status, code:"unauthorized" if 401}`; then:

| Situation | Result |
|---|---|
| already terminal-unauthorized | stay terminal, no reschedule |
| disabled ∧ invalid_grant | `Status=disabled`, `StatusMessage="disabled (invalid grant)"`, unschedule |
| disabled (other error) | `NextRefreshAfter=now+5 min` |
| the failing access token was rejected by upstream ∧ invalid_grant | **terminal**: `Unavailable, Status=error, NextRefresh/NextRetry=0`, `LastError{unauthorized}`, `"unauthorized (refresh token invalid)"`, unschedule (needs new login) |
| no valid access token (or rejected) | `Unavailable=true, Status=error`; 401 ⇒ `NextRefreshAfter=0` (`StatusMessage "unauthorized"`; terminal-ish); invalid_grant ⇒ `RefreshFailures++`, `NextRefreshAfter = now + min(30 min, 1 min·2^(failures-1))` (shift capped at 10), `"invalid grant (retrying)"`; else `NextRefreshAfter=now+5 min`, `"token expired"` |
| access token still valid | keep serving; `NextRefreshAfter = now+5 min` (invalid_grant: backoff above), but never later than the token's expiry; log warning |

### 9.3 Request-time refresh on 401 (`tryRefreshAfterUnauthorized`, `conductor_refresh.go:~520-545`)
In every execute path: on first 401 per auth per request (and not request-scoped, auth has `refresh_token`/`refreshToken` (or Meta `dca_token`), not terminal-unauthorized) ⇒ `refreshAuthForRequest(id, failedAccessToken)`; success ⇒ same request re-executed once on the refreshed auth; failure ⇒ proceed with normal failure handling (30 min cooldown etc.). Concurrency: the per-auth mutex + "token already changed" check de-duplicate N concurrent 401s.

### 9.4 Per-provider refresh protocols
All HTTP calls here are *credential acquisition* (30 s timeout in most; the only network timeouts allowed by project rules).

**Codex** (`internal/auth/codex/openai_auth.go:25-27,190-300`; executor `codex_executor_auth.go:17-85`):
`POST https://auth.openai.com/oauth/token` `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, body `client_id=app_EMoamEEZ73f0CkXaXp7hrann&grant_type=refresh_token&refresh_token=<rt>&scope=openid profile email`. Timeout 30 s, single-flight keyed by refresh token, `RefreshTokensWithRetry(…, 3)`: attempts with `attempt` seconds sleep between; **non-retryable if error text contains `refresh_token_reused`**; any other failure retried (up to 3). Response `{access_token, refresh_token, id_token, token_type, expires_in}`; `account_id/email/plan_type` re-derived from `id_token` JWT (failure ⇒ defaults "" / "free"). Written into metadata: `id_token, access_token, refresh_token (if non-empty), account_id (if non-empty), email, expired = now+expires_in (RFC3339), type="codex", last_refresh=now (RFC3339), plan_type`; `Attributes.plan_type` updated. No refresh token ⇒ returns auth unchanged (no error).

**Claude** (`anthropic_auth.go:22-45,490-610`; executor `claude_executor_auth.go:149-185`):
`POST https://platform.claude.com/v1/oauth/token`, headers `Accept: application/json, text/plain, */*`, `Content-Type: application/json`, `User-Agent: axios/1.15.2`, `Accept-Encoding: gzip, compress, deflate, br`, `Connection: close`; JSON body `{"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","grant_type":"refresh_token","refresh_token":"<rt>","scope":"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"}`. Single-flight per refresh token, 30 s timeout. Response `{access_token, refresh_token, token_type, expires_in, organization:{uuid,name}, account:{uuid,email_address}}`; if `refresh_token` empty keep old. Then best-effort `GET https://api.anthropic.com/api/oauth/profile` (same axios headers + `Authorization: Bearer <at>` + `Cache-Control: no-cache`) → `{account:{uuid,email}, organization:{uuid,name}}` (failure ⇒ keep previous identity, never blank it). Retry policy (`RefreshTokensWithRetry(…,3)`): sleeps `attempt` s; **only HTTP ≥500 are retryable**; transport errors and other statuses are *not* retried (token may already be consumed); **HTTP 429 ⇒ not retryable and blocks that refresh token for `Retry-After` (clamped 5 s…5 min; default 5 s; also `Retry-After-Ms`)** (in-process map). Metadata written: `access_token, refresh_token, email, account_uuid, organization_uuid, organization_name, expired, type="claude", last_refresh`. Other login endpoints: authorize `https://claude.ai/oauth/authorize` (`code=true, client_id, response_type=code, redirect_uri=http://localhost:54545/callback, scope, code_challenge, code_challenge_method=S256, state`); code exchange = same token URL with JSON body `{grant_type:"authorization_code", code, redirect_uri, client_id, code_verifier, state}` (key order matters upstream-side; code may be `code#state`); followed by profile + `GET https://api.anthropic.com/api/oauth/claude_cli/roles`.

**Antigravity** (`executor/antigravity_executor_auth.go:23-155`; constants `internal/auth/antigravity/constants.go`):
Client ID `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`, client secret `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` (public installed-app secret embedded in source). `POST https://oauth2.googleapis.com/token` form `client_id, client_secret, grant_type=refresh_token, refresh_token`; headers `Host: oauth2.googleapis.com`, `Content-Type: application/x-www-form-urlencoded`, `User-Agent: Go-http-client/2.0`. Timeout 30 s, single-flight per refresh token. Response `{access_token, expires_in, (refresh_token?), token_type}`. Metadata written: `access_token, refresh_token (if returned), expires_in, timestamp=unixMilli(now), expired=now+expires_in (RFC3339), type="antigravity"`; then `ensureAntigravityProjectID` (if `project_id` missing) and queue credits-hint refresh. Error: non-2xx ⇒ `statusErr{code, body}` (429 parses `retryDelay`). Request-time guard: if `access_token` empty or expiry within **5 min** (`antigravityRequestTokenSafetyWindow`) the executor refreshes inline before the call (`ensureAccessToken`). Login: auth URL `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&client_id&prompt=consent&redirect_uri=http://localhost:51121/oauth-callback&response_type=code&scope=<cloud-platform userinfo.email userinfo.profile cclog experimentsandconfigs>&state`; user info `GET https://www.googleapis.com/oauth2/v2/userinfo?alt=json`.
Project discovery (`internal/auth/antigravity/auth.go:249-406`): `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` body `{"metadata":{"ideType":"ANTIGRAVITY"}}`, `Authorization: Bearer`, `Accept: */*`, `Content-Type: application/json`, `User-Agent` = Antigravity UA (`misc.AntigravityRequestUserAgent`); project = first non-empty of `cloudaicompanionProject|projectId|project` (string, or object `.id`). If absent ⇒ `POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser` body `{"tier_id": <default allowedTiers[].id with isDefault, else currentTier.id, else "free-tier">, "metadata":{"ide_type":"ANTIGRAVITY","ide_version":<from UA>,"ide_name":"antigravity"}}`, headers add `X-Goog-Api-Client: gl-node/22.21.1`; poll up to **5** attempts (30 s each, 2 s sleep) until `done==true` then `response.<project keys>`.

**Kimi** (`internal/auth/kimi/kimi.go:27-50,596-668`; executor `kimi_executor.go:1044-1110`):
`POST https://auth.kimi.com/api/oauth/token` (or `https://auth.kimi.ai/...` for `kimi.ai` domain) form `client_id=17e5f671-d194-4dfb-9706-5516cb48c098&grant_type=refresh_token&refresh_token=<rt>`, headers `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, plus device headers `X-Msh-Platform: CLIProxyAPI`, `X-Msh-Version: <build version>`, `X-Msh-Device-Name: <hostname>`, `X-Msh-Device-Model: <model string>`, `X-Msh-Device-Id: <metadata.device_id>`. Single-flight; 401/403 ⇒ "refresh token rejected"; response `{access_token, refresh_token, token_type, expires_in (float), scope}`; empty access token ⇒ error. Written: `access_token, refresh_token (if returned), expired=now+expires_in (only if expires_in>0), type (if absent: kimi-ai|kimi), domain/base_url defaults, last_refresh`. Login = RFC 8628 device flow: `POST …/api/oauth/device_authorization` form `client_id`; poll `POST …/api/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code, device_code, client_id`; interval ≥5 s; max wait 15 min or `expires_in`; errors `authorization_pending`, `slow_down`, `expired_token`, `access_denied`.

**xAI** (`internal/auth/xai/xai.go:67-112,342-423`, `types.go`; executor `xai_executor_auth.go:16-77`):
Endpoint from OIDC discovery `GET https://auth.x.ai/.well-known/openid-configuration` (`token_endpoint`, validated by `ValidateOAuthEndpoint`) unless `metadata.token_endpoint` is cached. `POST <token_endpoint>` form `grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=<rt>`, headers `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`; 30 s client timeout; single-flight per refresh token; non-200 ⇒ error with body. Response `{access_token, refresh_token, id_token, token_type, expires_in}`; `email`/`sub` parsed from `id_token` (unverified base64url payload). Written: `type="xai", auth_kind="oauth", access_token, refresh_token, id_token, token_type, expires_in, expired (UTC RFC3339), email, sub, token_endpoint, base_url (default https://api.x.ai/v1), last_refresh (UTC RFC3339)`; `Attributes.auth_kind="oauth"`, `base_url`. Device login scope: `openid profile email offline_access grok-cli:access api:access`, default poll 5 s, max 30 min, `urn:ietf:params:oauth:grant-type:device_code`.

**Meta** (`internal/auth/meta/meta.go:24-36,425-475`; executor `meta_executor.go:87-200`):
Not a token refresh: *mint* an LLM API key from the DCA token. `POST https://api.meta.ai/muse-code/key` (override env `META_MINT_URL`), headers `Authorization: Bearer <dca_token>`, `User-Agent: muse-code/1.0.2`, `Content-Type: application/json`, `Accept: application/json`, body `{"dca_token":"<dca_token>"}`. Response `{api_key, base_url, user_email, user_full_name, subs_tier_name, subs_tier_id, is_subs_active, has_payment_method, require_payment, can_subscribe}`; empty `api_key` ⇒ error. Written: `base_url, api_key, access_token=api_key, dca_token, (expired deleted), email, name, subs_tier_name/id (deleted if empty), is_subs_active, has_payment_method, type="meta", last_refresh`; attributes `base_url, api_key, access_token`. Triggers: `PrepareRequestAuth` when auth has a DCA token but no API key (`ShouldPrepareRequestAuth`); inline `ensureAuth`; 401 recovery (`authHasRefreshCredential` accepts `dca_token`). Serialized with the refresh lock; **mint result is persisted before use** (error if save fails). Not in the auto loop. Login: device flow `POST https://auth.meta.com/oidc/device/authorization/` form `client_id=1031625952748946` (UA `muse-code/1.0.2`); poll `POST https://auth.meta.com/oidc/device/token/` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`; same OAuth error codes; max 15 min.

**Devin** (`executor/devin_executor.go:143-225`; `internal/auth/devin/*`): `Refresh` only refreshes *metadata + quota signals* (no token): `POST <base_url default https://server.codeium.com>/exa.seat_management_pb.SeatManagementService/GetUserStatus` (Connect protocol, `Content-Type: application/proto`, `Connect-Protocol-Version: 1`, `Authorization: Basic <token>-<token>`, empty UA; protobuf body). Result fills `email,user_name,user_id,team_id,plan,org_id,org_name` (metadata+attributes) and `Quota.Signals{plan, daily_quota_remaining_percent "NN%", weekly_quota_remaining_percent, daily/weekly_quota_reset_at, plan_start, plan_end}`, `ObservedAt`. Not scheduled (no lead) — only invoked via `ForceRefresh`/management. Profile: `GET https://api.devin.ai/v3/self` (`Authorization: Bearer`) → `user_name,user_id,org_id`. Port as optional.

**Vertex / Gemini API-key / AI Studio / OpenAI-compat**: `Refresh` returns the auth unchanged (compat: error only if the auth has a refresh_token, i.e. misconfigured). Vertex access tokens minted per request (§2.2).

### 9.5 Request-time preparation (`RequestAuthPreparer`, `Manager.PrepareRequestAuth`, `conductor_execution.go:1522-1593`)
Before executing, if `executor.ShouldPrepareRequestAuth(auth)`: take per-auth prepare lock (Meta uses the refresh lock), re-read current auth, call `PrepareRequestAuth(clone)`, merge via `UpdatePreparedAuth` (does not touch refresh lifecycle/cooldown fields) and persist. Implementations: **Claude** (OAuth token and (no canonical device-id pool or no account UUID)) — ensure `claude_device_ids`, fetch `/api/oauth/profile` (10 s timeout) to fill `account_uuid/email/organization_*`, `claude_account_profile_checked_at`; on 403/scope errors or setup tokens derive a stable `account_uuid` from a seed (`StableClaudeCLIAccountUUID`); **Antigravity** (no `project_id`) — ensure fresh token then project discovery (30 s); **Meta** (DCA token, no API key) — mint.

### 9.6 Manual / bulk refresh
`ForceRefreshAuth(id)` (ignores terminal-unauthorized/disabled gating) and `ForceRefreshAll` (all non-disabled auths with refresh credential or Runtime; worker pool = `auth-auto-refresh-workers` or 16).

---

## 10. Persistence & in-memory-only inventory

| State | Where it lives | Survives restart? | Port suggestion |
|---|---|---|---|
| Token material, `expired`, `last_refresh`, identity fields, user flags (`disabled`, `priority`, `weight`, `prefix`, `proxy_url`, `headers`, `excluded_models`, `model_aliases`, …) | auth JSON file (`FileTokenStore.Save`) = `Auth.Metadata` (+Storage struct) | yes | D1 row per credential (JSON blob + indexed `id/provider/disabled`) or KV; **write-through on every refresh/prepare** (token rotation!) |
| Config-derived API-key auths | recomputed from config each load; **never saved** | n/a | recompute from config; keep stable-ID algorithm (§4.3) |
| `Status, StatusMessage, Unavailable, NextRetryAfter, Quota, ModelStates, LastError` | memory | **no**, unless `save-cooldown-status` ⇒ `.cds` (only unexpired cooling records, §8.7) | DO memory + periodic/diff-triggered persistence to D1; at minimum persist records of long cooldowns (30 min/12 h/Anthropic 5h/7d) |
| `NextRefreshAfter, RefreshFailures, RejectedAccessToken`, refresh jobs, refresh blocks (Claude 429 map) | memory | no | DO memory |
| `Success/Failed` counters, recent-requests ring | memory | no | optional (UI) |
| Round-robin cursors (`lastPicked`), smooth-WRR credits, mixed-provider cursors, openai-compat model-pool offsets | memory | no | DO memory (loss only perturbs fairness) |
| Session affinity cache + LCP matcher | memory (TTL 1 h default, 65 536 entries) | no | DO memory or KV w/ TTL |
| `RegistrationEpoch/CredentialVersion/Generation` | memory (re-derived at `Load`: epoch+1, generation 1, credential version = prev or 1, +1 if creds changed) | no | needed only for in-flight fencing; DO single-writer removes most need |
| Antigravity credits hint, Antigravity project/model probes | memory (30-min TTL in Home mode) | no | cache |
| AI Studio auths | memory, tied to websocket | no | DO holding WS |

Persist rules (`Manager.persist`, `conductor_lifecycle.go:519-560`): skip when no store, config-API-key auth, `runtime_only=true`, plugin-virtual, `Metadata==nil`; per-auth lock + monotonic `(RegistrationEpoch, Generation)` guard drops out-of-order writes; `WithSkipPersist(ctx)` used when reacting to file-watcher events (file already source of truth). Save failures are logged, **non-fatal** (except Meta mint). `Register/Update` merge store-side mutations back (`mergeAuthSaveDelta`). `Load()` replaces the entire map atomically under an exclusive gate; removed IDs get tombstones (epoch+1) so stale async results can't resurrect them.
Store backends (file default; Postgres/git/object-store via `PGSTORE_*`, `GITSTORE_*`, `OBJECTSTORE_*`) implement `Store{List, Save, Delete}` (`store.go`) — the same JSON shape.

---

## 11. Merge semantics worth keeping (`metadata_merge.go`)
* `MergeExistingAuthMetadata(target, existingFile)`: when re-login overwrites a file, user-configured fields from the old file are carried over (everything except token lifecycle keys `access_token, refresh_token, id_token, session_id, expired, last_refresh, expires_in, timestamp, token_type, user_code, verification_uri(_complete)`; for Meta also `api_key, dca_token, dca_expired, dca_expires_at`); `disabled` carried unless explicitly set.
* `MergeRefreshedAuth(base, current, updated)`: three-way merge so a refresh that finished after a user edit/disable or a *new concurrent error/cooldown* does not clobber them: disabled flag = user's current unless only the executor changed it; active `credential_quota` / active cooldown / new concurrent error are preserved over the refresh's "healthy" status; otherwise a successful refresh clears error state. A refresh whose base credentials differ from the current ones (token changed meanwhile) is **discarded** and the current auth returned (`updateInternal`, `CredentialVersion` / `CredentialsChanged`).

---

## 12. Porting checklist (behaviours easiest to get wrong)

1. **Never select an expired OAuth token** (§6.2.3) and keep refresh ahead: leads codex 24 h / claude 4 h / antigravity 30 min / xai & kimi 5 min; loop wakes ≤30 s; failures back off 5 min; invalid_grant 1→30 min exponential; 401-rejected token + invalid_grant = terminal until re-login.
2. Refresh-token rotation requires **serialised refresh per credential** across all isolates; persist new tokens *before* releasing the lock; commit even if the client request was cancelled.
3. JWT `exp` outranks `expired` metadata; `RejectedAccessToken` forces immediate refresh.
4. Cooldown is **per (credential, model)**; credential-wide only for CredentialScope (Anthropic 5h/7d rejected headers, Codex `usage_limit_reached`). 401/402/403 = 30 min, 404/model-unsupported = 12 h, 429 = `Retry-After`-based (≥10 s) or 1 s·2^n up to 30 min (no escalation inside an open window), transient 5xx/408 = 60 s (configurable, `-1` off). Cooldowns only extend, never shorten.
5. Request faults (400/409/413/422 and listed body codes) and transport/cancel errors **never penalise** credentials; 429/402 always do even with `invalid_request_error` bodies; 401+`authentication_error` is a credential failure.
6. Retry semantics: failover within a round across credentials (no sleep), extra rounds only for 403/408/429/5xx(500,502,503,504)/transient transport, wait = closest recovery (zero if something is free; ≥10 s for an already-tried 429 credential), abort if wait > `max-retry-interval`; per-credential `request-retry` removes credentials from later rounds.
7. Streaming failover only before the first payload chunk.
8. Priority: only the highest available tier is selectable; session affinity may keep a lower-tier binding.
9. Config key IDs are content hashes: any change to key/base-url/proxy/prefix/headers ⇒ new identity.
10. `weight` semantic differs by strategy: only `weighted-round-robin` honours it; `weight<=0` excludes only under that strategy at pick time (`positiveWeightAuths`), though it is still a *valid* value.
11. Do not port: Home mode, plugins, utls fingerprinting, proxies, filesystem watcher, `.cds` file layout (replace with DB), pprof.

### Suggested Workers mapping (non-binding)
* One **Durable Object** ("AuthPool") per tenant/pool as the single writer: holds the `Map<id, Auth>`, rotation cursors, session cache, cooldown state; serialises refreshes (replaces `refreshLocks`/singleflight); schedules refresh with **DO alarms** (next due = min over `nextRefreshCheckAt`, cap 30 s only if you want suspend-resilience — not needed on Workers).
* **D1** for credential JSON (+ cooldown records `(auth_id, model, …)`), **KV** optionally for read-mostly config snapshot, **R2** not needed for credentials. **Cron** as a safety net to wake the DO.
* Treat `fetch` network rejections as `transient_transport`; map `AbortSignal` to `connection_lifecycle`.
