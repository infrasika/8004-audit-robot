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
  meta?: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  };
}

/** Fetch a single page of agents from the 8004scan public API. */
export async function fetchAgentsPage(env: Env, page: number): Promise<ScanPage> {
  const limit = Number(env.SCAN_PAGE_LIMIT) || 20;
  const url = new URL(env.SCAN_BASE_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sortBy", "created_at");
  url.searchParams.set("sortOrder", "desc");

  console.log("[scan] request", { page, limit, url: url.toString() });
  const startedAt = Date.now();
  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    console.error("[scan] request failed", { page, status: resp.status, ms: Date.now() - startedAt });
    throw new Error(`SCAN request failed (${resp.status}) for page ${page}`);
  }

  const body = (await resp.json()) as ScanApiResponse;
  const agents: ScanAgent[] = (body.data ?? []).map((a) => ({
    name: a.name ?? null,
    description: a.description ?? null,
    chain_id: normalizeUint256Decimal(a.chain_id),
    token_id: normalizeUint256Decimal(a.token_id),
    chain_type: a.chain_type ?? null,
    owner_address: a.owner_address ?? null,
  }));

  const hasMore = body.meta?.pagination?.hasMore ?? agents.length === limit;
  console.log("[scan] response", {
    page,
    count: agents.length,
    hasMore,
    total: body.meta?.pagination?.total,
    ms: Date.now() - startedAt,
  });
  return { agents, hasMore };
}
