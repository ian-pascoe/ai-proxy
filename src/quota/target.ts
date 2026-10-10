/**
 * What a quota probe needs from one credential, extracted inside the ControlPlane Durable Object from the freshly
 * refreshed credential (`ensureFresh`, the same freshness as `POST /requests/api-call`) and handed to the Worker, which
 * makes the upstream calls (src/quota/probe.ts).
 *
 * Token per provider: the `$TOKEN$` value of api-call (`apiCallToken`) for Claude, Codex, Antigravity, Kimi and xAI;
 * the `dca_token` for Meta (the usage endpoint refuses the minted API key, upstream panel
 * features/quota/providers/meta/requests.ts); the session token for Devin (`devinCredentials`). The target carries
 * token material, so it only ever crosses the RPC boundary to the Worker and is never logged or returned to clients.
 */
import { decodeJwtClaims } from "../credentials/expiry.ts";
import type { Credential } from "../credentials/model.ts";
import { devinCredentials } from "../executor/devin/credentials.ts";
import { isJsonObject, type Json } from "../json/index.ts";
import { apiCallToken } from "../management/credential-ops.ts";
import { kimiUsageUrl } from "./kimi.ts";
import { isDcaToken } from "./meta.ts";
import type { QuotaProvider } from "./report.ts";

export interface QuotaProbeTarget {
  readonly id: string;
  readonly provider: QuotaProvider;
  /** Bearer token (Meta: the `dca_token`; Devin: the session token). */
  readonly token: string;
  /** Codex `Chatgpt-Account-Id`. */
  readonly accountId?: string;
  /** Antigravity Cloud project. */
  readonly projectId?: string;
  /** Kimi usage URL (`api.kimi.com` or `api.kimi.ai`). */
  readonly usageUrl?: string;
  /** xAI subject (`x-userid`). */
  readonly userId?: string;
  /** Devin API base URL and device seed. */
  readonly baseUrl?: string;
  readonly deviceSeed?: string;
}

/** Answer of the `quotaProbeTarget` RPC. `unavailable` is a failed check (it is recorded in the report). */
export type QuotaTargetResult =
  | { readonly ok: true; readonly target: QuotaProbeTarget }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "unsupported"; readonly provider: string }
  | {
      readonly ok: false;
      readonly error: "unavailable";
      readonly id: string;
      readonly message: string;
    };

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** `chatgpt_account_id` of the Codex id token, else the stored `account_id`. */
const codexAccountId = (credential: Pick<Credential, "metadata">): string => {
  const token = text(credential.metadata.id_token);
  const auth = token === "" ? undefined : decodeJwtClaims(token)?.["https://api.openai.com/auth"];
  const claim = isJsonObject(auth) ? text(auth.chatgpt_account_id) : "";

  return claim || text(credential.metadata.account_id);
};

/** `resolveAntigravityProjectId`: `project_id` of the file, of `installed` or of `web`. */
const antigravityProject = (credential: Pick<Credential, "metadata" | "attributes">): string => {
  const { metadata } = credential;

  const nested = (key: string): string => {
    const value = metadata[key];

    return isJsonObject(value) ? text(value.project_id) || text(value.projectId) : "";
  };

  return (
    text(metadata.project_id) ||
    text(metadata.projectId) ||
    (credential.attributes.project_id?.trim() ?? "") ||
    nested("installed") ||
    nested("web")
  );
};

const unavailable = (id: string, message: string): QuotaTargetResult => ({
  ok: false,
  error: "unavailable",
  id,
  message,
});

/** The probe input of a fresh credential of a supported provider. */
export const buildQuotaTarget = (
  credential: Pick<Credential, "id" | "provider" | "metadata" | "attributes">,
  provider: QuotaProvider,
): QuotaTargetResult => {
  const { id } = credential;

  switch (provider) {
    case "meta": {
      const token = text(credential.metadata.dca_token);

      return isDcaToken(token)
        ? { ok: true, target: { id, provider, token } }
        : unavailable(id, "credential has no dca_token");
    }

    case "devin": {
      const devin = devinCredentials({
        id,
        provider: credential.provider,
        kind: "oauth",
        attributes: credential.attributes,
        metadata: credential.metadata,
      });

      if (devin.apiKey === "") return unavailable(id, "credential has no session token");

      return {
        ok: true,
        target: {
          id,
          provider,
          token: devin.apiKey,
          baseUrl: devin.baseUrl,
          deviceSeed: devin.deviceSeed,
        },
      };
    }

    default:
      break;
  }

  const token = apiCallToken(credential);

  if (token === "") return unavailable(id, "credential has no access token");

  switch (provider) {
    case "codex": {
      const accountId = codexAccountId(credential);

      return {
        ok: true,
        target: { id, provider, token, ...(accountId === "" ? {} : { accountId }) },
      };
    }

    case "antigravity": {
      const projectId = antigravityProject(credential);

      return projectId === ""
        ? unavailable(id, "credential has no project_id")
        : { ok: true, target: { id, provider, token, projectId } };
    }

    case "kimi":
    case "kimi-ai":
      return {
        ok: true,
        target: {
          id,
          provider,
          token,
          usageUrl: kimiUsageUrl(credential.provider, credential.metadata),
        },
      };

    case "xai": {
      const userId = text(credential.metadata.sub);

      return { ok: true, target: { id, provider, token, ...(userId === "" ? {} : { userId }) } };
    }

    default:
      return { ok: true, target: { id, provider, token } };
  }
};
