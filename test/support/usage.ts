// Helpers for the usage tests: the D1 schema (the real migration file) and sample records.
import { env } from "cloudflare:workers";
import initial from "../../migrations/0001_usage_records.sql?raw";
import sessions from "../../migrations/0002_usage_sessions.sql?raw";
import { emptyUsageDetail, type UsageRecord } from "../../src/usage/record.ts";

const statementsOf = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/**
 * Applies the checked-in migrations to the test D1 database (idempotent) and empties the table. `ALTER TABLE ... ADD
 * COLUMN` has no IF NOT EXISTS, so a duplicate-column failure of an already migrated database is ignored.
 */
export const resetUsageDb = async (db: D1Database = env.USAGE): Promise<D1Database> => {
  for (const statement of [...statementsOf(initial), ...statementsOf(sessions)]) {
    try {
      await db.prepare(statement.replace(/^CREATE (TABLE|INDEX)/, "CREATE $1 IF NOT EXISTS")).run();
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }

  await db.prepare("DELETE FROM usage_records").run();

  return db;
};

export const sampleRecord = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  requestId: crypto.randomUUID(),
  traceId: "trace-1",
  provider: "codex",
  executorType: "codex",
  model: "gpt-5",
  alias: "gpt-5",
  endpoint: "POST /v1/responses",
  principalId: "user:dev@example.com",
  authId: "codex-a.json",
  authType: "oauth",
  source: "dev@example.com",
  stream: false,
  requestedAt: 1_700_000_000_000,
  latencyMs: 120,
  failed: false,
  detail: {
    ...emptyUsageDetail,
    inputTokens: 100,
    outputTokens: 30,
    reasoningTokens: 12,
    cachedTokens: 40,
    cacheReadTokens: 40,
    totalTokens: 130,
  },
  serviceTier: "auto",
  ...overrides,
});
