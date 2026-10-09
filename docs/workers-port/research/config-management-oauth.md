# Config schema, Management API, OAuth flows and Model registry (port reference)

Scope: CLIProxyAPI (Go) → TypeScript/Effect v4 on plain Cloudflare Workers. Read-only research; no Go code was changed.
All paths are relative to the repo root `/home/ianpascoe/src/ai-proxy`. Line numbers refer to the checked-out tree.
Secrets in `config.yaml`/`auths/` were NOT read; only schemas are described. Public OAuth client IDs (and the Antigravity installed-app client secret, which is hard-coded in source at `internal/auth/antigravity/constants.go:5-6`) are quoted because the port needs them.

Contents
1. Config schema (v8 layout, legacy aliases, defaults, Workers relevance)
2. Management API (`/v8/management/*`, auth, ban logic, control panel)
3. OAuth login flows per provider (+ token refresh, credential JSON shapes)
4. Model registry (embedded catalogs, remote updater, `/v1/models` per protocol)
5. Things that cannot run on Workers (summary)

---------------------------------------------------------------------------------------------------

## 1. Config schema

### 1.1 Loading model, layouts, aliases

* Go runtime struct is `internal/config/config.go:6` `Config` (flat, legacy-shaped; `SDKConfig` is inlined from `internal/config/sdk_config.go`; `sdk/config/config.go` is only type aliases + `LoadConfig` wrappers). The **v8 YAML layout** (`config.example.yaml`, `config-version: 8`) is translated to/from this flat struct only at the YAML boundary (`internal/config/config_v8.go:buildV8Paths` lines ~78-140: table `old → current` of every key).
* A TS port should model the **v8 layout as the canonical document** (store it as JSON in KV/D1/DO) and drop the legacy layout, unless old `config.yaml` import is wanted. Legacy→v8 mapping table is §1.4.
* Rules at the YAML boundary (`config_v8.go`, `config_v8_api.go`): when both spellings exist the v8 value wins (even `false`/`0`/empty); the legacy key is deleted on load; unknown v8 sections/fields are commented out (`commentUnknownV8Sections`); v8 allowed roots `models, config-version, api-keys, plugins, quota-exceeded, client` + the prefixes listed in 1.4; `ValidateV8Config` (config_v8.go ~857) rejects unknown `api-keys.<provider>` names and base-url at key level (`api-keys.<p>: base-url belongs to the group`).
* `LoadConfigOptional(path, optional)` (`config_load.go:21`): missing/empty/invalid file with `optional=true` returns an empty `Config` (cloud-deploy standby). Defaults applied **before** YAML unmarshal (`config_load.go:~50-70`): `host=""`, `logging-to-file=false`, `logs-max-total-size-mb=0`, `error-logs-max-files=10`, `usage-statistics-enabled=false`, `redis-usage-queue-retention-seconds=60`, `disable-cooling=false`, `save-cooldown-status=false`, `transient-error-cooldown-seconds=0`, `disable-image-generation=false(Off)`, `ws-auth=true`, `pprof.enable=false`, `pprof.addr="127.0.0.1:8316"`, discovery defaults (service-type `_ai-gateway._tcp`, subtypes `_chat-completions,_responses,_messages,_generate-content,_interactions`), `panel-github-repository=https://github.com/router-for-me/Cli-Proxy-API-Management-Center`, in-flight defaults.
* Post-unmarshal normalisation (`config_load.go:100-200`, `config_normalization.go`):
  * `management.secret-key`: if non-empty and not bcrypt-looking (`$2a$/$2b$/$2y$` prefix, `config_validation.go:67`) → hashed with `bcrypt.DefaultCost` (10) and **written back to the file** (`hashSecret`, config_validation.go:72). Port: store only a hash (bcrypt or better: PBKDF2/Argon via WebCrypto; but keep bcrypt-compat if importing existing hashes — needs a JS bcrypt lib).
  * `redis-usage-queue-retention-seconds` ≤0 → 60, >3600 → 3600. `error-logs-max-files` <0 → 10. `logs-max-total-size-mb` <0 → 0. `max-retry-credentials` <0 → 0. `panel-github-repository` blank → default. `pprof.addr` blank → default.
  * `NormalizeHeaders`: trim key/value, drop empty. `NormalizeExcludedModels`: lowercase+trim+dedupe, drop empty. `normalizeModelPrefix`: trim, strip leading/trailing `/`, returns `""` if it still contains `/`.
  * Gemini/Interactions keys: drop entries with empty api-key AND empty base-url; dedupe on `apiKey\0baseURL\0proxyURL\0prefix\0sortedHeaders` (`config_normalization.go:339-376`).
  * Codex & xAI keys: **drop entries with empty base-url**; xAI forces `alpha-search=false` (`:222-292`). Meta keys: drop empty api-key or api-key starting `dca:`; default `base-url=https://api.meta.ai/v1`; force `alpha-search=false` (`:249-272`).
  * Claude keys: normalise prefix/headers/excluded, `NormalizeCloakConfig` (trim mode, trim/drop empty sensitive words), `fingerprint-profile` normalised (`claude-code-cli`; legacy alias `oauth-cli`; unknown → "" ) (`internal/config/claude_fingerprint_profile.go`).
  * OpenAI-compat: drop entries with empty base-url; trim name/prefix/base-url; normalise headers.
  * `oauth.excluded-models`: provider key lowercased/trimmed; list normalised; empty lists dropped. `oauth.model-alias`: channel lowercased; entries need name+alias, skip `name==alias` (case-insens), dedupe by lowercase alias. `oauth.settings`: dedupe by `lower(name)->lower(alias)` keeping the **last** occurrence. `oauth.request-scoped-errors`: action lowercased; drop rules with `status<=0`, empty action, or no `match`/`match-regexr`.
  * Payload raw rules (`default-raw`, `override-raw`): values must be valid JSON (strings used as-is); invalid entries dropped (`config_validation.go:12-55`).
  * Credential `weight`: integers; `<=0` = excluded from weighted routing; `>1_000_000` = load error (`internal/credentialweight/*.go`: Default=1, Max=1_000_000). `trusted-proxies` validated as IP/CIDR (`trusted_proxies.go`).
  * Safe mode: if `access.api-keys` contains any of `your-api-key-1|2|3` (`internal/safemode/example_api_keys.go:9-13`) and the option is on, **all** `/v1/*`, `/v1beta/*`, `/openai/v1/*`, `/backend-api/codex/*` return `403 {"error":"unsafe_example_api_key","message":"..."}` with header `X-CPA-SAFE-MODE: example-api-key`; `GET /` and `GET|HEAD /management.html` return a warning HTML page unless `?safe-mode=configure` (`internal/api/server_middleware.go:61-125`). Port: optional nicety.
* "OAuth-only" scoping: v8 keys under `oauth.providers.*` apply to OAuth/file credentials only; API-key credentials get `cfg.ForAPIKey()` view (`internal/config/oauth_scope.go:13`). Shared per-provider behaviour lives under `upstream.<provider>`; client-compat under `client.codex`.

### 1.2 v8 key reference

Legend: **W** = relevant to Workers port; **~** = relevant only in a changed form; **✗** = irrelevant on Workers. "Used by" = Go subsystem. Defaults are the *effective* default.

#### `config-version`
| key | type | default | notes |
|---|---|---|---|
| `config-version` | int | – | `8`. Only a marker (`IsV8ConfigLayout`, config_v8.go ~795). W (keep as schema version) |

#### `models.*` — model catalog sources (`internal/registry/catalog_config.go`) **~**
| key | type | default | used by / notes |
|---|---|---|---|
| `models.catalog` | string (http(s) URL or absolute file path) | `""` → official remote URLs (§4.3) | general `models.json`. Relative paths/non-http schemes rejected (`Validate()`). Files not usable on Workers → URL only |
| `models.codex-catalog` | string | `""` | `codex_client_models.json` (Codex client template catalog) |
| `models.devin-catalog` | string | `""` | `devin_models.json` |
Explicit source beats `--local-model`; `--local-model` (no explicit source) uses embedded; custom sources never fall back to official URLs; failed refresh keeps last valid catalog; refresh every 3 h and on source change; Home mode never loads general+devin catalog (`registry/catalog_sources.go:configureCatalogs/effectiveCatalogSources`).

#### `server.*` (listener/TLS/discovery) — almost all **✗**
| key | type | default | used by / Workers |
|---|---|---|---|
| `server.host` | string | `""` | gin bind address. ✗ |
| `server.port` | int | `8317` (flag/config) | listener port; **also** used to build OAuth callback targets `http://127.0.0.1:<port>/…` (`management/auth_files_oauth_callback.go:managementCallbackURL`, `auth_files_devin_oauth.go:devinCallbackURL`) and the Devin `redirect_uri`. ✗ (replace by Worker public origin) |
| `server.github-token` | string | `""` | GitHub API token for release/asset downloads (management panel, latest-version, plugin store); precedence config > `GITHUB_TOKEN` env (`util.ResolveGitHubToken`). ~ (Worker secret) |
| `server.trusted-proxies` | []string IP/CIDR | `[]` | gin `SetTrustedProxies` – which proxies may supply `X-Forwarded-For`; affects `c.ClientIP()` used by management ban logic. ✗ (use `CF-Connecting-IP`) |
| `server.tls.{enable,cert,key}` | bool/string/string | false | HTTPS listener; also flips the scheme in `managementCallbackURL`. ✗ |
| `server.commercial-mode` | bool | false | disables high-overhead request logging + some middleware. ~ (could map to "no body logging") |
| `server.discovery.{enabled,service-name,service-type,subtypes,interfaces.include,interfaces.exclude,auth-required,advertise-management}` | mixed | enabled=false; type `_ai-gateway._tcp`; subtypes see above; `auth-required` default true; `advertise-management` false | mDNS/DNS-SD multicast (`sdk/cliproxy/discovery_advertiser.go`). **✗ (UDP multicast)** |

#### `management.*` (`RemoteManagement`, `config_types.go:319`)
| key | type | default | notes |
|---|---|---|---|
| `management.allow-remote` | bool | false | when false only loopback client IPs (`127.0.0.1`, `::1`) may call management. On Workers every caller is "remote" → port as "always allowed once a key is set" or an IP allow-list. ~ |
| `management.secret-key` | string (plaintext→bcrypt) | `""` | empty (and no `MANAGEMENT_PASSWORD` env) ⇒ management routes are **not registered** (404). W (store hash) |
| `management.disable-control-panel` | bool | false | disables `/management.html`. W |
| `management.disable-auto-update-panel` | bool | false | disables 3-hourly background download of panel. ~ |
| `management.base-url` | string | – | only for TUI client mode (`--tui`). ✗ |
| `management.panel-github-repository` | string (repo URL or releases API URL) | `https://github.com/router-for-me/Cli-Proxy-API-Management-Center` | source of `management.html` (§2.5). W |
Env override: `MANAGEMENT_PASSWORD` (plaintext, trimmed) – also forces `allowRemote=true` (`handler.go:NewHandler`, `allowRemoteOverride: envSecret != ""`). Env `MANAGEMENT_STATIC_PATH` (file/dir for the panel asset). ✗/~

#### `access.*`
| key | type | default | notes |
|---|---|---|---|
| `access.api-keys` | []string | – (example template: 3 placeholders) | **client** API keys for the proxy API (not upstream keys). Hot-reloaded. W |

#### `credentials.*` (Home/cluster only) **✗**
`credentials.concurrency.{lifecycle-config-revision,observation-barrier-revision,cpa-heartbeat-timeout(3s),cpa-cancel-bound(5s),reclaim-grace(5s),cleanup-interval(5s),release-flush-interval(250ms),release-max-backoff(2s),busy-retry-min(250ms),busy-retry-max(1s),max-limit(1_000_000)}` (`config/credential_concurrency.go:12-23`) and `credentials.in-flight.{snapshot-interval 2s, stale-after 10s, max-part-bytes 262144, max-part-count 64, max-revision-bytes 16777216, max-aggregate-groups 100000, max-details 10000, max-string-bytes 256, staging-retention 1m}` (`credential_in_flight.go`). Used only by CLIProxyAPIHome control plane (RESP/redis protocol). Revisions are read-only through management (`400 {"error":"read_only_field"}`). ✗ — a DO-based per-credential concurrency limiter could replace the idea but the keys are not needed.

#### `routing.*` (consumed by `sdk/cliproxy/service_config.go`, `sdk/cliproxy/auth/*`) **W**
| key | type | default | notes |
|---|---|---|---|
| `routing.strategy` | `round-robin`\|`weighted-round-robin`\|`fill-first` | `round-robin` | aliases accepted: `weightedroundrobin`,`wrr`; `fillfirst`,`ff` (service_config.go:46-50). Weighted uses per-credential integer weight (default 1, max 1,000,000; ≤0 excludes) |
| `routing.session-affinity` | bool | false | session→credential binding wrapper around the selector |
| `routing.session-affinity-ttl` | Go duration string | `1h` | invalid/≤0 → 1h; `<1s` clamped to 1s |
| `routing.session-affinity-subagents` | bool | true | only effective when affinity is on |
| `routing.force-model-prefix` | bool | false | unprefixed requests only use credentials without prefix (except prefix==model name); also controls model-list prefix exposure (§4.6) |
| `routing.retry.request-retry` | int | 3 (example) / Go zero-value 0 | extra credential retry rounds; per-credential `request-retry` overrides (negative/omitted inherits; 0 disables) |
| `routing.retry.max-retry-credentials` | int | 0 (=all) | cap per round |
| `routing.retry.max-retry-interval` | int seconds | 0 in struct / 30 in example | max cooldown wait between rounds; ≤0 never waits |
| `routing.cooldown.disable-cooling` | bool | false | per-credential `disable-cooling` overrides |
| `routing.cooldown.save-cooldown-status` | bool | false | persist cooldown `.cds` files next to auth files (filesystem) → ~ (persist in DO/D1) |
| `routing.cooldown.transient-error-cooldown-seconds` | int | 0 | 0 = legacy 60 s, -1 disables; applies to 408/500/502/503/504/520-526 |
Additional rounds apply to HTTP 403/408/429/500/502/503/504.
Legacy-only `quota-exceeded.{switch-project,switch-preview-model}` (no v8 equivalent; Config.QuotaExceeded) and `quota-exceeded.antigravity-credits` → `oauth.providers.antigravity.antigravity-credits`.

#### `requests.*` **W**
| key | type | default | notes |
|---|---|---|---|
| `requests.proxy-url` | string | `""` | socks5/http/https proxy for upstream calls; per-entry `proxy-url` overrides; `direct`/`none` bypasses. **✗ on Workers** (no outbound proxy/raw TCP; ignore or reject) |
| `requests.passthrough-headers` | bool | false | forward filtered upstream response headers downstream |
| `requests.nonstream-keepalive-interval` | int s | 0 | emit blank lines every N s on non-stream responses (idle-timeout avoidance) |
| `requests.streaming.keepalive-seconds` | int | 0 | SSE keep-alives; ≤0 disabled |
| `requests.streaming.bootstrap-retries` | int | 0 | retries before first byte |
| `requests.payload.{default,default-raw,override,override-raw,filter}` | rules | – | payload rules: `models:[{name(wildcard),protocol(openai\|gemini\|claude\|codex\|antigravity),from-protocol(openai\|responses\|gemini\|claude),headers{k:wildcard},match[{path:value}],not-match[...],exist[path],not-exist[path]}]`, `params` (map path→value; or list of paths for `filter`). Paths are gjson/sjson syntax. **Must be the final step before sending upstream** (AGENTS.md rule). W |

#### `client.codex.*` (`ClientConfig`, sdk_config.go) **W**
`client.codex.enable-apply-patch` bool false; `client.codex.optimize-multi-agent-v2` bool false (historic aliases: `oauth.providers.codex.optimize-multi-agent-v2`, `providers.codex.…`, `codex.…`; canonical wins by presence).

#### `upstream.*` (shared provider behaviour; `config_types.go:115-220`) **W**
| key | type | default | notes |
|---|---|---|---|
| `upstream.codex.response-steering` | bool | false | full-duplex WS steering. ✗/~ (needs WS client + DO) |
| `upstream.codex.disable-codex-cloaking` | bool | false | stop forcing Codex UA/originator |
| `upstream.codex.stream-bootstrap-buffering` | bool | false | hold handshake frames until first generated event so `server_is_overloaded` in-stream rejections can fail over; budget 48 SSE lines / 1 MiB; WS: 48 messages |
| `upstream.codex.stream-bootstrap-timeout` | string | `"0"` | Go duration or int seconds; `0/none/unlimited/disabled/off/never` = unlimited (`CodexConfig.StreamBootstrapTimeoutDuration`, config_types.go:232) |
| `upstream.codex.orphan-delegation-compatibility` | bool | false | header `X-Openai-Subagent: collab_spawn` orphan `function_call_output` handling |
| `upstream.codex.model-level-cooling` | bool | false | scope `usage_limit_reached` cooldown to model |
| `upstream.claude.model-level-cooling` | bool | false | same for Claude |
| `upstream.claude.disable-claude-cloak-mode` | bool | false | default cloak mode "never" |
| `upstream.claude.disable-cloaking-model-list` | bool | false | `ClaudeCode.DisableCloakingModelList` – return original model IDs in Anthropic list (§4.5) |
| `upstream.claude.header-defaults.{user-agent,package-version,runtime-version,os,arch,timeout,timezone,stabilize-device-profile}` | strings/bool | UA `claude-cli/2.1.280 (external, cli)`, pkg `0.112.1`, runtime `v26.3.0`, os `MacOS`, arch `arm64`, timeout `600`, tz fallback (examples) | Claude CLI fingerprint baseline |
| `upstream.xai.inject-x-search` | bool | false | inject native x_search tool |

#### API-key upstreams `api-keys.<provider>[]` (grouped; flattened to legacy `*-api-key` lists at load) **W**
Group = `{name, base-url, headers, proxy-url, prefix, priority, models[], excluded-models[], disable-cooling, request-retry, request-scoped-errors[], keys[]…}`; each `keys[]` entry carries `api-key`, `weight`, and optional per-key overrides (missing/`null` inherits the group value; explicit `false/0/""/[]` overrides; maps/lists replace whole). Provider families (`config_v8.go` `v8KeyFamilies`): `gemini`↔`gemini-api-key`, `interactions`↔`interactions-api-key`, `vertex`↔`vertex-api-key`, `codex`↔`codex-api-key`, `claude`↔`claude-api-key`, `xai`↔`xai-api-key`, `meta`↔`meta-api-key`, `openai-compatibility`↔`openai-compatibility` (keys→`api-key-entries`). Legacy flat list → groups via `groupLegacyKeys`: one group per legacy entry, auto-named `<provider>-<index+1>` (config_v8.go ~425).

Common key struct fields (`config_types.go`):
| field | type | notes |
|---|---|---|
| `api-key` | string | upstream secret |
| `priority` | int | larger wins |
| `weight` | *int | weighted-RR share |
| `prefix` | string | model prefix (`prefix/model`) |
| `base-url` | string | required for codex/xai/openai-compat; optional for others (vertex falls back to Google Vertex; claude to api.anthropic.com; gemini to generativelanguage.googleapis.com; meta default `https://api.meta.ai/v1`; xai example `https://api.x.ai/v1`) |
| `proxy-url` | string | per-key proxy / `direct` |
| `headers` | map | value starting `$` ⇒ copy that header from the downstream request (omitted if absent) |
| `models[]` | list | `{name (upstream), alias, display-name, max-context-length, force-mapping, is-compat, thinking{min,max,zero-allowed,dynamic-allowed,levels[]}}` (+ codex: `support-configuration-update`; openai-compat: `image`, `input-modalities[]`, `output-modalities[]`, `use-max-completion-tokens`) |
| `excluded-models[]` | list | exact or `*` wildcard (prefix/suffix/substring), lowercase-compared |
| `disable-cooling` | *bool | overrides global |
| `request-retry` | *int | overrides global; <0 inherits |
| `request-scoped-errors[]` | `{status int, match []string(substring), match-regexr []string, action stop\|stop-and-cooldown\|continue\|continue-and-cooldown}` | |
Per-provider extras: **Claude key**: `rebuild-mid-system-message`, `cloak{mode auto\|always\|never, strict-mode, sensitive-words[], cache-user-id}`, `fingerprint-profile` (`claude-code-cli`), `experimental-cch-signing` (deprecated). **Codex key**: `websockets`, `alpha-search`, `disable-codex-cloaking`. **xAI key**: `websockets`. **Vertex key**: `interactions` bool. **OpenAI-compat group**: `disabled`, `support-prompt-cache-key`, `name`.
Management response adds a computed `auth_index` to each group/key (stripped on write) — algorithm in §2.4.

#### `oauth.*` (OAuth/file-backed credentials)
| key | type | default | notes |
|---|---|---|---|
| `oauth.auth-dir` | path (`~` expanded) | `~/.cli-proxy-api` | **filesystem** store of credential JSON files. ✗ → D1/KV/R2/DO |
| `oauth.auth-auto-refresh-workers` | int | 0 (=16) | refresh worker pool size. ~ |
| `oauth.model-alias.<channel>[]` | `{name, alias, fork, display-name, force-mapping}` | – | channels: vertex, aistudio, antigravity, claude, codex, kimi, xai, meta (+plugin keys). Not applied to api-key groups. Per-auth `model_aliases` in credential JSON takes precedence (§4.6) |
| `oauth.settings.<channel>[]` | `{name, alias, max-context-length}` | – | override advertised context window |
| `oauth.excluded-models.<channel>[]` | []string | – | |
| `oauth.request-scoped-errors.<channel>[]` | rules | – | |
| `oauth.providers.aistudio.ws-auth` | bool | **true** | auth on `/v1/ws` AI Studio websocket relay (`Config.WebsocketAuth`) |
| `oauth.providers.codex.live-media-relay.{enabled,max-sessions(32),disable-private-remote-ips,public-ip,udp-port-min,udp-port-max,ice-servers[{urls,username,credential}]}` | | disabled | in-process WebRTC relay with UDP. **✗ (UDP/WebRTC)**. TURN `username/credential` are `json:"-"`, hidden in JSON GET and preserved on write (`preserveV8TURNSecrets`) |
| `oauth.providers.codex.header-defaults.{user-agent,beta-features}` | strings | – | defaults for Codex **OAuth** requests only; beta-features websocket only |
| `oauth.providers.antigravity.{sensitive-words[], connection-pool{enabled,idle-conn-timeout(30s, cap 210s),max-idle-conns-per-host(2)}, antigravity-credits(true in example), signature-cache-enabled(true), signature-bypass-strict(false)}` | | | connection-pool ✗ (Go http.Transport) |
| `oauth.providers.devin.sensitive-words[]` | | | |
Aliases: `oauth.providers.claude.*` and `oauth.providers.xai.*` are historic spellings of `upstream.claude.*`/`upstream.xai.*` (v8SharedPaths).

#### `multimedia.*`
`multimedia.disable-image-generation` `false|true|"chat"|"passthrough"` (`config/disable_image_generation_mode.go`: Off/All/Chat/Passthrough); `multimedia.gpt-image-2-base-model` string (must start `gpt-` case-insens; default `gpt-5.4-mini`; `internal/runtime/executor/codex_openai_images.go:73`); `multimedia.video-result-auth-cache-ttl` duration string default `3h` (`sdk/api/handlers/openai/openai_videos_handlers.go:291`). W

#### `observability.*`
| key | default | notes |
|---|---|---|
| `observability.logs.debug` | false | debug logging. ~ |
| `observability.logs.logging-to-file` | false | rotating files. **✗ (filesystem)** |
| `observability.logs.logs-max-total-size-mb` | 0 | log dir cap. ✗ |
| `observability.logs.error-logs-max-files` | 10 | ✗ |
| `observability.logs.request-log` | false | per-request log files; management `GET /observability/logs/*` read these. ~ (replace with R2/D1/Logpush) |
| `observability.usage.usage-statistics-enabled` | false | feed in-memory usage queue. W |
| `observability.usage.redis-usage-queue-retention-seconds` | 60 (1..3600) | in-memory usage queue TTL for `GET /observability/usage/queue` (the RESP/redis listener is the real consumer, `internal/api/redis_queue_protocol.go`, ✗) |
| `observability.pprof.{enable,addr}` | false, `127.0.0.1:8316` | pprof listener. **✗** |

#### `plugins.*` (dynamic C-ABI plugins, `internal/pluginhost`, `internal/pluginstore`) **✗**
`plugins.{enabled(false), dir("plugins"), store-sources[], store-auth[{match,apply-to[registry|artifact],type bearer|basic|header|github-token,token-env,username-env,password-env,header-name,header-value-env,allow-insecure}], auth-revision (read-only), configs.<id>{enabled, priority, …free-form}}`. Loads native `.so/.dll` via `-buildmode=c-shared` — impossible on Workers. The Management plugin routes and the `plugin provider` OAuth path (§2.2/§3) can be omitted (or reimplemented as TS modules).

#### Home mode (`Config.Home`, `internal/home`, `-home-jwt`) **✗**
Cluster control plane (RESP). When enabled, management and `/management.html` return 404 and all proxy routes return 503 until heartbeat is OK (`server_middleware.go:homeHeartbeatMiddleware`).

### 1.3 Other runtime/env inputs (not in YAML)
CLI flags: `--config`, `--tui`, `--standalone`, `--local-model`, `--no-browser`, `--oauth-callback-port`, `-home-jwt`; env: `MANAGEMENT_PASSWORD`, `MANAGEMENT_STATIC_PATH`, `GITHUB_TOKEN`, `META_MINT_URL` (override Meta mint URL, `internal/auth/meta/meta.go`), `PGSTORE_*`, `GITSTORE_*`, `OBJECTSTORE_*` (alternate credential/config stores) — all ✗ on Workers (replace by Worker bindings/secrets).

### 1.4 Legacy → v8 path table (from `config_v8.go buildV8Paths`)
`host→server.host`, `port→server.port`, `trusted-proxies/github-token/tls/commercial-mode/discovery → server.*`, `remote-management→management`, `api-keys(client list)→access.api-keys`, `credential-concurrency→credentials.concurrency`, `credential-in-flight→credentials.in-flight`, `force-model-prefix→routing.force-model-prefix`, `request-retry/max-retry-credentials/max-retry-interval→routing.retry.*`, `disable-cooling/save-cooldown-status/transient-error-cooldown-seconds→routing.cooldown.*`, `proxy-url/passthrough-headers/nonstream-keepalive-interval/streaming/payload→requests.*`, `auth-dir/auth-auto-refresh-workers→oauth.*`, `oauth-model-alias→oauth.model-alias`, `oauth-excluded-models→oauth.excluded-models`, `oauth-request-scoped-errors→oauth.request-scoped-errors`, `oauth-settings→oauth.settings`, `ws-auth→oauth.providers.aistudio.ws-auth`, `codex.{disable-codex-cloaking,stream-bootstrap-*,orphan-delegation-compatibility,model-level-cooling,response-steering}→upstream.codex.*`, `codex→oauth.providers.codex`, `codex-header-defaults→oauth.providers.codex.header-defaults`, `claude`/`claude-code`→`upstream.claude`, `disable-claude-cloak-mode→upstream.claude.disable-claude-cloak-mode`, `claude-header-defaults→upstream.claude.header-defaults`, `antigravity→oauth.providers.antigravity`, `antigravity-signature-*→oauth.providers.antigravity.signature-*`, `quota-exceeded.antigravity-credits→oauth.providers.antigravity.antigravity-credits`, `xai→upstream.xai`, `devin→oauth.providers.devin`, `disable-image-generation/gpt-image-2-base-model/video-result-auth-cache-ttl→multimedia.*`, `debug/logging-to-file/logs-max-total-size-mb/request-log/error-logs-max-files→observability.logs.*`, `usage-statistics-enabled/redis-usage-queue-retention-seconds→observability.usage.*`, `pprof→observability.pprof`, `*-api-key`/`openai-compatibility`→`api-keys.<family>` groups.

---------------------------------------------------------------------------------------------------

## 2. Management API

Sources: route table `internal/api/server_management_v8.go:11-62`; legacy registrar `internal/api/server_management.go:12-200`; handlers `internal/api/handlers/management/*.go`; doc `docs/management-api-v8.md`.

### 2.1 Availability & authentication

* Management routes exist only when `management.secret-key != ""` **or** env `MANAGEMENT_PASSWORD` is set **or** a local TUI password is set (`internal/api/server.go:243-250`, hot-toggled in `server_reload.go:137-161`). Otherwise every management path returns bare **404** (`managementAvailabilityMiddleware`, `server_management.go:204-225`; also 404 when Home mode).
* Credential extraction (`handler.go:266-298`): header `Authorization: Bearer <key>` (case-insensitive scheme; if the header has no `Bearer ` prefix the whole header value is the key), else header `X-Management-Key`. Response headers set on every management response: `X-CPA-VERSION`, `X-CPA-COMMIT`, `X-CPA-BUILD-DATE`, `X-CPA-SUPPORT-PLUGIN`.
* `AuthenticateManagementKey(clientIP, localClient, provided)` (`handler.go:301-400`) — exact order:
  1. If client IP is banned (`blockedUntil` in the future) → **403** `{"error":"IP banned due to too many failed attempts. Try again in <remaining rounded to s>"}`; an expired ban resets counters.
  2. `localClient = clientIP ∈ {127.0.0.1, ::1}`; if `!localClient && !allowRemote` (allowRemote = `management.allow-remote` OR env password set) → **403** `{"error":"remote management disabled"}` (no failure counted).
  3. If no secret hash and no env secret → **403** `remote management key not set`.
  4. Empty provided key → counts a failure; **401** `missing management key`.
  5. Local client and `localPassword` (TUI) matches (constant-time) → ok. Env secret (`MANAGEMENT_PASSWORD`) matches (constant-time) → ok. Else `bcrypt.CompareHashAndPassword(secretHash, provided)`; mismatch → counts a failure, **401** `invalid management key`.
  6. Success resets the IP's counter.
* **Ban logic**: key `clientIP`; `maxFailures = 5` consecutive failures (counter increments on missing/invalid key) ⇒ `blockedUntil = now + 30 min`, counter reset; stale records purged hourly (`attemptCleanupInterval=1h`, `attemptMaxIdleTime=2h`, `handler.go:~40-45, startAttemptCleanup`). In-memory only. Port: DO (per-IP) or KV with TTL; use `CF-Connecting-IP`.
* `OAuth callback` routes (`/v8/management/oauth/callback`, and `/v0/management/oauth-callback`) are registered **outside** the auth group (only the availability middleware) — they rely on a pending-state check, no management key (`server_management_v8.go:14-15`, `server_management.go:27-28`).

### 2.2 `/v8/management` routes

Unless stated, JSON in/out, errors `{"error": "..."}`. All under the auth middleware except the OAuth callback pair. `ConfigV8ContextKey` is set on the group (config writes use v8 layout).

#### Config (`management/config_v8.go`, `config_v8_api.go`)
| Method | Path | Behaviour |
|---|---|---|
| GET | `/config` | Whole config as JSON (decoded from the v8 YAML doc; includes computed `auth_index` on api-key groups/keys; TURN `username`/`credential` stripped; `Cache-Control: no-store`). Aliased historic paths are projected back (`ProjectV8ConfigAliases`) when a sub-path is requested. |
| GET | `/config.yaml` | Raw YAML (`application/yaml; charset=utf-8`), includes TURN secrets. |
| PUT | `/config`, `/config.yaml` | Replace whole config (JSON body must be a JSON object → else `400 config_must_be_object`; invalid JSON `invalid_json`; YAML for `.yaml`). |
| PATCH | `/config` | Deep merge objects; lists & scalars replaced (`mergeConfigV8Patch`). |
| GET/PUT/PATCH/DELETE | `/config/*path` | `path` = `/`-separated mapping keys (not array indexes), e.g. `/config/routing/retry/request-retry`. Body = the value itself (no `{value:…}` envelope). DELETE removes the key (prunes emptied parents); 404 `not_found`; `DELETE /config` → 400 `cannot_delete_config`. |
Validation chain on write: strip `auth_index`/`auth-index` from api-key groups → normalise aliases → refuse changes to read-only paths `credentials/concurrency/lifecycle-config-revision`, `credentials/concurrency/observation-barrier-revision`, `plugins/auth-revision` (`400 {"error":"read_only_field","field":…}`) → `ParseConfigBytes` (`422 invalid_config` + message) → `ValidateV8Config` (`400 invalid_config`) → `NormalizeConfigLayout(migrate=true)` → atomic file write → swap in-memory cfg → **async** reload hook (`h.reloadConfigAfterManagementSaveAsync`, ordered by generation counter so an older snapshot never overrides a newer one) → `200 {"status":"ok","config-version":8}`. Errors: `read_failed`, `write_failed`, `invalid_body`, `invalid_path`.
Port: store config doc in D1/KV/DO; "reload" = invalidate cached config in isolates (version stamp in KV/DO).

#### Operational
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/server/latest-version` | – | calls `https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest` (headers `Accept: application/vnd.github+json`, `User-Agent: CLIProxyAPI`, optional `Authorization: Bearer <github token>`; 10 s timeout) → `{"latest-version": tag_name\|name}`; errors `502 {"error":"request_failed\|unexpected_status\|decode_failed\|invalid_response","message"}` (`management/config_basic.go:20-98`) |
| POST | `/requests/api-call` | `{auth_index (also `authIndex`/`AuthIndex`), method, url, proxy_url?, header{k:v}, data(string)}`; `$TOKEN$` placeholder in header values/data is replaced with the selected credential's access token (refreshing it first if needed; JSON-escaped when data is valid JSON); header `Host` overrides request host | `{"status_code":int,"header":{k:[v…]},"body":string}`; 60 s client timeout (`api_tools.go:23,103-240`); errors 400 `invalid body/missing method/missing url/invalid url/invalid proxy_url/auth token refresh failed/auth credential not found for auth_index/auth token not found`, 502 `request failed`/`failed to read response`. Used by the panel to probe provider quota endpoints. Workers: fetch only; per-credential proxy ignored. This is the explicit **exception** to "no timeouts after connect". |
| POST | `/routing/cooldown/reset` | `{"auth_index":"…"}` | `{"status":"ok","auth_index":…,"models":…}` (clears quota/cooldown state for the credential; 400 `invalid request body`/`auth_index is required`, 404 `auth not found`, 503 `core auth manager unavailable`) (`quota.go:27-69`) |
| GET | `/routing/model-definitions/:channel` | – | `{"channel":"<lowercased>","models":[ModelInfo…]}` from the **static** catalog (`registry.GetStaticModelDefinitionsByChannel`); channels: `claude, gemini, gemini-interactions, vertex, aistudio, codex (=codex-pro list), kimi/kimi-ai/kimi.ai/kimi.com, antigravity, xai/x-ai/grok, devin, meta/muse`; 400 `channel is required` / `unknown channel` (`model_definitions.go`) |
| GET | `/observability/logs` | `?cursor=&after=<unix>&limit=` | `{"lines":[],"line-count":n,"latest-timestamp":unix,"next-cursor":"…","cursor-reset"?:true}`; 400 `logging to file disabled` if `logging-to-file=false` (`logs.go:40-130,630-645`). ✗ (file-based) |
| DELETE | `/observability/logs` | – | truncates active log, removes rotated; `{…}` (`logs.go:135-195`). ✗ |
| GET | `/observability/logs/errors` | – | `{"files":[{"name","size","modified"(unix)}]}` for files `error-*.log`, newest first (`logs.go:197-256`) |
| GET | `/observability/logs/errors/:name` | – | file download (name validated) |
| GET | `/observability/logs/requests/:id` | `?id=` alt | request log lookup by request-id (`logs.go:261-430`) |
| GET | `/observability/usage/api-keys` | – | `{ "<provider|compat name lowercased>": { "<base_url>|<api_key>": {"success":n,"failed":n,"recent_requests":[{"time":"HH:MM-HH:MM","success":n,"failed":n}×20]} } }`; only credentials whose `AccountInfo()` kind is `api_key` (`api_key_usage.go`). Buckets: 20 × 10-minute buckets (`sdk/cliproxy/auth/types.go:159-170`) |
| GET | `/observability/usage/queue` | `?count=` (default 1, positive int else 400) | JSON array of usage records, **pops** oldest N (destructive read); record shape = `queuedUsageDetail` (`redisqueue/plugin.go:160-225`): `timestamp, latency_ms, ttft_ms, source, auth_index, access_token_sha256?, client_ip, resolved_client_ip, x_forwarded_for, user_agent, tokens{input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_read_tokens,cache_read_tokens_present,cache_creation_tokens,total_tokens}, failed, generate, stream, fail{status_code,body}, response_headers?, accounting_version, token_breakdown, provider, executor_type, model, alias, endpoint, auth_type, api_key, request_id, execution_id?, trace_id?, session_id?, parent_session_id?, node_kind?, is_fork?, is_compaction?, reasoning_effort, service_tier, response_service_tier?, response_model?`; in-memory queue with retention `redis-usage-queue-retention-seconds` (60..3600) (`redisqueue/queue.go`). Port: queue in DO/D1. |

#### Credentials (auth files) (`auth_files*.go`)
Credentials are JSON files named `*.json` (`filepath.Base` only; names containing `/`, `\` or a volume are rejected `400 invalid name`). Stored in `oauth.auth-dir` (filesystem) or Postgres/git/object store.
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/credentials` | `?name=`(file name or id), `?auth_index=`, optional pagination `?page=&page_size=` (default page_size 50 (`defaultAuthFilesPageSize`); non-positive → `400 page must be a positive integer`/`page_size must be…`) | `{"observed_at":ts,"files":[entry…]}` (+ `"total","page","page_size","has_more"` when paginated). Sorted case-insensitively by name. **Entry** (`auth_files.go:637-790`): `id, auth_index, name, type, provider, label, status, status_message, disabled, unavailable, runtime_only, source("file"\|"memory"), size, success, failed, recent_requests[20], quota{…}, model_quotas?, supports_quota?, quota_provider?, quota_probe?, email?, project_id?, account_type?, account?, created_at?, modtime, updated_at?, last_refresh?, next_retry_after?, path?, id_token{codex claims}?, priority?, note?, weight?, websockets?, request_retry?, cooldowns` (cooldown snapshot, `null` in Home mode). Falls back to disk listing if no auth manager. |
| POST | `/credentials` | multipart form with one or more `file` parts (`.json`), OR raw JSON body with `?name=x.json` | single: `{"status":"ok"}`; multiple: `{"status":"ok","uploaded":n,"files":[…]}`; partial: **207** `{"status":"partial","uploaded":n,"files":[…],"failed":[{"name","error"}]}`. Errors: 400 `file must be .json`, `name must end with .json`, `invalid name`, `failed to read body`, `invalid multipart form: …`, `no files uploaded`; 503 `core auth manager unavailable`. JSON is validated (`invalid auth file`), metadata normalised (legacy hyphen keys → snake_case, see below), provider = `type` field (default `"unknown"`), label = email or type, then registered/updated in the auth manager. |
| DELETE | `/credentials` | `?name=a.json&name=b.json` (repeatable) OR body `{"name":"x"}`/`{"names":[…]}`/`["a","b"]`; or `?all=true\|1\|*` (deletes every `*.json`) | `{"status":"ok"}` (single) / `{"status":"ok","deleted":n,"files":[…]}` / 207 partial (`failed:[{name,error}]`) / `{"status":"ok","deleted":n}` for `all` |
| GET | `/credentials/download` | `?name=x.json` | file body (`application/json`, `Content-Disposition: attachment; filename="x.json"`); 400/404/500 |
| GET | `/credentials/models` | `?name=` (file name or auth id; required else 400 `name is required`) | `{"models":[{"id","display_name"?,"type"?,"owned_by"?}]}` — models currently registered for that credential in the model registry (§4.6) |
| PATCH | `/credentials/status` | `{"name","auth_index"?,"disabled":bool}` (both `name` and `disabled` required, 400 otherwise) | `{"status":"ok","disabled":bool}`; 404 `auth file not found`. For credentials that are config api-keys, toggles the config entry's `excluded-models` to `*` instead (`toggleConfigAPIKeyExcludedAll`) |
| PATCH | `/credentials/fields` | `{"name":"x.json", "<dotted.path>": value, …, "request_retry": int\|null}` — set/delete arbitrary metadata fields in the credential JSON (`null` deletes). Keys canonicalised: `api-key→api_key, base-url→base_url, disable-cooling→disable_cooling, excluded-models→excluded_models, fingerprint-profile→fingerprint_profile, model-aliases→model_aliases, proxy-url→proxy_url, request-retry→request_retry, request-scoped-errors→request_scoped_errors, tool-prefix-disabled→tool_prefix_disabled` (`sdk/cliproxy/auth/metadata_keys.go`). Special: `weight` must be integer (`credentialweight`), no nested; `headers` merged specially; `priority`, `note`, `websockets`, `disabled`, `plan_type`, header attributes re-synced into runtime attributes (`syncAuthFileMetadataFields`) | `{"status":"ok"}`; 400 `no fields to update`/`field name is required`/`invalid field X`/`weight must be an integer`/`weight does not support nested fields`; 404 `auth file not found`; 409 plugin-virtual auth |
| POST | `/credentials/refresh` | `{"name"?,"auth_index"?,"all"?:bool}` or `?all=true&name=&auth_index=` | all → `{"ok":true,"results":[…]}`; one → `{"ok":true,"auth":{…refreshed Auth…}}`; 400 `name or all=true is required`; 404; 500 with error. Forces provider refresh (`ForceRefreshAuth`, `ForceRefreshAll`) |

Credential-file metadata keys honoured by the synthesizer (`internal/watcher/synthesizer/file.go:85-290`): `type`(provider), `email`, `disabled`, `proxy_url`, `prefix`, `priority`, `weight`, `note`, `headers`(custom headers), `excluded_models`, `model_aliases`, `fingerprint_profile`, `base_url`/`domain` (kimi), `plan_type`/`id_token` (codex plan), `request_retry`, `disable_cooling`, `websockets`, `access_token/refresh_token/expired…`. Expiry keys tried (`expireKeys`, `auth/types.go:689`): `expired, expire, expires_at, expiresAt, expiry, expires`, then `expires_in`+`timestamp`; access-token JWT `exp` takes precedence.

#### OAuth (see §3)
| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/oauth/auth-url` | `?provider=claude\|codex\|antigravity\|kimi\|kimi-ai\|xai\|devin\|meta\|<plugin id>`; extra: `is_webui=1\|true\|yes\|on`, kimi `?domain=`/`?channel=` | `{"status":"ok","url":…,"state":…}`; device flows add `"flow":"device","user_code":…,"expires_in":sec`; 400 `provider is required`; 404 `provider_not_found`; 500 `failed to generate PKCE codes/state parameter/authorization url/callback server unavailable/failed to start callback server/failed to start device authorization flow` |
| GET | `/oauth/status` | `?state=` | no state → `{"status":"ok"}`; invalid → 400 `{"status":"error","error":"invalid state"}`; unknown/expired → `{"status":"error","error":"unknown or expired state"}`; completed → `{"status":"ok"}`; failed → `{"status":"error","error":<message>}`; pending → `{"status":"wait"}` |
| DELETE | `/oauth/session` | `?state=` | `{"status":"ok","cancelled":bool}`; 400 `missing state`/`invalid state` |
| GET/POST | `/oauth/callback` (no mgmt key) | GET query or POST JSON `{provider?, redirect_url?, code, state, error}`; `redirect_url` is parsed for `state/code/error|error_description` when those fields are empty | `{"status":"ok"}`; errors `{"status":"error","error":…}`: 400 `invalid body/invalid redirect_url/state is required/invalid state/code or error is required/unsupported provider/provider does not match state`, 404 `unknown or expired state`, 409 `oauth flow is already completed` \| `<session error>` \| `oauth flow is not pending`, 500 `failed to persist oauth callback` (`oauth_callback.go`) |
| POST | `/oauth/import?provider=vertex` | multipart `file` (service-account JSON), optional `location` (form or query, default `us-central1`) | `{"status":"ok","auth-file":path,"project_id","email","location"}`; saves `vertex-<sanitized project_id>.json`. 400 `file required/invalid json/invalid service account/project_id missing`; 404 `provider_not_found` (`vertex_import.go`). Credential JSON: `{type:"vertex", service_account:{…normalised…}, project_id, email, location, label}` |

#### Plugins (all ✗ on Workers) 
`GET /plugins`, `DELETE /plugins/:id`, `GET /plugins/store`, `POST /plugins/store/:id/install`, `GET|POST|DELETE /plugins/:id/quota` (`plugins.go`, `plugin_store*.go`, `plugin_quota.go`). Plugin store downloads native binaries. Quota-provider plugins also supply `supports_quota` in credential entries.

### 2.3 Deprecated `/v0/management` (ignore except OAuth callbacks)
Kept routes: `GET|POST /v0/management/oauth-callback` (same handlers as v8 callback, no key). Everything else under `/v0/management` (≈150 routes: scalar getters/putters like `/debug`, `/proxy-url`, `/api-keys`, `/gemini-api-key`, `/auth-files`, `*-auth-url`, `/get-auth-status` …) is deprecated; a fresh port needs none of them.
Additionally root-level OAuth redirect receivers on the main server (`internal/api/server_routes.go:149-215`), each returns an HTML "success" page and writes the callback payload for the pending session (no auth): `GET /anthropic/callback`, `GET /codex/callback`, `GET /antigravity/callback`, `GET /callback` and `GET /devin/callback` (Devin; 400 `{"error":"invalid or expired OAuth callback"}` if state not pending, `{"error":"code or error is required"}`).

### 2.4 `auth_index` (stable credential id exposed to panel)
`sdk/cliproxy/auth/types.go:323-455`: `index = hex(sha256(seed))[:16 hex chars = first 8 bytes]` where `seed`:
1. `attributes["auth_index_seed"]` → `"auth_index_seed:" + value`; else
2. file credential (path/source/FileName/ID ending `.json`): `lower(type or provider) + ":" + cleanAbsPath`; else
3. API-key credential with `api_key`: `<prefix>:<base_url>+<api_key>` where prefix ∈ `openai-compatibility` (compat_name set / provider openai-compatibility), `gemini-api-key`, `interactions-api-key` (provider `gemini-interactions`), `codex-api-key`, `xai-api-key`, `claude-api-key`, `meta-api-key`; else
4. `"id:" + ID`.
Port: define your own stable id (e.g. sha256 of `provider:credentialKey`) but keep 16-hex-char length if the SPA expects it.

### 2.5 Control panel asset (`/management.html`)
* Route `GET /management.html` (`server_routes.go:55` → `server_management.go:serveManagementControlPanel`): 404 if Home mode or `management.disable-control-panel`; serves the local file `<static-dir>/management.html` (`static-dir` = `$MANAGEMENT_STATIC_PATH` | `<writable-path>/static` | `<config dir>/static`). If the file is missing it synchronously downloads it with a detached context.
* Download algorithm (`internal/managementasset/updater.go`):
  1. Release URL: from `management.panel-github-repository`. Repo URL `https://github.com/<owner>/<repo>[.git]` → `https://api.github.com/repos/<owner>/<repo>/releases/latest`; an `api.github.com` URL gets `/releases/latest` appended if absent; anything else → default `https://api.github.com/repos/router-for-me/Cli-Proxy-API-Management-Center/releases/latest`.
  2. GET release JSON with `Accept: application/vnd.github+json`, `User-Agent: CLIProxyAPI-management-updater`, optional `Authorization: Bearer <github token>`; pick asset named (case-insens) **`management.html`**; its `digest` field (`sha256:<hex>`) is the expected hash.
  3. If local file hash equals digest → nothing to do. Else GET `browser_download_url` (UA same, limit 50 MiB), sha256 it; if digest present and mismatched → **abort** ("digest mismatch … aborting update for safety"); else atomic write.
  4. If release lookup or download fails **and no local file exists**: download unverified fallback `https://cpamc.router-for.me/` and save it as management.html (warning logged: no digest verification).
  5. HTTP client timeout 15 s; `managementSyncMinInterval = 30 s` throttle between checks (`lastUpdateCheckTime`); singleflight; auto-updater goroutine checks every **3 h** (`updateCheckInterval`) unless `disable-control-panel` or `disable-auto-update-panel`.
* Workers port: fetch & cache `management.html` in R2/KV (cron every 3 h, or lazily on first request), verify `sha256`, serve with `Content-Type: text/html`. Static single-file SPA; it talks to `/v0/management/*` historically and `/v8/management/*` in newer versions — check which prefix the pinned panel version uses.

---------------------------------------------------------------------------------------------------

## 3. OAuth login flows

### 3.1 Shared session machinery (`management/oauth_sessions.go`)
* In-memory store `map[state]oauthSession{Provider, Source("builtin"|"plugin"), Status(error text), Metadata, Completed, ExpiresAt}`.
  * `oauthSessionTTL = 30 min` (must cover xAI ~30 min and Kimi ~15 min device flows); completed sessions kept `oauthCompletedSessionTTL = 1 min`; expired entries purged lazily on every access. `Register(state, provider)` re-registers (overwrites) a state; plugin registration errors with `errOAuthSessionExists` on duplicate.
  * `SetError(state,msg)` sets `Status=msg` (default "Authentication failed") and refreshes expiry to `now+ttl`; ignored if already completed/unknown. `Complete` clears status/metadata, `Completed=true`, expiry `now+1min`. `Cancel` deletes if pending (not completed/not errored). `IsPending(state[,provider])` = exists && !Completed && Status=="" (&& provider match, case-insens).
* `ValidateOAuthState`: non-empty (after trim), ≤128 chars, no `/` `\` `..`, only `[A-Za-z0-9._-]`.
* Provider name normalisation (`NormalizeOAuthProvider`): `anthropic|claude→anthropic`, `codex|openai→codex`, `antigravity|anti-gravity→antigravity`, `xai|x-ai|x.ai|grok→xai`, `devin|cognition→devin`, `meta|muse→meta`; plugin providers `[a-z0-9-]+`. **Note**: Kimi is not in `NormalizeOAuthProvider` (device flow has no callback). `/oauth/auth-url?provider=claude` registers the session under provider `anthropic`.
* State generator `misc.GenerateRandomState`: 16 random bytes → 32 hex chars. Device flows use `xai-<UnixNano>`, `meta-<UnixNano>`, `kmi-<UnixNano>` / `kmi-ai-<UnixNano>`.
* **Callback hand-off** (the thing to replace on Workers): the HTTP callback writes a file `<auth-dir>/.oauth-<canonicalProvider>-<state>.oauth` containing `{"code","state","error"}` atomically (tmp + rename, `oauth_sessions.go:428-477`, only if the session is pending for that provider); a goroutine polls for the file every **500 ms** up to a **5-minute** deadline (`Timeout waiting for OAuth callback`), deletes it, then exchanges code and saves the credential. On Workers: store callback in DO storage keyed by state and complete the exchange in the same DO request, or in `/oauth/callback` handler directly (no polling needed) — but keep the semantics: 5 min window, errors surfaced via `/oauth/status`.
* **Local callback forwarder** (`auth_files_oauth_callback.go`): when `?is_webui=…` is truthy the server starts a temporary TCP listener on `0.0.0.0:<fixed port>` (anthropic **54545**, codex **1455**, antigravity **51121**) which 302-redirects (with `Cache-Control: no-store`) to `<scheme>://127.0.0.1:<server port>/<provider>/callback?<original query>`; stopped when login finishes (2 s shutdown). **✗ on Workers** — the registered `redirect_uri`s are fixed to `http://localhost:<port>/…` by each provider's OAuth client, so the browser lands on a dead localhost page. Port must use the "paste the redirect URL" flow: the panel POSTs `/v8/management/oauth/callback` with `{"redirect_url": "<full localhost URL>"}` (supported by `handleOAuthCallback`, `oauth_callback.go:55-70`), or users run a tiny local redirector. (Devin is different: its `redirect_uri` is the server itself.)
* Credentials are persisted via `saveTokenRecord` (`auth_files_fields.go:945`): merges metadata of an existing same-named file (`mergeExistingAuthFileMetadata`), Claude legacy-filename migration (`FindMatchingLegacyCredential`: records named `claude-<email>.json` or account-only name are merged into the new hashed name and deleted), post-auth hooks, `store.Save`. Port: write to D1/KV + notify.

### 3.2 Per-provider flows

| Provider (`?provider=`) | Type | Session/provider key | Go entry |
|---|---|---|---|
| `claude` | Auth-code + PKCE (S256), **paste-back callback** | `anthropic` | `RequestAnthropicToken` auth_files_provider_oauth.go:37 |
| `codex` | Auth-code + PKCE | `codex` | :198 |
| `antigravity` | Google auth-code (no PKCE, client secret) | `antigravity` | :359 |
| `xai` | RFC 8628 device code via OIDC discovery | `xai` | :526 |
| `meta` | device code + API-key mint | `meta` | :639 |
| `kimi`, `kimi-ai` | device code | `kimi`, `kimi-ai` | :782-796 |
| `devin` | Auth-code + PKCE, redirect to server | `devin` | auth_files_devin_oauth.go:44 |
| `vertex` | import service-account JSON | – | vertex_import.go |
| Codex CLI "device" login (not via management) | OpenAI deviceauth | – | `sdk/auth/codex_device.go` |

PKCE (Claude/Codex): verifier = 96 random bytes → base64url **no padding** (128 chars); challenge = base64url(sha256(verifier)) no padding, method `S256` (`internal/auth/claude/pkce.go`, codex same). Devin: 64 random bytes, `RawURLEncoding`.

#### 3.2.1 Claude (Anthropic) — `internal/auth/claude/anthropic_auth.go:23-` 
Constants:
* `AuthURL` `https://claude.ai/oauth/authorize`; `TokenURL`=`RefreshTokenURL` `https://platform.claude.com/v1/oauth/token`; `ProfileURL` `https://api.anthropic.com/api/oauth/profile`; `RolesURL` `https://api.anthropic.com/api/oauth/claude_cli/roles`.
* `ClientID` `9d1c250a-e61b-44d9-88ed-5944d1962f5e`; `RedirectURI` `http://localhost:54545/callback`; scope `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`.
Authorize URL query (order as Go `url.Values.Encode` = alphabetical): `client_id, code=true, code_challenge, code_challenge_method=S256, redirect_uri, response_type=code, scope, state`.
Callback handling: code may arrive as `code#state`; the handler takes `strings.Split(code,"#")[0]`; the exchange also accepts `#state` suffix (overrides `state`). State from callback must equal the session state else session error `State code error`; callback `error` → `Bad request`.
Token exchange: `POST TokenURL`, **JSON** body `{"grant_type":"authorization_code","code":…,"redirect_uri":RedirectURI,"client_id":ClientID,"code_verifier":…,"state":…}`; headers (`applyClaudeOAuthAxiosHeaders`): `Accept: application/json, text/plain, */*`, `Content-Type: application/json`, `User-Agent: axios/1.15.2`, `Accept-Encoding: gzip, compress, deflate, br`, `Connection: close`. Response `{access_token, refresh_token, token_type, expires_in, organization{uuid,name}, account{uuid,email_address}}`. Non-200 ⇒ error. Then **profile enrichment**: `GET ProfileURL` (+ `GET RolesURL`, result ignored; failures only warn) with `Authorization: Bearer <access>`, `Cache-Control: no-cache` and same axios headers → `{account{uuid,email},organization{uuid,name}}` overrides token-response values (profile requires non-empty account UUID).
Device ids: `claude_device_ids` = 1 random 32-byte hex id (pool size 1) generated at login (`identity.go`; `ClaudeDevicePoolSize=1`, 32 bytes→64 hex chars).
Refresh: `POST RefreshTokenURL` JSON `{"client_id","grant_type":"refresh_token","refresh_token","scope":ClaudeOAuthScope}`; same headers. 200 → `{access_token, refresh_token (falls back to old if blank), expires_in}` then profile re-fetch (best effort). Failures: **429** ⇒ block that refresh token until `Retry-After`/`Retry-After-Ms` (clamped to `[5 s, 5 min]`, default 5 s) and return non-retryable; ≥500 retryable; other 4xx non-retryable. Single-flight per refresh token; 30 s overall timeout (`claudeRefreshTimeout`), 10 s TLS handshake timeout (`claudeRefreshHandshakeTimeout`); `RefreshTokensWithRetry` attempts with `attempt*1s` back-off between retries (only retryable errors) (`:440-667`).
**Workers blocker**: all Claude OAuth control-plane requests go through `NewAnthropicHttpClient` = **uTLS** (`github.com/refraction-networking/utls`) emulating Claude Code 2.1.220's Node/OpenSSL ClientHello (`HelloCustom`, `internal/auth/claude/utls_transport.go:113-175`), HTTP/1.1 only (`ForceAttemptHTTP2:false`) and *ordered* raw headers (`httpwire.NewOrderedRequestConn`): refresh/exchange order `Accept, Content-Type, User-Agent, Content-Length, Accept-Encoding, Host, Connection`; profile/roles GET order `Accept, Content-Type, Authorization, Cache-Control, User-Agent, Accept-Encoding, Host, Connection`. Workers `fetch` cannot control TLS fingerprint, HTTP version or header order → expect possible Cloudflare/Anthropic bot-mitigation rejections; must be tested; fall-back is user-supplied tokens (import credential JSON) or a relay.
Credential JSON (`ClaudeTokenStorage`, token.go): `{id_token?, access_token, refresh_token, last_refresh, email, account_uuid?, organization_uuid?, organization_name?, claude_device_ids:[…], type:"claude", expired:<RFC3339>}`; filename `claude-<email>.json` (no org/account) else `claude-<sha256(organization_uuid||account_uuid) hex[:8]>-<email>.json` (`filename.go`). Session record metadata: `email, account_uuid, organization_uuid, organization_name, claude_device_ids`. Refresh lead: **4 h** (`sdk/auth/claude.go:34`).

#### 3.2.2 Codex (OpenAI ChatGPT) — `internal/auth/codex/openai_auth.go:25-`
* `AuthURL` `https://auth.openai.com/oauth/authorize`; `TokenURL` `https://auth.openai.com/oauth/token`; `ClientID` `app_EMoamEEZ73f0CkXaXp7hrann`; `RedirectURI` `http://localhost:1455/auth/callback`.
* Authorize query (alphabetical): `client_id, code_challenge, code_challenge_method=S256, codex_cli_simplified_flow=true, id_token_add_organizations=true, prompt=login, redirect_uri, response_type=code, scope=openid email profile offline_access, state`.
* Callback forwarder target `/codex/callback`. State mismatch → `State code error`; exchange error → `Failed to exchange authorization code for tokens: <cause>`.
* Exchange: `POST TokenURL`, `application/x-www-form-urlencoded` (+ `Accept: application/json`) body `grant_type=authorization_code, client_id, code, redirect_uri, code_verifier`. Response `{access_token, refresh_token, id_token, token_type, expires_in}`. `id_token` JWT parsed **without signature verification**: `email`, claim `https://api.openai.com/auth`.{`chatgpt_account_id`, `chatgpt_plan_type`, `chatgpt_user_id`, `organizations[]`…}; plan default `"free"` (`DefaultPlanType`). `expired = now + expires_in` (RFC3339).
* Handler computes `hashAccountID = hex(sha256(chatgpt_account_id))[:8]`; filename `codex-<hashAccountID>-<email>-<plan>.json` (`CredentialFileName(email, plan, hash, true)`; plan lowercased and non-alphanumerics → `-`; missing hash → `codex-<email>-<plan>.json`; missing plan omitted). Metadata `{email, account_id, plan_type}` + attribute `plan_type`.
* Credential JSON (`CodexTokenStorage`): `{id_token, access_token, refresh_token, account_id, last_refresh, email, type:"codex", expired, plan_type?}`.
* Refresh: `POST TokenURL` form `client_id, grant_type=refresh_token, refresh_token, scope=openid profile email`; 30 s timeout, single-flight per refresh token; error text containing `refresh_token_reused` is non-retryable (`isNonRetryableRefreshErr`); `RefreshTokensWithRetry` with attempt-based back-off. Refresh lead **24 h** (`sdk/auth/codex.go:34`).
* **Device-code login (CLI only, `sdk/auth/codex_device.go`)**: `POST https://auth.openai.com/api/accounts/deviceauth/usercode` JSON `{"client_id":ClientID}` → `{device_auth_id, user_code|usercode, interval(string|int, default 5 s)}`; user opens `https://auth.openai.com/codex/device`; poll `POST https://auth.openai.com/api/accounts/deviceauth/token` JSON `{"device_auth_id","user_code"}` every `interval` — 2xx ⇒ `{authorization_code, code_verifier, code_challenge}`; 403/404 ⇒ keep polling; other ⇒ fail; 15 min overall timeout (`codexDeviceTimeout`); then standard exchange with `redirect_uri=https://auth.openai.com/deviceauth/callback`. Not exposed by management but is the **Workers-friendliest** Codex login — recommend implementing it as the primary Codex flow (no localhost redirect).
* (Optional in-process loopback server `internal/auth/codex/oauth_server.go` is CLI-only.)

#### 3.2.3 Antigravity (Google Cloud Code Assist) — `internal/auth/antigravity/`
* `ClientID` `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`, `ClientSecret` `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` (hard-coded; also in `internal/api/handlers/management/api_tools.go:26-27` and executor), `CallbackPort 51121`, redirect `http://localhost:51121/oauth-callback`.
* Scopes (space-joined): `https://www.googleapis.com/auth/cloud-platform`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`, `…/auth/cclog`, `…/auth/experimentsandconfigs`.
* Auth URL `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline, client_id, prompt=consent, redirect_uri, response_type=code, scope, state` (no PKCE).
* Token `POST https://oauth2.googleapis.com/token` form `code, client_id, client_secret, redirect_uri, grant_type=authorization_code` → `{access_token, refresh_token, expires_in, token_type}`. Callback state check: missing state tolerated, mismatch ⇒ `Authentication failed: state mismatch`; empty code ⇒ `Authentication failed: code not found`; callback target path `/antigravity/callback`.
* Then `GET https://www.googleapis.com/oauth2/v2/userinfo?alt=json` (Bearer) → `email` (required; else `Failed to fetch user info`). Short UA = `antigravity/hub/<version> darwin/arm64` (version from `https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml`, YAML `version:`, UA `electron-builder`, cached 6 h, refresh every 3 h, fallback `2.9.1`; `internal/misc/antigravity_version.go`).
* **Project discovery** (non-fatal): `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` JSON `{"metadata":{"ideType":"ANTIGRAVITY"}}` (Bearer, `Accept: */*`, UA short) → project from `cloudaicompanionProject` (string, or object with `id`); if absent → `onboardUser`: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser` JSON `{"tier_id": <allowedTiers[isDefault].id | currentTier.id | "free-tier">, "metadata":{"ide_type":"ANTIGRAVITY","ide_version":<ver>,"ide_name":"antigravity"}}` with UA `<short UA> google-api-nodejs-client/10.3.0` and `X-Goog-Api-Client: gl-node/22.21.1`; up to 5 attempts, 30 s each, 2 s sleep while `done:false`; project in `response.cloudaicompanionProject`.
* Credential JSON: `{type:"antigravity", access_token, refresh_token, expires_in, timestamp(ms), expired(RFC3339), email, project_id}`; filename `antigravity-<email>.json` (or `antigravity.json`). Label = email.
* Refresh (executor `antigravity_executor_auth.go:~100-190`): `POST https://oauth2.googleapis.com/token` form `client_id, client_secret, grant_type=refresh_token, refresh_token`; `User-Agent: Go-http-client/2.0`; 30 s budget; updates `access_token, refresh_token?, expires_in, timestamp, expired, type`; ensures `project_id`. Request-time safety window: refresh if token expires within **5 min** (`antigravityRequestTokenSafetyWindow`). Manager refresh lead **30 min**. 

#### 3.2.4 xAI (Grok) — device flow (`internal/auth/xai/`)
* `Issuer` `https://auth.x.ai`; discovery `GET https://auth.x.ai/.well-known/openid-configuration` (`Accept: application/json`) → `device_authorization_endpoint`, `token_endpoint`; both must be `https` and host `x.ai` or `*.x.ai` (`ValidateOAuthEndpoint`).
* `ClientID` `b1a00492-073a-47ea-816f-4c329264a828`; `Scope` `openid profile email offline_access grok-cli:access api:access`; grant `urn:ietf:params:oauth:grant-type:device_code`.
* Device request: `POST <device_authorization_endpoint>` form `client_id, scope` → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}` (device_code, user_code and a verification URI required). Management returns `url = verification_uri_complete || verification_uri`, `flow:"device"`, `user_code`, `expires_in` (default 1800 s = `MaxPollDuration` 30 min).
* Poll `POST <token_endpoint>` form `grant_type=<device grant>, device_code, client_id`; interval = max(`interval`, 5 s); deadline = min(30 min, `expires_in`); first attempt immediate; errors: `authorization_pending` continue, `slow_down` ⇒ +5 s, `expired_token` ⇒ `xai device code expired`, `access_denied` ⇒ `xai device authorization denied`, other ⇒ `xai device token error: <err>[: <desc>]`. Success `{access_token, refresh_token, id_token, token_type, expires_in}`; email/sub parsed from unverified `id_token` payload. The poller also stops (and no credential is saved) when the management session is cancelled (checked every 2 s, `watchOAuthSessionCancel`).
* Credential JSON (`TokenStorage`): `{type:"xai", access_token, refresh_token, id_token?, token_type?, expires_in?, expired?, last_refresh, email?, sub?, base_url:"https://api.x.ai/v1", redirect_uri?, token_endpoint, auth_kind:"oauth"}` (+ attributes `auth_kind`, `base_url`); filename `xai-<sanitized email|sub>.json` (allowed `[A-Za-z0-9@._-]`, other chars → `-`, trimmed `-`; fallback `xai-<unixMilli>.json`). `CLIChatProxyBaseURL = https://cli-chat-proxy.grok.com/v1` also defined (Grok CLI UA path).
* Refresh: `POST token_endpoint` form `grant_type=refresh_token, client_id, refresh_token` (token_endpoint from credential or rediscovered); single-flight per refresh token. **Refresh lead 5 min** (`xai/types.go:30`).

#### 3.2.5 Meta (Muse Code) — device flow + key mint (`internal/auth/meta/meta.go`)
* `ClientID` `1031625952748946`; device endpoint `POST https://auth.meta.com/oidc/device/authorization/` form `client_id`; token endpoint `POST https://auth.meta.com/oidc/device/token/` form `grant_type=<device grant>, device_code, client_id`; headers `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, `User-Agent: muse-code/1.0.2`. Poll interval `interval` or 5 s; `slow_down` ⇒ +5 s; max 15 min (or `expires_in`); network/read errors are retried silently; `access_denied`/`expired_token` terminal.
* On success `TokenData{access_token (the "DCA token"), token_type, expires_in}`; then **mint**: `POST https://api.meta.ai/muse-code/key` (override env `META_MINT_URL`) JSON `{"dca_token":…}` with `Authorization: Bearer <dca>`, UA `muse-code/1.0.2` → `{api_key, base_url, user_email, user_full_name, subs_tier_name, subs_tier_id, is_subs_active, has_payment_method, require_payment, can_subscribe}` (api_key required; mint failure is only a warning).
* Credential JSON (`MetaTokenStorage`): `{type:"meta", auth_kind:"oauth", access_token (= api_key if minted else DCA), dca_token, api_key?, token_type, expires_in, expired (only when no api_key), dca_expired, dca_expires_at, last_refresh, base_url (minted or https://api.meta.ai/v1), email, name}` + extra metadata `subs_tier_name, subs_tier_id, is_subs_active, has_payment_method`; filename `meta-<sanitized email (non [A-Za-z0-9._-] → _, max 120)>-<sha256(email) hex[:16 chars = 8 bytes]>.json`, else `meta-<sha256(sub)[:8bytes hex]>.json`, else `meta-oauth.json` (handler passes DCA token as the `sub` arg).
* No scheduled refresh (`RefreshLead()==nil`); on demand `MetaExecutor.Refresh` re-mints the API key from `dca_token` (single-flight per DCA token).

#### 3.2.6 Kimi / Kimi.ai — device flow (`internal/auth/kimi/kimi.go`)
* `kimiClientID` `17e5f671-d194-4dfb-9706-5516cb48c098`. Domains: `kimi.com` (default; OAuth host `https://auth.kimi.com`; API base `https://api.kimi.com/coding`) and `kimi.ai` (`https://auth.kimi.ai`; `https://api.kimi.ai/coding`). `?domain=` / `?channel=` pick the domain; `provider=kimi-ai` forces `.ai` (provider name `kimi-ai`, state prefix `kmi-ai`, file prefix `kimi-ai`).
* Device: `POST <host>/api/oauth/device_authorization` form `client_id` → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}`; poll `POST <host>/api/oauth/token` form `client_id, device_code, grant_type=urn:ietf:params:oauth:grant-type:device_code`; headers `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json` + device headers `X-Msh-Platform: CLIProxyAPI`, `X-Msh-Version: <build version>`, `X-Msh-Device-Name: <hostname>`, `X-Msh-Device-Model: "<OS> <arch>"`, `X-Msh-Device-Id: <uuid v4 generated per flow>`. Poll interval ≥5 s; max 15 min (or `expires_in`); `authorization_pending`/`slow_down` continue (interval NOT increased), `expired_token`/`access_denied`/other terminal. Response `{access_token, refresh_token, token_type, expires_in(float), scope}`.
* Credential JSON: `{type:"kimi"|"kimi-ai", access_token, refresh_token, token_type, scope, timestamp(ms), domain, base_url, expired (from expires_in), device_id}`; filename `kimi-<unixMilli>.json` / `kimi-ai-<unixMilli>.json`; label `Kimi User`/`Kimi.ai User`; attributes `base_url`, `domain`.
* Refresh: `POST <host>/api/oauth/token` form `client_id, grant_type=refresh_token, refresh_token` (single-flight). Lead **5 min** (`sdk/auth/kimi.go:16`, `refreshThresholdSeconds=300`).

#### 3.2.7 Devin (Cognition / Windsurf) — `internal/auth/devin/`
* Hosts: app `https://app.devin.ai`, API `https://api.devin.ai`, seat-management server `https://server.codeium.com`. 
* Authorize URL: `https://app.devin.ai/auth/cli/continue?redirect_uri=<urlenc>&state=<urlenc>&prompt=select_account&code_challenge=<urlenc>&code_challenge_method=S256` (+`cli_pkce_marker=1` only when redirect empty). **`redirect_uri` must be exactly `http://127.0.0.1:<server port>/callback`** (Devin validates http / 127.0.0.1 / `/callback`); the server itself serves `GET /callback` and `GET /devin/callback` (§2.3) — so on Workers the redirect URI would need to be `http://127.0.0.1:…` → same "paste redirect URL" problem. PKCE verifier 64 random bytes `RawURLEncoding`.
* Callback wait: 5 min context timeout, file hand-off like others (`.oauth-devin-<state>.oauth`), checks: state equal (`State code error`), `error` ⇒ `Devin authorization denied`, empty code ⇒ `Missing authorization code`, exchange failure ⇒ `Failed to exchange authorization code for tokens` (details deliberately hidden), record failure ⇒ `Failed to create Devin authentication record`.
* Exchange: `POST https://api.devin.ai/auth/cli/token` JSON `{"code","code_verifier"}` (`Accept: application/json`) → `{"token": "<session token>"}`. Session token normalised by `FormatSessionToken`: if it starts with `devin-session-token$` keep; if it starts with `eyJ` prefix `devin-session-token$`.
* Enrichment: `GET https://api.devin.ai/v3/self` (Bearer session token) → `user_name, user_id, org_id`; and **Connect-RPC** `POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus` with protobuf body (request field 1 → {1:"chisel", 2:"3000.10.21", 3:<session token>, 4:"en", 5:<goos>, 7:"3000.10.21", 12:"chisel", 31:<732-hex device fingerprint = sha256 chain of seed or random>}), headers `Authorization: Basic <token>-<token>`, `Connect-Protocol-Version: 1`, `Content-Type: application/proto`, `Accept: */*`, empty `User-Agent`; response protobuf parsed for email, user/team/org ids, plan, daily/weekly quota remaining %, reset times, plan start/end (`internal/auth/devin/user_status.go`; needs a protobuf encoder/decoder in TS, e.g. `@bufbuild/protobuf` or a manual varint codec). Failures only warn.
* Credential JSON metadata: `{type:"devin", api_key=session_token, session_token, user_name, user_id, org_id, auth_kind:"oauth", email?, plan?}`; attributes include `base_url=https://server.codeium.com`; filename `devin-<identifier>.json` where identifier = user_name || user_id || `user-<sha256(token)[:8 bytes hex]>`, chars outside `[A-Za-z0-9_.@-]` or len>160 ⇒ `user-<sha256(identifier)[:8 bytes]>`. No refresh (session token is permanent; `RefreshLead()==nil`); `DevinExecutor.Refresh` only re-fetches user status/quota.

#### 3.2.8 Vertex (service-account import) & Gemini/AI Studio
No OAuth: `POST /oauth/import?provider=vertex` stores a normalised service-account JSON (`internal/auth/vertex/keyutil.go` `NormalizeServiceAccountMap` fixes private key PEM) with `location` (default `us-central1`); runtime mints Google access tokens from the SA (JWT bearer) — see executor docs. AI Studio/Gemini credentials are API keys (config) or imported JSON.

### 3.3 Refresh scheduling summary (`sdk/cliproxy/auth/conductor_refresh.go:113-170`, `auto_refresh_loop.go`)
`shouldRefresh(auth, now)`: false if unauthorized/invalid_grant-disabled failure or `NextRefreshAfter` in the future; per-credential `refresh_interval_seconds` (metadata/attributes keys `refresh_interval_seconds|refreshIntervalSeconds|refresh_interval|refreshInterval`) wins; else lead per provider (`sdk/auth/refresh_registry.go`): codex 24 h, claude 4 h, antigravity 30 min, kimi/kimi-ai/kimi.ai 5 min, xai 5 min, meta none, devin none; refresh when `expiry - now <= lead`, or (no expiry) `now - lastRefresh >= lead`. Worker pool default 16 (`oauth.auth-auto-refresh-workers`). Port: cron trigger + DO alarm per credential, or refresh-on-demand (token expiry check before request) with single-flight per credential in a DO.

---------------------------------------------------------------------------------------------------

## 4. Model registry

### 4.1 Embedded static catalogs (`internal/registry/models/`, `//go:embed`)
| file | embed site | loaded into | size (this checkout) |
|---|---|---|---|
| `models/models.json` | `model_updater.go:24` | `modelsCatalogStore` (`staticModelsJSON`, model_definitions.go:~28) | 118 KB |
| `models/codex_client_models.json` | `codex_client_models.go:15` | `codexClientCatalogStore` (raw bytes + revision) | 624 KB |
| `models/devin_models.json` | `devin_models.go:16` | `devinCatalogStore` | 25 KB |
Embedded catalogs are loaded in `init()`; parse failure only logs a warning. Port: bundle as JSON imports (Workers bundle size limit applies — 624 KB codex catalog is OK) and/or put the live copy in KV/R2 refreshed by cron.

**`models.json` shape** — one JSON object whose top-level keys are provider arrays: `claude, gemini, vertex, gemini-cli(legacy/unused), aistudio, codex-free, codex-team, codex-plus, codex-pro, kimi, antigravity, xai, devin, meta` (counts here: 18,14,21,7,16,5,9,9,9,10,14,12,–,5; `devin` section optional). Go struct `staticModelsJSON` omits `gemini-cli`. Each element is a `ModelInfo` (`model_registry.go:31-104`):
```
{ id, object:"model", created(unix), owned_by, type, display_name?, name?("models/…" for gemini), version?, description?,
  inputTokenLimit?, outputTokenLimit?, supportedGenerationMethods?[], context_length?, max_completion_tokens?, supported_parameters?[],
  supportedInputModalities?[], supportedOutputModalities?[], supports_web_search?(bool),
  thinking?{min,max,zero_allowed,dynamic_allowed,levels[]}, config?{override_header{k:v}},
  native_capabilities?{web_search:bool|null}, support_configuration_update?(bool) }
```
Fields tagged `json:"-"` internally (`MetadataModelID, ExplicitThinking, ExplicitInputModalities, MaxContextLength, UserDefined, IsCompat`) are runtime-only.
Validation (`validateModelsCatalog`, model_updater.go:~190): every listed section must have unique, non-empty `id`s (null entries/duplicates reject the whole catalog); empty sections only warn.
Built-in (hard-coded, not in JSON) additions: `WithCodexBuiltins` upserts image models `gpt-image-1.5, gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2.5` (owned_by `openai`, type `openai`, object `model`, created 1704067200 for the first two) into **every codex-* tier**; `WithXAIBuiltins` upserts `grok-imagine-image, grok-imagine-image-quality, grok-imagine-image-2.0, grok-imagine-video(created 1735689600), grok-imagine-video-1.5, grok-imagine-video-1.5-preview, grok-tts(created 1773619200), grok-voice-tts-1.0` (owned_by/type `xai`) (`model_definitions.go:12-26,243-440`). Devin built-ins (`WithDevinBuiltins`, `staticDevinModels` e.g. `devin/swe-2` context 262000, `devin/claude-fable-5-1`) in `devin_models.go`.
`LookupStaticModelInfo(id)` searches claude, gemini, vertex, aistudio, **codex-pro**, kimi, antigravity, xai, devin, staticDevin, meta (first match).

**`codex_client_models.json` shape**: `{"models":[{slug, display_name, description, base_instructions, minimal_client_version, visibility, priority(int ≥0), context_window, max_context_window (context_window ≤ max, both >0 ints), default_reasoning_level, supported_reasoning_levels:[{effort,description}] (non-empty, unique efforts, default must be listed), prefer_websockets, support_verbosity, default_verbosity, apply_patch_tool_type, web_search_tool_type, input_modalities[], truncation_policy{mode,limit}, supports_parallel_tool_calls, tool_mode, multi_agent_version, use_responses_lite, supports_reasoning_effort_updates, …}]}`; must contain slug `gpt-5.5` (default template); total ≤ 8 MiB; slugs unique (`ValidateCodexClientModelsJSON`, codex_client_models.go:~70-150). Currently 10 entries.
**`devin_models.json` shape**: `{"devin":[ModelInfo…]}` (also accepts `{"models":[…]}` or a bare array; `ValidateDevinModelsJSON`).

### 4.2 Static model lookups by credential type (`registerModelsForAuth`, `sdk/cliproxy/service_models.go:17-330`)
| credential provider | base model list | config override |
|---|---|---|
| `gemini` / `gemini-interactions` | `models.gemini` | key `models[]` replaces list (`buildConfigModels(…, owned_by "google", type "gemini")`); api-key kind uses key's `excluded-models` |
| `vertex` | `models.vertex` | vertex key `models[]` (type `vertex`) |
| `aistudio` | `models.aistudio` | – |
| `antigravity` | `models.antigravity`; unless Home: dynamic list from `fetchAvailableModels` (§4.4) | – |
| `claude` | `models.claude` | key `models[]` (owned_by `anthropic`, type `claude`) |
| `codex` OAuth | by `attributes.plan_type` (case-insens): `pro`→`codex-pro`, `plus`→`codex-plus`, `team|business|go`→`codex-team`, `free`→`codex-free`, other/empty→`codex-pro` | – |
| `codex` API key | entry `models[]` (owned_by/type `openai`) or **all of `codex-pro`** (with `support_configuration_update=false`) when no models configured | configured `display-name`/`support-configuration-update` applied |
| `kimi`, `kimi-ai`, `kimi.ai`, `kimi.com` | `models.kimi` | – |
| `xai` | `models.xai` (+builtins) | key `models[]` (owned_by/type `xai`) |
| `devin` | active devin catalog (`GetDevinModels`) | – |
| `meta` | `models.meta` | key `models[]` (owned_by/type `meta`) |
| openai-compatibility (by `compat_name`/`provider_key`/provider name matching `openai-compatibility[].name`) | provider `models[]` → `ModelInfo{id=alias||name, MetadataModelID=name, object model, created=now, owned_by=<provider name>, type "openai-compatibility" (or `openai-image` when `image:true`), display_name, thinking default `levels [low,medium,high]` unless `image`, input/output modalities normalised lowercase-dedupe, context length}`; skipped when `disabled:true`; same alias repeated = internal model pool, exposed once | – |
Then, in order: **excluded models** (`applyExcludedModels`: lowercase patterns; supports `*` prefix/suffix/substring/multi-segment wildcards; OAuth exclusions from `oauth.excluded-models.<provider>`, or the per-credential pre-merged `attributes.excluded_models` (comma-sep) which overrides; api-key credentials use the key's own list) → **OAuth model aliases** (`applyOAuthModelAliasForAuth`: channel = provider name (api-key auth ⇒ none; `gemini` ⇒ none); per-credential `model_aliases` first, then global `oauth.model-alias.<channel>`, de-duplicated by lowercase alias (per-credential wins); each alias clones the model with `id=alias`, `MetadataModelID=orig`, optional `display_name` override, `name` rewritten (`models/<orig>`→`models/<alias>`); `fork:true` keeps the original too; aliases equal to the name are ignored) → plugin models appended → **OAuth settings** (`oauth.settings` `max-context-length` ⇒ `context_length` & `MaxContextLength`) → **prefix** (`applyModelPrefixes(models, auth.Prefix, force-model-prefix)`: when prefix set, add `prefix/<id>` clone for each model; the unprefixed id is kept unless `force-model-prefix` is true and prefix != id) → `registerResolvedModelsForAuth` → `GlobalModelRegistry().RegisterClient(authID, provider, models)`.
Disabled credentials: `UnregisterClient`. Registration is re-run when credentials/config change or the catalog refresh callback fires for the affected providers.

### 4.3 Remote catalog updater (`registry/model_updater.go`, `catalog_sources.go`, `*_updater.go`)
* `ModelsRefreshInterval = 3 * time.Hour` (model_updater.go:17). One `catalogUpdater` per catalog; `configure(ctx, source)` starts a goroutine: refresh immediately, then `time.Ticker(3h)` (not for `embed`; `source=="disabled"` does nothing); reconfiguring with a changed source cancels and restarts; generation counter prevents stale publishes.
* Sources (tried in order; first valid wins; with an explicit `models.<x>` source only that one is tried; `readCatalogSource` supports absolute file paths or http(s) with `http.DefaultClient`, no custom UA/headers, size limit 8 MiB (`maxCodexClientModelsSize`/`maxDevinModelsSize`) – the general catalog uses the same helper):
  * general: `https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json`, then `https://models.router-for.me/models.json`
  * codex client: `…/refs/heads/main/codex_client_models.json`, then `https://models.router-for.me/codex_client_models.json`
  * devin: `…/refs/heads/main/devin_models.json`, then `https://models.router-for.me/devin_models.json`
* Publish: validate; if the new general catalog has no `meta` section keep the old one (`publishCatalogBytes`); compute changed providers (`detectChangedProviders`: per section JSON-compare plus `native_capabilities`/`support_configuration_update`; mapping `gemini→{gemini,gemini-interactions}`, codex-* → `codex`, `kimi→{kimi,kimi-ai,kimi.ai,kimi.com}`) → `notifyModelRefresh(changed)` → service re-registers models of credentials of those providers. Pending notifications are queued until a callback is registered. Codex/Devin catalogs keep a monotonically increasing `revision` and compare raw bytes (no change ⇒ no notification; codex callback never lists changed providers).
* Failure: log "keeping last valid catalog". Home mode: general & devin catalogs "disabled".
* Port: Workers cron every 3 h (or lazy refresh on a stale-while-revalidate KV entry) fetching the same URLs, validating, storing in KV/R2; fan-out "changed providers" → invalidate model-list caches.

### 4.4 Antigravity dynamic model list (`sdk/cliproxy/antigravity_models.go`)
For non-Home Antigravity credentials the registered models come from the account, not the static list: `POST <base>/v1internal:fetchAvailableModels` (default base `https://daily-cloudcode-pa.googleapis.com`; overridable via credential `base_url`/`base_urls`; only first URL used) with JSON `{"project": <metadata.project_id>}`, headers `Authorization: Bearer <access>`, `Content-Type: application/json`, `User-Agent: antigravity/hub/<ver> darwin/arm64`; 401/403 ⇒ auth error, other non-2xx / >8 MiB ⇒ transient. Response parsed for `models` (map keyed by model id) and `webSearchModelIds[]`; both lower-cased/trimmed; static entries are filtered to the returned ids and `supports_web_search=true` set for web-search ids. Cache TTL 3 h (`antigravityCapabilityCacheTTL = ModelsRefreshInterval`); failure back-off 1 min doubling to 30 min (`antigravityCapabilityRetryBase/Max`); refresh scan every 1 min. Uses proxy per credential.

### 4.5 `/v1/models` output per protocol
Route wiring: `internal/api/server_routes.go:66` `GET /v1/models` → `unifiedModelsHandler` (lines 594-620); `GET /v1beta/models` and `GET /v1beta/models/*action` (:131-134). Auth = client API key middleware (not management). Source of truth: `registry.GetGlobalRegistry().GetAvailableModels(handlerType)` (`model_registry.go:1276-1390`).
**Dispatch for `GET /v1/models`** (in order):
1. User-Agent contains `grok-shell` (case-insens) → Grok Build format (below).
2. Query contains `client_version` (even empty) → Codex client catalog format (below).
3. Anthropic format when header `Anthropic-Version` is present OR UA starts with `claude-cli`.
4. Otherwise OpenAI format.
(Home mode variants omitted.)

**Availability**: a model is listed iff `modelRegistrationAvailability` > 0 effective clients: `Count` of registered clients minus those with `quota_exceeded` within the last **5 min** (`modelQuotaExceededWindow`) minus clients suspended for non-quota reasons; clients suspended with reason `"quota"` don't remove the model (still counted available when no other-suspension). Map output is cached per `handlerType` until the earliest quota recovery time or any registry change (`invalidateAvailableModelsCacheLocked`). Registry also deduplicates by model id across credentials (`registerClientLocked`: model registration `Count`, per-provider `InfoByProvider`); ordering is Go map iteration (unspecified) — the Anthropic format sorts, others are unsorted (a port should sort by id for determinism).

**OpenAI** (`handlerType "openai"`, then filtered by `OpenAIModels`, `sdk/api/handlers/openai/openai_handlers.go:63-107`): response `{"object":"list","data":[{"id","object","created"?,"owned_by"?}]}` — only these four keys survive the filter (internal map also has type, display_name, version, description, context_length, max_context_length, max_completion_tokens, supported_parameters; used by `/v1/responses`-model routers and Codex catalog).
**Anthropic** (`code_handlers.go:159`, `internal/client/claude/models/models.go`): per model map `{id, object:"model", owned_by, created_at:<RFC3339 UTC of created, only if created>0>, type:"model", display_name (fallback id), max_input_tokens (context_length or 200000), max_tokens (max_completion_tokens or 64000)}`; ID cloaking unless `upstream.claude.disable-cloaking-model-list`: ids not starting `claude-` become `claude-fable-5-dd-` + reversed-characters id (`EnsureClaudeModelIDPrefix`; inverse `ResolveClaudeModelIDPrefix` on requests, preserving `(thinking)` suffix); list sorted by `display_name` then `id`; envelope `{"data":[…],"has_more":false,"first_id":<first>,"last_id":<last>}`.
**Gemini** (`GET /v1beta/models`, `gemini_handlers.go:50-78`): `handlerType "gemini"` maps `{name (model.Name or id; "models/" prefix ensured), version?, displayName? (default = name), description? (default = name), inputTokenLimit?, outputTokenLimit?, supportedGenerationMethods (default ["generateContent"]), supportedInputModalities?, supportedOutputModalities?}` wrapped as `{"models":[…]}`. `GET /v1beta/models/<name>` returns the single matching map (name matched with/without `models/`), else 404 `{"error":{"message":"Not Found","type":"not_found"}}`.
**Generic** (any other handler type): `{id, object:"model", owned_by?, type?, created?}`.
**Codex client catalog** (`/v1/models?client_version=<v>`, `sdk/api/handlers/openai/codex_client_models.go`, `internal/client/codex/models/models.go`): returns `{"models":[…template entries…]}` compact-marshalled (no HTML escape). For each available model: metadata id = `MetadataModelID` of registry info (or text after the first `/`, or the id); if a template with that slug exists in `codex_client_models.json`, clone it, set `slug=id`, apply capability/display/description/base-instructions/max-context/max-tokens/thinking overrides, provider/web-search/apply-patch capability flags, reasoning-level sanitising by client version (extended levels `max/ultra` only for newer clients), `multi_agent_version:"v2"` when `client.codex.optimize-multi-agent-v2`; image/video model ids get `visibility:"hide"`. Non-template models are cloned from the `gpt-5.5` template with overrides (`context_window=max_context_window=context_length|max_context_length`, `prefer_websockets:false`, `service_tiers:[]`, compact instructions) and priorities assigned after the highest template priority in steps of 100 sorted by display name; final sort by `priority`. Complex (≈1000 LOC) — see the file for exact rules; port after the basic lists.
**Grok Build** (`internal/client/grokbuild/grokbuild.go`): `{"object":"list","data":[{"id","model":id,"name":display_name||id,"context_window"?,"api_backend":"responses","supported_in_api":true,"reasoning_efforts":[{"value":level}…]?}]}` from all available models (`GetAvailableModelInfos`, sorted by id).
All list responses pass through `WriteModelListResponse` (plugin interceptors; default `application/json; charset=utf-8`).

### 4.6 Misc registry behaviours worth keeping
* Quota/suspension: `SetModelQuotaExceeded(clientID, modelID)`, `ClearModelQuotaExceeded`, `SuspendClientModel(clientID, modelID, reason)`, `ResumeClientModel`, `CleanupExpiredQuotas` (5 min window) — driven by the conductor on upstream errors.
* `ResolveResponsesWebSearchCapability`: tri-state (`true/false/nil`) across all routes of a public model; provider path support: `codex, xai, claude, antigravity` ⇒ true; `openai, openai-compatibility, gemini, aistudio, vertex, kimi*, interactions, gemini-interactions, openai-compatible-*` ⇒ false; unknown ⇒ unknown.
* `ModelOverrideHeaders(modelID, provider)` returns `config.override_header` from the catalog entry (forces upstream headers).
* `GET /v8/management/credentials/models?name=` and per-model thinking capabilities (`thinking.levels` or `min/max/zero_allowed/dynamic_allowed`) feed `internal/thinking` (not covered here).

---------------------------------------------------------------------------------------------------

## 5. What cannot work on plain Cloudflare Workers (and what it is used for)

| Go feature | Where | Used for | Workers replacement |
|---|---|---|---|
| Listening sockets / TLS / host/port | `server.*`, gin | serving API | Worker `fetch` handler; public origin replaces `127.0.0.1:<port>` in callback URLs |
| mDNS multicast discovery | `sdk/cliproxy/discovery_advertiser.go` | LAN advertise | drop |
| pprof listener, redis/RESP usage-queue listener (`internal/api/redis_queue_protocol.go`, protocol multiplexer `mux_listener.go`) | debugging, usage export | drop; expose usage via HTTP/Queues/Analytics Engine |
| Callback forwarder TCP listeners (ports 54545/1455/51121) | `auth_files_oauth_callback.go` | redirect `localhost:<port>` OAuth redirects to the server | impossible; use manual "paste redirect URL" (`POST /oauth/callback` with `redirect_url`), Codex device flow, or a tiny local helper |
| Filesystem: auth dir, `.oauth-*.oauth` hand-off files, static dir, log files, `.cds` cooldown files, `config.yaml` rewrite with comment preservation | everywhere | persistence | D1/KV/DO/R2; no YAML comment preservation needed |
| Goroutine loops: auth auto-refresh (`auto_refresh_loop.go`), catalog updaters (3 h), management asset updater (3 h), antigravity version updater (3 h)/model probes (1 min scan), attempt purger (1 h), OAuth poll loops (500 ms / device intervals), watcher/config hot-reload (fsnotify) | | background maintenance | Cron Triggers + Durable Object alarms (device-code polling needs DO alarm or client-driven polling via `/oauth/status`) |
| uTLS ClientHello spoofing + ordered raw HTTP/1.1 headers for Claude OAuth (`internal/auth/claude/utls_transport.go`, `httpwire`), also inference-plane Claude fingerprinting | Claude login/refresh/profile | look like Claude Code/Node | not possible with `fetch`; need relay or accept risk |
| Outbound proxies (`proxy-url`, socks5/http, `util.SetProxy`, per-credential proxies) | all upstream calls | egress control | not available (no raw TCP; `connect()` API TCP sockets exist but not general proxies) |
| WebRTC/UDP live media relay (`codex.live-media-relay`) | Codex Live | media relay | not possible |
| WebSocket **client** to upstream (Codex/xAI WS executors) and WS server relays (`/v1/ws`, wsrelay) | streaming | possible with `new WebSocket()` fetch-upgrade (client) and DO WebSocket hibernation (server) — but connection-lifetime/CPU limits apply |
| Native C-ABI plugins (`plugins.*`, `internal/pluginhost`, plugin store binary downloads) | extensibility | drop; reimplement as TS modules if needed |
| bcrypt (golang.org/x/crypto) | management secret | need JS bcrypt (WASM/pure JS) only for compatibility; new design can use PBKDF2/scrypt via WebCrypto |
| Home/cluster control plane | `internal/home`, `credentials.*` | multi-node scheduling | DO-based scheduler |
| `singleflight` per-refresh-token | refreshes | dedupe concurrent refresh | DO per credential (serialises naturally) |
| In-memory OAuth session store, ban map, usage queue, `recent_requests` ring | management | state | DO storage / KV TTL |

### Key numeric constants (quick sheet)
OAuth session TTL 30 min (completed 1 min); callback wait 5 min (500 ms poll); state ≤128 chars `[A-Za-z0-9._-]`; management ban 5 failures → 30 min; ban cleanup 1 h / idle 2 h; API-call timeout 60 s; latest-version timeout 10 s; panel HTTP timeout 15 s, panel check min interval 30 s, panel/model/antigravity-version refresh 3 h; recent-requests 20 × 10 min buckets; model quota-exceeded window 5 min; Claude refresh timeout 30 s / TLS handshake 10 s / 429 block 5 s–5 min; Codex refresh timeout 30 s; refresh leads codex 24 h, claude 4 h, antigravity 30 min, kimi 5 min, xai 5 min; device-flow max: xAI 30 min, Meta 15 min, Kimi 15 min, Codex-device 15 min; poll min interval 5 s; usage-queue retention 60 s (1..3600); session-affinity TTL 1 h; weight default 1 / max 1,000,000; video result cache 3 h; antigravity credits/capability cache 3 h, retry 1→30 min.
