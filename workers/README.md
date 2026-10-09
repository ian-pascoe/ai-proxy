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

- `src/index.ts` — Worker entry (`fetch`, `scheduled` placeholder, stub `ControlPlane` / `SessionState` Durable Objects).
- `src/http/` — `HttpRouter` app (`app.ts`), CORS middleware matching Go (`cors.ts`), `/healthz` and `/` (`routes.ts`).
- `src/platform/env.ts` — `WorkerEnv` / `WorkerExecutionContext` services, provided per request via `requestContext`.
- `src/platform/logging.ts` — logging conventions and header redaction.
- `src/errors.ts` — base tagged errors.

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
