-- Daily usage rollup. One row per (utc_day, provider, model, account_label).
-- Written by `LogsRepo.insert()` for `kind='request'`. Survives the 1-day
-- `request_logs` purge so Overview/Stats/usageByAccount still have history
-- across the operator's `log_retention_days` window (default 30).
CREATE TABLE IF NOT EXISTS daily_usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  utc_day             TEXT NOT NULL,
  provider            TEXT,
  model               TEXT,
  account_label       TEXT,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  tokens_saved        INTEGER NOT NULL DEFAULT 0,
  errors              INTEGER NOT NULL DEFAULT 0,
  total_latency_ms    INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(utc_day, provider, model, account_label)
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_day      ON daily_usage(utc_day);
CREATE INDEX IF NOT EXISTS idx_daily_usage_provider ON daily_usage(provider);