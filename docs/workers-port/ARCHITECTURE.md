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

## Claude provider (`src/executor/claude/`, `src/translator/claude/`)

Ported from `internal/runtime/executor/claude_executor*.go`, `internal/translator/claude/*` and the helpers they use.

- **Credentials**: OAuth access tokens (`metadata.access_token`) and API keys (`api-keys.claude[]`, synthesised by
  `claude/config-credentials.ts`); base URL defaults to `https://api.anthropic.com`. OAuth credentials get the Claude
  Code treatment (cloaking); API-key credentials to first-party hosts keep caller-owned mode (caller betas verbatim,
  body `betas` appended). Custom `base-url` gateways skip upstream `count_tokens` and estimate locally.
- **Request order** (matches the Go executor and the payload-rules barrier): translate -> thinking -> sanitise ->
  cloaking (system relocation, billing block, identity, date reminder, user_id, context management) ->
  MCP tool aliasing -> cache-control policy -> payload rules -> CCH signing (`cch=` is `xxh64` over the normalised
  final body; only the five hex digits change) -> HTTP. Signing is the last step so it covers payload-rule output.
- **Responses**: Claude upstream always streams for non-stream clients; tool aliases are restored in non-stream bodies
  and stream lines; `ExecutionError` classification (`ratelimit.ts`) separates credential-scoped (unified-limit 429/401),
  request-scoped (Fast mode entitlement) and model-level failures for the picker.
- **Translators**: OpenAI chat, OpenAI Responses, Gemini and Interactions clients -> Claude, each with request and
  response (stream/non-stream/token-count) functions, golden-tested against Go through the translator corpus.
  `claude -> claude` has no translator (registry fallback forces `model`). Model capabilities (adaptive levels,
  max tokens) come from `translator/model-info.ts`, which the model registry slice populates.

Deviations from Go (all deliberate, documented in code headers):

- No uTLS/HTTP-2 fingerprinting (Workers limitation); `wire-policy` is parsed but not enforced.
- Device-profile stabilisation, Fable/Opus-5.5 context-management reconcilers, `rebuildMidSystem` and Kimi attribution
  are not ported; continuity and thinking-replay stores are in-memory per isolate (TODO: session Durable Object).
- `internal/signature` is replaced by structural checks (`executor/claude/sanitize.ts`: decodable `E…`/`R…`
  envelope); Gemini clients always receive Gemini's bypass `thoughtSignature` sentinel for Claude thinking blocks.
- OpenAI Responses -> Claude: the Codex `apply_patch` custom-tool bridge (`internal/client/codex/apply-patch`) is not
  ported; such tools behave like ordinary custom tools. Go's log-only invariant diagnostics are omitted.
- `responses/compact` for Claude returns 501 until the compaction capsule slice lands.

## Gemini, Vertex and Interactions (`src/executor/gemini/`, `src/translator/gemini/`, `src/handlers/gemini/`)

- **Providers**: one engine (`executor/gemini/google.ts`) parameterised by a `GoogleVariant` (`targets.ts`): `gemini`
  (API key, `x-goog-api-key`), `gemini-interactions` (same key, native `POST /v1beta/interactions` with the
  `Api-Revision` header) and `vertex` (API key against the project-less host, or a service account against the regional
  `projects/<id>/locations/<loc>` endpoint; Imagen models go through `:predict` with the request/response converters).
  Request shaping (`shaping.ts`: model/suffix handling, `maxOutputTokens` cap, content-turn splitting) and usage parsing
  (`usage.ts`: `usageMetadata`/Interactions usage, intermediate-usage filtering) follow the Go executors. Payload rules
  stay the last mutation of the body in every path (stream, count, Imagen, native Interactions).
- **Routes**: `POST /v1beta/models/*` (`generateContent`, `streamGenerateContent`, `countTokens`, Gemini SSE or raw
  chunks for other `alt`s) and `POST /v1beta/interactions` (exactly one of `model`/`agent`; agent requests are forced to
  the `gemini-interactions` provider and select credentials as for `gemini-2.5-flash`, the Go `auth_selection_model`).
  `ExecutionInput.forcedProvider`/`authSelectionModel` and `PickRequest.selectionModel` carry that through the conductor.
- **Vertex tokens**: service-account access tokens are minted by the ControlPlane (`ensureFresh`) before the attempt by
  the conductor's credential preparation (`needsPreparation` for `vertex` without `metadata.access_token`); the executor
  only reads `metadata.access_token` (401 `credentialScoped` when missing). API-key vs service-account is decided by the
  `api_key` attribute (a minted `access_token` next to a `service_account` is a bearer token, not an API key).
- **Translators** (all golden-fixture tested against Go, `tools/fixturegen/translator/corpus/*-gemini.json`,
  `gemini-interactions.json`, `interactions-*.json`): gemini->gemini, claude->gemini, openai->gemini,
  openai-response->gemini, interactions<->gemini, interactions->interactions (passthrough). Shared Gemini pieces live
  in `translator/gemini/{common,util}`: contents merging, thought-signature replay policy (Gemini target only; other
  providers' signatures are never replayable for Gemini, so only the Gemini decision table is ported), JSON-schema
  cleaners and the MIME table.
- **Responses (`translator/gemini/openai/responses/`)**: request/response ported file by file (carrier, trailing
  signature, tools, media, web search, streaming and non-streaming). Gemini returns whole function calls, so the
  apply_patch bridge is reduced to strict `{"input": ...}` validation (`finishApplyPatchArguments`) plus the event
  helpers it needs; a retained failure sets `state.toolInputError` (stream: `response.failed`, non-stream: translation
  failure -> 502). Hidden text signatures (a signature that trails the visible text) go to a `ReplayCache`
  (`replay-cache.ts`): per-isolate, 1 h TTL, 10240 entries, injected clock for tests. TODO(SessionState Durable
  Object): back it with the session state DO so carriers survive isolate recycling and span isolates; until then a
  continuation that lands elsewhere degrades to the bypass signature, never to an error.
- **Fixtures**: cases with generated ids/timestamps are tagged `needs: ["id-normalization"]` and run by
  `test/translator-fixtures-ids.test.ts` (ids and `created_at` masked on both sides; thinking-summary cases apply the
  real summary hooks); everything else must match the Go bytes exactly (`test/translator-fixtures.test.ts`).
- **Deviations from Go**: `TranslationError.body` returns the partially translated body for fixture parity only;
  `gjson.Raw` whitespace is not preserved (embedded raw JSON is compacted); model capability lookups
  (`ModelSupportsWebSearch`, `lookupModelInfo`) read the embedded static catalog, not the live registry; Go's
  `PrepareAntigravityInteractions` is not ported (no Antigravity provider yet); a Vertex Imagen request without a prompt
  answers 400; logging of signature decisions is dropped. Not ported: claude->interactions (not in the slice).

## OpenAI-compatible upstream for every client protocol (`src/translator/openai/`, `src/executor/openai-compat/`)

Port of `internal/translator/openai/{claude,gemini,openai,interactions}` plus the image paths of
`openai_compat_executor.go` and `openai_images_handlers.go`. `translator/openai/register.ts` registers (client -> provider):
claude/gemini/openai-response -> openai, interactions <-> openai (Chat Completions) and interactions <-> openai-response;
`handlers/openai/routes.ts` already converts Responses-shaped bodies sent to `/v1/chat/completions`.

- **Layout**: one directory per Go package; `openai/common/` holds the shared helpers (apply_patch bridge, Responses tool
  descriptors, tool-name fixing, signature checks, user-turn-drop policy, file data). Modules cite their Go source. The
  apply_patch identity state machine of `interactions/responses` is ported statement by statement (including the
  `ApplyPatchInputDecoder`), and every translator is covered by golden fixtures (`corpus/*-openai*.json`, `*-interactions.json`).
- **Images**: the executor serves `openai-image` entry requests (`executor/openai-compat/images.ts`): the JSON body is
  forwarded to `{base-url}/images/generations|edits` with model/stream normalised and payload rules applied last. The handler
  routes `gpt-image-*` to Codex and every model the registry types `openai-image` (config `models[].image: true`; test
  doubles of `ModelProviders` may implement the optional `modelType`) to the OpenAI-compatible executor, converting the
  non-stream answer to `response_format` (`buildImagesApiResponse`). The handler turns multipart edits into the JSON edit
  form, so the executor rebuilds `multipart/form-data` for the upstream (file names are not kept).
- **Deviations**: `isRecognizedReasoningSignature` only knows GPT/SWE/Gemini-bypass signatures (Claude/Gemini/Kimi/Grok
  envelope validation belongs to those provider slices); a patch-enabled Interactions stream that ends without its source
  terminator is reported as a gateway error instead of a synthesised `response.failed` (`FinalizeToolInput`); malformed
  Interactions event JSON is only approximated (longest valid object prefix) because gjson reads lazily; raw JSON texts that
  Go copies byte for byte (`gjson.Raw`) are re-serialised compactly.
- **No equivalent needed**: the Go OpenAI-compatible executor has no refresh and no reasoning replay cache (§7 of the pipeline
  research lists none for it); 401s are ordinary upstream errors for the conductor's classification.

## Management API and control panel (`src/management/`)

Port of `internal/api/handlers/management` for the `/v8/management` routes that apply on Workers; response shapes follow
the Go server so the official panel (`Cli-Proxy-API-Management-Center`, checked against v1.25.6) works unchanged. Auth is
the Access admin gate only (`access/routes.ts` classifies `/v8/management*` **and `/management.html`** as `management`);
the panel's "management key" is ignored (any text logs in).

- **Config** (`config-routes.ts`, `config-document.ts`): `GET|PUT|PATCH /config`, `GET|PUT /config.yaml`,
  `GET|PUT|PATCH|DELETE /config/*path`. `/config` serves the ControlPlane's canonical document (defaults included),
  `/config.yaml` the sparse YAML export. Writes are read-modify-write over the JSON document with `putConfig(text,
  expectedVersion)` (retried on a concurrent write, `409 conflict` after four attempts); the ControlPlane validates
  (`422 invalid_config`). Paths address mapping keys, DELETE prunes emptied parents, PATCH deep-merges. `auth_index` is
  injected into `api-keys` entries on read and stripped on write. The Go read-only Home revision paths and TURN secret
  handling do not exist in the Workers schema.
- **Credentials** (`credentials-routes.ts`, `credential-entry.ts`, `credentials/field-patch.ts`): list (filters,
  pagination), upload (multipart or raw JSON + `?name=`), delete (`name`/`names`/`all`), download (the stored file,
  tokens included), `models`, `status`, `fields`, `refresh`, `routing/cooldown/reset`. Credential id = file name; only
  auth files are listed (config API keys are not auth files; toggling them answers 409). `auth_index` =
  `sha256("id:" + id)[:16 hex]` (`auth-index.ts`, the Go fallback seed). The ControlPlane builds the redacted panel
  entries (`listCredentialEntries`) and owns the mutations (`patchCredentialFields`, `refreshCredential`,
  `refreshAllCredentials`, `resetCredentialCooldown`, `removeCredentials`, `getCredentialFile`).
- **Operational**: `requests/api-call` (`api-call.ts`; `$TOKEN$` resolved in the ControlPlane through `ensureFresh`;
  60 s bound like Go; no `proxy_url`/`Host` override on Workers), `server/latest-version`, `routing/model-definitions/:channel`
  (static catalogs of the model registry), file-log routes answering like Go with file logging disabled.
- **Not here**: `/oauth/*` (OAuth slice), plugins, Home, `/v0/management`. `/observability/usage/*` lives in
  `usage-routes.ts` (see "Usage accounting and observability").

- **Not here**: `/oauth/*` (see _Provider OAuth logins_), `/observability/usage/*` (usage slice), plugins, Home, `/v0/management`.
- **Panel asset**: `GET /management.html` serves `public/management.html` through the `ASSETS` binding
  (`run_worker_first`, so the Access gate runs first; `404` with an install hint when missing). `pnpm panel:sync`
  (`tools/panel-sync/`) downloads it from the GitHub release asset and verifies the `sha256` digest before replacing the
  file (no unverified fallback download, unlike Go); the file is git-ignored and must be synced before deploying.
- Deviations from Go: cooldown `reason`s are
  limited to the quota reason / last error code; `GET /credentials` always returns JSON timestamps as RFC 3339 strings.

## Usage accounting and observability (`src/usage/`, `src/observability/`, `src/management/usage-routes.ts`)

Port of `sdk/cliproxy/usage` (token accounting v2), `helps/usage_helpers.go` (parsers, `StreamUsageBuffer`, TTFT) and the
`internal/redisqueue` export shape. One `UsageRecord` per upstream attempt (`UsageReporter` per attempt, `finish` exactly
once; a 401 retry keeps the rejected attempt's failed record, a failed-over credential gets its own).

- **Accounting v2** (`accounting.ts`): `TokenBreakdown` (`input = uncached + cacheRead + cacheWrite`, `output =
  nonReasoning + reasoning`, `total = input + output + unclassified`, quality `complete|unclassified|inconsistent`).
  `ensureTokenBreakdown(detail, provider, executorType)` picks the semantics: **subset** (openai, codex, xai, grok, kimi,
  qwen, deepseek, openrouter, `openai-compatible-*`; cache inside input, reasoning inside output), **independent**
  (claude/anthropic; cache outside `input_tokens`, thinking inside `output_tokens`), **separate-reasoning** (gemini,
  aistudio, antigravity, vertex, interactions; `candidatesTokenCount` excludes thoughts), otherwise unclassified. Parsers
  attach the protocol's own breakdown (`record.ts` OpenAI/Responses/Codex, `parsers.ts` Claude, Gemini, Interactions,
  Antigravity + `mergeStreamUsageDetail`); `UsageReporter.finish` guarantees a valid breakdown on every record.
  Executors feed the reporter with `publish` (latest wins, tier-only updates keep the token detail, an earlier response
  tier survives) or `publishMerged` (Claude/Interactions events that complement each other). Go's int64 overflow checks
  become safe-integer checks. Executors must use these parsers: a hand-rolled `UsageDetail` without a breakdown is
  re-derived from the raw buckets, which is wrong for Claude (reasoning inside output).
- **TTFT** (`ttft.ts` + reporter): `markFirstByte` (non-stream: effective TTFT), `recordFirstPacket` /
  `observeTokenEvent(now, isToken)` (streams: first substantive token event, first packet as fallback). Codex streams use
  `isResponsesTokenEvent`; OpenAI-compatible and Claude executors still mark the first response byte (hook the matching
  `is*TokenEvent` into their stream loops to refine it).
- **Persistence** (`d1.ts`, `d1-sink.ts`, `migrations/0001_usage_records.sql`): table `usage_records` (primary key =
  attempt `request_id`, `trace_id` = inbound request id, raw token columns plus the `acct_*` breakdown columns,
  `exported_at` for the queue). `D1UsageSink` (default in `makeProxyRoutes`) inserts through `ctx.waitUntil` (awaits when
  `waitUntil` throws), logs failures with request id and message only and never fails the request. The sink reads
  `WorkerEnv`/`WorkerExecutionContext` from the fiber context at publish time (not part of its type, so the conductor's
  attempt plumbing is unchanged). Apply the schema with `wrangler d1 migrations apply cliproxy-usage`
  (`migrations_dir` in `wrangler.jsonc`). Failure bodies are truncated to 2 KiB.
- **Retention** (`retention.ts`, cron task `usage-retention`): deletes records older than `USAGE_RETENTION_DAYS` (default
  30, `0` = keep) in bounded batches. `usage-statistics-enabled` and `redis-usage-queue-retention-seconds` are not used:
  persistence is always on when the `USAGE` binding exists.
- **Management** (`management/usage-routes.ts`): `GET /v8/management/observability/usage/api-keys` (per provider,
  `base_url|api_key` -> success/failed/`recent_requests`, from the ControlPlane counters and recent-requests ring; keys
  use the masked API key), `.../queue?count=N` (atomically pops the oldest unexported records, Go queue JSON with
  `token_breakdown`; `api_key` = Access principal id, `auth_index` = the management `auth_index`) and the Workers
  additions `.../records` (filters `since|until|provider|model|principal|auth_id|failed`, `limit`, keyset `before`) and
  `.../summary` (`group_by=model|provider|principal|auth|endpoint|day`, totals per v2 bucket, avg latency/TTFT).
- **Trace and logs** (`observability/`): the global `TraceLayer` middleware gives each request a `RequestTrace` (Context
  reference, `undefined` outside the router) and sets `X-CPA-TRACE-ID` = `yyyyMMddHHmmss-<auth index>-<request id>`
  (UTC; refreshed on every credential selection, `auth_index` = management `auth_index`) or the bare request id when no
  credential was selected (Go omits the header then). `/healthz` is exempt. One structured log line per request
  (`method`, pathname without query, `status`, `latencyMs`, `principal`, `provider`, `model`, `authIndex`, `attempts`,
  `requestId`) through Effect logging; `WorkersLoggerLayer` (`Logger.consoleStructured`) makes Workers Logs index the
  annotations. Headers, bodies, query strings and credentials are never logged.

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

## Provider OAuth logins (`src/oauth/`, `src/management/oauth-routes.ts`)

Port of the management OAuth handlers (`auth_files_provider_oauth.go`, `auth_files_devin_oauth.go`, `oauth_callback.go`,
`oauth_sessions.go`) and `internal/auth/*`. The panel's OAuth page works unchanged: `GET /v8/management/oauth/auth-url?provider=`
(`claude`, `codex`, `antigravity`, `devin`, `xai`, `meta`, `kimi`, `kimi-ai`; `is_webui` ignored) returns `{status,url,state}`
(+ `flow:"device"`, `user_code`, `expires_in` for device logins), `GET /oauth/status?state=` answers `ok|wait|error`,
`DELETE /oauth/session?state=` cancels and `POST|GET /oauth/callback` takes `{provider, redirect_url | state+code}`.

- **Sessions** (`session-store.ts`): a SQLite table in the `ControlPlane` DO with the Go rules (TTL 30 min, completed kept 1 min,
  `SetError` refreshes the TTL, cancel only for pending sessions). Flow secrets (PKCE verifier, device code) stay in the row and are
  wiped when the session ends; replies never contain them. A busy lease (2 min, released in `ensuring`) lets one exchange/poll run
  per session, and the credential is saved only while the session is still pending (a cancel racing the exchange wins).
- **Authorization-code logins** (Claude, Codex, Antigravity, Devin): provider client IDs only allow `localhost`/`127.0.0.1`
  redirect URIs, so the user pastes the redirected URL (`POST /oauth/callback`). The request performs the token exchange itself
  (no waiter goroutine/file hand-off); like Go it answers `{"status":"ok"}` once the callback is accepted and failures show up in
  `/oauth/status` (messages are Go's: `State code error` cannot occur because the state *is* the session key; `Bad request`,
  `Failed to exchange authorization code for tokens[: cause]`, `Timeout waiting for OAuth callback`, ...). The callback window is
  5 minutes. PKCE (S256, 96 bytes; Devin 64) and states use WebCrypto; authorization URLs use Go's `url.Values.Encode` ordering.
- **Device logins** (Codex `?provider=codex&flow=device`, xAI, Meta, Kimi/Kimi.ai): `auth-url` requests the device code, the panel
  polls `/oauth/status` and each poll performs the upstream poll when `nextPollAt` has passed (xAI immediately, others after one
  interval; `slow_down` +5 s except Kimi), so providers are never polled faster than their interval. Windows: xAI 30 min, Meta/
  Kimi/Codex 15 min (or the device code's `expires_in`). No DO alarms are needed.
- **Credentials** are the Go files (same keys, same names: `claude-<sha8(org|account)>-<email>.json`, `codex-<sha8(account)>-<email>-<plan>.json`,
  `antigravity-<email>.json`, `xai-<email|sub>.json`, `meta-<email>-<sha16>.json`, `kimi[-ai]-<ms>.json`, `devin-<user>.json`, plus
  `disabled`). `record.ts` replays `saveTokenRecord`: same-name user settings are kept (never tokens), a Claude login migrates the
  legacy email/account-named file, then the file is stored through the pool (`importAuthFile` semantics) and is selectable at once.
- **Public browser callbacks** (`/anthropic/callback`, `/codex/callback`, `/antigravity/callback`, `/callback`, `/devin/callback`;
  `public-routes.ts`) exist for users that rewrite the localhost host to the Worker. They are outside the Access admin gate, so
  they only act on the `state` of a pending *callback* login of the route's provider and answer with a static page (no-store,
  never containing code/state/tokens/errors); everything else is a neutral 400.

Deviations from Go: Antigravity's client version is the Go fallback (`2.9.1`, no Hub manifest polling) and project discovery runs
inside the login (non-fatal); a transport failure or 5xx of one xAI/Kimi poll keeps waiting instead of ending the login; Codex
exchange errors include the (scrubbed) upstream status/body like Go but cap it at 512 chars; device-flow states carry a random
suffix (`xai-<ms>-<hex>`); Kimi stores the normalised `domain`; Claude's uTLS/ordered-header fingerprint cannot be reproduced (see
Claude provider). Not ported: `POST /oauth/import?provider=vertex` (belongs to the Vertex/Gemini slice; service-account files can be
uploaded through `POST /credentials`), plugin logins and the local callback forwarder (`is_webui`). Credential JSON files from the Go
server can still be imported through management.
