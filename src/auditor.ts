import type { AuditResponse, Env, ScanAgent, AuditOutcome } from "./types";

/** target is expressed as `chain_id:token_id`, e.g. "56:232968". */
export function targetOf(agent: ScanAgent): string {
  return `${agent.chain_id}:${agent.token_id}`;
}

/**
 * Invoke the auditor for a single agent. Never throws: network / parse / HTTP
 * errors are captured into the returned outcome so the caller can record them.
 */
export async function auditAgent(env: Env, agent: ScanAgent): Promise<AuditOutcome> {
  const target = targetOf(agent);
  const body = { target, force: false };
  const url = `${env.AUDITOR_BASE_URL}/oasf/audit`;
  console.log("[audit] request", { name: agent.name, url, ...body });

  const startedAt = Date.now();
  let outcome: AuditOutcome;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // force:false so the auditor can return cached results.
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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
        reportId: null,
        cached: null,
        success: false,
        error: `Unexpected response (${resp.status}): ${text.slice(0, 300)}`,
      };
    } else if (!resp.ok || !data.auditId) {
      outcome = {
        reportId: data.auditId ?? null,
        cached: typeof data.cached === "boolean" ? data.cached : null,
        success: false,
        error: `Audit failed (${resp.status}): ${text.slice(0, 300)}`,
      };
    } else {
      outcome = {
        reportId: data.auditId,
        cached: typeof data.cached === "boolean" ? data.cached : null,
        success: true,
        error: null,
      };
    }
  } catch (err) {
    outcome = {
      reportId: null,
      cached: null,
      success: false,
      error: err instanceof Error ? (err.message ?? String(err)) : String(err),
    };
  }

  const logResult = { target, ms: Date.now() - startedAt, ...outcome };
  if (outcome.success) console.log("[audit] result", logResult);
  else console.error("[audit] failed", logResult);
  return outcome;
}
