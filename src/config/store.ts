/**
 * Versioned config storage inside the ControlPlane Durable Object (SQLite).
 *
 * The document is the canonical v8 JSON produced by `encodeConfig`. The version starts at 0 (nothing stored: defaults)
 * and increases by one on every write. All methods are synchronous so a read-check-write sequence is atomic under the
 * Durable Object input gate.
 */
import { Effect, Result, Schema } from "effect";
import type { Json } from "../json/index.ts";
import { decodeConfig, encodeConfig, parseConfigYaml } from "./codec.ts";
import { notAppliedSettings } from "./not-applied.ts";
import { Config } from "./schema.ts";

/** What `getConfig` returns over RPC (plain data only). */
export interface ConfigSnapshotWire {
  readonly version: number;
  /** Canonical JSON document; omitted when the caller already has `version` (`unchanged`). */
  readonly document?: string;
  readonly unchanged: boolean;
  /** Epoch milliseconds of the last write (0 when nothing was stored). */
  readonly updatedAt: number;
}

export type PutConfigResult =
  | {
      readonly ok: true;
      readonly version: number;
      readonly document: string;
      readonly updatedAt: number;
      /** Keys set in the document that have no effect on Workers (`not-applied.ts`). */
      readonly notApplied: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: "invalid"; readonly message: string }
  | {
      readonly ok: false;
      readonly error: "conflict";
      readonly message: string;
      readonly currentVersion: number;
    };

interface Row {
  version: number;
  document: string;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

export class ConfigStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS config (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         version INTEGER NOT NULL,
         document TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  #read(): Row | undefined {
    return this.#sql
      .exec<Row>("SELECT version, document, updated_at FROM config WHERE id = 1")
      .toArray()[0];
  }

  #defaultDocument(): string {
    return JSON.stringify(encodeConfig(Schema.decodeUnknownSync(Config)({})));
  }

  get(sinceVersion?: number): ConfigSnapshotWire {
    const row = this.#read();
    const version = row?.version ?? 0;
    const updatedAt = row?.updated_at ?? 0;

    if (sinceVersion !== undefined && sinceVersion === version)
      return { version, unchanged: true, updatedAt };

    return {
      version,
      unchanged: false,
      document: row?.document ?? this.#defaultDocument(),
      updatedAt,
    };
  }

  /**
   * Validates `text` (YAML or JSON, v8 or legacy layout), normalises it and stores the canonical document.
   * With `expectedVersion`, the write fails with `conflict` unless it equals the current version.
   */
  put(text: string, expectedVersion?: number): PutConfigResult {
    const current = this.#read()?.version ?? 0;

    if (expectedVersion !== undefined && expectedVersion !== current) {
      return {
        ok: false,
        error: "conflict",
        message: `config version is ${current}, expected ${expectedVersion}`,
        currentVersion: current,
      };
    }

    const parsed = Effect.runSync(Effect.result(parseConfigYaml(text)));

    if (Result.isFailure(parsed))
      return { ok: false, error: "invalid", message: parsed.failure.message };
    // Round-trip through the schema so the stored document is exactly what readers will decode.
    const document = JSON.stringify(encodeConfig(parsed.success));
    const version = current + 1;
    const updatedAt = this.#now();
    this.#sql.exec(
      `INSERT INTO config (id, version, document, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, document = excluded.document, updated_at = excluded.updated_at`,
      version,
      document,
      updatedAt,
    );

    return {
      ok: true,
      version,
      document,
      updatedAt,
      notApplied: notAppliedSettings(parsed.success),
    };
  }
}

/** Decodes a stored/wire JSON document into a `Config` (the DO already validated it on write). */
export const decodeStoredConfig = (document: string) =>
  Effect.try({
    try: (): Json => JSON.parse(document),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(decodeConfig));
