import type {
  AuditPollResult,
  AuditReportResponse,
  AuditResponse,
  AuditSubmission,
  Env,
  ScanAgent,
} from "./types";

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;

/** target is expressed as `chain_id:token_id`, e.g. "56:232968". */
export function targetOf(agent: ScanAgent): string {
  return `${agent.chain_id}:${agent.token_id}`;
}

/**
 * Submit one asynchronous audit. A successful 202 response only means the
 * auditor accepted the job; completion is confirmed separately via pollAudit.
 */
export async function startAudit(env: Env, agent: ScanAgent): Promise<AuditSubmission> {
  const target = targetOf(agent);
  const body = { target, force: false };
  const url = `${env.AUDITOR_BASE_URL}/oasf/audit`;
  console.log("[audit] request", { name: agent.name, url, ...body });

  const startedAt = Date.now();
  let outcome: AuditSubmission;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // force:false so the auditor can return cached results.
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await resp.text();
    let data: AuditResponse | undefined;
    try {
      data = JSON.parse(text) as AuditResponse;
    } catch {
      data = undefined;
    }

    if (data === undefined) {
      outcome = {
        accepted: false,
        reportId: null,
        cached: null,
        status: null,
        error: `Unexpected response (${resp.status}): ${text.slice(0, 300)}`,
      };
    } else if (!resp.ok || !data.auditId) {
      outcome = {
        accepted: false,
        reportId: data.auditId ?? null,
        cached: typeof data.cached === "boolean" ? data.cached : null,
        status: typeof data.status === "string" ? data.status : null,
        error: `Audit failed (${resp.status}): ${text.slice(0, 300)}`,
      };
    } else {
      outcome = {
        accepted: true,
        reportId: data.auditId,
        cached: typeof data.cached === "boolean" ? data.cached : null,
        status: typeof data.status === "string" ? data.status : null,
        error: null,
      };
    }
  } catch (err) {
    outcome = {
      accepted: false,
      reportId: null,
      cached: null,
      status: null,
      error: err instanceof Error ? (err.message ?? String(err)) : String(err),
    };
  }

  const logResult = { target, ms: Date.now() - startedAt, ...outcome };
  if (outcome.accepted) console.log("[audit] accepted", logResult);
  else console.error("[audit] submission failed", logResult);
  return outcome;
}

/**
 * Poll the public report endpoint once. Transport and malformed-response errors
 * are non-terminal so the scheduler can retry them until its polling deadline.
 */
export async function pollAudit(env: Env, auditId: string): Promise<AuditPollResult> {
  const url = `${env.AUDITOR_BASE_URL}/oasf/report/${encodeURIComponent(auditId)}`;
  const startedAt = Date.now();

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
    });
    const text = await resp.text();
    let data: AuditReportResponse | undefined;
    try {
      data = JSON.parse(text) as AuditReportResponse;
    } catch {
      data = undefined;
    }

    if (!resp.ok || data === undefined) {
      const apiError = data?.error;
      const detail = apiError?.message ?? apiError?.code ?? text.slice(0, 300);
      const result = {
        terminal: false,
        success: false,
        status: null,
        error: `Report poll failed (${resp.status}): ${detail}`,
      };
      console.warn("[audit] poll retryable error", {
        auditId,
        ms: Date.now() - startedAt,
        ...result,
      });
      return result;
    }

    const status = typeof data.index?.status === "string" ? data.index.status : null;
    if (status === "completed") {
      const result = { terminal: true, success: true, status, error: null };
      console.log("[audit] completed", { auditId, ms: Date.now() - startedAt, ...result });
      return result;
    }
    if (status === "failed") {
      const result = {
        terminal: true,
        success: false,
        status,
        error: data.index?.errorCode ?? "Auditor reported a failed audit",
      };
      console.error("[audit] failed", { auditId, ms: Date.now() - startedAt, ...result });
      return result;
    }

    const result = {
      terminal: false,
      success: false,
      status,
      error: status === "queued" || status === "running"
        ? null
        : `Unexpected audit status: ${status ?? "missing"}`,
    };
    console.log("[audit] pending", { auditId, ms: Date.now() - startedAt, ...result });
    return result;
  } catch (err) {
    const result = {
      terminal: false,
      success: false,
      status: null,
      error: err instanceof Error ? (err.message ?? String(err)) : String(err),
    };
    console.warn("[audit] poll retryable error", {
      auditId,
      ms: Date.now() - startedAt,
      ...result,
    });
    return result;
  }
}
