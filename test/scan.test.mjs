import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchAgentsPage } from "../src/scan.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("fetchAgentsPage keeps retry metadata and stringifies chain and token IDs", async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
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
      meta: { pagination: { page: 3, limit: 100, total: 201, hasMore: false } },
    });
  };

  const result = await fetchAgentsPage({
    SCAN_BASE_URL: "https://8004scan.io/api/v1/public/agents",
    SCAN_PAGE_LIMIT: "100",
  }, 3);

  assert.equal(requestedUrl.searchParams.get("page"), "3");
  assert.equal(requestedUrl.searchParams.get("limit"), "100");
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.agents[0], {
    name: "Example agent",
    description: "Agent description",
    chain_id: "56",
    token_id: "232968",
    chain_type: "evm",
    owner_address: "0x123",
  });
});

test("fetchAgentsPage preserves uint256-sized chain and token IDs", async () => {
  const chainId = "900719925474099312345678901234567890";
  const tokenId = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  globalThis.fetch = async () => Response.json({
    success: true,
    data: [{ chain_id: chainId, token_id: tokenId }],
    meta: { pagination: { hasMore: false } },
  });

  const result = await fetchAgentsPage({
    SCAN_BASE_URL: "https://8004scan.io/api/v1/public/agents",
    SCAN_PAGE_LIMIT: "100",
  }, 1);

  assert.equal(result.agents[0].chain_id, chainId);
  assert.equal(result.agents[0].token_id, tokenId);
});
