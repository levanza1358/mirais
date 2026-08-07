-- Proxy pool: free HTTPS proxies discovered from public lists and manually entered.
-- Stores only host/port/protocol; no upstream credentials ever pass through Mirais.
CREATE TABLE proxy_proxies (
  id           TEXT PRIMARY KEY,
  scheme       TEXT NOT NULL DEFAULT 'http', -- 'http' (used for HTTPS via CONNECT)
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  country      TEXT,
  source       TEXT NOT NULL,                -- 'manual' or the list name that yielded it
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | healthy | slow | failing | disabled
  latency_ms   INTEGER,
  last_checked TEXT,
  last_error   TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  tags         TEXT,                          -- JSON: extra metadata
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scheme, host, port)
);
CREATE INDEX idx_proxy_status ON proxy_proxies(status);
CREATE INDEX idx_proxy_country ON proxy_proxies(country);

-- Scrape runs: history of automatic/manual scrapes for the Proxy page log.
CREATE TABLE proxy_scrape_runs (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  fetched      INTEGER NOT NULL DEFAULT 0,
  added        INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'manual' -- 'manual' | 'interval' | 'auto-warmup'
);
CREATE INDEX idx_proxy_scrape_started ON proxy_scrape_runs(started_at DESC);

-- Pool assignment: which provider (or 'all') should prefer which proxies.
-- A provider without a row uses the global default (or 'direct' if unset).
CREATE TABLE proxy_assignments (
  provider_id  TEXT PRIMARY KEY,             -- '*' for global default; provider id otherwise
  mode         TEXT NOT NULL DEFAULT 'direct', -- 'direct' | 'pool' | 'scored'
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO proxy_assignments(provider_id, mode) VALUES ('*', 'direct');