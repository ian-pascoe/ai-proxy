// Test helpers for credential selection: builders for credentials/state and a pick harness with an injected clock.
import {
  type Credential,
  type CredentialState,
  type ModelState,
  emptyQuota,
  emptyState,
} from "../../src/credentials/model.ts";
import {
  type CredentialEntry,
  type SelectionSettings,
  selectCredential,
} from "../../src/credentials/selection/pick.ts";
import { SessionCache } from "../../src/credentials/selection/affinity.ts";
import { RotationState } from "../../src/credentials/selection/strategies.ts";
import type { PickRequest } from "../../src/credentials/selection/types.ts";

export const NOW = 1_800_000_000_000;

export const cred = (id: string, overrides: Partial<Credential> = {}): Credential => ({
  id,
  provider: "gemini",
  source: "file",
  authKind: "oauth",
  label: id,
  disabled: false,
  priority: 0,
  weight: 1,
  attributes: {},
  metadata: {},
  headers: {},
  excludedModels: [],
  modelAliases: [],
  credentialVersion: 1,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

export const state = (overrides: Partial<CredentialState> = {}): CredentialState => ({
  ...emptyState(),
  ...overrides,
});

/** A cooling model state (`unavailable` until `next`, optionally with quota). */
export const cooling = (next: number, quota = false): ModelState => ({
  status: "active",
  unavailable: true,
  nextRetryAfter: next,
  quota: quota ? { ...emptyQuota(), exceeded: true, nextRecoverAt: next } : emptyQuota(),
  updatedAt: 0,
});

export const entry = (
  credential: Credential,
  credentialState: CredentialState = emptyState(),
): CredentialEntry => ({
  credential,
  state: credentialState,
});

export const defaultSettings: SelectionSettings = {
  strategy: "round-robin",
  sessionAffinity: false,
  sessionAffinitySubagents: true,
  forceModelPrefix: false,
  oauthModelAlias: {},
};

/** Holds rotation/affinity state across picks like the ControlPlane pool does. */
export class Harness {
  readonly rotation = new RotationState();
  readonly affinity = new SessionCache(60_000);
  now = NOW;

  constructor(public settings: SelectionSettings = defaultSettings) {}

  select(entries: ReadonlyArray<CredentialEntry>, request: Partial<PickRequest> = {}) {
    return selectCredential({
      credentials: entries,
      request: { providers: ["gemini"], model: "model", ...request },
      settings: this.settings,
      runtime: { rotation: this.rotation, affinity: this.affinity },
      now: this.now,
    });
  }

  /** Picked credential id, or `failure:<code>`. */
  id(entries: ReadonlyArray<CredentialEntry>, request: Partial<PickRequest> = {}): string {
    const outcome = this.select(entries, request);

    return outcome.ok ? outcome.entry.credential.id : `failure:${outcome.failure.code}`;
  }

  ids(
    entries: ReadonlyArray<CredentialEntry>,
    count: number,
    request: Partial<PickRequest> = {},
  ): string[] {
    return Array.from({ length: count }, () => this.id(entries, request));
  }

  counts(
    entries: ReadonlyArray<CredentialEntry>,
    count: number,
    request: Partial<PickRequest> = {},
  ) {
    const out: Record<string, number> = {};

    for (const id of this.ids(entries, count, request)) out[id] = (out[id] ?? 0) + 1;

    return out;
  }
}
