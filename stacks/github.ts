/**
 * CI credentials as code (docs/DEPLOY.md): the GitHub Actions environments `production` and `preview`, a scoped
 * Cloudflare API token for deploys, the Access service token of the post-deploy check, and the secrets and variables
 * that hand them to .github/workflows/ci.yml. Deployed once from a workstation with a profile that may create API
 * tokens, and again to rotate or change permissions:
 *
 *   pnpm ci:setup        # alchemy deploy --config stacks/github.ts --profile admin --stage ci
 *
 * The deploy settings (CLIPROXY_DOMAIN, ACCESS_*) come from `.env`, like `alchemy.run.ts`.
 */
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { readSettings } from "../infra/settings.ts";

/** Account-scoped "Access: Apps and Policies Write" (the catalog name is shared with a zone-scoped group). */
const ACCESS_APPS_AND_POLICIES_WRITE = { id: "1e13c5124ca64b72b1969a67e8829049" };

/** The account's zone that serves `domain` (the longest zone name `domain` ends with). */
const zoneFor = (accountId: string, domain: string) =>
  zones.listZones.items({ account: { id: accountId } }).pipe(
    Stream.filter((zone) => domain === zone.name || domain.endsWith(`.${zone.name}`)),
    Stream.runCollect,
    Effect.flatMap((matches) => {
      const zone = [...matches].toSorted((a, b) => b.name.length - a.name.length)[0];

      return zone === undefined
        ? Effect.die(new Error(`no zone of account ${accountId} serves ${domain}`))
        : Effect.succeed(zone);
    }),
    // A failed lookup aborts the deploy (the stack's error channel only carries ConfigError).
    Effect.orDie,
  );

export default Alchemy.Stack(
  "cliproxy-github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const settings = yield* readSettings(false, "prod");

    const [owner = "", repository = ""] = (yield* Config.String("GITHUB_REPOSITORY").pipe(
      Config.withDefault("ian-pascoe/ai-proxy"),
    )).split("/");

    const repo = { owner, repository };
    const zone = yield* zoneFor(accountId, settings.domain);

    const production = yield* GitHub.Environment("Production", {
      ...repo,
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    });

    const preview = yield* GitHub.Environment("Preview", { ...repo, name: "preview" });

    // Everything `alchemy deploy`/`destroy` of alchemy.run.ts touches, for any stage. Alchemy's state store needs
    // Secrets Store Write (it binds its token secret to a short-lived preview Worker on every run).
    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      name: "cliproxy-ci-deploy",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "D1 Write",
            "Secrets Store Write",
            "Account Settings Read",
            ACCESS_APPS_AND_POLICIES_WRITE,
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          // The production custom domain (its DNS record and Workers route).
          effect: "allow",
          permissionGroups: ["Zone Read", "DNS Write", "Workers Routes Write"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.api.account.zone.${zone.id}`]: "*",
            },
          },
        },
      ],
    });

    // The post-deploy check (tools/check-deploy.sh) authenticates with this token; ACCESS_ALLOW_SERVICE_TOKEN_IDS
    // admits it on every stage's Access application.
    const checkToken = yield* Cloudflare.Access.ServiceToken("CheckToken", {
      name: "cliproxy-ci-check",
    });

    const checkSecret = checkToken.clientSecret.pipe(
      Output.map((secret) => {
        if (secret === undefined) throw new Error("Cloudflare returned no client secret");

        return secret;
      }),
    );

    const variables = {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      ACCESS_TEAM_DOMAIN: settings.teamDomain,
      ACCESS_ALLOW_EMAILS: settings.allowEmails.join(","),
      ACCESS_ALLOW_EMAIL_DOMAINS: settings.allowEmailDomains.join(","),
      ACCESS_ADMIN_EMAILS: settings.adminEmails.join(","),
      ACCESS_SESSION_DURATION: settings.sessionDuration,
      ACCESS_ALLOW_SERVICE_TOKEN_IDS: checkToken.serviceTokenId,
    } satisfies Record<string, string | Output.Output<string>>;

    const secrets = {
      CLOUDFLARE_API_TOKEN: deployToken.value,
      CF_ACCESS_CLIENT_ID: checkToken.clientId.pipe(Output.map((id) => Redacted.make(id))),
      CF_ACCESS_CLIENT_SECRET: checkSecret,
    } satisfies Record<string, Redacted.Redacted | Output.Output<Redacted.Redacted>>;

    for (const [label, environment] of [
      ["Production", production],
      ["Preview", preview],
    ] as const) {
      const scoped =
        label === "Production" ? { ...variables, CLIPROXY_DOMAIN: settings.domain } : variables;

      for (const [name, value] of Object.entries(scoped)) {
        // GitHub rejects empty variables; an unset variable reads as "" in the workflow anyway.
        if (value === "") continue;

        yield* GitHub.Variable(`${label}-${name}`, { ...repo, environment, name, value });
      }

      for (const [name, value] of Object.entries(secrets)) {
        yield* GitHub.Secret(`${label}-${name}`, { ...repo, environment, name, value });
      }
    }

    return {
      // Put this into ACCESS_ALLOW_SERVICE_TOKEN_IDS in .env too, so local deploys keep the CI token admitted.
      checkServiceTokenId: checkToken.serviceTokenId,
      zone: zone.name,
    };
  }),
);
