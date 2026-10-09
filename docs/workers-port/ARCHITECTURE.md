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
- Tests: `vitest` + `@effect/vitest`; Worker/Durable Object integration tests with `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`).
  Translators and the thinking pipeline are verified against golden fixtures produced by `workers/tools/fixturegen`
  from the Go implementation (`go run ./workers/tools/fixturegen`), checked in under `workers/test/fixtures/`.
- Never log tokens, API keys or JWTs.

## JSON values, config and payload rules

- **Path engine (`src/json/`)**: gjson/sjson semantics over parsed `JSON.parse` values instead of raw bytes, verified
  against the real tidwall libraries through golden fixtures (`go run ./workers/tools/fixturegen/jsonpath`). `get`
  returns `undefined` for "does not exist" (`null` exists); `set`, `setRaw` and `del` mutate containers in place and
  return the root; values are inserted by reference (clone shared values). Known differences from Go: integer-like
  object keys are enumerated first by the JS engine, numbers are doubles (raw text such as `1.0` is not preserved),
  and sets/deletes on complex paths (`#`, `|`, `@`, `*`, `?`) throw `JsonPathError` (sjson silently rewrites matches;
  nothing in the Go code relies on it, payload rules expand `#(...)` queries into index paths first). Reads support
  `#`, `#.key`, `#(q)`, `#(q)#`, wildcards, pipes and the modifiers `@this @reverse @keys @values @flatten`.
- **Config (`src/config/`)**: the canonical document is the v8 layout restricted to keys that apply on Workers
  (`schema.ts`, kebab-case keys as in YAML). `codec.ts` imports YAML/JSON (v8, legacy flat layout and historical v8
  spellings, see `document.ts`), validates, normalises (`normalize.ts`, port of the Go `Sanitize*` functions) and
  exports YAML (defaults omitted). Added keys without a Go counterpart: `access.admin-emails` and
  `access.admin-service-tokens` (management allow-list, see Authentication). `requests.proxy-url` is accepted but
  ignored. Unknown/inapplicable keys are dropped on import.
- **Storage**: the `ControlPlane` DO (`src/credentials/control-plane.ts`) stores the canonical JSON in a SQLite table
  with a monotonically increasing version. RPC: `getConfig(sinceVersion?)` (returns `unchanged: true` when the caller
  is current) and `putConfig(yamlOrJson, expectedVersion?)` (validates; returns a structured result with `invalid` /
  `conflict` instead of throwing). The Worker reads through `ConfigReader` (`src/config/reader.ts`): per-isolate
  snapshot, 5 s TTL then a version check, stale-if-error.
- **Payload rules (`src/config/payload/`)**: `applyPayloadRules(config, request, payload)` is the single final barrier;
  it mutates `payload` in place (callers pass a freshly built body and a distinct `original`). The Codex tool-schema
  integer normalisation that Go performs inside the same function belongs to the Codex executor slice.

## Thinking pipeline (`src/thinking/`)

Port of `internal/thinking`, keeping the "canonical `ThinkingConfig` → central validation → provider applier" shape.

- Entry point: `applyThinking(body, options)` collapses the five Go entry points (`ApplyThinking`,
  `…WithSummary`, `…WithSourceAndSummary`, `…WithModelInfo[AndSummary]`) via options: `sourceBody`, `summaryConfig`,
  `normalizedUpdatesChanged`, and `modelInfo` (resolved exact model; `null` = resolved but unknown) or
  `lookupModelInfo` (the registry lookup, `(modelId, providerKey) => info`). It returns `{ body, error? }`
  (`ThinkingError`, HTTP 400) and never throws.
- Bodies are parsed JSON mutated in place (`undefined` = Go's empty/invalid body). A `sourceBody` aliasing `body` is
  cloned first. Debug logging and plugin appliers are not ported. Applier errors (Kimi sjson failures) cannot occur
  on parsed JSON and are dropped.
- Model capabilities come from a minimal structural `ThinkingModelInfo`/`ModelThinkingSupport` (camelCase of
  `registry.ModelInfo`); the model registry slice supplies richer records and the lookup.
- Summary helpers (`extractSummaryConfig`, `applySummaryConfigForProvider`, `applyTranslatedSummaryToClaude`, …) are
  exported for the translator registry (Go calls them from `TranslateRequestEnvelope`).
- Fixtures: `go run ./workers/tools/fixturegen/thinking` → `test/fixtures/thinking.json` (~2.7 MB; includes the Go
  static model catalog used by the lookup). Known Go quirk not mirrored: gjson reads *unparsable* source JSON
  leniently in `extractCodexConfig`; the Workers port only handles parsed bodies.

## Credentials and selection (ControlPlane)

- **Sources** (`src/credentials/`): auth JSON files imported through `importAuthFile`/`upsertCredential` (stored verbatim in
  the DO's SQLite `credentials` table, the file *is* the metadata) and API keys synthesised from `api-keys` config with
  the Go content-hash ids (`synthesize.ts`, verified against the Go synthesizer via `tools/fixturegen/credentials`).
  `derive.ts` turns a stored file into the immutable `Credential` (priority, weight, prefix, headers, exclusions,
  aliases, plan/domain attributes); global exclusions and aliases are applied at selection time, so config edits take
  effect immediately. Config credentials are never stored; their runtime state is pruned when their id disappears.
- **Selection** (`selection/`, pure and deterministic, clock injected): candidate set -> availability (`availability.ts`,
  incl. "never an expired OAuth token") -> highest priority tier -> strategy (`strategies.ts`: round-robin, smooth
  weighted round-robin, fill-first) -> optional session affinity (`affinity.ts`, TTL cache keyed
  `callerScope::providers::session::model`). Model prefixes, `force-model-prefix`, exclusions, OAuth/API-key aliases,
  `force-mapping` and alias pools are resolved per credential in `routing.ts`. The caller still resolves the provider set
  (`PickRequest.providers`) from the model registry; the DO enforces the per-credential rules.
- **RPC**: `pick(request)` returns `{ ok: true, credential, route, lease }` (credential snapshot including token
  metadata, resolved base URL/headers, and the requested -> upstream model mapping) or `{ ok: false, failure }`
  (`model_cooldown` 429 + body, `auth_unavailable` 503, `auth_not_found`, `provider_not_found`). `report(lease, result)`
  records counters/last error and affinity effects; the cooldown state machine is added on top of it by the
  retry/cooldown slice (`CredentialState` already has the Go fields and `availability.ts` already reads them).
  Management methods: `listCredentials` (redacted), `upsertCredential` (re-login merge, credentials.md §11),
  `importAuthFile`, `removeCredential`, `setCredentialDisabled`.
- Deviations from Go: several providers are selected from one ID-sorted union (no per-provider slot cursor); alias groups
  of the session cache are independent keys; the LCP conversation matcher and session-id extraction are left to the
  pipeline slice (`PickRequest.session` carries the extracted id).

## Request pipeline

Core contracts every provider slice implements (Go references in each module header):

- **Translators (`src/translator/`)**: `TranslatorRegistry` keyed by `(client format, provider format)` with named
  `client`/`provider` arguments (Go's inverted `TranslateStream(from=provider, to=client)` order does not leak).
  Request transforms are pure functions over a private copy of the parsed body (refusals throw `TranslationError`,
  a request-scoped 400); response transforms take raw text (one upstream SSE line, or the whole body) and return
  complete client chunks as text (bare JSON for OpenAI/Gemini, `event:`/`data:` framed for Claude/Responses/
  Interactions). Per-attempt state is `TranslationState` (Go `param *any`), incl. `toolInputError` and
  `canFinalize`. Go fallbacks are kept (force `model`; passthrough stream/non-stream; raw usage for token counts).
  The thinking summary hooks are injected (`SummaryHooks`). Pairs are registered in `translator/builtin.ts`;
  golden fixtures come from `go run ./workers/tools/fixturegen/translator` (corpus files under
  `workers/tools/fixturegen/translator/corpus/`, one fixture file per corpus file, picked up automatically by
  `test/translator-fixtures.test.ts`; cases may declare `needs` to be skipped until a capability lands).
- **Executors (`src/executor/`)**: `ProviderExecutor { execute, executeStream, countTokens }` over
  `ExecutorRequest`/`ExecutorOptions` (Go `Request`/`Options`, typed `ExecutionMetadata`) and an `ExecutionContext`
  (credential snapshot, config snapshot, `UsageReporter`). Streams are `Stream<string, ExecutionError>` of client
  chunks. All failures are `ExecutionError` (status, upstream body as message, `retryAfterMs`, `credentialScoped`,
  `requestScoped`, `terminalAuth`, `direct`, `code`). Order inside executors: translate -> `Thinking.apply` (no-op
  service until the thinking slice) -> provider shaping -> `applyPayloadRules` (last) -> `HttpClient` (tracing
  propagation disabled so no `traceparent` reaches providers). Shared helpers live in `executor/helps/`.
- **Credential selection**: `CredentialPicker { pick, report }` (`executor/picker.ts`, contract documented there);
  `static-picker.ts` is a config-only stand-in (round-robin over `api-keys.openai-compatibility`) until the
  ControlPlane implementation lands. Per-credential model resolution (prefix strip, alias pools, suffix kept) is a
  pure Worker-side function (`executor/models.ts`), so the picker only returns snapshots + leases.
- **Handlers (`src/handlers/`)**: `execute.ts` runs resolve (`ModelProviders` service: config-backed until the
  registry slice) -> pick -> executor -> report -> usage (one record per attempt via `UsageSink`, published when the
  stream ends). `respond.ts` peeks the first stream chunk inside the request scope (the web handler keeps the scope
  open for streamed bodies) so pre-stream failures become real HTTP errors, then frames with a per-protocol
  `StreamFramer` (`framing.ts`), with optional keep-alives. Error bodies per protocol are in `http/errors.ts`.
  Route layers close over the services (`handlers/layer.ts`, `makeProxyRoutes` for tests) and are Access-gated.
- One attempt per request for now; retries across credentials, cooldown waits and bootstrap retries are added by
  the execution-retry slice around `runAttempt` in `handlers/execute.ts`.

## Model registry and `/models` endpoints (`src/registry/`)

Port of `internal/registry` plus the model registration in `sdk/cliproxy/service_models.go`. The Go registry is a mutable
process-wide singleton that the service keeps in sync with credentials; on Workers it is a pure function of three inputs,
evaluated per isolate and cached for 5 s (`ModelRegistry.snapshot`, `RegistrySnapshot`):

- **Credentials**: `ControlPlane.listModelSources()` returns a `ModelSource` per credential (provider, executor key, prefix,
  plan tier, exclusions, per-account aliases, the `models:` of config entries, credential/model runtime state; no secrets).
- **Config**: `ConfigReader` (global `oauth.model-alias`, `oauth.settings`, `routing.force-model-prefix`,
  `upstream.claude.disable-cloaking-model-list`).
- **Catalogs**: `models.json`, `codex_client_models.json`, `devin_models.json`. Embedded copies live in
  `src/registry/catalog/` (checked in; `pnpm catalog:sync` = `go run ./workers/tools/fixturegen/registry` re-copies them
  from `internal/registry/models/` and regenerates `builtins.json`, the hard-coded Codex/xAI/Devin definitions that Go
  upserts into every catalog). The cron job (`src/scheduled.ts`, every 3 h like `ModelsRefreshInterval`) fetches the
  official URLs (or the single `models.<x>` URL), validates them like Go (`validateModelsCatalog`,
  `ValidateCodexClientModelsJSON`, `ValidateDevinModelsJSON`; 8 MiB limit), keeps the previous `meta` section when the new
  catalog has none, and stores the text in KV `CACHE` (`registry/*.json`). Invalid/unreachable sources keep the last valid
  catalog; a KV entry that fails validation falls back per catalog to the embedded copy. Isolates re-read KV every minute.
- **Assembly** (`credential-models.ts`): `registerModelsForAuth` per credential: base list (provider catalog, Codex plan
  tier, config `models:`), exclusions, OAuth aliases (`fork`, display names, per-credential first), `oauth.settings`
  context length, prefixes (`force-model-prefix`). OpenAI-compatibility models keep duplicate aliases (model pools) and skip
  exclusions/aliases like Go.
- **Index** (`registry.ts`): provider counts, per-provider records ("last registered wins", credentials registered in id
  order), the 5 min quota window and suspension rules of `modelRegistrationAvailability`, `GetModelProviders`,
  `GetModelInfo`, `LookupModelInfo` (registry, then static catalogs), `GetFirstAvailableModel`, native web-search capability.
  Records are camelCase `ModelInfo`s that satisfy `ThinkingModelInfo`; `snapshot.lookupModelInfo` is the `ModelInfoLookup`
  for `applyThinking`, `snapshot.providersForModel` is `util.GetProviderName` (the pipeline's `ModelProviders`).
- **Listings** (`listings.ts`, `models-api.ts`, `routes.ts`): `GET /v1/models[/{id}]` dispatches Grok shell UA -> `client_version`
  query -> Anthropic (`Anthropic-Version` or `claude-cli` UA, with ID cloaking `claude-fable-5-dd-<reversed id>`) -> OpenAI;
  detail routes pick the entry whose `id` equals the path remainder (ids may contain `/`). `GET /v1beta/models[/{model}]` is
  the Gemini shape. Bodies are serialised like Go's `encoding/json` (sorted keys, `\u003c` escapes) so they are byte-identical
  to the Go server's; lists are sorted by model id (Go's order is map iteration order).
- Fixtures: `go run ./workers/tools/fixturegen/registry` drives the real Go handlers (`OpenAIModels`, `ClaudeModels`,
  `GeminiModels`, `GeminiGetHandler`, `WriteModelListResponse` detail mode) against a real `registry.ModelRegistry` and records
  bodies and registry queries (`test/fixtures/registry.json`).

Deviations from Go: models are registered under the credential's **executor key** (`kimi.com` -> `kimi`), which is what
`PickRequest.providers` is matched against; the quota window starts at the model state's observation time; Go's
`GetFirstAvailableModel` sorts with an inconsistent comparator for models without `created`, the port is deterministic
(newest, then id); credential/catalog edits show up within the 5 s snapshot TTL (1 min for KV catalogs). Not ported: plugin
models, the Antigravity per-account `fetchAvailableModels` list (static catalog is used until the Antigravity slice), and the
Codex client catalog (`GET /v1/models?client_version=...`, `internal/client/codex/models`), which answers 501 until the Codex
slice implements `ModelsOptions.codexClient` (the validated catalog is already refreshed into KV and exposed as
`ModelCatalogs.codexClient`).

## Authentication (Cloudflare Access)

- Access application on the Worker's custom domain; `workers_dev = false` and preview URLs disabled so Access cannot
  be bypassed.
- The Worker verifies `Cf-Access-Jwt-Assertion` (RS256, JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  `iss` = team domain, `aud` contains the application AUD tag, `exp`/`nbf`). JWKS is cached per isolate.
- Principal: `email` for users, `common_name` (service token client id) for service tokens. The principal replaces the
  Go `userApiKey` for usage records and the `caller_scope` hash used to isolate session state.
- Management routes require the principal to match a configured admin allow-list (emails / service token ids), in
  addition to Access policy.
- Implementation notes (`workers/src/access/`): the gate is a *global* router middleware that matches protected path
  prefixes (default-deny for `/v1*`, `/openai/v1*`, `/backend-api/codex*`, `/v8/management*`, normalising case, duplicate
  slashes and percent-encoding) and provides `AccessPrincipal`; route layers that read it use `withAccess(...)` for typing.
  JWKS keys are cached per isolate and refreshed on unknown `kid` at most once per 30 s (no cross-request locks, which
  workerd forbids). `ACCESS_DEV_BYPASS` only applies when the request host is loopback (i.e. `wrangler dev`).
- Machine clients use Access service tokens (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, or Access
  single-header mode via `x-api-key`).

## Provider OAuth logins

Provider client IDs require `localhost` redirect URIs, so authorization-code logins use a "paste the redirect URL"
flow in management (`POST /v8/management/oauth/callback`). Device-code flows (Codex device, xAI, Kimi, Meta) work
natively. Credential JSON files from the Go server can be imported through management.
