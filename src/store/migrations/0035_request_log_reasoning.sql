-- 0035_request_log_reasoning.sql
-- Telemetry columns for the universal reasoning pipeline. Reasoning content is
-- never stored (R1.1 / R1.6) — only the requested mode and the upstream-reported
-- reasoning token count, which is a non-sensitive integer.

ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER;