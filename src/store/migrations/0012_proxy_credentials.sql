-- Promote proxy credentials to first-class columns so the dashboard can
-- mask them and the executor can build the CONNECT request without parsing
-- JSON. We backfill from the legacy `tags` JSON blob, then leave it
-- untouched for any other metadata.
ALTER TABLE proxy_proxies ADD COLUMN username TEXT;
ALTER TABLE proxy_proxies ADD COLUMN password TEXT;

UPDATE proxy_proxies
SET username = json_extract(tags, '$.username'),
    password = json_extract(tags, '$.password')
WHERE tags IS NOT NULL
  AND json_extract(tags, '$.username') IS NOT NULL
  AND json_extract(tags, '$.password') IS NOT NULL;