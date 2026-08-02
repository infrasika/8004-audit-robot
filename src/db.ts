import type { AuditSubmitFailure, Env, ScanAgent } from "./types";

const MAX_ERROR_LENGTH = 1_024;
const MAX_RESPONSE_EXCERPT_LENGTH = 2_048;

function truncate(value: string | null, maxLength: number): string | null {
  return value === null ? null : value.slice(0, maxLength);
}

/** Insert or refresh one unresolved `/oasf/audit` submission failure. */
export async function upsertAuditFail(
  env: Env,
  agent: ScanAgent,
  targetUrl: string,
  failure: AuditSubmitFailure,
  failedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oasf_audit_fails
       (chain_id, token_id, chain_type, name, description, owner_address,
        target_url, last_error_kind, last_http_status, last_error,
        last_response_excerpt, last_retry_after, attempt_count,
        first_failed_at, last_failed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (chain_id, token_id) DO UPDATE SET
       chain_type = excluded.chain_type,
       name = excluded.name,
       description = excluded.description,
       owner_address = excluded.owner_address,
       target_url = excluded.target_url,
       last_error_kind = excluded.last_error_kind,
       last_http_status = excluded.last_http_status,
       last_error = excluded.last_error,
       last_response_excerpt = excluded.last_response_excerpt,
       last_retry_after = excluded.last_retry_after,
       attempt_count = oasf_audit_fails.attempt_count + 1,
       last_failed_at = excluded.last_failed_at`,
  )
    .bind(
      agent.chain_id,
      agent.token_id,
      agent.chain_type ?? null,
      agent.name ?? null,
      agent.description ?? null,
      agent.owner_address ?? null,
      targetUrl,
      failure.kind,
      failure.httpStatus,
      truncate(failure.error, MAX_ERROR_LENGTH),
      truncate(failure.responseExcerpt, MAX_RESPONSE_EXCERPT_LENGTH),
      failure.retryAfter,
      failedAt,
      failedAt,
    )
    .run();
}

/** Remove a resolved submission failure. This operation is idempotent. */
export async function deleteAuditFail(env: Env, agent: ScanAgent): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM oasf_audit_fails WHERE chain_id = ? AND token_id = ?`,
  )
    .bind(agent.chain_id, agent.token_id)
    .run();
}

/** List the current unresolved submission failures, newest first. */
export async function listAuditFails(env: Env, limit: number): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM oasf_audit_fails ORDER BY last_failed_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results;
}
