/**
 * SQLite persistence of the quota reports inside the ControlPlane Durable Object, next to the credential runtime state
 * (`credential_state`, src/credentials/store.ts) and following the same pattern: one JSON row per credential id,
 * decoded with the schema on read; rows that no longer decode are dropped.
 *
 * A separate table rather than a field of `CredentialState`: the report is written by the quota check only, must
 * survive restarts whatever `save-cooldown-status` says, and is not touched by the cooldown state machine or a
 * cooldown reset. It is deleted with its credential and when a re-login replaces the credential's tokens.
 *
 * All methods are synchronous so read-modify-write sequences are atomic under the Durable Object input gate.
 */
import { Option, Schema } from "effect";
import { QuotaReport } from "../management/contract/credentials.ts";
import { tryParseJson } from "../json/index.ts";

interface ReportRow {
  id: string;
  report: string;
  [column: string]: SqlStorageValue;
}

const decodeReport = Schema.decodeUnknownOption(QuotaReport);

export class QuotaReportStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS credential_quota_report (
         id TEXT PRIMARY KEY,
         report TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  #decode(row: ReportRow): QuotaReport | undefined {
    const parsed = tryParseJson(row.report);
    const decoded = parsed === undefined ? undefined : Option.getOrUndefined(decodeReport(parsed));

    if (decoded !== undefined) return decoded;
    this.delete(row.id);

    return undefined;
  }

  get(id: string): QuotaReport | undefined {
    const row = this.#sql
      .exec<ReportRow>("SELECT id, report FROM credential_quota_report WHERE id = ?", id)
      .toArray()[0];

    return row === undefined ? undefined : this.#decode(row);
  }

  /** Every stored report by credential id. */
  all(): Map<string, QuotaReport> {
    const reports = new Map<string, QuotaReport>();

    for (const row of this.#sql
      .exec<ReportRow>("SELECT id, report FROM credential_quota_report")
      .toArray()) {
      const report = this.#decode(row);

      if (report !== undefined) reports.set(row.id, report);
    }

    return reports;
  }

  put(id: string, report: QuotaReport): void {
    this.#sql.exec(
      `INSERT INTO credential_quota_report (id, report, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET report = excluded.report, updated_at = excluded.updated_at`,
      id,
      JSON.stringify(report),
      this.#now(),
    );
  }

  delete(id: string): void {
    this.#sql.exec("DELETE FROM credential_quota_report WHERE id = ?", id);
  }
}
