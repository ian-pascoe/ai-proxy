import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Deploy-time settings of the stack, read from the shell environment and `.env` (see `.env.example`). They
 * are inputs of `alchemy deploy` only; the Worker itself never reads this file.
 */
export interface Settings {
  /**
   * Pull-request preview stage (`pr-<number>`): served on its `workers.dev` URL behind its own Access application,
   * with empty storage and no cron trigger. `domain`, `existingAud` and `serviceTokens` are ignored.
   */
  readonly preview: boolean;
  /** Custom hostname of the Worker (the zone must exist in the account), e.g. `proxy.example.com`. */
  readonly domain: string;
  /** Access team name or domain, e.g. `myteam` or `myteam.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** AUD tag(s) of an Access application managed outside this stack; when set, no Access resources are created. */
  readonly existingAud: string;
  /** Users allowed through Access (Allow policy). */
  readonly allowEmails: ReadonlyArray<string>;
  readonly allowEmailDomains: ReadonlyArray<string>;
  /** Names of the service tokens to create (Service Auth policy), one per client/machine. */
  readonly serviceTokens: ReadonlyArray<string>;
  /** IDs of service tokens managed outside the stack (e.g. CI's) that the Service Auth policy also admits. */
  readonly allowServiceTokenIds: ReadonlyArray<string>;
  /** Management admins: emails, and service token names (from `serviceTokens`) or Client IDs. */
  readonly adminEmails: ReadonlyArray<string>;
  readonly adminServiceTokens: ReadonlyArray<string>;
  /** Access session duration, e.g. `24h`. */
  readonly sessionDuration: string;
  /** Optional header Access reads a JSON service token from (single-header mode), e.g. `x-api-key`. */
  readonly serviceTokenHeader: string;
  readonly usageRetentionDays: string;
  readonly metaMintUrl: string;
  readonly cpuMs: number;
  /** Local development identity (`alchemy dev` only). */
  readonly devBypass: string;
}

const text = (name: string, fallback = "") =>
  Config.String(name).pipe(Config.withDefault(fallback));

const list = (name: string) =>
  Config.map(text(name), (value) =>
    value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );

const TOKEN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Stage names of pull-request previews (`pr-<number>`, as deployed by .github/workflows/ci.yml). */
export const PREVIEW_STAGE = /^pr-\d+$/;

export const readSettings = (dev: boolean, stage: string) =>
  Effect.gen(function* () {
    const preview = !dev && PREVIEW_STAGE.test(stage);

    const settings: Settings = {
      preview,
      domain: (yield* text("CLIPROXY_DOMAIN")).trim(),
      teamDomain: (yield* text("ACCESS_TEAM_DOMAIN")).trim(),
      existingAud: preview ? "" : (yield* text("ACCESS_AUD")).trim(),
      allowEmails: yield* list("ACCESS_ALLOW_EMAILS"),
      allowEmailDomains: yield* list("ACCESS_ALLOW_EMAIL_DOMAINS"),
      serviceTokens: preview ? [] : yield* list("ACCESS_SERVICE_TOKENS"),
      allowServiceTokenIds: yield* list("ACCESS_ALLOW_SERVICE_TOKEN_IDS"),
      adminEmails: yield* list("ACCESS_ADMIN_EMAILS"),
      adminServiceTokens: yield* list("ACCESS_ADMIN_SERVICE_TOKENS"),
      sessionDuration: (yield* text("ACCESS_SESSION_DURATION", "24h")).trim(),
      serviceTokenHeader: (yield* text("ACCESS_SERVICE_TOKEN_HEADER")).trim(),
      usageRetentionDays: (yield* text("USAGE_RETENTION_DAYS", "30")).trim(),
      metaMintUrl: (yield* text("META_MINT_URL")).trim(),
      cpuMs: yield* Config.Number("CLIPROXY_CPU_MS").pipe(Config.withDefault(300_000)),
      devBypass: (yield* text("ACCESS_DEV_BYPASS", "dev@example.com")).trim(),
    };

    if (dev) return settings;
    const problems: Array<string> = [];

    if (settings.domain === "" && !preview)
      problems.push("CLIPROXY_DOMAIN is required (the Worker's custom hostname)");

    if (settings.teamDomain === "")
      problems.push("ACCESS_TEAM_DOMAIN is required (your Zero Trust team name)");

    if (settings.existingAud === "") {
      if (
        settings.allowEmails.length === 0 &&
        settings.allowEmailDomains.length === 0 &&
        settings.serviceTokens.length === 0 &&
        settings.allowServiceTokenIds.length === 0
      ) {
        problems.push(
          "set ACCESS_ALLOW_EMAILS, ACCESS_ALLOW_EMAIL_DOMAINS, ACCESS_SERVICE_TOKENS and/or ACCESS_ALLOW_SERVICE_TOKEN_IDS, or ACCESS_AUD for an existing Access application",
        );
      }

      for (const name of settings.serviceTokens) {
        if (!TOKEN_NAME.test(name))
          problems.push(`ACCESS_SERVICE_TOKENS: "${name}" must match ${TOKEN_NAME.source}`);
      }
    } else if (settings.serviceTokens.length > 0 || settings.allowServiceTokenIds.length > 0) {
      problems.push(
        "ACCESS_SERVICE_TOKENS and ACCESS_ALLOW_SERVICE_TOKEN_IDS need a stack-managed Access application: unset ACCESS_AUD",
      );
    }

    if (problems.length > 0) {
      // The stack's error channel only carries ConfigError: report invalid combinations as a defect with a readable message.
      return yield* Effect.die(new Error(`Invalid deploy settings:\n- ${problems.join("\n- ")}`));
    }

    return settings;
  });
