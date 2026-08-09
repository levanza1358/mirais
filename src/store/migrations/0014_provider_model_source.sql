-- Track whether a provider model was manually configured or discovered by sync.
-- Existing rows remain manual so an upgrade cannot delete operator-managed data.

ALTER TABLE provider_models
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'sync'));
