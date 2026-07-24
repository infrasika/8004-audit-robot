import type { AuditOutcome, Env, ScanAgent } from "./types";

/** Persist a single audit result (success or failure) to D1. */
export async function recordAudit(
  env: Env,
  agent: ScanAgent,
  outcome: AuditOutcome,
  auditedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_records
       (name, chain_id, token_id, chain_type, owner_address,
        audited_at, report_id, cached, success, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      agent.name,
      agent.chain_id,
      agent.token_id,
      agent.chain_type,
      agent.owner_address,
      auditedAt,
      outcome.reportId,
      outcome.cached === null ? null : outcome.cached ? 1 : 0,
      outcome.success ? 1 : 0,
      outcome.error,
    )
    .run();
}
