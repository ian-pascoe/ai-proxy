# CLIProxyAPI on Cloudflare Workers

A TypeScript + [Effect v4](https://effect.website) port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) that
runs on plain Cloudflare Workers behind Cloudflare Zero Trust **Access**. It exposes OpenAI (chat completions, completions,
Responses incl. WebSocket), Anthropic (`/v1/messages`), Gemini (`/v1beta`) and Interactions compatible APIs, backed by your
own provider logins (OAuth) and API keys, with round-robin credential selection, cooldowns and automatic token refresh.

| Guide                                                   | Contents                                                |
| ------------------------------------------------------- | ------------------------------------------------------- |
| [ACCESS.md](../docs/workers-port/ACCESS.md)             | Create the Access application, policies, service tokens |
| [CLIENTS.md](../docs/workers-port/CLIENTS.md)           | Claude Code, Codex CLI, SDKs, curl                      |
| [MIGRATION.md](../docs/workers-port/MIGRATION.md)       | Moving from the Go server                               |
| [DEVELOPMENT.md](../docs/workers-port/DEVELOPMENT.md)   | Scripts, module layout, conventions                     |
| [ARCHITECTURE.md](../docs/workers-port/ARCHITECTURE.md) | Binding design decisions                                |

## How it works

- **Authentication is Cloudflare Access only.** Access sits in front of the Worker's custom domain and injects a signed
  `Cf-Access-Jwt-Assertion`; the Worker verifies it. There are no proxy API keys. Users sign in with your IdP; tools use
  Access **service tokens** (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers).
- **State** lives in a `ControlPlane` Durable Object (config, credentials, cooldowns, OAuth sessions), a `SessionState`
  Durable Object (reasoning replay/continuity caches), KV `CACHE` (model catalogs), and D1 `USAGE` (usage records).
- **Management**: the official control panel is served at `/management.html` and the API at `/v8/management`, both for Access
  admins only. You add credentials (OAuth login or auth-file upload) and edit config there.

## Provider support

| Provider (credential)                                      | Client protocols served                                  | Notes                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude (OAuth login, API key)                              | OpenAI, Responses, Claude, Gemini, Interactions          | Claude Code cloaking and body signing; no uTLS (see limitations)                            |
| Codex / ChatGPT (OAuth browser or device, API key)         | OpenAI, Responses (HTTP + WebSocket), Claude, Gemini     | `/backend-api/codex/*` aliases; no Codex live/realtime                                      |
| Gemini (API key), Vertex (API key, service account upload) | OpenAI, Claude, Gemini, Responses, Interactions          | No Gemini OAuth: Gemini-CLI auth files (`type: gemini`/`gemini-cli`) are rejected on import |
| Antigravity (OAuth)                                        | OpenAI, Claude, Gemini, Interactions                     | Compaction and some grounding paths still answer 501 (follow-up)                            |
| xAI (device login, API key)                                | OpenAI, Responses (HTTP + WebSocket), images, video, TTS |                                                                                             |
| Kimi / Kimi.ai (device login), Meta, Devin                 | OpenAI, Claude, Responses                                | Devin: authorization-code login                                                             |
| OpenAI-compatible upstreams (API key)                      | every client protocol                                    | Configured as `api-keys.openai-compatibility` groups                                        |

The matrix is indicative: which (client protocol, provider) pairs work follows the registered translators in
`src/translator/builtin.ts`; an unsupported pair answers with a 4xx/501 error body.

Endpoints: `POST /v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`
(+ `/compact`, `GET` WebSocket upgrade), `GET /v1/models`, `/v1beta/models/*` (`:generateContent`, `:streamGenerateContent`, …),
`POST /v1beta/interactions`, images, videos and speech under `/v1`, plus `/openai/v1/videos` and
`/backend-api/codex/{responses,responses/compact,alpha/search}`. `GET /healthz` and `/` are public from the Worker's point of
view (an Access application on the whole hostname still protects them).

### Known limitations

- **No uTLS / HTTP-2 fingerprint impersonation.** Workers `fetch` cannot control the TLS ClientHello or HTTP/2 settings, so
  `wire-policy`/`tls-fingerprint` settings are ignored. Header/body cloaking for Claude Code still applies; upstream
  providers that fingerprint TLS may treat the traffic differently.
- **Egress IPs are Cloudflare's.** Requests to providers leave from Cloudflare data-centre addresses, not your own IP.
  Providers that bind sessions to an IP or block cloud ranges may reject or challenge them. You cannot pin an egress IP.
- **No outbound proxies.** `proxy-url` (global, per credential, per key group) is read but not applied.
- **Removed features:** plugins, CLIProxyAPIHome mode, TUI, mDNS discovery, pprof, git/Postgres/object-store backends,
  request-log files, Codex live/realtime (WebRTC/SIP), the AI Studio `wsrelay` gateway, `/v0/management`, legacy proxy API keys
  (`api-keys` client list: imported into `access.api-keys` but not enforced).
- **WebSocket CPU limit.** The Responses WebSocket lives in the invocation that accepted it and is bounded by the Workers
  CPU limit (`limits.cpu_ms = 300000`, which needs the Workers Paid plan). There are no ping keep-alives
  (`streaming.keepalive-seconds` is ignored). Clients reconnect on close; prefer HTTP/SSE if you see 1011/1012 closes.
- **Not ported:** see ARCHITECTURE.md for the per-provider lists and MIGRATION.md for config keys without effect.
  `/v1/responses/compact` answers 501 for Gemini/Vertex credentials, like Go.

## Local development

```bash
cd workers
pnpm install
cp .dev.vars.example .dev.vars     # contains ACCESS_DEV_BYPASS=you@example.com
pnpm panel:sync                    # downloads the control panel into public/ (optional locally)
pnpm dev                           # http://localhost:8787
```

`ACCESS_DEV_BYPASS` makes every request on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) an Access **admin** with that
email (`true` uses `dev@localhost`). It is ignored for any other host and refused (with a logged warning) whenever
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set, so it cannot weaken a deployed Worker, but keep it out of `wrangler.jsonc` and out
of production secrets. `.dev.vars` is git-ignored; `.dev.vars.example` is committed.

Open `http://localhost:8787/management.html` (any non-empty text works as "management key"), add a credential, then:

```bash
curl localhost:8787/v1/models
curl localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"<model id from /v1/models>","messages":[{"role":"user","content":"hi"}]}'
```

Local Durable Object, KV and D1 state lives in `.wrangler/state`. For local usage records run
`pnpm exec wrangler d1 migrations apply cliproxy-usage --local` once.

## Deploy

Prerequisites: a Cloudflare account on the **Workers Paid** plan (the CPU limit in `wrangler.jsonc`), a domain in that
account, Zero Trust enabled, Node 22+ and `pnpm exec wrangler login` (all commands below run in `workers/`).

1. **Create the resources** and paste the printed ids into `wrangler.jsonc`:

   ```bash
   pnpm exec wrangler kv namespace create CACHE      # -> kv_namespaces[0].id
   pnpm exec wrangler d1 create cliproxy-usage       # -> d1_databases[0].database_id
   ```

   The Durable Objects (`ControlPlane`, `SessionState`) are created by the `migrations` entry in `wrangler.jsonc` during
   deploy. The Worker is named `cliproxy-workers`; change `name` if you like.

2. **Attach a custom domain.** Add to `wrangler.jsonc` (the zone must be in your account):

   ```jsonc
   "routes": [{ "pattern": "proxy.example.com", "custom_domain": true }]
   ```

   `workers_dev` and `preview_urls` are already `false`: leave them. Access can only protect the custom domain, so a
   `workers.dev` or preview URL would bypass authentication.

3. **Create the Access application** for that hostname and note its AUD tag: see [ACCESS.md](../docs/workers-port/ACCESS.md).

4. **Set the Access variables** in `wrangler.jsonc` `vars` (they are identifiers, not secrets):
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the admin lists `ACCESS_ADMIN_EMAILS` / `ACCESS_ADMIN_SERVICE_TOKENS`.
   Optionally set `USAGE_RETENTION_DAYS` (default `30`, `0` keeps everything). With the defaults empty, every protected route
   answers 500 `Authentication service error` (fail closed). Do not set `ACCESS_DEV_BYPASS` here.

   The Worker reads **no other secrets**: provider tokens and API keys are stored in the `ControlPlane` Durable Object through
   the management API/panel. If you prefer secrets over `vars` for the Access values, use `pnpm exec wrangler secret put NAME` and remove the matching
   key from `vars` so the two do not conflict.

5. **Apply the D1 migrations** to the remote database:

   ```bash
   pnpm exec wrangler d1 migrations apply cliproxy-usage --remote
   ```

6. **Install the control panel** (not committed; ~3 MB, SHA-256 verified against the GitHub release):

   ```bash
   pnpm panel:sync          # GITHUB_TOKEN raises the API rate limit; --tag vX.Y.Z pins a release
   ```

7. **Deploy and verify:**

   ```bash
   pnpm build               # dry run: bundles and validates the config
   pnpm exec wrangler deploy
   curl https://proxy.example.com/healthz      # {"status":"ok"} once Access lets you through
   ```

8. **Add credentials.** Open `https://proxy.example.com/management.html` (sign in through Access as an admin; type any text
   as the management key), then use _OAuth login_ for Claude/Codex/…, upload auth files, or add API keys in the config. Then
   connect your tools: [CLIENTS.md](../docs/workers-port/CLIENTS.md). Coming from the Go server: [MIGRATION.md](../docs/workers-port/MIGRATION.md).

The cron trigger (`0 */3 * * *`) refreshes model catalogs, prunes old usage rows and re-arms credential refresh alarms.
Re-run `pnpm panel:sync` before a deploy to pick up a new panel release.

## Cloudflare Access reference

`/v1*`, `/openai/v1*`, `/backend-api/codex*` need a valid `Cf-Access-Jwt-Assertion`; `/v8/management*` and
`/management.html` additionally need an admin. Cross-site browser requests (and cross-origin WebSocket upgrades) are refused;
non-browser clients are unaffected. Variables and the browser-session hardening: see
[ACCESS.md](../docs/workers-port/ACCESS.md#3-worker-variables).

## Development

Scripts (`typecheck`, `lint`, `test`, `build`, …), module layout and conventions are in
[DEVELOPMENT.md](../docs/workers-port/DEVELOPMENT.md).
