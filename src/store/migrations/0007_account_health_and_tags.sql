ALTER TABLE provider_accounts ADD COLUMN notes TEXT;
ALTER TABLE provider_accounts ADD COLUMN tags TEXT;
ALTER TABLE provider_accounts ADD COLUMN last_warmup_at TEXT;
ALTER TABLE provider_accounts ADD COLUMN last_warmup_status TEXT;
ALTER TABLE provider_accounts ADD COLUMN last_warmup_latency_ms INTEGER;
ALTER TABLE provider_accounts ADD COLUMN last_warmup_detail TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('warmup_config', '{"enabled":false,"interval_minutes":30}');