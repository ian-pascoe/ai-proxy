-- Session identity and upstream base URL of each usage record (sdk/cliproxy/usage Record.SessionID/ParentSessionID/BaseURL).
-- `session_id` is the bounded identity (`claude:<id>`, `derived:ctx:v1:<hash>`, `lcp:v1:<hash>`, ...); the queue export
-- projects it to a canonical UUID like Go's redisqueue.
ALTER TABLE usage_records ADD COLUMN session_id TEXT;
ALTER TABLE usage_records ADD COLUMN parent_session_id TEXT;
ALTER TABLE usage_records ADD COLUMN base_url TEXT;
CREATE INDEX usage_records_session ON usage_records (session_id, requested_at) WHERE session_id IS NOT NULL;
