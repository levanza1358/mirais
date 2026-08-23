-- Prompt cache telemetry.
--
-- Cache hits are the whole point of provider prompt caching, so they have to be
-- observable: without these columns a cached request looks identical to an
-- uncached one and there is no way to tell whether caching is working.
ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER;
