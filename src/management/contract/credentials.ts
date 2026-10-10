/**
 * `GET /v8/management/credentials`: the credential list (`../credential-entry.ts` builds each entry). Shared with the
 * browser: imports `effect` only. Field names are the wire's (snake_case, like Go's auth-file list).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

export const CredentialStatus = Schema.Literals([
  "unknown",
  "active",
  "pending",
  "refreshing",
  "error",
  "disabled",
]);

export type CredentialStatus = typeof CredentialStatus.Type;

/** One ten-minute bucket of the recent-requests ring, labelled `HH:MM-HH:MM` (UTC). */
export const RecentRequests = Schema.Struct({
  time: Schema.String,
  success: Schema.Number,
  failed: Schema.Number,
});

/** Last observed upstream quota headers (`signals`: lower-cased header name to value). */
export const QuotaObservation = Schema.Struct({
  observed_at: optional(Schema.String),
  signals: Schema.Record(Schema.String, Schema.String),
});

export type QuotaObservation = typeof QuotaObservation.Type;

/** An unexpired retry timer of the credential or one of its models. */
export const Cooldown = Schema.Struct({
  scope: Schema.Literals(["credential", "model"]),
  model_key: optional(Schema.String),
  reason: Schema.String,
  retry_at: Schema.String,
  remaining_seconds: Schema.Number,
  backoff_level: optional(Schema.Number),
  http_status: optional(Schema.Number),
});

export type Cooldown = typeof Cooldown.Type;

export const CredentialEntry = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  status: CredentialStatus,
  status_message: Schema.String,
  disabled: Schema.Boolean,
  unavailable: Schema.Boolean,
  runtime_only: Schema.Boolean,
  source: Schema.String,
  size: Schema.Number,
  success: Schema.Number,
  failed: Schema.Number,
  recent_requests: Schema.Array(RecentRequests),
  quota: QuotaObservation,
  model_quotas: optional(Schema.Record(Schema.String, QuotaObservation)),
  supports_quota: optional(Schema.Boolean),
  email: optional(Schema.String),
  account: optional(Schema.String),
  account_type: optional(Schema.String),
  project_id: optional(Schema.String),
  created_at: optional(Schema.String),
  updated_at: optional(Schema.String),
  last_refresh: optional(Schema.String),
  next_retry_after: optional(Schema.String),
  priority: optional(Schema.Number),
  note: optional(Schema.String),
  weight: optional(Schema.Number),
  cooldowns: Schema.Array(Cooldown),
});

export type CredentialEntry = typeof CredentialEntry.Type;

export const CredentialList = Schema.Struct({ files: Schema.Array(CredentialEntry) });

export class CredentialsGroup extends HttpApiGroup.make("credentials").add(
  HttpApiEndpoint.get("list", "/credentials", {
    success: CredentialList,
    error: managementErrors,
  }),
) {}
