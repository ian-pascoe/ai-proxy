/**
 * Infrastructure of the Workers port, deployed with Alchemy (`pnpm deploy`, `pnpm dev`, `pnpm destroy`): the Worker
 * with its Durable Objects, static assets and cron trigger, the KV namespace, the D1 usage database (migrations
 * applied on every deploy) and the Cloudflare Access application, policies and service tokens in front of it.
 * Deploy-time settings are read from the environment / `.env` (see `.env.example` and infra/settings.ts).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { type AccessWiring, provisionAccess } from "./infra/access.ts";
import { readSettings } from "./infra/settings.ts";

/** Runtime compatibility of the Worker; keep in sync with vitest.config.ts and worker-configuration.d.ts. */
export const COMPATIBILITY = { date: "2026-08-01", flags: ["nodejs_compat"] };

/** Model catalog refresh, credential refresh sweep and usage retention (src/scheduled.ts). */
export const CRONS = ["0 */3 * * *"];

// Remote state in the account (`Cloudflare.state()`, shared by every machine and CI) unless ALCHEMY_STATE=local,
// which keeps it under .alchemy/ (handy for `alchemy dev` without a Cloudflare login).
const state = process.env["ALCHEMY_STATE"] === "local" ? Alchemy.localState() : Cloudflare.state();

export default Alchemy.Stack(
  "cliproxy",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV;
    const settings = yield* readSettings(dev);

    const cache = yield* Cloudflare.KV.Namespace("Cache");
    const usage = yield* Cloudflare.D1.Database("Usage", { migrations: "./migrations" });

    // `alchemy dev` serves the Worker on localhost without Access: the dev bypass (src/access/config.ts) makes every
    // loopback request an admin. Deployed Workers never get it and require the Access JWT.
    const access: AccessWiring = dev
      ? { aud: "", adminServiceTokens: "", serviceTokenClientIds: {} }
      : yield* provisionAccess(settings);

    const worker = yield* Cloudflare.Worker("Proxy", {
      main: "./src/index.ts",
      compatibility: COMPATIBILITY,
      // Access is the only client authentication: no workers.dev or preview URLs, only the Access-protected domain.
      workersDev: false,
      ...(dev ? {} : { domain: settings.domain }),
      limits: { cpuMs: settings.cpuMs },
      // The management panel (`pnpm panel:sync`). The Worker runs first so proxy routes are never shadowed by assets.
      assets: { directory: "./public", runWorkerFirst: true },
      crons: CRONS,
      env: {
        CACHE: cache,
        USAGE: usage,
        CONTROL_PLANE: Cloudflare.DurableObject("ControlPlane"),
        SESSION_STATE: Cloudflare.DurableObject("SessionState"),
        ACCESS_TEAM_DOMAIN: dev ? "" : settings.teamDomain,
        ACCESS_AUD: access.aud,
        ACCESS_ADMIN_EMAILS: settings.adminEmails.join(","),
        ACCESS_ADMIN_SERVICE_TOKENS: access.adminServiceTokens,
        ACCESS_DEV_BYPASS: dev ? settings.devBypass : "",
        USAGE_RETENTION_DAYS: settings.usageRetentionDays,
        META_MINT_URL: settings.metaMintUrl,
      },
    });

    return {
      url: worker.url,
      accessAud: access.aud,
      serviceTokens: access.serviceTokenClientIds,
    };
  }),
);
