import type { Env, ScanAgent, ScanPage } from "./types";

const UINT256_MAX = (1n << 256n) - 1n;

/** Normalize API identifiers to canonical decimal strings without precision loss. */
function normalizeUint256Decimal(value: unknown): string {
  const decimal = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "bigint"
      ? value.toString()
      : "";
  if (!/^\d+$/.test(decimal) || BigInt(decimal) > UINT256_MAX) {
    throw new Error("identifier must be an unsigned uint256 decimal integer");
  }
  return BigInt(decimal).toString();
}

interface ScanApiResponse {
  success: boolean;
  data: Array<{
    name: string | null;
    description?: string | null;
    chain_id: string | number;
    token_id: string | number;
    chain_type: string | null;
    owner_address: string | null;
  }>;
  error?: {
    code?: string;
    message?: string;
  };
  meta?: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
      nextCursor?: string | null;
    };
  };
}

export class ScanRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string, retryable = isRetryableScanStatus(status)) {
    super(message);
    this.name = "ScanRequestError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function isRetryableScanStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function scanErrorMessage(status: number, body: ScanApiResponse | null): string {
  const detail = body?.error?.message ?? body?.error?.code;
  const suffix = detail ? `: ${detail}` : "";
  return `SCAN request failed (${status})${suffix}`;
}

/** Fetch a page of agents from the 8004scan public API using cursor pagination. */
export async function fetchAgentsPage(
  env: Env,
  cursor: string | null = null,
): Promise<ScanPage> {
  const limit = Number(env.SCAN_PAGE_LIMIT) || 20;
  const url = new URL(env.SCAN_BASE_URL);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sortBy", "created_at");
  url.searchParams.set("sortOrder", "desc");
  if (cursor) url.searchParams.set("cursor", cursor);

  console.log("[scan] request", { cursor: cursor !== null, limit });
  const startedAt = Date.now();
  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-API-Key": env.SCAN_API_KEY,
    },
    signal: AbortSignal.timeout(30_000),
  });

  let body: ScanApiResponse | null = null;
  try {
    body = (await resp.json()) as ScanApiResponse;
  } catch {
    body = null;
  }

  if (!resp.ok) {
    console.error("[scan] request failed", {
      status: resp.status,
      ms: Date.now() - startedAt,
      detail: body?.error,
    });
    throw new ScanRequestError(resp.status, scanErrorMessage(resp.status, body));
  }

  const agents: ScanAgent[] = (body?.data ?? []).map((a) => ({
    name: a.name ?? null,
    description: a.description ?? null,
    chain_id: normalizeUint256Decimal(a.chain_id),
    token_id: normalizeUint256Decimal(a.token_id),
    chain_type: a.chain_type ?? null,
    owner_address: a.owner_address ?? null,
  }));

  const nextCursor = body?.meta?.pagination?.nextCursor || null;
  const hasMore = nextCursor !== null && (body?.meta?.pagination?.hasMore ?? true);
  console.log("[scan] response", {
    count: agents.length,
    hasMore,
    total: body?.meta?.pagination?.total,
    ms: Date.now() - startedAt,
  });
  return { agents, hasMore, nextCursor };
}
