-- Per-model credit metadata so the dashboard can show estimated usage cost for
-- every provider, not just the two that report credits upstream.
-- credit_rate  = credit units consumed per 1,000 tokens (null = unknown)
-- credit_unit  = what one unit means: token | credit | request | image
ALTER TABLE provider_models ADD COLUMN credit_rate REAL;
ALTER TABLE provider_models ADD COLUMN credit_unit TEXT;

-- Whether credit_usage on a log row came from the provider or was derived from
-- credit_rate. Estimates must never be presented as an actual bill.
ALTER TABLE request_logs ADD COLUMN credit_source TEXT;
