import type { Env } from "./types";
import { AuditScheduler } from "./scheduler";

export { AuditScheduler };

const SINGLETON = "singleton";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const scheduler = env.SCHEDULER.getByName(SINGLETON);

    // Start a new audit round.
    if (url.pathname === "/start" && request.method === "POST") {
      const result = await scheduler.start();
      return json(result, result.started ? 200 : 409);
    }

    // Stop the current round.
    if (url.pathname === "/stop" && request.method === "POST") {
      return json(await scheduler.stop());
    }

    // Inspect current round progress.
    if (url.pathname === "/status" && request.method === "GET") {
      return json(await scheduler.status());
    }

    // Recent audit records from D1.
    if (url.pathname === "/records" && request.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
      const { results } = await env.DB.prepare(
        `SELECT * FROM audit_records ORDER BY id DESC LIMIT ?`,
      )
        .bind(limit)
        .all();
      return json({ count: results.length, records: results });
    }

    if (url.pathname === "/") {
      return json({
        name: "8004-audit-robot",
        endpoints: {
          "POST /start": "start a fresh audit round (one pass over all agents)",
          "POST /stop": "stop the current round",
          "GET /status": "current round progress",
          "GET /records?limit=50": "recent audit records",
        },
      });
    }

    return json({ error: "not found" }, 404);
  },

  // Cron safety net: resume an active round if its alarm was lost.
  // It never starts a new round — rounds are kicked off via POST /start.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const scheduler = env.SCHEDULER.getByName(SINGLETON);
    const { resumed } = await scheduler.ensureRunning();
    console.log("[cron] tick", { resumed });
  },
} satisfies ExportedHandler<Env>;
