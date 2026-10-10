/**
 * Name-based (v5) UUIDs, matching Go `uuid.NewSHA1` (google/uuid).
 */
import { createHash } from "node:crypto";

/** `uuid.NameSpaceOID`. */
export const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

const hexBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");

/** `uuid.NewSHA1(namespace, data).String()`. */
export const uuidV5 = (namespace: string, name: string): string => {
  const hash = createHash("sha1").update(hexBytes(namespace)).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** `uuidV5(NameSpaceOID, name)`. */
export const uuidV5Oid = (name: string): string => uuidV5(NAMESPACE_OID, name);

/** `helps.stableProviderSessionUUID`: provider-scoped stable UUID of a session identity (`""` for an empty one). */
export const providerSessionUuid = (
  provider: string,
  kind: string,
  identity: string | undefined,
): string => {
  const name = provider.trim().toLowerCase();
  const value = (identity ?? "").trim();

  return name === "" || value === ""
    ? ""
    : uuidV5Oid(["cli-proxy-api", name, kind, value].join("\u0000"));
};
