-- Mirais initial schema (doc 04)

CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  base_url    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE provider_accounts (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  api_key     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_accounts_provider ON provider_accounts(provider_id, enabled);

CREATE TABLE provider_models (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  display_name TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  input_per_1m  REAL,
  output_per_1m REAL,
  UNIQUE(provider_id, model_id)
);

CREATE TABLE aliases (
  id         TEXT PRIMARY KEY,
  alias      TEXT NOT NULL UNIQUE,
  target     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE combos (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  strategy   TEXT NOT NULL DEFAULT 'sequential',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE combo_entries (
  id         TEXT PRIMARY KEY,
  combo_id   TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  target     TEXT NOT NULL,
  UNIQUE(combo_id, position)
);

CREATE TABLE gateway_keys (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  key_hash           TEXT NOT NULL UNIQUE,
  key_prefix         TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  allowed_models     TEXT,
  rate_limit_rpm     INTEGER,
  concurrency        INTEGER,
  daily_token_budget INTEGER,
  expires_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at       TEXT
);

CREATE TABLE request_logs (
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
  cost_usd        REAL,
  latency_ms      INTEGER,
  tokens_saved    INTEGER DEFAULT 0,
  request_body    TEXT,
  response_body   TEXT,
  attempts_detail TEXT
);
CREATE INDEX idx_logs_ts       ON request_logs(ts DESC);
CREATE INDEX idx_logs_model    ON request_logs(model);
CREATE INDEX idx_logs_provider ON request_logs(provider);
CREATE INDEX idx_logs_key      ON request_logs(key_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE pricing (
  model         TEXT PRIMARY KEY,
  input_per_1m  REAL NOT NULL,
  output_per_1m REAL NOT NULL
);

-- default pricing (USD per 1M tokens, indicative list prices)
INSERT OR IGNORE INTO pricing (model, input_per_1m, output_per_1m) VALUES
  ('gpt-5.2', 10.00, 30.00),
  ('gpt-5.2-mini', 2.00, 8.00),
  ('gpt-4o', 2.50, 10.00),
  ('gpt-4o-mini', 0.15, 0.60),
  ('claude-opus-4-7', 15.00, 75.00),
  ('claude-sonnet-4-5', 3.00, 15.00),
  ('claude-haiku-3-5', 0.80, 4.00),
  ('gemini-3-pro', 2.00, 12.00),
  ('gemini-3-flash', 0.30, 2.50),
  ('deepseek-chat', 0.27, 1.10),
  ('deepseek-reasoner', 0.55, 2.19),
  ('glm-5.1', 0.60, 2.20),
  ('grok-4', 5.00, 15.00),
  ('MiniMax-M2.7', 0.20, 1.10);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('token_saver', '{"enabled":true,"rules":{"gitDiff":true,"grep":true,"ls":true,"longOutputMaxLines":200}}'),
  ('terse_mode', '{"enabled":false,"prompt":"Be concise. Answer with the minimum words needed while preserving technical accuracy."}'),
  ('log_retention_days', '30'),
  ('ui', '{"theme":"dark","accent":"#7C5CFF"}');
