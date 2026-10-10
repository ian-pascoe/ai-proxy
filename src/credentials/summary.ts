/**
 * Management-facing credential views (never contain token material) and executor snapshots (do).
 */
import type { Schema } from "effect";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import type { RecentBucket } from "./cooldown/recent-requests.ts";
import { accessTokenExpiry } from "./expiry.ts";
import {
  type Credential,
  type CredentialError,
  type CredentialState,
  executorKey,
} from "./model.ts";
import type { CredentialSnapshot } from "./selection/types.ts";

const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|session_id|dca/i;

const SAFE_KEYS = new Set(["token_type", "token_endpoint", "dca_expired", "dca_expires_at"]);

const SECRET_ATTRIBUTES = new Set(["api_key"]);

/** Last four characters only, so a key is recognisable without being usable. */
export const maskSecret = (value: string): string =>
  value.length <= 8 ? "[redacted]" : `[redacted]…${value.slice(-4)}`;

const redactValue = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(redactValue);

  if (isJsonObject(value)) return redactMetadata(value);

  return value;
};

/** Copy of auth-file metadata with every secret-looking value replaced. */
export const redactMetadata = (metadata: JsonObject): JsonObject => {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY.test(key) && !SAFE_KEYS.has(key)) {
      out[key] =
        typeof value === "string" && value !== ""
          ? maskSecret(value)
          : value === null
            ? null
            : "[redacted]";
    } else {
      out[key] = redactValue(value);
    }
  }

  return out;
};

export interface CredentialSummary {
  readonly id: string;
  readonly provider: string;
  readonly executor: string;
  readonly source: Credential["source"];
  readonly authKind?: Credential["authKind"];
  readonly label: string;
  readonly prefix?: string;
  readonly disabled: boolean;
  readonly priority: number;
  readonly weight: number;
  readonly attributes: Readonly<Record<string, string>>;
  readonly headerNames: ReadonlyArray<string>;
  readonly excludedModels: ReadonlyArray<string>;
  /** Redacted auth-file JSON. */
  readonly metadata: Readonly<Record<string, Schema.MutableJson>>;
  readonly credentialVersion: number;
  /** Access-token expiry (epoch ms) when known. */
  readonly expiresAt?: number;
  readonly status: CredentialState["status"];
  readonly statusMessage?: string;
  readonly unavailable: boolean;
  readonly nextRetryAfter: number;
  readonly quota: {
    readonly exceeded: boolean;
    readonly reason?: string;
    readonly nextRecoverAt: number;
  };
  readonly lastError?: CredentialError;
  readonly success: number;
  readonly failed: number;
  /** Raw recent-requests ring (see `recentRequestsSnapshot`), when any request was reported. */
  readonly recentRequests?: ReadonlyArray<RecentBucket>;
  readonly modelStates: Readonly<
    Record<
      string,
      {
        readonly unavailable: boolean;
        readonly nextRetryAfter: number;
        readonly statusMessage?: string;
      }
    >
  >;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const summarizeCredential = (
  credential: Credential,
  state: CredentialState,
): CredentialSummary => {
  const attributes: Record<string, string> = {};

  for (const [key, value] of Object.entries(credential.attributes)) {
    attributes[key] = SECRET_ATTRIBUTES.has(key) ? maskSecret(value) : value;
  }

  const expiresAt = accessTokenExpiry(credential.metadata, state.rejectedAccessToken);
  const modelStates: Record<
    string,
    { unavailable: boolean; nextRetryAfter: number; statusMessage?: string }
  > = {};

  for (const [model, modelState] of Object.entries(state.modelStates)) {
    modelStates[model] = {
      unavailable: modelState.unavailable,
      nextRetryAfter: modelState.nextRetryAfter,
      ...(modelState.statusMessage === undefined
        ? {}
        : { statusMessage: modelState.statusMessage }),
    };
  }

  return {
    id: credential.id,
    provider: credential.provider,
    executor: executorKey(credential),
    source: credential.source,
    ...(credential.authKind === undefined ? {} : { authKind: credential.authKind }),
    label: credential.label,
    ...(credential.prefix === undefined ? {} : { prefix: credential.prefix }),
    disabled: credential.disabled,
    priority: credential.priority,
    weight: credential.weight,
    attributes,
    headerNames: Object.keys(credential.headers),
    excludedModels: credential.excludedModels,
    metadata: redactMetadata(credential.metadata),
    credentialVersion: credential.credentialVersion,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    status: credential.disabled ? "disabled" : state.status,
    ...(state.statusMessage === undefined ? {} : { statusMessage: state.statusMessage }),
    unavailable: state.unavailable,
    nextRetryAfter: state.nextRetryAfter,
    quota: {
      exceeded: state.quota.exceeded,
      ...(state.quota.reason === undefined ? {} : { reason: state.quota.reason }),
      nextRecoverAt: state.quota.nextRecoverAt,
    },
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    success: state.success,
    failed: state.failed,
    ...(state.recentRequests === undefined ? {} : { recentRequests: state.recentRequests }),
    modelStates,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
};

const stringField = (value: Json | undefined): string =>
  typeof value === "string" ? value.trim() : "";

/** Credential plus resolved executor key and base URL: the data an executor needs to call the upstream. */
export const toSnapshot = (credential: Credential): CredentialSnapshot => {
  const baseUrl =
    credential.attributes.base_url?.trim() || stringField(credential.metadata.base_url);

  return {
    ...credential,
    ...(baseUrl === "" ? {} : { baseUrl }),
    executor: executorKey(credential),
  };
};
