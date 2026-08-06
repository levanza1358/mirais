ALTER TABLE provider_accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'api_key';
ALTER TABLE provider_accounts ADD COLUMN refresh_token TEXT;
ALTER TABLE provider_accounts ADD COLUMN id_token TEXT;
ALTER TABLE provider_accounts ADD COLUMN account_id TEXT;
ALTER TABLE provider_accounts ADD COLUMN expires_at INTEGER;
