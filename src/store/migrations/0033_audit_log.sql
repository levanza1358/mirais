-- Admin configuration audit trail. Never store secrets or request/response bodies here.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit_log(ts DESC);
