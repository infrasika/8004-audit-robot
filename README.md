# 8004-audit-robot

Robot that auto-audits agents listed on [8004scan.io](https://8004scan.io).

It pulls agents from the 8004scan public API page by page, and audits them one at a
time via the auditor service. Non-cached audits are paced at 5 minutes apart; when
the auditor returns `cached: true` it immediately moves on to the next agent. Every
attempt (success or failure) is recorded to D1. A round makes a single pass over all
agents and then stops.

## Architecture

- **Cloudflare Worker** (`src/index.ts`) — HTTP routes + cron handler.
- **Durable Object** `AuditScheduler` (`src/scheduler.ts`) — a single instance that
  drives the whole round using its alarm: fetch a page, audit one agent per alarm,
  advance, and reschedule (immediately if cached, otherwise after the interval).
- **D1** (`migrations/`, `src/db.ts`) — stores one `audit_records` row per attempt.
- **Cron** (`*/5 * * * *`) — safety net only. It resumes an active round if its alarm
  was lost; it never starts a new round.

Flow: SCAN API → `AuditScheduler` (alarm loop) → auditor `/oasf/audit` → D1.

`target` is `chain_id:token_id` (e.g. `56:232968`).

## Audit record fields

`name`, `chain_id`, `token_id`, `chain_type`, `owner_address`, `audited_at`,
`report_id` (auditId), `cached`, `success` (0 on network/parse/HTTP errors, i.e. no
`report_id`), `error`.

The audit `target` is derived on the fly as `chain_id:token_id`, so it isn't stored
as its own column.

## Setup

```bash
npm install

# Create the D1 database, then paste the returned database_id into wrangler.jsonc
npx wrangler d1 create audit_robot

# Apply migrations
npm run db:migrate:local     # local dev
npm run db:migrate:remote    # production

# Generate binding types
npm run cf-typegen
```

### Database migrations

Schema changes live in `migrations/` and are applied with D1's built-in migration
system.

```bash
npm run db:migrate:new -- <message>   # scaffold migrations/NNNN_<message>.sql
# edit the generated file, then apply:
npm run db:migrate:local              # apply to local DB
npm run db:migrate:remote             # apply to production DB
npm run db:migrate:list               # show applied / pending migrations (local)
```

Migrations are applied in order and tracked in D1, so each file runs once.

Configuration lives in `wrangler.jsonc` under `vars`:

| Var | Meaning | Default |
| --- | --- | --- |
| `SCAN_BASE_URL` | 8004scan agents endpoint | `https://8004scan.io/api/v1/public/agents` |
| `SCAN_PAGE_LIMIT` | agents fetched per page | `20` |
| `AUDITOR_BASE_URL` | auditor service base URL | `https://auditor-agent.infrasika.workers.dev` |
| `AUDIT_INTERVAL_MS` | delay between non-cached audits | `300000` (5 min) |

## Run

```bash
npm run dev      # local
npm run deploy   # production
```

### Endpoints

| Method + path | Description |
| --- | --- |
| `POST /start` | start a fresh round (409 if one is already running) |
| `POST /stop` | stop the current round |
| `GET /status` | current round progress + stats |
| `GET /records?limit=50` | recent audit records from D1 |

Kick off a round:

```bash
curl -X POST https://<your-worker>.workers.dev/start
```

## Notes

- 8004scan currently lists 660k+ agents; a full non-cached round at 5-min pacing is
  effectively unbounded in time. Cached agents are processed back-to-back, so real
  throughput depends heavily on the auditor's cache hit rate. Tune `AUDIT_INTERVAL_MS`
  as needed.
- Errors are only recorded, never retried (per spec). The cron safety net just resumes
  a stalled-but-active round.
