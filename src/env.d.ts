// Bindings and variables of the Worker. Deployed values come from `alchemy.run.ts` (the Worker's `env` plus the
// `ASSETS` binding created by `assets`); keep both in sync. Tests bind the same names in `vitest.config.ts`.
interface __BaseEnv_Env {
  /** Model catalogs, signature cache, Antigravity state (Workers KV). */
  CACHE: KVNamespace;
  /** Usage records (D1); schema in migrations/. */
  USAGE: D1Database;
  /** Static assets (management panel). */
  ASSETS: Fetcher;
  /** Access team name or domain (`myteam`, `myteam.cloudflareaccess.com`); empty fails closed. */
  ACCESS_TEAM_DOMAIN: string;
  /** Comma separated Access application AUD tags; empty fails closed. */
  ACCESS_AUD: string;
  /** Comma separated management admin emails. */
  ACCESS_ADMIN_EMAILS: string;
  /** Comma separated management admin service token Client IDs. */
  ACCESS_ADMIN_SERVICE_TOKENS: string;
  /** Local development only: treats loopback requests as this admin. Never set when deployed. */
  ACCESS_DEV_BYPASS: string;
  /** Days of usage history kept in D1; 0 keeps everything. */
  USAGE_RETENTION_DAYS: string;
  /** Overrides the Meta key-mint endpoint (empty: default). */
  META_MINT_URL: string;
  CONTROL_PLANE: DurableObjectNamespace<import("./index").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("./index").SessionState>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "ControlPlane" | "SessionState";
  }

  interface Env extends __BaseEnv_Env {}
}

interface Env extends __BaseEnv_Env {}

// Non-JavaScript modules (Workers module rules; `*.bin` is in src/tokenizer/bin.d.ts).
declare module "*.txt" {
  const value: string;
  export default value;
}

declare module "*.html" {
  const value: string;
  export default value;
}

declare module "*.sql" {
  const value: string;
  export default value;
}
