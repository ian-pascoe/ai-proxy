# Workers port — development guide

Developer notes for the TypeScript/Effect Worker in `workers/`. User-facing docs: [`workers/README.md`](../../workers/README.md).
Design decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md) (module layout, runtime topology, per-subsystem behaviour and
deviations from Go). The Go code in the repository root is the behavioural source of truth.

## Requirements

- Node.js 22+ and pnpm (`packageManager` in `package.json`).
- Go (only for `tools/fixturegen` and `pnpm catalog:sync`).

## Commands

Run from `workers/` (or use `pnpm -C workers <script>`):

| Script               | Purpose                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `pnpm install`       | Install dependencies                                                     |
| `pnpm dev`           | `wrangler dev` (local Worker with local DO/KV/D1)                        |
| `pnpm typecheck`     | `tsc --noEmit` (strict)                                                  |
| `pnpm lint`          | `oxlint` + `prettier --check`                                            |
| `pnpm format`        | `prettier --write`                                                       |
| `pnpm test`          | `vitest run` inside the Workers runtime (`@cloudflare/vitest-plugin`)    |
| `pnpm build`         | `wrangler deploy --dry-run --outdir dist` (bundle + config check)        |
| `pnpm types`         | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`    |
| `pnpm panel:sync`    | Install `public/management.html` (control panel) from its GitHub release |
| `pnpm catalog:sync`  | Regenerate the embedded model catalogs from the Go registry              |
| `pnpm check:startup` | `wrangler check startup` (Worker startup CPU profile)                    |

## Layout

`ARCHITECTURE.md` ("Layout" plus one section per subsystem) is the map. In short: `src/access` (Access JWT gate),
`src/http` (router, CORS, SSE), `src/handlers` (inbound protocols and the shared execution pipeline), `src/translator`
and `src/thinking` (pure sync translation), `src/executor` (one directory per provider), `src/credentials` (ControlPlane
Durable Object, token refresh), `src/session-state` (SessionState Durable Object), `src/registry` (model catalogs and
`/models`), `src/management` and `src/oauth` (management API, panel, provider logins), `src/usage` and
`src/observability` (D1 usage records, trace ids), `migrations/` (D1 schema), `tools/panel-sync` (control panel installer)
and `tools/fixturegen` (Go programs that emit golden fixtures; run from the repo root, e.g.
`go run ./workers/tools/fixturegen/translator`; `pnpm catalog:sync` runs `…/registry`).

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
