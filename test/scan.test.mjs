import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchAgentsPage, ScanRequestError } from "../src/scan.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const env = {
  SCAN_BASE_URL: "https://8004scan.io/api/v1/public/agents",
  SCAN_API_KEY: "scan-api-key",
  SCAN_PAGE_LIMIT: "100",
};

test("fetchAgentsPage uses cursor pagination and stringifies chain and token IDs", async () => {
  let requestedUrl;
  let requestedHeaders;
  globalThis.fetch = async (url, init) => {
    requestedUrl = new URL(url);
    requestedHeaders = new Headers(init.headers);
    return Response.json({
      success: true,
      data: [{
        name: "Example agent",
        description: "Agent description",
        chain_id: 56,
        token_id: 232968,
        chain_type: "evm",
        owner_address: "0x123",
      }],
      meta: {
        pagination: {
          page: 1,
          limit: 100,
          total: 201,
          hasMore: true,
          nextCursor: "cursor-2",
        },
      },
    });
  };

  const result = await fetchAgentsPage(env, "cursor-1");

  assert.equal(requestedUrl.searchParams.get("cursor"), "cursor-1");
  assert.equal(requestedUrl.searchParams.has("page"), false);
  assert.equal(requestedUrl.searchParams.get("limit"), "100");
  assert.equal(requestedHeaders.get("X-API-Key"), "scan-api-key");
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "cursor-2");
  assert.deepEqual(result.agents[0], {
    name: "Example agent",
    description: "Agent description",
    chain_id: "56",
    token_id: "232968",
    chain_type: "evm",
    owner_address: "0x123",
  });
});

test("the first page omits cursor and page query params", async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return Response.json({
      success: true,
      data: [],
      meta: { pagination: { hasMore: false } },
    });
  };

  const result = await fetchAgentsPage(env);

  assert.equal(requestedUrl.searchParams.has("cursor"), false);
  assert.equal(requestedUrl.searchParams.has("page"), false);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
});

test("fetchAgentsPage preserves uint256-sized chain and token IDs", async () => {
  const chainId = "900719925474099312345678901234567890";
  const tokenId = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  globalThis.fetch = async () => Response.json({
    success: true,
    data: [{ chain_id: chainId, token_id: tokenId }],
    meta: { pagination: { hasMore: false } },
  });

  const result = await fetchAgentsPage(env);

  assert.equal(result.agents[0].chain_id, chainId);
  assert.equal(result.agents[0].token_id, tokenId);
});

test("a 422 SCAN backend error is not retryable", async () => {
  globalThis.fetch = async () => Response.json({
    success: false,
    error: { code: "BACKEND_ERROR", message: "An error occurred while fetching data from the backend." },
  }, { status: 422 });

  await assert.rejects(
    () => fetchAgentsPage(env),
    (err) => {
      assert.ok(err instanceof ScanRequestError);
      assert.equal(err.status, 422);
      assert.equal(err.retryable, false);
      assert.match(err.message, /422/);
      assert.match(err.message, /backend/i);
      return true;
    },
  );
});

test("a 503 SCAN error is retryable", async () => {
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });

  await assert.rejects(
    () => fetchAgentsPage(env),
    (err) => {
      assert.ok(err instanceof ScanRequestError);
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});
