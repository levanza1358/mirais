-- Distinguish real traffic from warmup/test pings, and store payload previews.
ALTER TABLE request_logs ADD COLUMN kind TEXT NOT NULL DEFAULT 'request';
