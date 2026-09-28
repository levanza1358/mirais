CREATE TABLE IF NOT EXISTS request_log_payloads (
  request_log_id TEXT PRIMARY KEY REFERENCES request_logs(id) ON DELETE CASCADE,
  request_body TEXT,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_log_payloads_created_at ON request_log_payloads(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_kind_ts ON request_logs(kind, ts DESC);

INSERT OR IGNORE INTO request_log_payloads (request_log_id, request_body, response_body, created_at)
SELECT id, request_body, response_body, ts
FROM request_logs
WHERE request_body IS NOT NULL OR response_body IS NOT NULL;
