export interface Env {
  SCHEDULER: DurableObjectNamespace<import("./scheduler").AuditScheduler>;
  DB: D1Database;
  SCAN_BASE_URL: string;
  SCAN_API_KEY: string;
  SCAN_PAGE_LIMIT: string;
  AUDITOR_BASE_URL: string;
  AUDIT_INTERVAL_MS: string;
  AUDIT_POLL_INTERVAL_MS?: string;
  AUDIT_POLL_TIMEOUT_MS?: string;
}

/** One agent entry from the 8004scan public API. */
export interface ScanAgent {
  name: string | null;
  description: string | null;
  chain_id: string;
  token_id: string;
  chain_type: string | null;
  owner_address: string | null;
}

export interface ScanPage {
  agents: ScanAgent[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Response shape from the auditor `/oasf/audit` endpoint. */
export interface AuditResponse {
  auditId?: string;
  status?: string;
  reportUrl?: string;
  cached?: boolean;
  auditedAt?: string;
  error?: AuditApiError;
}

export interface AuditApiError {
  code: string;
  message?: string;
  retryable?: boolean;
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

export type AuditSubmitFailureKind = "network" | "timeout" | "http" | "protocol";

export interface AuditSubmitFailure {
  kind: AuditSubmitFailureKind;
  httpStatus: number | null;
  error: string;
  responseExcerpt: string | null;
  retryAfter: string | null;
}

/** Result of submitting an audit for asynchronous processing. */
export type AuditSubmission =
  | {
      kind: "accepted";
      targetUrl: string;
      reportId: string;
      cached: boolean | null;
      status: string | null;
    }
  | {
      kind: "business_error";
      targetUrl: string;
      businessError: AuditApiError;
    }
  | {
      kind: "failure";
      targetUrl: string;
      failure: AuditSubmitFailure;
    };

/** Result of one report-status poll. */
export interface AuditPollResult {
  terminal: boolean;
  success: boolean;
  status: string | null;
  error: string | null;
}

/** Runtime result of auditing a single agent; it is not persisted to D1. */
export interface AuditOutcome {
  cached: boolean | null;
  success: boolean;
}
