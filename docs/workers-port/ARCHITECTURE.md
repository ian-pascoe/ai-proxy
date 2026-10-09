# Cloudflare Workers port — architecture

This document records the binding decisions for the TypeScript/Effect rewrite of CLIProxyAPI that runs on plain
Cloudflare Workers behind Cloudflare Zero Trust Access. Behavioural references for the Go implementation live in
`docs/workers-port/research/*.md`; the Go code under the repository root remains the source of truth for behaviour.

## Goals and non-goals

Goals:
- Serve the OpenAI (chat/completions, completions, Responses), Claude (messages, count_tokens), Gemini (`/v1beta`) and
  Interactions APIs from a Worker, backed by the same provider credentials (OAuth and API key) as the Go server.
- Faithful port of model resolution, credential selection/cooldowns/refresh, translators, the thinking pipeline and
  user payload rules.
- Cloudflare Access is the only client authentication mechanism (optional legacy API keys for migration).

Non-goals (not ported): plugins (`internal/pluginhost`), CLIProxyAPIHome mode, TUI, mDNS discovery, pprof, git/Postgres/
object stores, request-log files, per-credential outbound proxies (`proxy-url`), uTLS TLS fingerprinting, Codex live /
realtime (WebRTC/SIP), the AI Studio `wsrelay` gateway, and deprecated `/v0/management` routes.

## Layout

```
workers/                      pnpm package, deployed with wrangler
  wrangler.jsonc
  src/
    index.ts                  Worker entry: fetch, scheduled, DO class exports
    platform/                 Cloudflare bindings as Effect services (Env, ExecutionContext, KV, D1, DO stubs)
    http/                     router, CORS, error formatting per protocol, SSE framing, streaming helpers
    access/                   Cloudflare Access JWT verification, principals
    config/                   config schema (Effect Schema), storage, payload rules
    json/                     gjson/sjson-compatible path engine and JSON helpers
    registry/                 model catalogs, model info, /models listings
    credentials/              credential model, selection, cooldowns, refresh, ControlPlane Durable Object
    thinking/                 canonical thinking pipeline (port of internal/thinking)
    translator/               registry + one directory per (client -> provider) pair
    executor/                 executor interface + one directory per provider
    handlers/                 inbound protocol handlers (openai, responses, claude, gemini, interactions, ...)
    management/               /v8/management API + OAuth login flows
    usage/                    usage records, D1 persistence
  test/                       vitest suites (+ fixtures generated from the Go code)
  tools/fixturegen/           Go program that emits golden fixtures from the Go translators/thinking code
```

## Runtime topology

- **Worker** (stateless): routing, Access verification, request handling, translation, upstream `fetch`, streaming.
- **`ControlPlane` Durable Object** (singleton, `getByName("global")`, SQLite storage): config document, credentials,
  selection cursors, cooldown/quota state, session affinity, OAuth login sessions, refresh scheduling via alarms.
  It is the single writer for credential state, which replaces the Go `singleflight`/mutex/goroutine machinery. The
  Worker talks to it through JS RPC methods (e.g. `pick`, `report`, `getConfig`).
- **`SessionState` Durable Object** (one per `caller_scope + session key`): reasoning/thinking replay caches that need
  compare-and-swap semantics, and per-socket state for the Responses WebSocket API.
- **KV `CACHE`**: model catalogs refreshed by cron, best-effort caches (signature cache) with `expirationTtl`.
- **D1 `USAGE`**: usage records written with `ctx.waitUntil`.
- **Static assets**: management control panel.
- **Cron trigger**: model catalog refresh (3 h in Go) and a safety sweep that re-arms credential refresh alarms.

Request flow:
```
client -> Cloudflare Access -> Worker
  verify Cf-Access-Jwt-Assertion -> principal (email | service token common_name)
  handler parses body (entry protocol) -> resolve model/providers (registry + config, suffixes, aliases)
  loop (retry rounds): ControlPlane.pick(...) -> credential snapshot + lease
      executor: translate request -> thinking -> provider shaping -> payload rules (final) -> fetch upstream
      translate response (stream: one SSE line at a time with per-request state)
      ControlPlane.report(lease, result) -> cooldown/quota bookkeeping
  frame response for the entry protocol (SSE / JSON / WebSocket); usage record via waitUntil
```

## Engineering conventions

- TypeScript strict mode, ESM, `effect@4` (HTTP via `effect/http` `HttpRouter.toWebHandler`; per-request Cloudflare
  `env`/`ctx` are provided as services through the handler's per-request `Context`).
- Use Effect at boundaries and for orchestration: services (`Context.Service`) + `Layer`s, `Schema` for config,
  credentials and external payloads, tagged errors, `Stream` for upstream/downstream streaming, `HttpClient`
  (`FetchHttpClient`) for upstream calls so tests can swap the transport.
- Translators, thinking appliers, and payload rules are pure synchronous functions over parsed JSON values
  (`JSON.parse` output). Preserve key order; do not reorder fields when not required. Keep the Go structure
  (one module per Go file group) so future upstream changes can be ported mechanically; cite the Go source path at the
  top of each ported module.
- Payload rules remain the final semantic mutation before the upstream request in every executor path (see AGENTS.md).
- No wall-clock sleeps in tests; use Effect `TestClock`.
- Tests: `vitest` + `@effect/vitest`; Worker/Durable Object integration tests with `@cloudflare/vitest-pool-workers`.
  Translators and the thinking pipeline are verified against golden fixtures produced by `workers/tools/fixturegen`
  from the Go implementation (`go run ./workers/tools/fixturegen`), checked in under `workers/test/fixtures/`.
- Never log tokens, API keys or JWTs.

## Authentication (Cloudflare Access)

- Access application on the Worker's custom domain; `workers_dev = false` and preview URLs disabled so Access cannot
  be bypassed.
- The Worker verifies `Cf-Access-Jwt-Assertion` (RS256, JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  `iss` = team domain, `aud` contains the application AUD tag, `exp`/`nbf`). JWKS is cached per isolate.
- Principal: `email` for users, `common_name` (service token client id) for service tokens. The principal replaces the
  Go `userApiKey` for usage records and the `caller_scope` hash used to isolate session state.
- Management routes require the principal to match a configured admin allow-list (emails / service token ids), in
  addition to Access policy.
- Machine clients use Access service tokens (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, or Access
  single-header mode via `x-api-key`).

## Provider OAuth logins

Provider client IDs require `localhost` redirect URIs, so authorization-code logins use a "paste the redirect URL"
flow in management (`POST /v8/management/oauth/callback`). Device-code flows (Codex device, xAI, Kimi, Meta) work
natively. Credential JSON files from the Go server can be imported through management.
