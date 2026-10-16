-- 003-add-security-audit-log.sql
-- Adds a table for security‑sensitive audit records.

CREATE TABLE IF NOT EXISTS security_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source_ip TEXT,
  request_id TEXT,
  correlation_id TEXT,
  outcome TEXT NOT NULL,
  details TEXT -- JSON string, may be NULL
);

-- Indexes for common lookup patterns
CREATE INDEX IF NOT EXISTS idx_security_audit_action ON security_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_security_audit_actor ON security_audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_security_audit_timestamp ON security_audit_log(timestamp);
