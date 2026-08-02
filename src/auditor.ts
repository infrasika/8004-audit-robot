import type {
  AuditApiError,
  AuditPollResult,
  AuditReportResponse,
  AuditSubmission,
  Env,
  ScanAgent,
} from "./types";

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_EXCERPT_LENGTH = 2_048;
const NON_FAILURE_API_ERROR_CODES = new Set(["AGENT_CARD_NOT_FOUND"]);

/** target is expressed as `chain_id:token_id`, preserving both IDs as strings. */
export function targetOf(agent: ScanAgent): string {
  return `${agent.chain_id}:${agent.token_id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function businessErrorOf(value: unknown): AuditApiError | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const code = value.error.code;
  if (typeof code !== "string" || code.trim() === "") return null;
  return {
    code,
    message: typeof value.error.message === "string" ? value.error.message : undefined,
    retryable: typeof value.error.retryable === "boolean" ? value.error.retryable : undefined,
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function failureSubmission(
  targetUrl: string,
  failure: Extract<AuditSubmission, { kind: "failure" }>["failure"],
): AuditSubmission {
  return { kind: "failure", targetUrl, failure };
}

function classifyAuditResponse(targetUrl: string, resp: Response, text: string): AuditSubmission {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    if (!resp.ok) {
      return failureSubmission(targetUrl, {
        kind: "http",
        httpStatus: resp.status,
        error: `Audit HTTP failure (${resp.status})`,
        responseExcerpt: text.slice(0, RESPONSE_EXCERPT_LENGTH),
        retryAfter: resp.headers.get("Retry-After"),
      });
    }
    return failureSubmission(targetUrl, {
      kind: "protocol",
      httpStatus: resp.status,
      error: `Invalid JSON response from auditor (${resp.status})`,
      responseExcerpt: text.slice(0, RESPONSE_EXCERPT_LENGTH),
      retryAfter: null,
    });
  }

  const businessError = businessErrorOf(data);
  if (businessError !== null && (resp.ok || NON_FAILURE_API_ERROR_CODES.has(businessError.code))) {
    return { kind: "business_error", targetUrl, businessError };
  }

  if (!resp.ok) {
    return failureSubmission(targetUrl, {
      kind: "http",
      httpStatus: resp.status,
      error: `Audit HTTP failure (${resp.status})`,
      responseExcerpt: text.slice(0, RESPONSE_EXCERPT_LENGTH),
      retryAfter: resp.headers.get("Retry-After"),
    });
  }

  if (!isRecord(data)) {
    return failureSubmission(targetUrl, {
      kind: "protocol",
      httpStatus: resp.status,
      error: `Invalid JSON response from auditor (${resp.status})`,
      responseExcerpt: text.slice(0, RESPONSE_EXCERPT_LENGTH),
      retryAfter: null,
    });
  }

  const auditId = typeof data.auditId === "string" && data.auditId.trim() !== ""
    ? data.auditId
    : null;
  if (auditId !== null) {
    return {
      kind: "accepted",
      targetUrl,
      reportId: auditId,
      cached: typeof data.cached === "boolean" ? data.cached : null,
      status: typeof data.status === "string" ? data.status : null,
    };
  }

  return failureSubmission(targetUrl, {
    kind: "protocol",
    httpStatus: resp.status,
    error: `Auditor response has neither auditId nor structured error (${resp.status})`,
    responseExcerpt: text.slice(0, RESPONSE_EXCERPT_LENGTH),
    retryAfter: null,
  });
}

/**
 * Submit one asynchronous audit. A successful response with an auditId only
 * means the auditor accepted the job; completion is confirmed via pollAudit.
 */
export async function startAudit(env: Env, agent: ScanAgent): Promise<AuditSubmission> {
  const target = targetOf(agent);
  const body = { target, force: false };
  const url = `${env.AUDITOR_BASE_URL}/oasf/audit`;
  console.log("[audit] request", { name: agent.name, url, ...body });

  const startedAt = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // force:false so the auditor can return cached results.
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await resp.text();
    const outcome = classifyAuditResponse(target, resp, text);

    const logResult = { target, ms: Date.now() - startedAt, ...outcome };
    if (outcome.kind === "accepted") console.log("[audit] accepted", logResult);
    else if (outcome.kind === "business_error") console.log("[audit] business result", logResult);
    else console.error("[audit] submission failed", logResult);
    return outcome;
  } catch (err) {
    const outcome = failureSubmission(target, {
      kind: isTimeoutError(err) ? "timeout" : "network",
      httpStatus: null,
      error: err instanceof Error ? (err.message ?? String(err)) : String(err),
      responseExcerpt: null,
      retryAfter: null,
    });
    console.error("[audit] submission failed", {
      target,
      ms: Date.now() - startedAt,
      ...outcome,
    });
    return outcome;
  }
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
