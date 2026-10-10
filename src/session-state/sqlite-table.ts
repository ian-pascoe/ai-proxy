/**
 * SQLite-backed {@link StateTable} of the `SessionState` Durable Object.
 *
 * Values are split into chunks of 256 Ki UTF-16 units: a SQLite row (and a Durable Object storage value) is limited to
 * 2 MiB while the Go caches allow up to 16 MiB per entry.
 */
import type { StateRow, StateTable } from "./engine.ts";

const CHUNK_UNITS = 256 * 1024;

interface EntryRow {
  [column: string]: SqlStorageValue;
  generation: number;
  expires_at: number;
  chunks: number;
}

interface ChunkRow {
  [column: string]: SqlStorageValue;
  data: string;
}

export class SqliteStateTable implements StateTable {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_state_entries (
         key TEXT PRIMARY KEY,
         generation INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         chunks INTEGER NOT NULL
       )`,
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS session_state_entries_generation ON session_state_entries (generation)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS session_state_entries_expiry ON session_state_entries (expires_at)",
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_state_chunks (
         key TEXT NOT NULL,
         seq INTEGER NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (key, seq)
       ) WITHOUT ROWID`,
    );
  }

  get(key: string): StateRow | undefined {
    const entry = this.#sql
      .exec<EntryRow>(
        "SELECT generation, expires_at, chunks FROM session_state_entries WHERE key = ?",
        key,
      )
      .toArray()[0];

    if (entry === undefined) return undefined;

    const chunks = this.#sql
      .exec<ChunkRow>("SELECT data FROM session_state_chunks WHERE key = ? ORDER BY seq", key)
      .toArray();

    return {
      value: chunks.map((chunk) => chunk.data).join(""),
      generation: entry.generation,
      expiresAt: entry.expires_at,
    };
  }

  put(key: string, row: StateRow): void {
    const existing = this.#sql
      .exec<EntryRow>(
        "SELECT generation, expires_at, chunks FROM session_state_entries WHERE key = ?",
        key,
      )
      .toArray()[0];

    // The value only changes with a new generation: a sliding expiry update keeps the chunks.
    if (existing === undefined || existing.generation !== row.generation) {
      this.#sql.exec("DELETE FROM session_state_chunks WHERE key = ?", key);
      let seq = 0;

      for (let offset = 0; offset === 0 || offset < row.value.length; offset += CHUNK_UNITS) {
        this.#sql.exec(
          "INSERT INTO session_state_chunks (key, seq, data) VALUES (?, ?, ?)",
          key,
          seq++,
          row.value.slice(offset, offset + CHUNK_UNITS),
        );
      }

      this.#sql.exec(
        "INSERT OR REPLACE INTO session_state_entries (key, generation, expires_at, chunks) VALUES (?, ?, ?, ?)",
        key,
        row.generation,
        row.expiresAt,
        seq,
      );

      return;
    }

    this.#sql.exec(
      "UPDATE session_state_entries SET expires_at = ? WHERE key = ?",
      row.expiresAt,
      key,
    );
  }

  delete(key: string): void {
    this.#sql.exec("DELETE FROM session_state_chunks WHERE key = ?", key);
    this.#sql.exec("DELETE FROM session_state_entries WHERE key = ?", key);
  }

  count(): number {
    return this.#sql
      .exec<{ [column: string]: SqlStorageValue; n: number }>(
        "SELECT COUNT(*) AS n FROM session_state_entries",
      )
      .one().n;
  }

  purgeExpired(now: number): void {
    this.#sql.exec(
      "DELETE FROM session_state_chunks WHERE key IN (SELECT key FROM session_state_entries WHERE expires_at <= ?)",
      now,
    );
    this.#sql.exec("DELETE FROM session_state_entries WHERE expires_at <= ?", now);
  }

  evictOldest(count: number): void {
    const oldest = "SELECT key FROM session_state_entries ORDER BY generation LIMIT ?";
    this.#sql.exec(`DELETE FROM session_state_chunks WHERE key IN (${oldest})`, count);
    this.#sql.exec(`DELETE FROM session_state_entries WHERE key IN (${oldest})`, count);
  }

  nextExpiry(): number | undefined {
    const row = this.#sql
      .exec<{ [column: string]: SqlStorageValue; next: number | null }>(
        "SELECT MIN(expires_at) AS next FROM session_state_entries",
      )
      .one();

    return row.next ?? undefined;
  }

  maxGeneration(): number {
    const row = this.#sql
      .exec<{ [column: string]: SqlStorageValue; max: number | null }>(
        "SELECT MAX(generation) AS max FROM session_state_entries",
      )
      .one();

    return row.max ?? 0;
  }
}
