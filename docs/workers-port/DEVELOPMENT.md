# Workers port — development guide

Developer notes for the TypeScript/Effect Worker in `workers/`. User-facing docs: [`workers/README.md`](../../workers/README.md).
Design decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md) (module layout, runtime topology, per-subsystem behaviour and
deviations from Go). The Go code in the repository root is the behavioural source of truth.

## Requirements

- Node.js 22+ and pnpm (`packageManager` in `package.json`).
- Go (only for `tools/fixturegen` and `pnpm catalog:sync`).

## Commands

Run from `workers/` (or use `pnpm -C workers <script>`):

| Script              | Purpose                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`      | Install dependencies                                                                                                        |
| `pnpm dev`          | `alchemy dev`: local Worker in workerd with emulated DO/KV/D1, hot reload (`ALCHEMY_STATE=local` avoids a Cloudflare login) |
| `pnpm typecheck`    | `tsc --noEmit` for the Worker (`tsconfig.json`) and the deploy code (`tsconfig.infra.json`)                                 |
| `pnpm lint`         | `oxlint` + `prettier --check`                                                                                               |
| `pnpm format`       | `prettier --write`                                                                                                          |
| `pnpm test`         | `vitest run` inside the Workers runtime (`@cloudflare/vitest-plugin`)                                                       |
| `pnpm smoke`        | Boots `alchemy dev` with local state, checks a few routes, stops it (bundle + startup check)                                |
| `pnpm plan`         | `alchemy plan`: preview infrastructure changes (needs a Cloudflare profile)                                                 |
| `pnpm run deploy`   | `alchemy deploy` (`pnpm deploy` is a pnpm built-in; use `run`)                                                              |
| `pnpm destroy`      | `alchemy destroy`: delete every resource of a stage                                                                         |
| `pnpm logs`         | `alchemy logs` (`--tail`)                                                                                                   |
| `pnpm panel:sync`   | Install `public/management.html` (control panel) from its GitHub release                                                    |
| `pnpm catalog:sync` | Regenerate the embedded model catalogs from the Go registry                                                                 |

## Infrastructure

`alchemy.run.ts` is the composition root of the deployed resources (Alchemy v2, Effect-based); `infra/settings.ts` reads
the deploy settings (`.env`), `infra/access.ts` provisions Cloudflare Access. There is no Wrangler configuration. When you
add a binding or variable, change three places together: the Worker's `env` in `alchemy.run.ts`, the `Env` interface in
`src/env.d.ts`, and the test bindings in `vitest.config.ts` (which mirrors the deployed Worker: entry, compatibility
settings, Durable Objects, `*.bin` Data modules).

`worker-configuration.d.ts` holds the Workers runtime types for the compatibility date and flags in `alchemy.run.ts`.
Regenerate it when those change (Wrangler is used only as a type generator here):

```bash
printf '{"name":"t","main":"src/index.ts","compatibility_date":"2026-08-01","compatibility_flags":["nodejs_compat"]}' > /tmp/rt.json
pnpm dlx wrangler@4 types --include-env=false -c /tmp/rt.json worker-configuration.d.ts
```

then restore the three-line header comment. Durable Object classes are SQLite-backed; Alchemy derives their class migrations from the
`DurableObject` bindings (renaming a class needs `className`/`transferredFrom`, see the Alchemy docs).

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
- `alchemy.run.ts` keeps `workersDev: false` (no `workers.dev` or preview URLs) so Cloudflare Access cannot be bypassed.

## Dependency notes

- `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`) is used because it supports vitest 5,
  which `@effect/vitest@4` requires.
- `alchemy` (2.0.0 beta, pinned) needs `@effect/platform-node` for its CLI; `@distilled.cloud/cloudflare` is pinned to
  the version Alchemy uses (the Access settings step calls the Cloudflare API with Alchemy's credentials).
