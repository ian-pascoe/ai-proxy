// How an account is named and what the operator needs to know about it, shared by the overview and the Accounts
// pages. Pure: no DOM, tested in test/web-quota.test.ts.
import type { CredentialEntry } from "#contract/credentials.ts";
import { type AccountStanding, accountStanding } from "./quota.ts";

/** The account's address or label, whichever it has (the file name as a last resort). */
export const accountName = (entry: CredentialEntry): string =>
  [entry.email, entry.account, entry.label].find(
    (name) => name !== undefined && name !== "" && name !== entry.provider,
  ) ?? entry.name;

export interface Assessed {
  readonly entry: CredentialEntry;
  readonly standing: AccountStanding;
  /** Closed or failing: the red trail mark beside the name. */
  readonly closed: boolean;
  /** What the operator needs to know, shown under the name ("Closed", "Failing: ..."); none when healthy. */
  readonly note: string | undefined;
  /** The note's tone: red when closed, ink when near the limit, stone when disabled. */
  readonly tone: "closed" | "near" | "disabled" | undefined;
}

export const assess = (entry: CredentialEntry): Assessed => {
  const standing = accountStanding(entry);

  if (entry.disabled) {
    return { entry, standing, closed: false, note: "Disabled", tone: "disabled" };
  }

  if (standing.cutOffUntil !== undefined) {
    return {
      entry,
      standing,
      closed: true,
      note: "Closed by the provider's rate limit",
      tone: "closed",
    };
  }

  if (entry.status === "error") {
    const detail = entry.status_message === "" ? "" : `: ${entry.status_message}`;

    return { entry, standing, closed: true, note: `Failing${detail}`, tone: "closed" };
  }

  if (standing.level === "near") {
    return { entry, standing, closed: false, note: "Near its limit", tone: "near" };
  }

  return { entry, standing, closed: false, note: undefined, tone: undefined };
};

/** Providers whose tokens the server can refresh on request (src/credentials/refresh/registry.ts). */
const REFRESHABLE = new Set([
  "claude",
  "codex",
  "antigravity",
  "xai",
  "kimi",
  "kimi-ai",
  "meta",
  "vertex",
]);

export const refreshable = (provider: string): boolean => REFRESHABLE.has(provider);
