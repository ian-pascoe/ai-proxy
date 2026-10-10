import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Settings } from "./settings.ts";

/** Where `alchemy deploy` writes the service token credentials (gitignored, mode 0600). */
export const SERVICE_TOKENS_FILE = ".alchemy/access-service-tokens.json";

/** Values the Worker needs from the Access setup (see src/access). */
export interface AccessWiring {
  readonly aud: string | Output.Output<string>;
  readonly adminServiceTokens: string | Output.Output<string>;
  readonly serviceTokenClientIds: Record<string, Output.Output<string>>;
  /** The stack's application on preview stages, where the Worker enrolls into it (`access` prop) for `workers.dev`. */
  readonly application?: Cloudflare.Access.Application;
}

/**
 * Re-applies the cookie and single-header settings the Alchemy `Access.Application` resource does not manage.
 * Cloudflare's update endpoint is PUT-style, so every update of the application by Alchemy resets them; the
 * application's `updatedAt` is part of the input so this runs again after each such update.
 */
const ApplicationSettings = Alchemy.Action(
  "CliproxyAccessApplicationSettings",
  Effect.fn(function* (input: {
    readonly accountId: string;
    readonly applicationId: string;
    readonly updatedAt: string | undefined;
    readonly serviceTokenHeader: string;
  }) {
    // The GET response is a union over every application type; only the fields Alchemy manages are copied back.
    // SAFETY: every member of the response union has these fields with these types (all optional, read-only here).
    const app = (yield* zeroTrust.getAccessApplicationForAccount({
      accountId: input.accountId,
      appId: input.applicationId,
    })) as {
      readonly domain?: string;
      readonly type?: string;
      readonly name?: string;
      readonly sessionDuration?: string;
      readonly allowedIdps?: Array<string>;
      readonly autoRedirectToIdentity?: boolean;
      readonly appLauncherVisible?: boolean;
      readonly tags?: Array<string>;
      readonly policies?: ReadonlyArray<{ readonly id?: string; readonly precedence?: number }>;
      readonly destinations?: zeroTrust.AccessApplicationsUpdateRequestDestinationsList;
    };

    yield* zeroTrust.updateAccessApplicationForAccount({
      accountId: input.accountId,
      appId: input.applicationId,
      // Preview applications have no domain: they protect the Worker through its `worker` destinations, which a
      // PUT without them would drop.
      ...(app.domain === undefined
        ? app.destinations === undefined
          ? {}
          : { destinations: app.destinations }
        : { domain: app.domain }),
      type: app.type ?? "self_hosted",
      ...(app.name === undefined ? {} : { name: app.name }),
      ...(app.sessionDuration === undefined ? {} : { sessionDuration: app.sessionDuration }),
      ...(app.allowedIdps === undefined ? {} : { allowedIdps: app.allowedIdps }),
      ...(app.autoRedirectToIdentity === undefined
        ? {}
        : { autoRedirectToIdentity: app.autoRedirectToIdentity }),
      ...(app.appLauncherVisible === undefined
        ? {}
        : { appLauncherVisible: app.appLauncherVisible }),
      ...(app.tags === undefined ? {} : { tags: app.tags }),
      policies: (app.policies ?? []).flatMap((policy) =>
        policy.id === undefined
          ? []
          : [
              {
                id: policy.id,
                ...(policy.precedence === undefined ? {} : { precedence: policy.precedence }),
              },
            ],
      ),
      // CSRF defence in depth: the session cookie is not sent on cross-site subrequests (docs/ACCESS.md).
      sameSiteCookieAttribute: "lax",
      httpOnlyCookieAttribute: true,
      ...(input.serviceTokenHeader === ""
        ? {}
        : { readServiceTokensFromHeader: input.serviceTokenHeader }),
    });

    return { applied: true };
  }),
);

/** Writes the client credentials of the stack's service tokens to {@link SERVICE_TOKENS_FILE} on the deploying machine. */
const WriteServiceTokens = Alchemy.Action(
  "CliproxyWriteServiceTokens",
  Effect.fn(function* (input: {
    readonly tokens: ReadonlyArray<{
      readonly name: string;
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted | undefined;
    }>;
  }) {
    const path = resolve(SERVICE_TOKENS_FILE);

    const body = Object.fromEntries(
      input.tokens.map((token) => [
        token.name,
        {
          "CF-Access-Client-Id": token.clientId,
          "CF-Access-Client-Secret":
            token.clientSecret === undefined ? null : Redacted.value(token.clientSecret),
        },
      ]),
    );

    yield* Effect.promise(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    });

    return { path };
  }),
);

/**
 * Cloudflare Access for the Worker's custom domain: one self-hosted application covering the whole hostname, an Allow
 * policy for people, a Service Auth policy for the stack's service tokens (and `ACCESS_ALLOW_SERVICE_TOKEN_IDS`), and
 * the tokens themselves. With `ACCESS_AUD` set, an application managed elsewhere is used instead and nothing is
 * created. Preview stages get an application without a domain that the Worker enrolls into (see `application`).
 */
export const provisionAccess = (settings: Settings) =>
  Effect.gen(function* () {
    if (settings.existingAud !== "") {
      const wiring: AccessWiring = {
        aud: settings.existingAud,
        adminServiceTokens: settings.adminServiceTokens.join(","),
        serviceTokenClientIds: {},
      };

      return wiring;
    }

    const tokens: Array<{ readonly name: string; readonly token: Cloudflare.Access.ServiceToken }> =
      [];

    for (const name of settings.serviceTokens) {
      tokens.push({
        name,
        token: yield* Cloudflare.Access.ServiceToken(`ServiceToken-${name}`, {}),
      });
    }

    const policies: Array<Output.Output<string>> = [];

    const people = [
      ...settings.allowEmails.map((email) => ({ email })),
      ...settings.allowEmailDomains.map((emailDomain) => ({ emailDomain })),
    ];

    if (people.length > 0) {
      const allow = yield* Cloudflare.Access.Policy("AllowUsers", {
        decision: "allow",
        include: people,
      });

      policies.push(allow.policyId);
    }

    const serviceTokenIds: Array<string | Output.Output<string>> = [
      ...tokens.map(({ token }) => token.serviceTokenId),
      ...settings.allowServiceTokenIds,
    ];

    if (serviceTokenIds.length > 0) {
      const serviceAuth = yield* Cloudflare.Access.Policy("AllowServiceTokens", {
        decision: "non_identity",
        include: serviceTokenIds.map((serviceToken) => ({ serviceToken })),
      });

      policies.push(serviceAuth.policyId);
    }

    const app = yield* Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      ...(settings.preview ? {} : { domain: settings.domain }),
      sessionDuration: settings.sessionDuration,
      policies,
    });

    yield* ApplicationSettings({
      accountId: app.accountId,
      applicationId: app.applicationId,
      updatedAt: app.updatedAt,
      serviceTokenHeader: settings.serviceTokenHeader,
    });

    if (tokens.length > 0) {
      yield* WriteServiceTokens({
        tokens: tokens.map(({ name, token }) => ({
          name,
          clientId: token.clientId,
          clientSecret: token.clientSecret,
        })),
      });
    }

    // Admin service tokens may be named by their stack token name or given as a Client ID.
    const clientIds = Object.fromEntries(tokens.map(({ name, token }) => [name, token.clientId]));
    const named = settings.adminServiceTokens.some((entry) => clientIds[entry] !== undefined);

    const adminIds = settings.adminServiceTokens.map((entry) =>
      Output.asOutput(clientIds[entry] ?? entry),
    );

    // `Output.all` only types tuples, so the Client IDs are joined pairwise ("a,b,c" as `ids.join(",")` would).
    const joinedAdminIds = adminIds.reduce<Output.Output<string> | undefined>(
      (joined, id) =>
        joined === undefined
          ? id
          : Output.all(joined, id).pipe(Output.map(([left, right]) => `${left},${right}`)),
      undefined,
    );

    const wiring: AccessWiring = {
      aud: app.aud,
      adminServiceTokens:
        named && joinedAdminIds !== undefined
          ? joinedAdminIds
          : settings.adminServiceTokens.join(","),
      serviceTokenClientIds: clientIds,
      ...(settings.preview ? { application: app } : {}),
    };

    return wiring;
  });
