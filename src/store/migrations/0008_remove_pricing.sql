-- Remove legacy pricing and cost columns/tables.
-- SQLite-compatible table rebuilds are used so existing data remains intact.

BEGIN TRANSACTION;

CREATE TABLE provider_models_new (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL,
  display_name      TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  context_length    INTEGER,
  max_output_tokens INTEGER,
  capabilities      TEXT,
  UNIQUE(provider_id, model_id)
);

INSERT INTO provider_models_new (
  id,
  provider_id,
  model_id,
  display_name,
  enabled,
  context_length,
  max_output_tokens,
  capabilities
)
SELECT
  id,
  provider_id,
  model_id,
  display_name,
  enabled,
  context_length,
  max_output_tokens,
  capabilities
FROM provider_models;

DROP TABLE provider_models;
ALTER TABLE provider_models_new RENAME TO provider_models;

CREATE TABLE request_logs_new (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  key_id          TEXT REFERENCES gateway_keys(id) ON DELETE SET NULL,
  endpoint        TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  provider        TEXT,
  model           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,
  http_status     INTEGER,
  error           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  latency_ms      INTEGER,
  tokens_saved    INTEGER DEFAULT 0,
  request_body    TEXT,
  response_body   TEXT,
  attempts_detail TEXT,
  kind            TEXT DEFAULT 'request'
);

INSERT INTO request_logs_new (
  id,
  ts,
  key_id,
  endpoint,
  requested_model,
  provider,
  model,
  attempts,
  status,
  http_status,
  error,
  input_tokens,
  output_tokens,
  latency_ms,
  tokens_saved,
  request_body,
  response_body,
  attempts_detail,
  kind
)
SELECT
  id,
  ts,
  key_id,
  endpoint,
  requested_model,
  provider,
  model,
  attempts,
  status,
  http_status,
  error,
  input_tokens,
  output_tokens,
  latency_ms,
  tokens_saved,
  request_body,
  response_body,
  attempts_detail,
  COALESCE(kind, 'request')
FROM request_logs;

DROP TABLE request_logs;
ALTER TABLE request_logs_new RENAME TO request_logs;

CREATE INDEX idx_logs_ts       ON request_logs(ts DESC);
CREATE INDEX idx_logs_model    ON request_logs(model);
CREATE INDEX idx_logs_provider ON request_logs(provider);
CREATE INDEX idx_logs_key      ON request_logs(key_id);

DROP TABLE IF EXISTS pricing;

COMMIT;
