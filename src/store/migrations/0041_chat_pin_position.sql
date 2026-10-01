-- Playground chat: pin + manual reorder. The sidebar defaults to
-- `updated_at DESC`, but a pinned session jumps to the top (newest
-- pinned first) and explicit `position` lets the operator drag sessions
-- into a stable order across restarts. `position` is a sparse slot — we
-- only rewrite rows the user touches, leaving the rest NULL.
ALTER TABLE chat_sessions ADD COLUMN pinned    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN position  INTEGER;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_pinned ON chat_sessions(pinned DESC, position ASC, updated_at DESC);