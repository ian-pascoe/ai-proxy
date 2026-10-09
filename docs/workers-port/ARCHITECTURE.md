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
  integer normalisation that Go performs inside the same function lives in `executor/helps/payload.ts` (`finalizePayload`: normalise
  for Codex clients targeting non-Codex executors, then `applyPayloadRules`); executors call `finalizePayload`.
- **Config normalisation** follows the Go `Sanitize*` functions on the _flattened_ list: gemini/interactions keys are
  deduplicated across all groups of a family (key, base URL, proxy, prefix, order-independent headers; entry values override
  the group's), vertex keys by `api-key|base-url` (keys without api-key and models without name or alias are dropped), and
  credential-less entries (a gemini entry with only a base URL) are accepted.

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
  static model catalog used by the lookup). Known Go quirk not mirrored: gjson reads _unparsable_ source JSON
  leniently in `extractCodexConfig`; the Workers port only handles parsed bodies.

## Credentials and selection (ControlPlane)

- **Sources** (`src/credentials/`): auth JSON files imported through `importAuthFile`/`upsertCredential` (stored verbatim in
  the DO's SQLite `credentials` table, the file _is_ the metadata) and API keys synthesised from `api-keys` config with
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
  runs the cooldown/quota state machine (below); `planRetry(query)` answers whether another retry round is worth starting
  and how long to wait.
  Management methods: `listCredentials` (redacted), `upsertCredential` (re-login merge, credentials.md §11),
  `importAuthFile`, `removeCredential`, `setCredentialDisabled`.
- **Results, cooldowns and quota** (`credentials/cooldown/`, port of `conductor_cooldown.go` `MarkResult`): `markResult`
  is a pure function over `CredentialState` with an injected clock. Per-(credential, model) cooldowns: 401/402/403 30 min,
  404 and model-support errors 12 h (or `Retry-After`), 429 `Retry-After` (>= 10 s) or the 1 s·2^n ladder (once per open
  window), 408/5xx 60 s (`transient-error-cooldown-seconds`), Cloudflare challenge ladder, invalid_grant 30 min;
  credential-scoped 429s (`ReportResult.credentialScoped`: Anthropic 5h/7d windows, Codex `usage_limit_reached`) block the
  whole credential (`credential_quota`); cooldowns only ever extend; request-scoped, connection-lifecycle and
  transient-transport failures never cool (`classify.ts`, shared with the Worker). `disable-cooling` precedence: credential
  metadata, then `routing.cooldown.disable-cooling`. Also kept per credential: counters, a 20x10 min recent-requests ring
  and the passive quota header snapshot (claude/codex/devin). Alias pools report each attempt under its upstream model
  (`ReportResult.model`, `route.pooled`) and `pick` drops cooling upstream models (a credential without any usable one is
  skipped). Persistence: counters and the last error always survive restarts; cooldown fields only with
  `routing.cooldown.save-cooldown-status` (or for a terminal 401), as plain `credential_state` rows instead of the Go `.cds`
  files.
- **Retry planning** (`selection/retry.ts`, `retryAllowed` + `closestCooldownWait`): per-credential `request_retry`,
  `max-retry-interval`, the 10 s floor for an already-attempted 429 credential. `PickRequest.retryRound`/`requestRetry`
  make credentials with an exhausted budget age out of later rounds. Alias pools count as available when any upstream model
  is (Go only discovers a cooling pool when it filters the execution models). When the wait exceeds the limit the plan
  carries the recovery time so the Worker can answer with `Retry-After`.
- Deviations from Go: several providers are selected from one ID-sorted union (no per-provider slot cursor); alias groups
  of the session cache are independent keys; the LCP conversation matcher is not ported (`PickRequest.session` carries the
  id extracted by `handlers/session.ts`).

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
  `requestScoped`, `terminalAuth`, `direct`, `code`). Order inside executors: translate -> `Thinking.apply` -> provider shaping -> `applyPayloadRules` (last) -> `HttpClient` (tracing
  propagation disabled so no `traceparent` reaches providers). Shared helpers live in `executor/helps/`.
- **Credential selection**: `CredentialPicker { pick, report, planRetry }` (`executor/picker.ts`, contract documented
  there). The default implementation (`control-plane-picker.ts`) is a thin adapter over the ControlPlane RPC; it maps the
  DO snapshot to the executor view (`kind`, `header:<Name>` attributes, `base_url`) and turns pick failures into
  `ExecutionError`s (`model_cooldown` keeps its JSON body and `Retry-After`). `static-picker.ts` is a config-only stand-in
  for tests (`makePipeline` uses it; `test/support/pool.ts` runs the real `CredentialPool` in-process with an injected
  clock). The route returned by `pick` (`PickedRoute`: upstream model pool, `originalAlias`, `forceMapping`, `pooled`) is
  computed in the DO; `executor/models.ts` is only used by the static picker.
- **Handlers (`src/handlers/`)**: `execute.ts` runs resolve (`ModelProviders` service: config-backed until the
  registry slice) -> pick -> executor -> report -> usage (one record per attempt via `UsageSink`, published when the
  stream ends). `respond.ts` peeks the first stream chunk inside the request scope (the web handler keeps the scope
  open for streamed bodies) so pre-stream failures become real HTTP errors, then frames with a per-protocol
  `StreamFramer` (`framing.ts`), with optional keep-alives. Error bodies per protocol are in `http/errors.ts`.
  Route layers close over the services (`handlers/layer.ts`, `makeProxyRoutes` for tests) and are Access-gated.
- **Conductor** (`handlers/conductor.ts`, port of `conductor_execution.go`/`conductor_stream.go`): `conduct(prepared, run)`
  runs retry rounds. A round picks credentials one after another (`excludedIds` grows, no sleeping) until one succeeds, a
  stop condition hits (request-scoped rule `stop*`, request faults 400/409/413/422 and the listed body codes,
  `responses/compact` faults) or nothing is selectable; the final error is the last one that reached an upstream. Between
  rounds the Worker asks `planRetry` (only for 403/408/429/500/502/503/504 and transient transport errors) and sleeps
  `wait + jitter` (Effect clock, so tests use `TestClock`). `max-retry-credentials` caps a round, per-credential
  `request-retry` ages credentials out of later rounds, request-scoped rules (`continue`, `continue-and-cooldown`, `stop`,
  `stop-and-cooldown`) come from credential metadata or `oauth.request-scoped-errors`. Every attempt is reported exactly
  once (`Attempt.finish`: picker report + one usage record), including client aborts (`connection_lifecycle`, no cooldown).
  Workers limits (deviation): at most 16 upstream attempts per request and cooldown waits capped at 30 s; a longer recovery
  returns the last error (429/503) with `Retry-After`.
  Streams are only "successful" after the first payload chunk (bootstrap read inside the request scope); earlier errors, an
  immediate close (`empty_stream`) or an HTTP error fail over; later errors reach the client and are reported when the
  stream ends. `requests.streaming.bootstrap-retries` repeats the whole execution for bootstrap failures. Force-mapped
  aliases rewrite the `model` fields of responses and chunks (`handlers/model-rewrite.ts`).
  Credential preparation and the 401 loop wrap every attempt (`executor/helps/credential-refresh.ts`, port of
  `prepareRequestAuth` + `tryRefreshAfterUnauthorized`): `ensureFresh` first when the snapshot cannot be used as is (Vertex
  without a minted token, Meta without a key, OAuth token missing/expired, Antigravity within 5 min), and after a 401
  `refreshNow(id, rejectedToken)` plus one repeat with the new token (a rejected attempt keeps its own failed usage record;
  results are reported against the refreshed `credentialVersion`; a token that did not change is not repeated, a terminal
  refresh failure marks the 401 `terminalAuth`). Executors with their own transport paths (WebSocket) can call
  `withCredentialRefresh(context, use)` directly; `CredentialRefresher.none` disables it for API-key-only tests.
- **Models and thinking**: `ModelProviders.registryLayer` resolves providers from the `ModelRegistry` snapshot
  (`providersForModel`, `firstAvailableModel`); `ModelProviders.configLayer` remains for tests without a registry.
  `Thinking.live` (`executor/thinking.ts`) wires `applyThinking`, the translated summary-intent rules of `helps/thinking.go`
  and the registry summary hooks; `Thinking.noop` stays for tests. The conductor resolves the capabilities of each attempt
  through `ModelCapabilities.registryLayer` (the credential's own registration first - prefix/alias/config `models` aware -
  then `snapshot.lookupModelInfo`) and hands them to the executor as `ExecutorRequest.modelInfo` plus
  `modelLookup = snapshot.lookupModelInfo`, which executors pass to `Thinking.apply`.
- **Sessions**: `handlers/session.ts` ports `session.ExtractSessionInfo` (headers, Claude `metadata.user_id`, body fields)
  and feeds `PickRequest.session` together with the Access `callerScope`. Not ported: the derived content-hash identity and
  the LCP conversation matcher, so requests without an explicit session marker are never bound.

## Codex provider and Responses API (`src/executor/codex/`, `src/translator/codex/`, `src/handlers/responses/`)

- **Translators** (`translator/codex/<pkg>/{request,response}.ts`, registered by `codex/register.ts`): faithful ports of
  `internal/translator/codex/*` for `openai`, `openai-response`, `claude`, `gemini` and `interactions` -> `codex`. Shared
  helpers are under `translator/common/` (SSE frame builders, `UserTurnDrops`, apply_patch bridge, Responses tool winners,
  Claude message helpers, GPT/Grok signature checks). `TranslationError` may carry the translated `body` (Go returns both
  for unsupported-part refusals). Golden fixtures: `corpus/codex-*.json`; **generate them with `TZ=UTC`** (Gemini timestamps
  use the process time zone in Go). The Interactions `interaction.completed` event embeds the current time, so it is
  covered by a fake-timer unit test instead of a fixture. Request `tool_use.input` text is re-serialised compactly (Go
  forwards the raw bytes), hence the corpus files are excluded from prettier.
- **Executor** (`executor/codex/executor.ts`): per attempt `translate -> Thinking.apply -> model/stream fields ->
instructions -> image_generation tool -> reasoning sanitising -> parallel_tool_calls -> tool schema normalisation ->
reasoning replay -> prompt cache key + Session-Id -> input id sanitising -> finalizePayload (last) -> headers (routing
hint reads the final body) -> fetch`. Streams are processed line by line (`stream.ts`); non-stream aggregates the SSE
  until the terminal event; compaction posts to `/responses/compact` as `openai-response`. Errors (`errors.ts`) follow
  `codex_executor_terminal.go`: usage-limit/capacity -> 429 (credential-scoped unless `model-level-cooling`), body
  rewrites (`context_too_large`, `thinking_signature_invalid`, `previous_response_not_found`, `auth_unavailable`),
  in-stream `error`/`response.failed` mapping, empty `response.incomplete` -> request-scoped 502, missing terminal ->
  request-scoped 408. 401 refresh/retry is done by the conductor (`withCredentialRefresh`), not by the executor.
- **Reasoning replay** (`replay.ts`): Claude-format callers get cached encrypted reasoning/tool calls re-inserted by
  anchor matching. The store is an interface; the default is a per-isolate in-memory store (TTL 1 h, bounds as in Go).
  TODO(SessionState): back it with the `SessionState` Durable Object for cross-isolate continuity.
- **Handlers**: `POST /v1/responses`, `/v1/responses/compact` and `/backend-api/codex/{responses,responses/compact}` share
  `responses/routes.ts`; the Responses frame assembler (`responses/framer.ts`) buffers partial frames, filters private
  `responsesapi.*`/`codex.*` events (Codex clients keep `codex.response.metadata`), rebuilds an empty
  `response.output`, normalises error payloads (redacting secrets) and ends with a bare newline. `/v1/images/{generations,
edits}` (`handlers/openai/images.ts`) serve the Codex `gpt-image-*` models (multipart edits become JSON in the handler;
  free-plan credentials are excluded through `ExecutionInput.disallowFreeAuth`). `/v1/alpha/search` and
  `/backend-api/codex/alpha/search` (`handlers/codex/alpha-search.ts`) forward the sanitised body to
  `.../alpha/search`, selecting only OAuth credentials or API keys with `alpha-search` (`executor/policy-picker.ts`).
- **Not ported (follow-ups)**: WebSocket transports (#18), bootstrap buffering, multi-agent-v2/orphan-delegation rewriting,
  `is-compat` models, local token counting (`countTokens` answers 501; needs a BPE tokenizer) and the Claude stream
  input-token estimate, models.json header overrides (hook `modelHeaderOverrides` exists), Claude/Gemini envelope probes of
  the Grok signature check, xAI/OpenAI-compatible image models, and the Responses-tool image path being reachable only for
  non-`gpt-image` models (ported but not routed).

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

## Token refresh (`src/credentials/refresh/`)

Port of `auto_refresh_loop.go` + `conductor_refresh.go` + the per-provider `Refresh` executors. The `RefreshManager`
(Cloudflare-free, unit tested with a fake host/alarm/clock) is owned by the `ControlPlane` DO, which is the only writer:

- **Scheduling** (`schedule.ts`): `nextRefreshCheckAt` is a pure function of (now, credential, state) with the Go leads
  (codex 24 h, claude 4 h, antigravity 30 min, xai/kimi/kimi-ai/kimi.ai 5 min; devin, meta, kimi.com, vertex never).
  One alarm is multiplexed over all credentials: `rearm()` takes the minimum over the stored credentials (no heap) and
  is called after every credential mutation, after each alarm run and by the cron `sweepRefresh()`. `alarm()` refreshes
  what is due (`oauth.auth-auto-refresh-workers`, default 16, concurrently) and always re-arms, never sooner than 30 s
  when a credential is still due (guards against spinning). A running refresh pushes that credential's next check 60 s.
- **Single writer / dedupe**: one in-flight refresh per credential; the alarm, concurrent 401 recoveries and management
  calls share its outcome. `refreshNow(id, rejectedAccessToken?)` first records the rejected token (only when the token
  has no expiry of its own, like Go), returns the current credential without an upstream call when the token was
  already replaced, and otherwise refreshes. `forceRefresh(id)` ignores the terminal-unauthorized gating.
- **Persistence** (`pool.commitRefresh`, synchronous SQLite): new metadata is merged three-way (`three-way.ts`, the
  `MergeRefreshedAuth` metadata rules; user edits made while the refresh ran win, token keys take the refreshed value)
  and written before any caller sees the token, then runtime state (`outcome.ts`: failure table of credentials.md §9.2,
  back-off 5 min / invalid_grant 1->30 min, terminal 401, 30 s ineffective-refresh guard, concurrent cooldowns kept).
  A refresh whose base tokens were replaced meanwhile (re-login) is discarded. `credentialVersion` bumps on rotation,
  so leases of the old tokens are ignored by `report`.
- **Protocols** (`claude|codex|antigravity|xai|kimi|meta.ts`): `(context) => Effect<updatedMetadata, RefreshError,
HttpClient>` over the injectable Effect `HttpClient` (`FetchHttpClient.layer` in production, a recording client in
  tests). Each HTTP call is bounded to 30 s, a whole refresh to 120 s. Claude retries only HTTP >= 500 and blocks the
  credential for `Retry-After` on 429; Codex retries three times except `refresh_token_reused`.
- **Request-time preparation** (`ensureFresh(id)`): returns a snapshot with a usable `metadata.access_token`: Meta mints
  the API key from the DCA token (persisted first), OAuth providers refresh when the token is missing/expired/rejected
  (Antigravity: within 5 min), **Vertex** mints a service-account token. `patchCredentialMetadata(id, patch)` persists
  preparation results (Antigravity `project_id`, Claude profile fields) without touching token material.
- **Vertex** (`vertex.ts`): no auth-file refresh. RS256 JWT-bearer grant with WebCrypto (PEM repaired like
  `keyutil.go`, PKCS#1 wrapped into PKCS#8, scope cloud-platform, 1 h lifetime). The token is cached in DO memory per
  credential (fingerprint = `credentialVersion:updatedAt`) until `exp - 60 s`, never persisted. Executors get it two ways:
  `pick` returns a snapshot whose `metadata.access_token`/`expired` are injected from the cache when still valid
  (`CredentialPool` `decorate` hook), and `ensureFresh` mints on a miss (concurrent callers share one mint). An executor
  therefore does: `if (!snapshot.metadata.access_token) snapshot = (await controlPlane.ensureFresh(id)).credential`.

Deviations from Go: credentials without a refresh token are never scheduled (Go loops every 30 s on an unchanged auth);
Codex keeps `email`/`plan_type` when the new `id_token` lacks them; a cached xAI `token_endpoint` must be an https x.ai
URL; Kimi/Claude device/uTLS headers are constants/subsets; `META_MINT_URL` and Devin's metadata refresh (protobuf quota
probe, never scheduled) are not ported; Antigravity project discovery / credits probe and Claude device-id/profile
preparation belong to their executor slices (use `patchCredentialMetadata`).

## Authentication (Cloudflare Access)

- Access application on the Worker's custom domain; `workers_dev = false` and preview URLs disabled so Access cannot
  be bypassed.
- The Worker verifies `Cf-Access-Jwt-Assertion` (RS256, JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  `iss` = team domain, `aud` contains the application AUD tag, `exp`/`nbf`). JWKS is cached per isolate.
- Principal: `email` for users, `common_name` (service token client id) for service tokens. The principal replaces the
  Go `userApiKey` for usage records and the `caller_scope` hash used to isolate session state.
- Management routes require the principal to match a configured admin allow-list (emails / service token ids), in
  addition to Access policy.
- Implementation notes (`workers/src/access/`): the gate is a _global_ router middleware that matches protected path
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
