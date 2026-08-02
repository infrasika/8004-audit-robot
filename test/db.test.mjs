import assert from "node:assert/strict";
import test from "node:test";
import { deleteAuditFail, listAuditFails, upsertAuditFail } from "../src/db.ts";

const agent = {
  name: "Example agent",
  description: "An example",
  chain_id: "56",
  token_id: "232968",
  chain_type: "evm",
  owner_address: "0x123",
};

function mockEnv({ results = [] } = {}) {
  const statements = [];
  return {
    statements,
    env: {
      DB: {
        prepare(sql) {
          const statement = { sql, values: [] };
          statements.push(statement);
          return {
            bind(...values) {
              statement.values = values;
              return {
                async run() {},
                async all() {
                  return { results };
                },
              };
            },
          };
        },
      },
    },
  };
}

test("upsertAuditFail writes a bounded, idempotent failure row", async () => {
  const { env, statements } = mockEnv();
  const longError = "e".repeat(1_100);
  const longResponse = "r".repeat(2_100);

  await upsertAuditFail(
    env,
    agent,
    "56:232968",
    {
      kind: "http",
      httpStatus: 429,
      error: longError,
      responseExcerpt: longResponse,
      retryAfter: "30",
    },
    "2026-08-02T00:00:00.000Z",
  );

  assert.match(statements[0].sql, /ON CONFLICT \(chain_id, token_id\) DO UPDATE/);
  assert.match(statements[0].sql, /attempt_count = oasf_audit_fails\.attempt_count \+ 1/);
  assert.equal(statements[0].values[0], "56");
  assert.equal(statements[0].values[1], "232968");
  assert.equal(statements[0].values[9].length, 1_024);
  assert.equal(statements[0].values[10].length, 2_048);
  assert.equal(statements[0].values[12], "2026-08-02T00:00:00.000Z");
  assert.equal(statements[0].values[13], "2026-08-02T00:00:00.000Z");
});

test("deleteAuditFail deletes by the composite agent key", async () => {
  const { env, statements } = mockEnv();

  await deleteAuditFail(env, agent);

  assert.match(statements[0].sql, /WHERE chain_id = \? AND token_id = \?/);
  assert.deepEqual(statements[0].values, ["56", "232968"]);
});

test("listAuditFails returns newest failures with a bound limit", async () => {
  const rows = [{ chain_id: "56", token_id: "232968" }];
  const { env, statements } = mockEnv({ results: rows });

  const result = await listAuditFails(env, 25);

  assert.deepEqual(result, rows);
  assert.match(statements[0].sql, /ORDER BY last_failed_at DESC LIMIT \?/);
  assert.deepEqual(statements[0].values, [25]);
});
