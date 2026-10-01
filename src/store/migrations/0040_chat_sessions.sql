-- Playground chat sessions. The dashboard's /dashboard/chat page stores
-- multi-turn conversations here so they survive restart, browser switch,
-- and accidental localStorage wipes. FK ON chat_messages.session_id cascades
-- so deleting a session removes its messages in one statement.
--
-- The cap is enforced in the dashboard (max 100 sessions, 50 messages each)
-- to keep storage under a few MB even after heavy use.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  model       TEXT NOT NULL,
  system      TEXT,
  params      TEXT,                  -- JSON: {temperature, max_tokens, top_p, stop, json_mode}
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content      TEXT NOT NULL,
  position     INTEGER NOT NULL,
  in_tokens    INTEGER,
  out_tokens   INTEGER,
  cost         REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, position)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, position);