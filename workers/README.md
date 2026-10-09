# workers/ — CLIProxyAPI on Cloudflare Workers

TypeScript + [Effect v4](https://effect.website) port of the Go proxy for plain Cloudflare Workers. Design decisions are
in [`docs/workers-port/ARCHITECTURE.md`](../docs/workers-port/ARCHITECTURE.md); the Go code in the repository root is
the behavioural source of truth.

## Requirements

- Node.js 22+ and pnpm (`packageManager` in `package.json`).

## Commands

Run from `workers/` (or use `pnpm -C workers <script>`):

| Script           | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `pnpm install`   | Install dependencies                                                  |
| `pnpm dev`       | `wrangler dev` (local Worker with local DO/KV/D1)                     |
| `pnpm typecheck` | `tsc --noEmit` (strict)                                               |
| `pnpm lint`      | `oxlint` + `prettier --check`                                         |
| `pnpm format`    | `prettier --write`                                                    |
| `pnpm test`      | `vitest run` inside the Workers runtime (`@cloudflare/vitest-plugin`) |
| `pnpm build`     | `wrangler deploy --dry-run --outdir dist` (bundle + config check)     |
| `pnpm types`     | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

## Layout

See the architecture document. Currently implemented:

- `src/index.ts` — Worker entry (`fetch`, `scheduled` placeholder, `ControlPlane` export, stub `SessionState` Durable Object).
- `src/http/` — `HttpRouter` app (`app.ts`), CORS middleware matching Go (`cors.ts`), `/healthz` and `/` (`routes.ts`).
- `src/platform/env.ts` — `WorkerEnv` / `WorkerExecutionContext` services, provided per request via `requestContext`.
- `src/platform/logging.ts` — logging conventions and header redaction.
- `src/errors.ts` — base tagged errors.
- `src/access/` — Cloudflare Access authentication: JWT verification with `jose` (`verify.ts`), per-isolate JWKS cache
  (`jwks.ts`), principal service `AccessPrincipal` (`principal.ts`), global gate (`middleware.ts`, `layer.ts`), path policy
  (`routes.ts`) and env config (`config.ts`).
- `src/json/` — gjson/sjson-compatible path engine over parsed JSON (`get`, `set`, `setRaw`, `del`, coercions).
- `src/thinking/` — thinking pipeline port (`applyThinking`, suffix parsing, validation, provider appliers, reasoning-summary helpers).
- `src/config/` — config schema, YAML/JSON codec, normalisation, `ConfigReader`, and `payload/` (`applyPayloadRules`).
- `src/credentials/control-plane.ts` — `ControlPlane` Durable Object (config storage so far; credentials come later).
- `src/translator/` — translator registry (`registry.ts`), built-in pairs (`builtin.ts`), `openai/openai` passthrough.
- `src/executor/` — executor contracts (`types.ts`, `errors.ts`), `CredentialPicker` (`picker.ts`, config-only
  `static-picker.ts`), `Thinking` hook (`thinking.ts`), per-credential model resolution and the OpenAI-compatible
  executor (`openai-compat/`).
- `src/handlers/` — shared execution pipeline (`execute.ts`), SSE responder and framers (`respond.ts`, `framing.ts`),
  `/v1/chat/completions` and `/v1/completions` (`openai/`), service wiring (`layer.ts`).
- `src/usage/` — usage records, per-attempt `UsageReporter`, `UsageSink` (no-op until persistence lands).
- `tools/fixturegen/` — Go programs that emit golden fixtures from the Go implementation (run from the repo root:
  `go run ./workers/tools/fixturegen/jsonpath`, `…/payload`, `…/thinking` and `…/translator` (reads
  `tools/fixturegen/translator/corpus/*.json`); `pnpm catalog:sync` runs `…/registry`, which also refreshes the
  embedded model catalogs in `src/registry/catalog/`).

## Cloudflare Access

`/v1*`, `/openai/v1*`, `/backend-api/codex*` and `/v8/management*` require a valid `Cf-Access-Jwt-Assertion`; `/healthz`
and `/` are public. Management additionally requires an admin. Configure (vars in `wrangler.jsonc`, or secrets):

| Variable                      | Meaning                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN`          | `myteam` or `myteam.cloudflareaccess.com` (issuer + JWKS location)           |
| `ACCESS_AUD`                  | comma separated Access application AUD tags                                  |
| `ACCESS_ADMIN_EMAILS`         | comma separated admin emails (case-insensitive)                              |
| `ACCESS_ADMIN_SERVICE_TOKENS` | comma separated admin service token client ids (`common_name`)               |
| `ACCESS_DEV_BYPASS`           | `wrangler dev` only (put in `.dev.vars`): fake admin user for loopback hosts |

Empty defaults fail closed (protected routes answer 500 `Authentication service error`). Route layers whose handlers
read the principal wrap themselves with `withAccess(routes)` (`src/access/layer.ts`) and use `yield* AccessPrincipal`
(`{ principal, principalId, callerScope }`).

## Conventions

- Per-request Cloudflare `env` / `ctx` are passed as the `Context` argument of the web handler
  (`handler(request, requestContext(env, ctx))`); routes read them via `yield* WorkerEnv`. Never capture them in a layer.
- Add routes as `HttpRouter.add(...)` layers and merge them into `AppLayer` in `src/http/app.ts`.
- Never log tokens, API keys, JWTs or bodies; use `redactHeaders` when headers must be logged.
- No wall-clock sleeps in tests; use Effect `TestClock` or injected clocks.
- Tests live in `test/*.test.ts` and run in workerd. Use `@effect/vitest` (`it.effect`) for Effect code and
  `exports.default.fetch(...)` (`cloudflare:workers`) for end-to-end Worker requests.
- `wrangler.jsonc` uses placeholder KV/D1 ids; set real ids when deploying. `workers_dev` and `preview_urls` stay
  disabled so Cloudflare Access cannot be bypassed.

## Dependency notes

- `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`) is used because it supports vitest 5,
  which `@effect/vitest@4` requires.
- `wrangler` is pinned to the version used by the vitest plugin so a single `workerd` is installed.
