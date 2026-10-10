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

CI's credentials are code: `stacks/github.ts` is a second Alchemy stack that creates them and writes them into GitHub.
It manages:

- the GitHub environments `production` (deployments from `main` only, no reviewers: a green push deploys) and
  `preview`;
- `cliproxy-ci-deploy`, an account-owned Cloudflare API token limited to what `alchemy.run.ts` deploys: Workers Scripts,
  Workers KV Storage, D1, Secrets Store (Alchemy's state store) and Access: Apps and Policies (Write), Account Settings
  (Read), and Zone Read, DNS Write and Workers Routes Write on the zone of `CLIPROXY_DOMAIN`;
- `cliproxy-ci-check`, the Access service token of the post-deploy check;
- in both environments, the secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and the
  variables `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_*` (from `.env`) and `ACCESS_ALLOW_SERVICE_TOKEN_IDS` (the check token's
  ID); in `production` also `CLIPROXY_DOMAIN`.

Raw secrets never leave Alchemy: Cloudflare returns them once, they go to the encrypted state store and are encrypted
again for GitHub.

### 1. An `admin` profile (once)

Creating API tokens needs more than the everyday OAuth login, so the stack deploys with a separate Alchemy profile:

```bash
pnpm exec alchemy profile create admin
pnpm exec alchemy profile edit --profile admin
```

For Cloudflare, use the **Global API Key** (with your email), or an API token with **Account → API Tokens: Write** and
**Account → Access: Service Tokens: Write**. For GitHub, choose `gh` (GitHub CLI, needs repository admin). Treat this
profile like root: use it only for this stack.

### 2. Deploy the CI stack

```bash
pnpm ci:setup
```

It runs `alchemy deploy --config stacks/github.ts --stage ci --profile admin` and prints the outputs. Copy
`checkServiceTokenId` into `ACCESS_ALLOW_SERVICE_TOKEN_IDS` in your local `.env`: a local deploy of `prod` without it
removes the CI token from the production policy and the next CI check fails.

Re-run `pnpm ci:setup` to apply changed permissions or `.env` values. To rotate the deploy token, destroy and redeploy
the stack (`pnpm exec alchemy destroy --config stacks/github.ts --stage ci --profile admin`, then `pnpm ci:setup`).

## Operations

- **Management panels.** CI builds the control panel from `web/` (`pnpm web:build`) and installs the upstream panel
  release pinned by `PANEL_TAG` in `ci.yml` (`pnpm panel:sync --tag`); bump the tag deliberately, Dependabot does not.
- **State.** Deploys use the Alchemy state store in the account (`Cloudflare.state()`), shared by CI and local
  machines; `deploy --yes` also upgrades the state store when Alchemy needs a newer version.
- **Concurrency.** One deploy per stage at a time, never cancelled midway; a newer push to `main` waits for the
  running production deploy.
- **Stale previews.** If a destroy fails, rerun the job, or run `pnpm run destroy --stage pr-<number>` locally.
