import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { startAudit, targetOf } from "../src/auditor.ts";

const originalFetch = globalThis.fetch;

const env = {
  SCAN_BASE_URL: "https://8004scan.io/api/v1/public/agents/",
  AUDITOR_BASE_URL: "https://auditor.example",
};

const agent = {
  name: "Example agent",
  description: "An example",
  chain_id: "56",
  token_id: "232968",
  chain_type: "evm",
  owner_address: "0x123",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("targetOf preserves chain and token IDs in chainId:tokenId format", () => {
  const chainId = "900719925474099312345678901234567890";
  assert.equal(
    targetOf({ ...agent, chain_id: chainId, token_id: "900719925474099312345678901234567891" }),
    `${chainId}:900719925474099312345678901234567891`,
  );
});

test("startAudit accepts a 2xx response with an auditId", async () => {
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return Response.json({ auditId: "audit-1", status: "queued", cached: false }, { status: 202 });
  };

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "accepted");
  assert.equal(result.reportId, "audit-1");
  assert.deepEqual(requestBody, {
    target: "56:232968",
    force: false,
  });
});

test("startAudit treats a structured 2xx error as a business result", async () => {
  globalThis.fetch = async () => Response.json({
    error: {
      code: "BUSINESS_RULE_NOT_SATISFIED",
      message: "The request was handled but cannot start an audit.",
      retryable: false,
    },
  });

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "business_error");
  assert.deepEqual(result.businessError, {
    code: "BUSINESS_RULE_NOT_SATISFIED",
    message: "The request was handled but cannot start an audit.",
    retryable: false,
  });
});

test("a retryable 2xx business error is still not a submission failure", async () => {
  globalThis.fetch = async () => Response.json({
    error: { code: "TEMPORARY_BUSINESS_STATE", retryable: true },
  }, { status: 202 });

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "business_error");
  assert.equal(result.businessError.code, "TEMPORARY_BUSINESS_STATE");
  assert.equal(result.businessError.retryable, true);
});

test("AGENT_CARD_NOT_FOUND is a business result even when returned with HTTP 500", async () => {
  globalThis.fetch = async () => Response.json({
    error: {
      code: "AGENT_CARD_NOT_FOUND",
      message: "Agent card could not be fetched or parsed. Audit was not started.",
      retryable: false,
    },
  }, { status: 500 });

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "business_error");
  assert.equal(result.businessError.code, "AGENT_CARD_NOT_FOUND");
});

test("startAudit records non-2xx responses as HTTP failures", async () => {
  globalThis.fetch = async () => Response.json(
    { error: { code: "BUSINESS_RULE_NOT_SATISFIED", retryable: false } },
    { status: 503, headers: { "Retry-After": "30" } },
  );

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "failure");
  assert.equal(result.failure.kind, "http");
  assert.equal(result.failure.httpStatus, 503);
  assert.equal(result.failure.retryAfter, "30");
});

test("startAudit records malformed 2xx JSON as a protocol failure", async () => {
  globalThis.fetch = async () => new Response("not json", { status: 200 });

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "failure");
  assert.equal(result.failure.kind, "protocol");
});

test("startAudit records incomplete 2xx JSON as a protocol failure", async () => {
  globalThis.fetch = async () => Response.json({ status: "queued" });

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "failure");
  assert.equal(result.failure.kind, "protocol");
});

test("startAudit distinguishes timeout failures", async () => {
  globalThis.fetch = async () => {
    const error = new Error("request timed out");
    error.name = "TimeoutError";
    throw error;
  };

  const result = await startAudit(env, agent);

  assert.equal(result.kind, "failure");
  assert.equal(result.failure.kind, "timeout");
});
