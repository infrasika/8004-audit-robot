-- Migration number: 0001 	 create audit_records
-- Audit records for agents pulled from 8004scan.io
CREATE TABLE IF NOT EXISTS audit_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT,
  chain_id       INTEGER,                -- target is `chain_id:token_id`
  token_id       TEXT,
  chain_type     TEXT,
  owner_address  TEXT,
  audited_at     TEXT NOT NULL,          -- ISO timestamp when we invoked the audit
  report_id      TEXT,                   -- auditId returned by auditor (null on failure)
  cached         INTEGER,                -- 1 / 0 / null
  success        INTEGER NOT NULL,       -- 1 if auditor returned a valid report_id, else 0
  error          TEXT                    -- error message when success = 0
);

CREATE INDEX IF NOT EXISTS idx_audit_records_success ON audit_records (success);
CREATE INDEX IF NOT EXISTS idx_audit_records_audited_at ON audit_records (audited_at);
