-- Add audit_retention_days setting (default 90 days). The hourly
-- retention sweep in server.ts#purgeOldLogs() reads this and calls
-- AuditRepo.purgeOlderThan(days) so the trail doesn't accumulate forever.
INSERT OR IGNORE INTO settings (key, value) VALUES ('audit_retention_days', '90');