-- Preserve uint256 chain IDs exactly. SQLite/D1 requires a table rebuild to
-- change the declared type of an existing column.
DROP INDEX IF EXISTS idx_oasf_audit_fails_last_failed_at;
ALTER TABLE oasf_audit_fails RENAME TO oasf_audit_fails_chain_id_integer;

CREATE TABLE oasf_audit_fails (
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

INSERT INTO oasf_audit_fails (
  chain_id, token_id, chain_type, name, description, owner_address,
  target_url, last_error_kind, last_http_status, last_error,
  last_response_excerpt, last_retry_after, attempt_count, first_failed_at,
  last_failed_at
)
SELECT
  CAST(chain_id AS TEXT), token_id, chain_type, name, description,
  owner_address, target_url, last_error_kind, last_http_status, last_error,
  last_response_excerpt, last_retry_after, attempt_count, first_failed_at,
  last_failed_at
FROM oasf_audit_fails_chain_id_integer;

DROP TABLE oasf_audit_fails_chain_id_integer;
CREATE INDEX idx_oasf_audit_fails_last_failed_at
  ON oasf_audit_fails (last_failed_at);
