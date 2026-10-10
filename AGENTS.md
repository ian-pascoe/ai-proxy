# AGENTS.md

TypeScript + Effect v4 (`effect@4.0.2`) port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) on plain Cloudflare Workers, behind Cloudflare Access. One pnpm package at the repository root. Design: `docs/ARCHITECTURE.md` (layout, per-subsystem behaviour, deviations from Go); developer notes: `docs/DEVELOPMENT.md`.

## Commands

- Run before finishing: `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke`; `pnpm format` formats.
- Never run `pnpm run deploy`/`pnpm destroy` (Alchemy) against a real account unless asked.

## Go reference

- The Go server is the behavioural source of truth. It lives in the read-only reference checkout `.repos/CLIProxyAPI`; Go paths in code and docs (`internal/...`, `sdk/...`) are relative to it. Read it there; change only this repository.
- Golden fixtures come from `tools/fixturegen` (Go programs run against the reference checkout, see `docs/DEVELOPMENT.md`). A fixture diff after a reference update is an upstream change to port.

## Conventions

- Read `node_modules/effect/AGENTS.md` and the effect source before writing Effect code (APIs differ from Effect 3).
- Infrastructure is Alchemy v2 (`alchemy.run.ts`, `infra/`); there is no Wrangler config. A new binding/variable goes in the Worker `env` in `alchemy.run.ts`, `src/env.d.ts` and `vitest.config.ts` together.
- Tests under `test/` run in workerd via `@cloudflare/vitest-plugin` (`exports.default.fetch` from `cloudflare:workers`); use `@effect/vitest` for Effect code.
- Per-request `env`/`ctx` are provided as `WorkerEnv`/`WorkerExecutionContext` services via the web handler's `Context` (`requestContext`); layers stay free of them.
- Translators/thinking/payload rules are pure sync functions over parsed JSON; cite the Go source path at the top of each ported module. Payload rules stay the final mutation before upstream requests.
- Redact tokens/API keys/JWTs in logs (`redactHeaders`); drive time in tests with `TestClock`; justify every `any` with a comment.
- Document every deliberate behaviour difference from Go in the module header and in `docs/ARCHITECTURE.md`.

## Reference repositories

The `pnpm install` command materializes these read-only references in `.repos/`.
Run `./tools/sync-reference-repos.sh` to refresh them directly.

| Repository                                                                  | Path                 | Useful for                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI) | `.repos/CLIProxyAPI` | The Go server this project ports: behavioural source of truth for translators, thinking, payload rules, executors, credential selection/refresh and the management API; `tools/fixturegen` builds against it to generate golden fixtures and `pnpm catalog:sync` copies its model catalogs. |
