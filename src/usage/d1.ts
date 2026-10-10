/**
 * D1 persistence of usage records: schema mapping, the queue/record JSON shape, queries and retention.
 *
 * Go source: internal/redisqueue/plugin.go (queuedUsageDetail: the export JSON, pipeline.md §8.4) and
 * internal/redisqueue/queue.go (PopOldest). Go keeps records in an in-process queue for 60 s; here they live in D1
 * (`migrations/0001_usage_records.sql`) and the "queue" is the set of records not yet exported.
 */
import { authIndexOf } from "../management/auth-index.ts"
import { normalizeToCanonicalUuid } from "../session-routing/identity.ts"
import { ensureTokenBreakdown, TOKEN_ACCOUNTING_SCHEMA_VERSION, type TokenBreakdown } from "./accounting.ts"
import type { UsageRecord } from "./record.ts"

/** Upstream error bodies are truncated before they are stored. */
export const MAX_FAIL_BODY_CHARS = 2048

/** One `usage_records` row. */
export interface UsageRow {
  request_id: string
  trace_id: string | null
  requested_at: number
  latency_ms: number
  ttft_ms: number | null
  provider: string
  executor_type: string
  model: string
  alias: string
  response_model: string | null
  endpoint: string
  principal_id: string
  auth_id: string
  auth_type: string
  source: string
  stream: number
  generate: number
  failed: number
  fail_status: number | null
  fail_body: string | null
  reasoning_effort: string | null
  service_tier: string
  response_service_tier: string | null
  session_id: string | null
  parent_session_id: string | null
  base_url: string | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cached_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  total_tokens: number
  accounting_version: number
  acct_quality: string
  acct_total_tokens: number
  acct_input_tokens: number
  acct_input_uncached_tokens: number
  acct_cache_read_tokens: number
  acct_cache_write_tokens: number
  acct_output_tokens: number
  acct_output_non_reasoning_tokens: number
  acct_output_reasoning_tokens: number
  acct_unclassified_tokens: number
  exported_at: number | null
}

type Column = keyof UsageRow

/** Insert order; `exported_at` stays NULL. */
const INSERT_COLUMNS = [
  "request_id",
  "trace_id",
  "requested_at",
  "latency_ms",
  "ttft_ms",
  "provider",
  "executor_type",
  "model",
  "alias",
  "response_model",
  "endpoint",
  "principal_id",
  "auth_id",
  "auth_type",
  "source",
  "stream",
  "generate",
  "failed",
  "fail_status",
  "fail_body",
  "reasoning_effort",
  "service_tier",
  "response_service_tier",
  "session_id",
  "parent_session_id",
  "base_url",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_tokens",
  "accounting_version",
  "acct_quality",
  "acct_total_tokens",
  "acct_input_tokens",
  "acct_input_uncached_tokens",
  "acct_cache_read_tokens",
  "acct_cache_write_tokens",
  "acct_output_tokens",
  "acct_output_non_reasoning_tokens",
  "acct_output_reasoning_tokens",
  "acct_unclassified_tokens"
] as const satisfies ReadonlyArray<Column>

const INSERT_SQL = `INSERT OR IGNORE INTO usage_records (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(
  () => "?"
).join(", ")})`

const trimmedOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ""
  return trimmed === "" ? null : trimmed
}

/** Maps a record (with its v2 breakdown ensured) to a row without `exported_at`. */
export const recordToRow = (record: UsageRecord): Omit<UsageRow, "exported_at"> => {
  const detail = ensureTokenBreakdown(record.detail, record.provider, record.executorType)
  const breakdown = detail.tokenBreakdown as TokenBreakdown
  return {
    request_id: record.requestId,
    trace_id: trimmedOrNull(record.traceId),
    requested_at: record.requestedAt,
    latency_ms: record.latencyMs,
    ttft_ms: record.ttftMs ?? null,
    provider: record.provider.trim() === "" ? "unknown" : record.provider.trim(),
    executor_type: record.executorType.trim() === "" ? "unknown" : record.executorType.trim(),
    model: record.model,
    alias: record.alias.trim() === "" ? record.model : record.alias,
    response_model: trimmedOrNull(record.responseModel),
    endpoint: record.endpoint,
    principal_id: record.principalId,
    auth_id: record.authId,
    auth_type: record.authType.trim() === "" ? "unknown" : record.authType.trim(),
    source: record.source,
    stream: record.stream ? 1 : 0,
    generate: record.generate === false ? 0 : 1,
    failed: record.failed ? 1 : 0,
    fail_status: record.failed ? (record.fail?.statusCode ?? 500) : null,
    fail_body: record.failed ? (record.fail?.body ?? "").trim().slice(0, MAX_FAIL_BODY_CHARS) : null,
    reasoning_effort: trimmedOrNull(record.reasoningEffort),
    service_tier: record.serviceTier,
    response_service_tier: trimmedOrNull(detail.responseServiceTier),
    session_id: trimmedOrNull(record.sessionId),
    parent_session_id: trimmedOrNull(record.parentSessionId),
    base_url: trimmedOrNull(record.baseUrl),
    input_tokens: detail.inputTokens,
    output_tokens: detail.outputTokens,
    reasoning_tokens: detail.reasoningTokens,
    cached_tokens: detail.cachedTokens,
    cache_read_tokens: detail.cacheReadTokens,
    cache_creation_tokens: detail.cacheCreationTokens,
    total_tokens: detail.totalTokens,
    accounting_version: breakdown.schemaVersion,
    acct_quality: breakdown.quality,
    acct_total_tokens: breakdown.totalTokens,
    acct_input_tokens: breakdown.input.totalTokens,
    acct_input_uncached_tokens: breakdown.input.uncachedTokens,
    acct_cache_read_tokens: breakdown.input.cacheReadTokens,
    acct_cache_write_tokens: breakdown.input.cacheWriteTokens,
    acct_output_tokens: breakdown.output.totalTokens,
    acct_output_non_reasoning_tokens: breakdown.output.nonReasoningTokens,
    acct_output_reasoning_tokens: breakdown.output.reasoningTokens,
    acct_unclassified_tokens: breakdown.unclassifiedTokens
  }
}

/** Stores one record (idempotent on `request_id`). */
export const insertUsageRecord = async (db: D1Database, record: UsageRecord): Promise<void> => {
  const row = recordToRow(record)
  await db
    .prepare(INSERT_SQL)
    .bind(...INSERT_COLUMNS.map((column) => row[column]))
    .run()
}

// ---------------------------------------------------------------------------------------------------------------
// JSON shape (redisqueue queuedUsageDetail)
// ---------------------------------------------------------------------------------------------------------------

/** `session_id`/`parent_session_id` of the export: canonical UUIDs, the parent only when it differs (redisqueue). */
const sessionPayload = (row: UsageRow): Record<string, string> => {
  const sessionId = normalizeToCanonicalUuid(row.session_id ?? "")
  if (sessionId === "") return {}
  const parent = normalizeToCanonicalUuid(row.parent_session_id ?? "")
  return { session_id: sessionId, ...(parent === "" || parent === sessionId ? {} : { parent_session_id: parent }) }
}

/** The export JSON of one record. `api_key` carries the Access principal id (the Go client API key). */
export const rowToPayload = (row: UsageRow): Record<string, unknown> => {
  const failed = row.failed === 1
  return {
    timestamp: new Date(row.requested_at).toISOString(),
    latency_ms: row.latency_ms,
    ttft_ms: row.ttft_ms ?? 0,
    source: row.source,
    // The management API's `auth_index` (a stable hash of the credential id), so collectors can join the two.
    auth_index: authIndexOf(row.auth_id),
    tokens: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      reasoning_tokens: row.reasoning_tokens,
      cached_tokens: row.cached_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_read_tokens_present: true,
      cache_creation_tokens: row.cache_creation_tokens,
      total_tokens: row.total_tokens
    },
    failed,
    generate: row.generate !== 0,
    stream: row.stream === 1,
    fail: failed ? { status_code: row.fail_status ?? 500, body: row.fail_body ?? "" } : { status_code: 200, body: "" },
    accounting_version: row.accounting_version === 0 ? TOKEN_ACCOUNTING_SCHEMA_VERSION : row.accounting_version,
    token_breakdown: {
      schema_version: row.accounting_version,
      quality: row.acct_quality,
      total_tokens: row.acct_total_tokens,
      input: {
        total_tokens: row.acct_input_tokens,
        uncached_tokens: row.acct_input_uncached_tokens,
        cache_read_tokens: row.acct_cache_read_tokens,
        cache_write_tokens: row.acct_cache_write_tokens
      },
      output: {
        total_tokens: row.acct_output_tokens,
        non_reasoning_tokens: row.acct_output_non_reasoning_tokens,
        reasoning_tokens: row.acct_output_reasoning_tokens
      },
      unclassified_tokens: row.acct_unclassified_tokens
    },
    provider: row.provider,
    executor_type: row.executor_type,
    model: row.model,
    alias: row.alias,
    endpoint: row.endpoint,
    auth_type: row.auth_type,
    api_key: row.principal_id,
    request_id: row.request_id,
    ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
    ...sessionPayload(row),
    ...(row.base_url === null ? {} : { base_url: row.base_url }),
    reasoning_effort: row.reasoning_effort ?? "",
    service_tier: row.service_tier,
    ...(row.response_service_tier === null ? {} : { response_service_tier: row.response_service_tier }),
    ...(row.response_model === null ? {} : { response_model: row.response_model })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Queue (GET .../usage/queue)
// ---------------------------------------------------------------------------------------------------------------

export const MAX_QUEUE_COUNT = 1000

/**
 * `PopOldest`: atomically marks the oldest `count` unexported records as exported and returns them oldest first. An
 * exported record stays in D1 (for the listing and summary endpoints) until retention removes it.
 */
export const popUsageQueue = async (db: D1Database, count: number, now: number): Promise<ReadonlyArray<UsageRow>> => {
  const limit = Math.max(1, Math.min(MAX_QUEUE_COUNT, Math.trunc(count)))
  const result = await db
    .prepare(
      `UPDATE usage_records SET exported_at = ?1 WHERE request_id IN (
         SELECT request_id FROM usage_records WHERE exported_at IS NULL ORDER BY requested_at ASC, request_id ASC LIMIT ?2
       ) RETURNING *`
    )
    .bind(now, limit)
    .run<UsageRow>()
  return result.results.toSorted(
    (a, b) =>
      a.requested_at - b.requested_at || (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0)
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Listing and summary
// ---------------------------------------------------------------------------------------------------------------

export interface UsageFilter {
  /** Inclusive lower bound of `requested_at` (epoch ms). */
  readonly since?: number
  /** Exclusive upper bound of `requested_at` (epoch ms). */
  readonly until?: number
  readonly provider?: string
  readonly model?: string
  readonly principal?: string
  readonly authId?: string
  readonly failed?: boolean
}

const filterClauses = (filter: UsageFilter): { readonly where: string; readonly params: Array<string | number> } => {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const add = (clause: string, value: string | number) => {
    params.push(value)
    clauses.push(clause.replace("?", `?${params.length}`))
  }
  if (filter.since !== undefined) add("requested_at >= ?", filter.since)
  if (filter.until !== undefined) add("requested_at < ?", filter.until)
  if (filter.provider !== undefined) add("provider = ?", filter.provider)
  if (filter.model !== undefined) add("model = ?", filter.model)
  if (filter.principal !== undefined) add("principal_id = ?", filter.principal)
  if (filter.authId !== undefined) add("auth_id = ?", filter.authId)
  if (filter.failed !== undefined) add("failed = ?", filter.failed ? 1 : 0)
  return { where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params }
}

export const MAX_LIST_LIMIT = 1000
export const DEFAULT_LIST_LIMIT = 100

export interface UsageListQuery extends UsageFilter {
  readonly limit?: number
  /** Cursor from a previous page: `<requested_at>:<request_id>`. */
  readonly before?: string
}

export interface UsageListPage {
  readonly rows: ReadonlyArray<UsageRow>
  readonly nextBefore: string | undefined
}

export const parseCursor = (cursor: string): { readonly at: number; readonly id: string } | undefined => {
  const separator = cursor.indexOf(":")
  if (separator <= 0) return undefined
  const at = Number(cursor.slice(0, separator))
  return Number.isSafeInteger(at) ? { at, id: cursor.slice(separator + 1) } : undefined
}

/** Newest records first, keyset-paginated. */
export const listUsageRecords = async (db: D1Database, query: UsageListQuery): Promise<UsageListPage> => {
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(query.limit ?? DEFAULT_LIST_LIMIT)))
  const { where, params } = filterClauses(query)
  const cursor = query.before === undefined ? undefined : parseCursor(query.before)
  let sql = `SELECT * FROM usage_records${where}`
  if (cursor !== undefined) {
    params.push(cursor.at, cursor.id)
    const cursorClause = `(requested_at < ?${params.length - 1} OR (requested_at = ?${params.length - 1} AND request_id < ?${params.length}))`
    sql += where === "" ? ` WHERE ${cursorClause}` : ` AND ${cursorClause}`
  }
  params.push(limit + 1)
  sql += ` ORDER BY requested_at DESC, request_id DESC LIMIT ?${params.length}`
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<UsageRow>()
  const rows = result.results.slice(0, limit)
  const last = rows[rows.length - 1]
  const more = result.results.length > limit && last !== undefined
  return { rows, nextBefore: more ? `${last.requested_at}:${last.request_id}` : undefined }
}

export const GROUP_BY = ["model", "provider", "principal", "auth", "endpoint", "day"] as const
export type GroupBy = (typeof GROUP_BY)[number]

const GROUP_EXPRESSIONS: Readonly<Record<GroupBy, string>> = {
  model: "model",
  provider: "provider",
  principal: "principal_id",
  auth: "auth_id",
  endpoint: "endpoint",
  day: "strftime('%Y-%m-%d', requested_at / 1000, 'unixepoch')"
}

const AGGREGATES = `COUNT(*) AS requests,
  COALESCE(SUM(failed), 0) AS failed,
  COALESCE(SUM(acct_input_tokens), 0) AS input_tokens,
  COALESCE(SUM(acct_input_uncached_tokens), 0) AS uncached_input_tokens,
  COALESCE(SUM(acct_cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(acct_cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(acct_output_tokens), 0) AS output_tokens,
  COALESCE(SUM(acct_output_reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(acct_unclassified_tokens), 0) AS unclassified_tokens,
  COALESCE(SUM(acct_total_tokens), 0) AS total_tokens,
  COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
  AVG(ttft_ms) AS avg_ttft_ms`

export interface UsageTotals {
  readonly requests: number
  readonly failed: number
  readonly input_tokens: number
  readonly uncached_input_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number
  readonly output_tokens: number
  readonly reasoning_tokens: number
  readonly unclassified_tokens: number
  readonly total_tokens: number
  readonly avg_latency_ms: number
  readonly avg_ttft_ms: number | null
}

export interface UsageGroup extends UsageTotals {
  readonly key: string
}

export interface UsageSummary {
  readonly totals: UsageTotals
  readonly groups: ReadonlyArray<UsageGroup>
}

export interface UsageSummaryQuery extends UsageFilter {
  readonly groupBy: GroupBy
  readonly limit?: number
}

/** Token totals (v2 breakdown buckets) overall and per `groupBy` key, largest total first (`day`: chronological). */
export const summarizeUsage = async (db: D1Database, query: UsageSummaryQuery): Promise<UsageSummary> => {
  const { where, params } = filterClauses(query)
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(query.limit ?? DEFAULT_LIST_LIMIT)))
  const expression = GROUP_EXPRESSIONS[query.groupBy]
  const order = query.groupBy === "day" ? "key DESC" : "total_tokens DESC, requests DESC, key ASC"
  const [totals, groups] = await db.batch<UsageTotals & { key?: string }>([
    db.prepare(`SELECT ${AGGREGATES} FROM usage_records${where}`).bind(...params),
    db
      .prepare(
        `SELECT ${expression} AS key, ${AGGREGATES} FROM usage_records${where} GROUP BY key ORDER BY ${order} LIMIT ${limit}`
      )
      .bind(...params)
  ])
  return {
    totals: (totals?.results[0] ?? {
      requests: 0,
      failed: 0,
      input_tokens: 0,
      uncached_input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      unclassified_tokens: 0,
      total_tokens: 0,
      avg_latency_ms: 0,
      avg_ttft_ms: null
    }) as UsageTotals,
    groups: (groups?.results ?? []).map((group) => ({ ...group, key: String(group.key ?? "") })) as UsageGroup[]
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------

export const PRUNE_BATCH = 5000
const MAX_PRUNE_BATCHES = 40

/** Deletes records older than `cutoff` (epoch ms) in bounded batches; returns the number removed. */
export const pruneUsageRecords = async (db: D1Database, cutoff: number): Promise<number> => {
  let removed = 0
  for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch += 1) {
    const result = await db
      .prepare(
        `DELETE FROM usage_records WHERE request_id IN (
           SELECT request_id FROM usage_records WHERE requested_at < ?1 ORDER BY requested_at ASC LIMIT ?2
         )`
      )
      .bind(cutoff, PRUNE_BATCH)
      .run()
    const changes = result.meta.changes ?? 0
    removed += changes
    if (changes < PRUNE_BATCH) break
  }
  return removed
}
