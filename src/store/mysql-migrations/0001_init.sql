CREATE TABLE IF NOT EXISTS providers (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL,
  base_url TEXT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 100,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  account_strategy VARCHAR(32) NOT NULL DEFAULT 'priority',
  display_name VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_providers_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS provider_accounts (
  id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  api_key LONGTEXT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 100,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  auth_kind VARCHAR(32) NOT NULL DEFAULT 'api_key',
  refresh_token LONGTEXT NULL,
  id_token LONGTEXT NULL,
  account_id VARCHAR(255) NULL,
  expires_at BIGINT NULL,
  notes TEXT NULL,
  tags TEXT NULL,
  last_warmup_at DATETIME(3) NULL,
  last_warmup_status VARCHAR(32) NULL,
  last_warmup_latency_ms INT NULL,
  last_warmup_detail TEXT NULL,
  plan_type VARCHAR(64) NULL,
  session_cookie LONGTEXT NULL,
  rate_limited_until BIGINT NULL,
  base_url TEXT NULL,
  reauth_required TINYINT(1) NOT NULL DEFAULT 0,
  reauth_reason VARCHAR(300) NULL,
  PRIMARY KEY (id),
  KEY idx_accounts_provider (provider_id, enabled),
  CONSTRAINT fk_provider_accounts_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS provider_models (
  id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(512) NOT NULL,
  display_name VARCHAR(255) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  context_length BIGINT NULL,
  max_output_tokens BIGINT NULL,
  capabilities LONGTEXT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'manual',
  credit_rate DOUBLE NULL,
  credit_unit VARCHAR(32) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_models_provider_model (provider_id, model_id),
  KEY idx_provider_models_model (model_id),
  CONSTRAINT fk_provider_models_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS account_model_cooldowns (
  account_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(512) NOT NULL,
  `until` BIGINT NOT NULL,
  reason VARCHAR(300) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (account_id, model_id),
  KEY idx_account_model_cooldowns_until (`until`),
  CONSTRAINT fk_cooldowns_account FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS aliases (
  id VARCHAR(64) NOT NULL,
  alias VARCHAR(255) NOT NULL,
  target TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_aliases_alias (alias)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS combos (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  strategy VARCHAR(32) NOT NULL DEFAULT 'sequential',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_combos_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS combo_entries (
  id VARCHAR(64) NOT NULL,
  combo_id VARCHAR(64) NOT NULL,
  position INT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_combo_entries_position (combo_id, position),
  CONSTRAINT fk_combo_entries_combo FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS gateway_keys (
  id VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  key_plain VARCHAR(255) NULL,
  key_prefix VARCHAR(32) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  allowed_models TEXT NULL,
  rate_limit_rpm INT NULL,
  concurrency INT NULL,
  daily_token_budget BIGINT NULL,
  token_budget BIGINT NULL,
  expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gateway_keys_key_hash (key_hash),
  KEY idx_gateway_keys_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS request_logs (
  id VARCHAR(64) NOT NULL,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  key_id VARCHAR(64) NULL,
  endpoint VARCHAR(255) NOT NULL,
  requested_model VARCHAR(512) NOT NULL,
  provider VARCHAR(255) NULL,
  model VARCHAR(512) NULL,
  account_label VARCHAR(255) NULL,
  attempts INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL,
  http_status INT NULL,
  error TEXT NULL,
  input_tokens BIGINT NULL,
  output_tokens BIGINT NULL,
  cached_tokens BIGINT NULL,
  cache_write_tokens BIGINT NULL,
  reasoning_tokens BIGINT NULL,
  credit_usage DOUBLE NULL,
  credit_source VARCHAR(32) NULL,
  latency_ms BIGINT NULL,
  tokens_saved BIGINT NOT NULL DEFAULT 0,
  reasoning_effort VARCHAR(32) NULL,
  request_body LONGTEXT NULL,
  response_body LONGTEXT NULL,
  attempts_detail LONGTEXT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'request',
  PRIMARY KEY (id),
  KEY idx_logs_ts (ts),
  KEY idx_logs_model (model(191)),
  KEY idx_logs_provider (provider),
  KEY idx_logs_key (key_id),
  CONSTRAINT fk_request_logs_key FOREIGN KEY (key_id) REFERENCES gateway_keys(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id VARCHAR(64) NOT NULL,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  action VARCHAR(64) NOT NULL,
  resource VARCHAR(64) NOT NULL,
  resource_id VARCHAR(255) NULL,
  detail LONGTEXT NULL,
  PRIMARY KEY (id),
  KEY idx_admin_audit_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(255) NOT NULL,
  value LONGTEXT NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS tracks (
  id VARCHAR(64) NOT NULL,
  title VARCHAR(256) NOT NULL,
  artist VARCHAR(256) NULL,
  album VARCHAR(256) NULL,
  duration_sec DOUBLE NULL,
  mime_type VARCHAR(255) NULL,
  size_bytes BIGINT NULL,
  source_type VARCHAR(16) NOT NULL,
  storage_path TEXT NULL,
  source_url TEXT NULL,
  thumbnail_url TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_tracks_artist (artist(191)),
  KEY idx_tracks_album (album(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS playlists (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(256) NOT NULL,
  description TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_playlists_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id VARCHAR(64) NOT NULL,
  track_id VARCHAR(64) NOT NULL,
  position INT NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  KEY idx_playlist_tracks_playlist (playlist_id),
  CONSTRAINT fk_playlist_tracks_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  CONSTRAINT fk_playlist_tracks_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS play_history (
  id VARCHAR(64) NOT NULL,
  track_id VARCHAR(64) NOT NULL,
  played_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  position_ms BIGINT NOT NULL DEFAULT 0,
  completed TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_play_history_track (track_id),
  KEY idx_play_history_played (played_at),
  CONSTRAINT fk_play_history_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;