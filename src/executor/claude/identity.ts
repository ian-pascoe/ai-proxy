/**
 * Claude Code identity: agent session UUID and `metadata.user_id` (device id, account UUID, session id).
 *
 * Go source: internal/runtime/executor/helps/claude_credential_identity.go (claudeAgentSessionUUID,
 * ApplyClaudeCredentialMetadata, rebuildClaudeMetadataUserID), helps/claude_cli_identity_seed.go (stable device /
 * account identifiers). Deviations: the credential's device-id pool lives in metadata `claude_device_ids` (written at
 * login); when it is missing, and for credentials without `account_uuid`, a stable identifier derived from the
 * credential id is used instead of generating/fetching and persisting one (the OAuth slice owns the profile lookup).
 */
import { createHash, randomUUID } from "node:crypto";
import { get, type Json, type JsonObject, tryParseJson } from "../../json/index.ts";
import { isObj, str } from "../../translator/common/gjson.ts";
import type { CredentialSnapshot } from "../picker.ts";

const OID_NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 version 5 UUID. */
export const uuidV5 = (namespace: string, name: string): string => {
  const nsBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(nsBytes).update(name).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** `stableClaudeCLIDeviceID`. */
export const stableDeviceId = (seed: string): string =>
  createHash("sha256").update(`cpa-claude-code-cli-device|${seed}`).digest("hex");

/** `stableClaudeCLIAccountUUID`. */
export const stableAccountUuid = (seed: string): string =>
  uuidV5(OID_NAMESPACE, `cpa-claude-code-cli-account|${seed}`);

/** `claudeAgentSessionUUID` for one request. */
export const agentSessionUuid = (input: {
  readonly headers: Headers;
  readonly payload: Json | undefined;
  readonly confirmedClaudeCode: boolean;
  readonly sessionId?: string | undefined;
}): string => {
  if (input.confirmedClaudeCode) {
    const header = (input.headers.get("x-claude-code-session-id") ?? "").trim();

    if (UUID.test(header)) return header.toLowerCase();
    const userId = str(get(input.payload, "metadata.user_id"));

    if (userId !== "") {
      // A user id that is not JSON falls through to the protocol session id.
      const session = str(get(tryParseJson(userId), "session_id"));

      if (UUID.test(session)) return session.toLowerCase();
    }
  }

  const identity = (input.sessionId ?? "").trim();

  if (identity === "") return randomUUID();
  const bare = identity.startsWith("claude:") ? identity.slice("claude:".length) : identity;

  if (UUID.test(bare)) return bare.toLowerCase();

  return uuidV5(
    OID_NAMESPACE,
    `cli-proxy-api\u0000claude\u0000agent-conversation\u0000${identity}`,
  );
};

const metadataString = (credential: CredentialSnapshot, ...keys: string[]): string => {
  for (const key of keys) {
    const value = credential.metadata[key];

    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }

  return "";
};

const devicePool = (credential: CredentialSnapshot): string[] => {
  const pool = credential.metadata["claude_device_ids"];

  return Array.isArray(pool)
    ? pool.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))
    : [];
};

export class IdentityError extends Error {
  override readonly name = "IdentityError";
}

/** `rebuildClaudeMetadataUserID`: device/account/session first, then the existing extras in order. */
export const rebuildMetadataUserId = (
  existing: string,
  deviceId: string,
  accountUuid: string,
  sessionId: string,
): string => {
  const extras: Array<[string, Json]> = [];

  // Not JSON: nothing to preserve.
  const parsed = tryParseJson(existing.trim());

  if (isObj(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "device_id" && key !== "account_uuid" && key !== "session_id")
        extras.push([key, value]);
    }
  }

  const out: JsonObject = { device_id: deviceId, account_uuid: accountUuid, session_id: sessionId };

  for (const [key, value] of extras) out[key] = value;

  return JSON.stringify(out);
};

/** `applyClaudeCLIIdentity` / `ApplyClaudeCredentialMetadata`: sets `metadata.user_id` of the upstream body. */
export const applyCLIIdentity = (
  body: JsonObject,
  credential: CredentialSnapshot,
  apiKey: string,
  sessionId: string,
  synthesize: boolean,
): void => {
  const seed = synthesize
    ? apiKey.trim() === ""
      ? "anonymous"
      : apiKey.trim()
    : `oauth|${credential.id}`;

  const pool = devicePool(credential);
  const deviceId = pool[0] ?? stableDeviceId(seed);

  const accountUuid =
    metadataString(credential, "account_uuid", "accountUuid") || stableAccountUuid(seed);

  const metadata = body.metadata;
  const existing = isObj(metadata) ? str(metadata.user_id) : "";
  const userId = rebuildMetadataUserId(existing, deviceId, accountUuid, sessionId);

  if (isObj(metadata)) metadata.user_id = userId;
  else body.metadata = { user_id: userId };
};
