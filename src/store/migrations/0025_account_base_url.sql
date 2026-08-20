BEGIN;

ALTER TABLE provider_accounts ADD COLUMN base_url TEXT;

COMMIT;
