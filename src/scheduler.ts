import { DurableObject } from "cloudflare:workers";
import type { Env, ScanAgent } from "./types";
import { fetchAgentsPage } from "./scan";
import { auditAgent } from "./auditor";
import { recordAudit } from "./db";

const STATE_KEY = "state";
/** Small delay used to chain immediately when a result is cached. */
const IMMEDIATE_DELAY_MS = 1_000;

interface RoundStats {
  audited: number;
  succeeded: number;
  failed: number;
  cached: number;
  pages: number;
}

interface RoundState {
  active: boolean;
  page: number; // last fetched page (0 = none yet)
  batch: ScanAgent[]; // current batch of agents
  index: number; // next index within batch to audit
  hasMore: boolean; // whether SCAN reports more pages after `page`
  stats: RoundStats;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

function freshState(): RoundState {
  return {
    active: false,
    page: 0,
    batch: [],
    index: 0,
    hasMore: true,
    stats: { audited: 0, succeeded: 0, failed: 0, cached: 0, pages: 0 },
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };
}

export class AuditScheduler extends DurableObject<Env> {
  private async load(): Promise<RoundState> {
    return (await this.ctx.storage.get<RoundState>(STATE_KEY)) ?? freshState();
  }

  private async save(state: RoundState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  /** Start a fresh audit round. No-op if one is already running. */
  async start(): Promise<{ started: boolean; reason?: string; state: RoundState }> {
    const current = await this.load();
    if (current.active) {
      return { started: false, reason: "a round is already running", state: current };
    }
    const state = freshState();
    state.active = true;
    state.startedAt = new Date().toISOString();
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now());
    console.log("[round] started", { startedAt: state.startedAt });
    return { started: true, state };
  }

  /** Ensure a round keeps making progress; used as a cron safety net. */
  async ensureRunning(): Promise<{ resumed: boolean; state: RoundState }> {
    const state = await this.load();
    if (!state.active) {
      return { resumed: false, state };
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      // Round is active but no alarm scheduled (e.g. lost after a failure) — resume.
      await this.ctx.storage.setAlarm(Date.now());
      console.warn("[round] resumed by cron (alarm was lost)", {
        page: state.page,
        index: state.index,
      });
      return { resumed: true, state };
    }
    return { resumed: false, state };
  }

  async stop(): Promise<RoundState> {
    const state = await this.load();
    state.active = false;
    state.finishedAt = new Date().toISOString();
    await this.save(state);
    await this.ctx.storage.deleteAlarm();
    console.log("[round] stopped", { stats: state.stats });
    return state;
  }

  async status(): Promise<RoundState> {
    return this.load();
  }

  private async finalize(state: RoundState): Promise<void> {
    state.active = false;
    state.finishedAt = new Date().toISOString();
    await this.save(state);
    await this.ctx.storage.deleteAlarm();
    console.log("[round] finished", {
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      stats: state.stats,
    });
  }

  /** Alarm drives the whole round: audits exactly one agent per invocation. */
  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state.active) return;

    // Advance to the next available agent, fetching new pages as needed.
    if (state.index >= state.batch.length) {
      if (state.page > 0 && !state.hasMore) {
        await this.finalize(state);
        return;
      }
      const next = await fetchAgentsPage(this.env, state.page + 1);
      state.page += 1;
      state.batch = next.agents;
      state.hasMore = next.hasMore;
      state.index = 0;
      state.stats.pages += 1;
      state.lastError = null;
      if (state.batch.length === 0) {
        await this.finalize(state);
        return;
      }
      await this.save(state);
    }

    const agent = state.batch[state.index];
    console.log("[round] auditing agent", {
      page: state.page,
      index: state.index,
      batchSize: state.batch.length,
      audited: state.stats.audited,
    });
    const auditedAt = new Date().toISOString();
    const outcome = await auditAgent(this.env, agent);

    // Persist the record BEFORE advancing the cursor so no agent is ever skipped.
    // If the DB write fails we rethrow: the alarm is retried (which may re-audit
    // this agent, at worst producing a duplicate record — never a missed one).
    try {
      await recordAudit(this.env, agent, outcome, auditedAt);
    } catch (err) {
      state.lastError = `DB write failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.save(state);
      throw err;
    }

    // Only now advance the cursor, so a crash before this point re-audits the agent.
    state.index += 1;
    state.stats.audited += 1;
    if (outcome.success) state.stats.succeeded += 1;
    else state.stats.failed += 1;
    if (outcome.cached === true) state.stats.cached += 1;
    state.lastError = null;
    await this.save(state);

    // Cached results skip the wait; otherwise pace at the configured interval.
    const intervalMs = Number(this.env.AUDIT_INTERVAL_MS) || 300_000;
    const delay = outcome.cached === true ? IMMEDIATE_DELAY_MS : intervalMs;
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}
