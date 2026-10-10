# CLIProxyAPI on Cloudflare Workers

A TypeScript + [Effect v4](https://effect.website) port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) that
runs on plain Cloudflare Workers behind Cloudflare Zero Trust **Access**. It exposes OpenAI (chat completions, completions,
Responses incl. WebSocket), Anthropic (`/v1/messages`), Gemini (`/v1beta`) and Interactions compatible APIs, backed by your
own provider logins (OAuth) and API keys, with round-robin credential selection, cooldowns and automatic token refresh.

| Guide                                   | Contents                                     |
| --------------------------------------- | -------------------------------------------- |
| [ACCESS.md](docs/ACCESS.md)             | Access application, policies, service tokens |
| [CLIENTS.md](docs/CLIENTS.md)           | Claude Code, Codex CLI, SDKs, curl           |
| [MIGRATION.md](docs/MIGRATION.md)       | Moving from the Go server                    |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Scripts, module layout, conventions          |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Binding design decisions                     |

## How it works

- **Authentication is Cloudflare Access only.** Access sits in front of the Worker's custom domain and injects a signed
  `Cf-Access-Jwt-Assertion`; the Worker verifies it. There are no proxy API keys. Users sign in with your IdP; tools use
  Access **service tokens** (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers).
- **State** lives in a `ControlPlane` Durable Object (config, credentials, cooldowns, OAuth sessions), a `SessionState`
  Durable Object (reasoning replay/continuity caches), KV `CACHE` (model catalogs), and D1 `USAGE` (usage records).
- **Management**: the control panel is served at `/` (new, being built page by page in `web/`), the official upstream panel
  at `/management.html` until the new one covers everything, and the API at `/v8/management`, all for Access admins only. Access is the login, so the panel opens without asking for a management key. You add credentials (OAuth
  login or auth-file upload) and edit config there.

## Provider support

| Provider (credential)                                      | Client protocols served                                  | Notes                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude (OAuth login, API key)                              | OpenAI, Responses, Claude, Gemini, Interactions          | Claude Code cloaking and body signing; no uTLS (see limitations)                            |
| Codex / ChatGPT (OAuth browser or device, API key)         | OpenAI, Responses (HTTP + WebSocket), Claude, Gemini     | `/backend-api/codex/*` aliases; no Codex live/realtime                                      |
| Gemini (API key), Vertex (API key, service account upload) | OpenAI, Claude, Gemini, Responses, Interactions          | No Gemini OAuth: Gemini-CLI auth files (`type: gemini`/`gemini-cli`) are rejected on import |
| Antigravity (OAuth)                                        | OpenAI, Claude, Gemini, Interactions                     |                                                                                             |
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
  CPU limit (300 s by default, `CLIPROXY_CPU_MS`, which needs the Workers Paid plan). There are no ping keep-alives
  (`streaming.keepalive-seconds` is ignored). Clients reconnect on close; prefer HTTP/SSE if you see 1011/1012 closes.
- **Not ported:** see ARCHITECTURE.md for the per-provider lists and MIGRATION.md for config keys without effect.
  `/v1/responses/compact` answers 501 for Gemini/Vertex credentials, like Go.

## Local development

```bash
pnpm install                       # also clones the Go server into .repos/ (read-only reference, see DEVELOPMENT.md)
pnpm web:build                     # builds the control panel (/) into public/ (pnpm web:dev for hot reload)
pnpm panel:sync                    # downloads the upstream panel (/management.html) into public/ (optional locally)
ALCHEMY_STATE=local pnpm dev       # alchemy dev: http://localhost:1337, hot reload
```

`alchemy dev` runs the Worker in local workerd with emulated KV, D1 (migrations applied) and Durable Objects; no
Cloudflare resources are created and, with `ALCHEMY_STATE=local`, no Cloudflare login is needed (state stays in
`.alchemy/`). Access is not provisioned in dev: the Worker gets `ACCESS_DEV_BYPASS`, which makes every request on a loopback
host (`localhost`, `127.0.0.1`, `[::1]`) an Access **admin** (`dev@example.com`, override with `ACCESS_DEV_BYPASS` in
`.env`). The bypass is ignored for any other host and refused whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set, and
deployed Workers never get it.

Open `http://localhost:1337/` for the overview, or `http://localhost:1337/management.html` (it logs in by itself: there is
no management key) to add a credential, then:

```bash
curl localhost:1337/v1/models
curl localhost:1337/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"<model id from /v1/models>","messages":[{"role":"user","content":"hi"}]}'
curl 'localhost:1337/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*'   # run the cron jobs
```

`pnpm smoke` boots the same dev stack, checks a few routes and stops it (CI runs it).

## Deploy

All infrastructure is declared in [`alchemy.run.ts`](alchemy.run.ts) and deployed with
[Alchemy](https://alchemy.run) (v2, Effect-based): the Worker (Durable Objects `ControlPlane`/`SessionState`, static assets,
cron trigger, custom domain, no `workers.dev`/preview URLs), the KV namespace, the D1 usage database with its migrations, and
the Cloudflare Access application, policies and service tokens. There is no Wrangler configuration.

Prerequisites: a Cloudflare account on the **Workers Paid** plan (the default 300 s CPU limit; see `CLIPROXY_CPU_MS`), a
domain (zone) in that account, Zero Trust enabled (note your team name), Node 22+. All commands run from the repository root.

1. **Log in once** (OAuth in the browser or an API token; stored in `~/.alchemy/profiles.json`):

   ```bash
   pnpm exec alchemy profile edit --add Cloudflare
   ```

2. **Configure the deploy** (`.env` is git-ignored; shell variables override it):

   ```bash
   cp .env.example .env     # CLIPROXY_DOMAIN, ACCESS_TEAM_DOMAIN, ACCESS_ALLOW_*, ACCESS_SERVICE_TOKENS, ACCESS_ADMIN_*
   ```

   See [ACCESS.md](docs/ACCESS.md) for what each Access setting creates. The Worker reads **no other
   secrets**: provider tokens and API keys are stored in the `ControlPlane` Durable Object through the management API/panel.

3. **Build and install the control panels** (neither is committed; the upstream one is ~3 MB, SHA-256 verified against
   the GitHub release):

   ```bash
   pnpm web:build           # the control panel at /
   pnpm panel:sync          # the upstream panel; GITHUB_TOKEN raises the API rate limit; --tag vX.Y.Z pins a release
   ```

4. **Deploy** (shows the plan and asks for confirmation; `pnpm plan` only previews):

   ```bash
   pnpm run deploy --stage prod
   ```

   Use the same `--stage` for every later deploy: resources are named and tracked per stage (the default stage is
   `live_$USER`). The first run asks to bootstrap Alchemy's state store (a small Worker + Secrets Store in your account that
   keeps the deploy state; set `ALCHEMY_STATE=local` to keep it in `.alchemy/` instead). D1 migrations from `migrations/` are
   applied on every deploy. The outputs print the URL, the Access AUD tag and each service token's Client ID; the Client
   Secrets are written to `.alchemy/access-service-tokens.json` (mode 0600) on the deploying machine.

5. **Verify and add credentials:**

   ```bash
   curl https://proxy.example.com/healthz \
     -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET"     # {"status":"ok"}
   ```

   Open `https://proxy.example.com/management.html` (sign in through Access as an admin; type any text as the management
   key), then use _OAuth login_ for Claude/Codex/…, upload auth files, or add API keys in the config. Then connect your
   tools: [CLIENTS.md](docs/CLIENTS.md). Coming from the Go server:
   [MIGRATION.md](docs/MIGRATION.md).

Other commands: `pnpm logs --stage prod --tail` (Workers logs), `pnpm destroy --stage prod` (deletes everything,
including the D1 usage history and the Durable Objects holding credentials). Pushes to `main` deploy
production from CI and every pull request gets a preview stage: see [DEPLOY.md](docs/DEPLOY.md).

The cron trigger (`0 */3 * * *`) refreshes model catalogs, prunes old usage rows and re-arms credential refresh alarms.
Re-run `pnpm panel:sync` before a deploy to pick up a new panel release.

## Cloudflare Access reference

`/v1*`, `/openai/v1*`, `/backend-api/codex*` need a valid `Cf-Access-Jwt-Assertion`; `/v8/management*`,
`/management.html` and the control panel (`/`, its pages and `/assets`) additionally need an admin. Cross-site browser requests (and cross-origin WebSocket upgrades) are refused;
non-browser clients are unaffected. Variables and the browser-session hardening: see
[ACCESS.md](docs/ACCESS.md#3-worker-variables).

## Development

Scripts (`typecheck`, `lint`, `test`, `smoke`, …), module layout and conventions are in
[DEVELOPMENT.md](docs/DEVELOPMENT.md).
