# Continuous deployment

`.github/workflows/ci.yml` checks every pull request and push to `main`, then deploys with Alchemy:

| Event                                    | Stage         | Where                                                        |
| ---------------------------------------- | ------------- | ------------------------------------------------------------ |
| Push to `main`                           | `prod`        | `CLIPROXY_DOMAIN`, GitHub environment `production`           |
| Pull request from a branch of this repo  | `pr-<number>` | the Worker's `workers.dev` URL, GitHub environment `preview` |
| That pull request closed (merged or not) | `pr-<number>` | destroyed                                                    |

Deploys run only after typecheck, lint, workflow lint (actionlint, zizmor), the test shards and the smoke test pass.
Fork and Dependabot pull requests get the checks but no preview (they receive no deploy secrets). A manual run
(`workflow_dispatch`) on `main` redeploys production.

After each deploy, `tools/check-deploy.sh` calls `/healthz` and `/v1/models` through Access with the CI service token;
the second route proves that the Worker accepts the Access JWT (team domain and AUD wired). The deploy job then shows
the URL on the run, and previews get a pull request comment (`tools/preview-comment.sh`) that is updated on every push.

## Preview stages

A stage named `pr-<number>` is a preview (`infra/settings.ts`):

- Its own Worker on `workers.dev`, protected by its own Access application. The Worker enrolls into it (Alchemy's
  Worker `access` prop), so Access covers the `workers.dev` URL; no custom hostname is needed.
- Same policies as production: `ACCESS_ALLOW_*` for people, `ACCESS_ALLOW_SERVICE_TOKEN_IDS` for the CI token. Same
  admins (`ACCESS_ADMIN_EMAILS`).
- Empty KV, D1 and Durable Objects, and no cron trigger. A preview has no provider credentials, so it serves the panel,
  the management API and the routes but cannot proxy real requests. Add credentials through its panel if you need to.
- `CLIPROXY_DOMAIN`, `ACCESS_AUD` and `ACCESS_SERVICE_TOKENS` are ignored.

Any machine with the deploy settings can deploy a preview by hand: `pnpm run deploy --stage pr-123`, and remove it with
`pnpm run destroy --stage pr-123`.

## Setup

### 1. Cloudflare API token (secret `CLOUDFLARE_API_TOKEN`)

Create a custom API token (My Profile → API Tokens → Create Custom Token) with:

| Scope                | Permission                                  | Used for                                                     |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Account              | Workers Scripts: Edit                       | the Worker, Durable Objects, crons, workers.dev, state store |
| Account              | Workers KV Storage: Edit                    | the `Cache` namespace                                        |
| Account              | D1: Edit                                    | the `Usage` database and its migrations                      |
| Account              | Secrets Store: Edit                         | Alchemy's state store credentials                            |
| Account              | Access: Apps and Policies: Edit             | the Access applications and policies                         |
| Account              | Account Settings: Read                      | account lookups                                              |
| Zone `ianpascoe.dev` | Zone: Read, DNS: Edit, Workers Routes: Edit | the production custom domain                                 |

Limit it to the one account and zone. It needs no Access service token permission: CI never creates service tokens.

### 2. CI service token (secrets `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`; variable `ACCESS_ALLOW_SERVICE_TOKEN_IDS`)

An Access service token managed outside the stack (Zero Trust → Access → Service credentials), used only by the
post-deploy check. Its **ID** (not the Client ID) goes into `ACCESS_ALLOW_SERVICE_TOKEN_IDS`, which adds it to each
application's Service Auth policy. Set the same value in your local `.env`: a local deploy without it removes the
token from the production policy and the next CI check fails.

### 3. GitHub environments

Create the environments `production` and `preview` (Settings → Environments), each with:

- Secrets: `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
- Variables: `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_ALLOW_EMAILS`, `ACCESS_ADMIN_EMAILS`,
  `ACCESS_ALLOW_SERVICE_TOKEN_IDS`, and in `production` also `CLIPROXY_DOMAIN`. Optional: `ACCESS_ALLOW_EMAIL_DOMAINS`,
  `ACCESS_SESSION_DURATION`.

Restrict `production` to the `main` branch (Deployment branches and tags → Selected branches → `main`). No reviewers:
a green push to `main` deploys.

The variables mirror `.env` (see `.env.example`); keep the two in sync, since local deploys of `prod` remain possible.

## Operations

- **Management panel.** CI installs the panel release pinned by `PANEL_TAG` in `ci.yml` (`pnpm panel:sync --tag`).
  Bump it deliberately; Dependabot does not.
- **State.** Deploys use the Alchemy state store in the account (`Cloudflare.state()`), shared by CI and local
  machines; `deploy --yes` also upgrades the state store when Alchemy needs a newer version.
- **Concurrency.** One deploy per stage at a time, never cancelled midway; a newer push to `main` waits for the
  running production deploy.
- **Stale previews.** If a destroy fails, rerun the job, or run `pnpm run destroy --stage pr-<number>` locally.
