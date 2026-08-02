-- Migration number: 0002 	 replace audit_records with unresolved submission failures
CREATE TABLE IF NOT EXISTS oasf_audit_fails (
  chain_id              TEXT NOT NULL,
  token_id              TEXT NOT NULL,
  chain_type            TEXT,
  name                  TEXT,
  description           TEXT,
  owner_address         TEXT,
  target_url            TEXT NOT NULL,
  last_error_kind       TEXT NOT NULL
                          CHECK (last_error_kind IN ('network', 'timeout', 'http', 'protocol')),
  last_http_status      INTEGER,
  last_error            TEXT NOT NULL,
  last_response_excerpt TEXT,
  last_retry_after      TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 1,
  first_failed_at       TEXT NOT NULL,
  last_failed_at        TEXT NOT NULL,
  PRIMARY KEY (chain_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_oasf_audit_fails_last_failed_at
  ON oasf_audit_fails (last_failed_at);

DROP TABLE IF EXISTS audit_records;
