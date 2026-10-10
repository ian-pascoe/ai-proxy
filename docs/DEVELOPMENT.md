# Development guide

Developer notes for the TypeScript/Effect Worker. User-facing docs: [`README.md`](../README.md).
Design decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md) (module layout, runtime topology, per-subsystem behaviour and
deviations from Go).

The Go server ([router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)) is the behavioural source of
truth. It is not part of this repository: `pnpm install` (the `prepare` script, skipped when `CI` is set) clones it into
`.repos/CLIProxyAPI` as a read-only reference. pnpm skips `prepare` when dependencies are already up to date, so refresh
it with `pnpm repos:sync` (`tools/sync-reference-repos.sh`, a fast-forward of upstream `main`; `pnpm catalog:sync` runs it
first).
Go paths cited in code and docs (`internal/...`, `sdk/...`) are relative to that checkout.

## Requirements

- Node.js 22+ (CI uses the version in `.node-version`) and pnpm (`devEngines.packageManager` in `package.json`).
- Go (only for `tools/fixturegen` and `pnpm catalog:sync`) and the reference checkout above.

## Commands

Run from the repository root:

| Script              | Purpose                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`      | Install dependencies and clone/update the Go reference checkout (`.repos/`)                                                 |
| `pnpm repos:sync`   | Clone or fast-forward the reference repositories in `.repos/` (`tools/sync-reference-repos.sh`)                             |
| `pnpm dev`          | `alchemy dev`: local Worker in workerd with emulated DO/KV/D1, hot reload (`ALCHEMY_STATE=local` avoids a Cloudflare login) |
| `pnpm typecheck`    | `tsc -b`: the Worker (`tsconfig.worker.json`) and the deploy code (`tsconfig.infra.json`), referenced by `tsconfig.json`    |
| `pnpm lint`         | `oxlint` (type-aware, with type checking, Effect and anti-slop rules) + `oxfmt --check`                                     |
| `pnpm format`       | `oxfmt`                                                                                                                     |
| `pnpm test`         | `vitest run` inside the Workers runtime (`@cloudflare/vitest-plugin`)                                                       |
| `pnpm smoke`        | Boots `alchemy dev` with local state, checks a few routes, stops it (bundle + startup check)                                |
| `pnpm plan`         | `alchemy plan`: preview infrastructure changes (needs a Cloudflare profile)                                                 |
| `pnpm run deploy`   | `alchemy deploy` (`pnpm deploy` is a pnpm built-in; use `run`)                                                              |
| `pnpm destroy`      | `alchemy destroy`: delete every resource of a stage                                                                         |
| `pnpm logs`         | `alchemy logs` (`--tail`)                                                                                                   |
| `pnpm panel:sync`   | Install `public/management.html` (control panel) from its GitHub release                                                    |
| `pnpm ci:setup`     | Deploy `stacks/github.ts`: CI's Cloudflare token, check service token and GitHub environments (`docs/DEPLOY.md`)            |
| `pnpm catalog:sync` | Regenerate the embedded model catalogs from the Go registry (reference checkout)                                            |

## Infrastructure

`alchemy.run.ts` is the composition root of the deployed resources (`stacks/github.ts`, a separate stack, holds CI's
credentials) (Alchemy v2, Effect-based); `infra/settings.ts` reads
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
and `tools/fixturegen` (Go programs that emit golden fixtures, see below).

## Golden fixtures (`tools/fixturegen`)

The generators run the real Go code of the reference checkout and write `test/fixtures/` (and, for the registry,
`src/registry/catalog/`). They form their own Go module (`tools/fixturegen/go.mod`, module path under the server's so they
may import its `internal/` packages) tied to `.repos/CLIProxyAPI` by a `replace` and the root `go.work`. Run them from the
repository root, e.g. `go run ./tools/fixturegen/translator` (use `TZ=UTC` for the translator); `pnpm catalog:sync` runs
`…/registry`.

The reference checkout follows upstream `main`, so regenerating after `pnpm repos:sync` shows what changed upstream: a
fixture diff is a porting task (port the Go change, then commit the new fixtures), not noise to commit blindly. Some
fixtures contain generated ids or timestamps that differ on every run; the tests mask those.

`tools/fixturegen/UPSTREAM_COMMIT` records the reference commit the committed fixtures were generated from (the last
ported upstream state). `tools/upstream-drift.sh` syncs the reference, regenerates every fixture, runs the tests on
them and reports the upstream commits since that commit and the test files that fail; the weekly
`.github/workflows/upstream-drift.yml` keeps one `upstream-drift` issue with that report. After porting, set
`UPSTREAM_COMMIT` to the reference commit you ported up to and commit the regenerated fixtures.

## Git hooks

`pnpm install` enables the Husky hooks in `.husky/` (the `prepare` script runs `husky`):

- `pre-commit`: lint-staged formats staged files with `oxfmt` and lints staged scripts with `oxlint --quiet` (errors
  only).
- `commit-msg`: commitlint with `@commitlint/config-conventional` (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `style:`, `test:`, `ci:`, …; header and body lines up to 100 characters).
- `pre-push`: `pnpm typecheck && pnpm lint`. The test suite runs in CI.

Skip them once with `git commit --no-verify` / `git push --no-verify`, or for a whole shell with `HUSKY=0`.

## CI and deployment

`.github/workflows/ci.yml` runs typecheck, lint, actionlint and zizmor, the tests in three shards, and the smoke test;
then deploys a preview per pull request and production from `main`. Setup and behaviour: [DEPLOY.md](DEPLOY.md).
Actions are pinned by commit SHA (Dependabot updates them weekly, `.github/dependabot.yml`), jobs get only the
permissions they need, and deploy jobs use no dependency cache.

## Lint and format

`pnpm lint` runs oxlint and `oxfmt --check`. oxlint (`.oxlintrc.json`) is type-aware (`options.typeAware`, via
`oxlint-tsgolint`) and also reports TypeScript errors (`options.typeCheck`); on top of its own rules it runs:

- **Effect tsgo** (`@effect/tsgo`, recommended preset): Effect-specific diagnostics. The `prepare` script
  (`effect-tsgo patch --no-typescript --oxlint`) patches the installed oxlint/tsgolint binaries after every install;
  `oxlint`, `oxlint-tsgolint` and `@effect/tsgo` are pinned to versions the patch supports, so upgrade them together.
- **anti-slop** (vendored in `tools/oxlint/anti-slop/`, provenance in its `UPSTREAM.md`): the copy belongs to this
  repository; edit its rules there.

Rules downgraded to warnings on purpose (reported, not failing): `effecttsgo/unstable-api-usage` (the HTTP stack is
`effect/unstable/http`), `anti-slop-effect/no-service-constructor-imports` (flags every `make*` function),
`anti-slop/no-runtime-typeof` (the translators walk arbitrary JSON like Go's gjson; `typeof` is the parse step) and
`anti-slop/no-conditional-empty-object-spread` (the `...(x === undefined ? {} : { x })` idiom required by
`exactOptionalPropertyTypes`). In `test/` the type-assertion and
dictionary-type rules are off (fake bindings and loose fixtures).

Errors fail lint; warnings are reported but do not. Fix findings rather than silencing them: no disable comments. A type
assertion that cannot be removed carries a `// SAFETY: <invariant>` comment on the line(s) before it.

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

- TypeScript 7 (native `tsc`); `tsconfig.json` is a solution config referencing `tsconfig.worker.json` (Worker, workerd
  types) and `tsconfig.infra.json` (deploy code, Node.js types). `capnp-es` (via Alchemy) declares a TypeScript 5/6 peer
  range; it only ships types, so the peer warning is harmless.
- `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`) is used because it supports vitest 5,
  which `@effect/vitest@4` requires.
- `alchemy` (2.0.0 beta, pinned) needs `@effect/platform-node` for its CLI; `@distilled.cloud/cloudflare` is pinned to
  the version Alchemy uses (the Access settings step calls the Cloudflare API with Alchemy's credentials).
