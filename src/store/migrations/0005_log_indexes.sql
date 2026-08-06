-- Index for filtering by kind (request vs warmup) — critical for logs/warmup-logs pages.
CREATE INDEX IF NOT EXISTS idx_logs_kind ON request_logs(kind);
-- Composite index for the most common filtered list query: kind + status + ts DESC
CREATE INDEX IF NOT EXISTS idx_logs_kind_status_ts ON request_logs(kind, status, ts DESC);
-- Composite index for kind + provider filtered queries
CREATE INDEX IF NOT EXISTS idx_logs_kind_provider_ts ON request_logs(kind, provider, ts DESC);
