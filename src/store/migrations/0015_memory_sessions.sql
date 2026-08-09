-- Optional, explicitly addressed conversation memory for stateless client APIs.
CREATE TABLE memory_sessions (
  id TEXT PRIMARY KEY,
  messages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_memory_sessions_expires ON memory_sessions(expires_at);
