-- Store the gateway key plaintext so it stays recoverable for operators.
-- Existing installations keep key_hash (legacy) for lookup fallback; new
-- installs no longer write it. The hash column remains for backward
-- compatibility with databases created before this migration.
ALTER TABLE gateway_keys ADD COLUMN key_plain TEXT;
