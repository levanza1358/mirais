CREATE TABLE IF NOT EXISTS request_log_payload_cleanup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO request_log_payload_cleanup (id) VALUES (1);
