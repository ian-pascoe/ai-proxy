/**
 * SQLite persistence of credentials inside the ControlPlane Durable Object.
 *
 * Auth files are stored as one JSON row each (the Go file *is* `Auth.Metadata`), with `provider`/`disabled`
 * duplicated into indexed columns. Config API-key credentials are never stored: they are re-synthesised from config.
 * Runtime state (`credential_state`) is persisted only when it matters across restarts (failures and cooldowns);
 * round-robin cursors and session bindings stay in memory (credentials.md §10).
 *
 * All methods are synchronous so read-modify-write sequences are atomic under the Durable Object input gate.
 */
import { Effect, Schema } from "effect";
import type { JsonObject } from "../json/index.ts";
import type { StoredCredential } from "./derive.ts";
import { credentialsChanged, mergeExistingMetadata } from "./merge.ts";
import { CredentialState } from "./model.ts";

interface CredentialRow {
  id: string;
  provider: string;
  disabled: number;
  metadata: string;
  credential_version: number;
  created_at: number;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

interface StateRow {
  id: string;
  state: string;
  [column: string]: SqlStorageValue;
}

export interface UpsertOptions {
  /** Carry user settings over from the existing file (re-login semantics, credentials.md §11). */
  readonly mergeExisting: boolean;
}

export interface UpsertOutcome {
  readonly record: StoredCredential;
  readonly created: boolean;
  /** Token/API-key material changed (`credentialVersion` was bumped). */
  readonly credentialsChanged: boolean;
}

const decodeState = Schema.decodeUnknownEffect(CredentialState);

const toRecord = (row: CredentialRow): StoredCredential => ({
  id: row.id,
  provider: row.provider,
  metadata: JSON.parse(row.metadata) as JsonObject,
  credentialVersion: row.credential_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class CredentialStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS credentials (
         id TEXT PRIMARY KEY,
         provider TEXT NOT NULL,
         disabled INTEGER NOT NULL DEFAULT 0,
         metadata TEXT NOT NULL,
         credential_version INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    sql.exec("CREATE INDEX IF NOT EXISTS credentials_provider ON credentials (provider, disabled)");
    sql.exec(
      `CREATE TABLE IF NOT EXISTS credential_state (
         id TEXT PRIMARY KEY,
         state TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  list(): StoredCredential[] {
    return this.#sql
      .exec<CredentialRow>(
        "SELECT id, provider, disabled, metadata, credential_version, created_at, updated_at FROM credentials ORDER BY id",
      )
      .toArray()
      .map(toRecord);
  }

  get(id: string): StoredCredential | undefined {
    const row = this.#sql
      .exec<CredentialRow>(
        "SELECT id, provider, disabled, metadata, credential_version, created_at, updated_at FROM credentials WHERE id = ?",
        id,
      )
      .toArray()[0];

    return row === undefined ? undefined : toRecord(row);
  }

  /** Inserts or replaces one auth file. `incoming` is the complete new file content. */
  upsert(
    id: string,
    provider: string,
    incoming: JsonObject,
    options: UpsertOptions,
  ): UpsertOutcome {
    const existing = this.get(id);

    const metadata =
      existing !== undefined && options.mergeExisting
        ? mergeExistingMetadata(provider, incoming, existing.metadata)
        : incoming;

    const now = this.#now();
    const changed = existing === undefined ? true : credentialsChanged(existing.metadata, metadata);

    const record: StoredCredential = {
      id,
      provider,
      metadata,
      credentialVersion:
        existing === undefined ? 1 : existing.credentialVersion + (changed ? 1 : 0),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.#write(record);

    return { record, created: existing === undefined, credentialsChanged: changed };
  }

  /** Sets the `disabled` flag (persisted in the file JSON like Go). `undefined` when the credential is unknown. */
  setDisabled(id: string, disabled: boolean): StoredCredential | undefined {
    const existing = this.get(id);

    if (existing === undefined) return undefined;

    const record: StoredCredential = {
      ...existing,
      metadata: { ...existing.metadata, disabled },
      updatedAt: this.#now(),
    };

    this.#write(record);

    return record;
  }

  remove(id: string): boolean {
    const existing = this.get(id);

    if (existing === undefined) return false;
    this.#sql.exec("DELETE FROM credentials WHERE id = ?", id);
    this.deleteState(id);

    return true;
  }

  #write(record: StoredCredential): void {
    this.#sql.exec(
      `INSERT INTO credentials (id, provider, disabled, metadata, credential_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, disabled = excluded.disabled,
         metadata = excluded.metadata, credential_version = excluded.credential_version,
         updated_at = excluded.updated_at`,
      record.id,
      record.provider,
      record.metadata.disabled === true ? 1 : 0,
      JSON.stringify(record.metadata),
      record.credentialVersion,
      record.createdAt,
      record.updatedAt,
    );
  }

  /** Persisted runtime states; rows that no longer decode are dropped. */
  loadStates(): Map<string, CredentialState> {
    const states = new Map<string, CredentialState>();

    for (const row of this.#sql
      .exec<StateRow>("SELECT id, state FROM credential_state")
      .toArray()) {
      try {
        const decoded = Effect.runSync(Effect.result(decodeState(JSON.parse(row.state))));

        if (decoded._tag === "Success") states.set(row.id, decoded.success);
        else this.deleteState(row.id);
      } catch {
        this.deleteState(row.id);
      }
    }

    return states;
  }

  saveState(id: string, state: CredentialState): void {
    this.#sql.exec(
      `INSERT INTO credential_state (id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      id,
      JSON.stringify(state),
      this.#now(),
    );
  }

  deleteState(id: string): void {
    this.#sql.exec("DELETE FROM credential_state WHERE id = ?", id);
  }
}
