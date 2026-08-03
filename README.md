# 8004-audit-robot

Robot that auto-audits agents listed on [8004scan.io](https://8004scan.io).

It pulls agents from the 8004scan public API page by page, and audits them one at a
time via the auditor service. After an audit is accepted, the robot polls its report
until the auditor reports `completed` or `failed`, then moves to the next agent.
Structured business errors returned with HTTP 2xx are treated as completed business
results and are not retried. The auditor currently returns `AGENT_CARD_NOT_FOUND`
with HTTP 500, so that exact structured error code is treated the same way regardless
of HTTP status. Non-cached audits are paced at the configured interval;
cached audits move on immediately after completion is confirmed. D1 only stores
unresolved transport, HTTP, timeout, or protocol failures from `POST /oasf/audit`.
A round makes a single pass over all agents and then stops.

## Architecture

- **Cloudflare Worker** (`src/index.ts`) — HTTP routes + cron handler.
- **Durable Object** `AuditScheduler` (`src/scheduler.ts`) — a single instance that
  drives the whole round using its alarm: fetch a page, audit one agent per alarm,
  advance, and reschedule (immediately if cached, otherwise after the interval).
- **D1** (`migrations/`, `src/db.ts`) — stores the current unresolved submission
  failures in `oasf_audit_fails`, one row per `(chain_id, token_id)`.
- **Cron** (`*/5 * * * *`) — safety net only. It resumes an active round if its alarm
  was lost; it never starts a new round.

Flow: SCAN API → `AuditScheduler` (alarm loop) → auditor `/oasf/audit` → D1.

`target` uses the lossless `chain_id:token_id` identity format, for example
`56:232968`. The auditor keeps `token_id` as a string so uint256-sized IDs are
not rounded by JavaScript number conversion.

## Submission failure fields

`chain_id`, `token_id`, `chain_type`, `name`, `description`, `owner_address`,
`target_url`, the latest error kind/status/message/response excerpt/`Retry-After`,
`attempt_count`, `first_failed_at`, and `last_failed_at`.

The table represents unresolved submission failures, not history. Repeated failures
upsert the same row; a later accepted submission, HTTP 2xx business result, or
`AGENT_CARD_NOT_FOUND` response deletes the row. Successful audits, report results,
`auditId`, and `cached` are not stored.

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

| Var | Meaning |
| --- | --- |
| `SCAN_BASE_URL` | 8004scan agents endpoint |
| `SCAN_API_KEY` | API key sent to 8004scan as the `X-API-Key` header |
| `SCAN_PAGE_LIMIT` | agents fetched per page |
| `AUDITOR_BASE_URL` | auditor service base URL |
| `AUDIT_INTERVAL_MS` | delay between non-cached audits and 2xx business results |
| `AUDIT_POLL_INTERVAL_MS` | delay between report-status polls |
| `AUDIT_POLL_TIMEOUT_MS` | maximum time to wait for a terminal report status |

Runtime values are environment-specific; use the checked-in `wrangler.jsonc` as the
source of truth for the current deployment configuration.

## Run

```bash
npm run dev      # local
npm run deploy   # production
npm test         # submission classification tests
```

### Endpoints

| Method + path | Description |
| --- | --- |
| `POST /start` | start a fresh round (409 if one is already running) |
| `POST /stop` | stop the current round |
| `GET /status` | current round progress + stats |
| `GET /audit-failures?limit=50` | current unresolved submission failures from D1 |

Kick off a round:

```bash
curl -X POST https://<your-worker>.workers.dev/start
```

## Notes

- 8004scan contains a large number of agents; a full non-cached round can be
  effectively unbounded in time. Cached agents are processed back-to-back, so real
  throughput depends heavily on the auditor's cache hit rate. Tune `AUDIT_INTERVAL_MS`
  as needed.
- Submission failures are recorded but not automatically retried in a separate retry
  queue yet. The cron safety net only resumes a stalled active round.
