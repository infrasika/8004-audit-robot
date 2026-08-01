export interface Env {
  SCHEDULER: DurableObjectNamespace<import("./scheduler").AuditScheduler>;
  DB: D1Database;
  SCAN_BASE_URL: string;
  SCAN_PAGE_LIMIT: string;
  AUDITOR_BASE_URL: string;
  AUDIT_INTERVAL_MS: string;
  AUDIT_POLL_INTERVAL_MS?: string;
  AUDIT_POLL_TIMEOUT_MS?: string;
}

/** One agent entry from the 8004scan public API. */
export interface ScanAgent {
  name: string | null;
  chain_id: number;
  token_id: string;
  chain_type: string | null;
  owner_address: string | null;
}

export interface ScanPage {
  agents: ScanAgent[];
  hasMore: boolean;
}

/** Response shape from the auditor `/oasf/audit` endpoint. */
export interface AuditResponse {
  auditId: string;
  status: string;
  reportUrl?: string;
  cached?: boolean;
  auditedAt?: string;
}

/** Response shape from `GET /oasf/report/:auditId`. */
export interface AuditReportResponse {
  index?: {
    auditId?: string;
    status?: string;
    errorCode?: string | null;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

/** Result of submitting an audit for asynchronous processing. */
export interface AuditSubmission {
  accepted: boolean;
  reportId: string | null;
  cached: boolean | null;
  status: string | null;
  error: string | null;
}

/** Result of one report-status poll. */
export interface AuditPollResult {
  terminal: boolean;
  success: boolean;
  status: string | null;
  error: string | null;
}

/** Result of auditing a single agent, ready to persist. */
export interface AuditOutcome {
  reportId: string | null;
  cached: boolean | null;
  success: boolean;
  error: string | null;
}
