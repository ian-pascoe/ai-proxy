-- Usage accounting: one row per upstream attempt (see src/usage/d1.ts).
-- Timestamps are epoch milliseconds. The `acct_*` columns hold the token accounting v2 breakdown
-- (sdk/cliproxy/usage/accounting.go): input_total = uncached + cache_read + cache_write,
-- output_total = non_reasoning + reasoning, total = input_total + output_total + unclassified.
CREATE TABLE usage_records (
  request_id TEXT PRIMARY KEY NOT NULL,
  trace_id TEXT,
  requested_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  provider TEXT NOT NULL,
  executor_type TEXT NOT NULL,
  model TEXT NOT NULL,
  alias TEXT NOT NULL,
  response_model TEXT,
  endpoint TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  auth_id TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  source TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  generate INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0,
  fail_status INTEGER,
  fail_body TEXT,
  reasoning_effort TEXT,
  service_tier TEXT NOT NULL DEFAULT '',
  response_service_tier TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  accounting_version INTEGER NOT NULL DEFAULT 2,
  acct_quality TEXT NOT NULL DEFAULT 'complete',
  acct_total_tokens INTEGER NOT NULL DEFAULT 0,
  acct_input_tokens INTEGER NOT NULL DEFAULT 0,
  acct_input_uncached_tokens INTEGER NOT NULL DEFAULT 0,
  acct_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  acct_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  acct_output_tokens INTEGER NOT NULL DEFAULT 0,
  acct_output_non_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  acct_output_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  acct_unclassified_tokens INTEGER NOT NULL DEFAULT 0,
  -- Set when the record was handed out by GET /v8/management/observability/usage/queue.
  exported_at INTEGER
);

CREATE INDEX usage_records_requested_at ON usage_records (requested_at);
CREATE INDEX usage_records_principal ON usage_records (principal_id, requested_at);
CREATE INDEX usage_records_model ON usage_records (model, requested_at);
CREATE INDEX usage_records_auth ON usage_records (auth_id, requested_at);
CREATE INDEX usage_records_unexported ON usage_records (requested_at) WHERE exported_at IS NULL;
