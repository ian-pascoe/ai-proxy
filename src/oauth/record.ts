/**
 * Persisting a finished login.
 *
 * Go source: auth_files_fields.go (`saveTokenRecord`, `mergeExistingAuthFileMetadata`), sdk/auth/filestore.go
 * (`Save`: the file always carries `disabled`), sdk/cliproxy/auth/metadata_merge.go (`MergeExistingAuthMetadata`),
 * internal/auth/claude/filename.go (`FindMatchingLegacyCredential`).
 * A re-login keeps the user's settings of the previous file (never its tokens) and a Claude login migrates the legacy
 * `claude-<email>.json` / account-hashed file into the organization-hashed name.
 */
import type { JsonObject } from "../json/index.ts";
import { mergeExistingMetadata } from "../credentials/merge.ts";
import { claudeFileName } from "./flows/claude.ts";
import type { CredentialRecord } from "./flows/types.ts";

/** The slice of the ControlPlane the login flows need (implemented over the credential pool). */
export interface CredentialSink {
  /** The stored auth file `name`, verbatim. */
  readonly get: (name: string) => JsonObject | undefined;
  /** Every stored auth file (id, `type`, content). */
  readonly list: () => ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly metadata: JsonObject;
  }>;
  /** Stores `metadata` verbatim as auth file `name` (replacing a file of that name). */
  readonly save: (
    name: string,
    metadata: JsonObject,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  readonly remove: (id: string) => Promise<void>;
}

const text = (metadata: JsonObject, key: string): string => {
  const value = metadata[key];

  return typeof value === "string" ? value.trim() : "";
};

const baseName = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/** `FindMatchingLegacyCredential` for a hashed Claude target. */
const findClaudeLegacy = async (
  record: CredentialRecord,
  sink: CredentialSink,
): Promise<{ readonly id: string; readonly metadata: JsonObject } | undefined> => {
  const email = text(record.metadata, "email");
  const organization = text(record.metadata, "organization_uuid");
  const account = text(record.metadata, "account_uuid");

  if (email === "" || (organization === "" && account === "")) return undefined;

  if (
    baseName(record.fileName).toLowerCase() !==
    (await claudeFileName(email, organization, account)).toLowerCase()
  ) {
    return undefined;
  }

  const emailName = (await claudeFileName(email, "", "")).toLowerCase();

  const accountName =
    organization !== "" && account !== ""
      ? (await claudeFileName(email, "", account)).toLowerCase()
      : "";

  for (const candidate of sink.list()) {
    if (candidate.type.toLowerCase() !== "claude") continue;
    const name = baseName(candidate.id).toLowerCase();
    const isEmailLegacy = name === emailName;
    const isAccountPredecessor = accountName !== "" && name === accountName;

    if (!isEmailLegacy && !isAccountPredecessor) continue;
    const candidateOrganization = text(candidate.metadata, "organization_uuid");
    const candidateAccount = text(candidate.metadata, "account_uuid");

    if (organization !== "") {
      if (
        candidateOrganization !== "" &&
        candidateOrganization.toLowerCase() === organization.toLowerCase()
      ) {
        return candidate;
      }

      if (
        candidateOrganization === "" &&
        isAccountPredecessor &&
        candidateAccount !== "" &&
        candidateAccount.toLowerCase() === account.toLowerCase()
      ) {
        return candidate;
      }
    } else if (isEmailLegacy && candidateOrganization === "" && account !== "") {
      if (candidateAccount !== "" && candidateAccount.toLowerCase() === account.toLowerCase())
        return candidate;
    }
  }

  return undefined;
};

/** Stores the record; resolves to an error message (never a token) when the credential could not be saved. */
export const saveCredentialRecord = async (
  record: CredentialRecord,
  sink: CredentialSink,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const provider = text(record.metadata, "type");
  let metadata: JsonObject = { ...record.metadata };
  const existing = sink.get(record.fileName);

  if (existing !== undefined) metadata = mergeExistingMetadata(provider, metadata, existing);
  const legacy = provider === "claude" ? await findClaudeLegacy(record, sink) : undefined;

  if (legacy !== undefined && legacy.id !== record.fileName) {
    metadata = mergeExistingMetadata(provider, metadata, legacy.metadata);
  }

  // The Go file store always writes the `disabled` flag (a disabled credential stays disabled across a re-login).
  if (typeof metadata.disabled !== "boolean") metadata.disabled = false;

  const saved = await sink.save(record.fileName, metadata);

  if (!saved.ok) return saved;

  if (legacy !== undefined && legacy.id !== record.fileName) await sink.remove(legacy.id);

  return saved;
};
