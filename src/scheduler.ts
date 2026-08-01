import { DurableObject } from "cloudflare:workers";
import type { AuditOutcome, Env, ScanAgent } from "./types";
import { fetchAgentsPage } from "./scan";
import { pollAudit, startAudit } from "./auditor";
import { recordAudit } from "./db";

const STATE_KEY = "state";
/** Small delay used to chain immediately when a result is cached. */
const IMMEDIATE_DELAY_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 1_860_000;
const ALARM_LEASE_MS = 120_000;

interface RoundStats {
  audited: number;
  succeeded: number;
  failed: number;
  cached: number;
  pages: number;
}

interface RoundState {
  active: boolean;
  roundId: string | null;
  page: number; // last fetched page (0 = none yet)
  batch: ScanAgent[]; // current batch of agents
  index: number; // next index within batch to audit
  hasMore: boolean; // whether SCAN reports more pages after `page`
  stats: RoundStats;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  pendingAudit: PendingAudit | null;
  /** Prevent the cron safety net from mistaking a running alarm for a lost one. */
  alarmLeaseUntil: string | null;
}

interface PendingAudit {
  auditId: string;
  cached: boolean | null;
  submittedAt: string;
  lastStatus: string | null;
  pollAttempts: number;
}

function freshState(): RoundState {
  return {
    active: false,
    roundId: null,
    page: 0,
    batch: [],
    index: 0,
    hasMore: true,
    stats: { audited: 0, succeeded: 0, failed: 0, cached: 0, pages: 0 },
    startedAt: null,
    finishedAt: null,
    lastError: null,
    pendingAudit: null,
    alarmLeaseUntil: null,
  };
}

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class AuditScheduler extends DurableObject<Env> {
  private async load(): Promise<RoundState> {
    const stored = await this.ctx.storage.get<Partial<RoundState>>(STATE_KEY);
    if (!stored) return freshState();
    const fresh = freshState();
    return {
      ...fresh,
      ...stored,
      stats: { ...fresh.stats, ...stored.stats },
      pendingAudit: stored.pendingAudit ?? null,
      alarmLeaseUntil: stored.alarmLeaseUntil ?? null,
    };
  }

  private async save(state: RoundState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private async isCurrentRound(state: RoundState): Promise<boolean> {
    const current = await this.load();
    return current.active && current.roundId === state.roundId;
  }

  /** Start a fresh audit round. No-op if one is already running. */
  async start(): Promise<{ started: boolean; reason?: string; state: RoundState }> {
    const current = await this.load();
    if (current.active) {
      return { started: false, reason: "a round is already running", state: current };
    }
    const state = freshState();
    state.active = true;
    state.roundId = crypto.randomUUID();
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
      const leaseUntil = Date.parse(state.alarmLeaseUntil ?? "");
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
        return { resumed: false, state };
      }
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
    state.alarmLeaseUntil = null;
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
    state.pendingAudit = null;
    state.alarmLeaseUntil = null;
    await this.save(state);
    await this.ctx.storage.deleteAlarm();
    console.log("[round] finished", {
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      stats: state.stats,
    });
  }

  private pollIntervalMs(): number {
    return positiveMs(this.env.AUDIT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  }

  private pollTimeoutMs(): number {
    return positiveMs(this.env.AUDIT_POLL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS);
  }

  private async schedule(state: RoundState, delayMs: number): Promise<void> {
    // Persist progress before making the next alarm visible.
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
    state.alarmLeaseUntil = null;
    await this.save(state);
  }

  private async finishAgent(
    state: RoundState,
    agent: ScanAgent,
    outcome: AuditOutcome,
    auditedAt: string,
  ): Promise<void> {
    // Persist the record BEFORE advancing the cursor so no agent is ever skipped.
    try {
      await recordAudit(this.env, agent, outcome, auditedAt);
    } catch (err) {
      if (!(await this.isCurrentRound(state))) return;
      state.lastError = `DB write failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.save(state);
      throw err;
    }

    // An operator may have stopped this round while the D1 request was in flight.
    if (!(await this.isCurrentRound(state))) return;

    state.pendingAudit = null;
    state.index += 1;
    state.stats.audited += 1;
    if (outcome.success) state.stats.succeeded += 1;
    else state.stats.failed += 1;
    if (outcome.cached === true) state.stats.cached += 1;
    state.lastError = null;

    const intervalMs = positiveMs(this.env.AUDIT_INTERVAL_MS, 300_000);
    const delay = outcome.cached === true ? IMMEDIATE_DELAY_MS : intervalMs;
    await this.schedule(state, delay);
  }

  private async pollPendingAudit(state: RoundState, agent: ScanAgent): Promise<void> {
    const pending = state.pendingAudit!;
    const result = await pollAudit(this.env, pending.auditId);
    // Do not let an old alarm overwrite a stopped or newly-started round.
    if (!(await this.isCurrentRound(state))) return;
    pending.pollAttempts += 1;
    if (result.status !== null) pending.lastStatus = result.status;

    if (result.terminal) {
      await this.finishAgent(
        state,
        agent,
        {
          reportId: pending.auditId,
          cached: pending.cached,
          success: result.success,
          error: result.error,
        },
        pending.submittedAt,
      );
      return;
    }

    const submittedAtMs = Date.parse(pending.submittedAt);
    const elapsedMs = Number.isFinite(submittedAtMs) ? Date.now() - submittedAtMs : 0;
    if (elapsedMs >= this.pollTimeoutMs()) {
      const lastDetail = result.error ?? `last status: ${pending.lastStatus ?? "unknown"}`;
      await this.finishAgent(
        state,
        agent,
        {
          reportId: pending.auditId,
          cached: pending.cached,
          success: false,
          error: `Audit polling timed out after ${elapsedMs} ms (${lastDetail})`,
        },
        pending.submittedAt,
      );
      return;
    }

    state.lastError = result.error;
    await this.schedule(state, this.pollIntervalMs());
  }

  /** Alarm advances one submission or polling step per invocation. */
  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state.active) return;
    state.alarmLeaseUntil = new Date(Date.now() + ALARM_LEASE_MS).toISOString();
    await this.save(state);

    if (state.pendingAudit !== null) {
      const pendingAgent = state.batch[state.index];
      if (!pendingAgent) {
        state.lastError = "Pending audit has no matching agent; dropping stale pending state";
        state.pendingAudit = null;
        await this.schedule(state, IMMEDIATE_DELAY_MS);
        return;
      }
      await this.pollPendingAudit(state, pendingAgent);
      return;
    }

    // Advance to the next available agent, fetching new pages as needed.
    if (state.index >= state.batch.length) {
      if (state.page > 0 && !state.hasMore) {
        await this.finalize(state);
        return;
      }
      const next = await fetchAgentsPage(this.env, state.page + 1);
      if (!(await this.isCurrentRound(state))) return;
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
    const submission = await startAudit(this.env, agent);
    if (!(await this.isCurrentRound(state))) return;

    if (!submission.accepted || !submission.reportId) {
      await this.finishAgent(
        state,
        agent,
        {
          reportId: submission.reportId,
          cached: submission.cached,
          success: false,
          error: submission.error ?? "Auditor did not accept the audit",
        },
        auditedAt,
      );
      return;
    }

    state.pendingAudit = {
      auditId: submission.reportId,
      cached: submission.cached,
      submittedAt: auditedAt,
      lastStatus: submission.status,
      pollAttempts: 0,
    };
    state.lastError = null;
    await this.schedule(
      state,
      submission.cached === true ? IMMEDIATE_DELAY_MS : this.pollIntervalMs(),
    );
  }
}
