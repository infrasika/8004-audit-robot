# 8004-audit-robot 审计提交与失败记录重构方案

> 文档状态：已实现，待生产迁移与部署。
>
> 核验基线：2026-08-02 的当前仓库实现，以及 8004scan Public API OpenAPI 1.0.0。

## 1. 结论

原始重构方向合理，但必须明确“提交失败”和“审计结果失败”的边界，并补齐失败记录的生命周期、迁移顺序及验收标准，否则实现后容易出现误记、漏记或重复提交。

本次重构采用以下语义：

- 删除 `audit_records`，不再持久化每次审计的成功、失败、`report_id` 或 `cached` 等结果。
- 新增 `oasf_audit_fails`，它不是错误流水表，而是“当前尚未确认成功提交到 `POST /oasf/audit` 的 agent 集合”，未来可直接作为重试来源。
- `POST /oasf/audit` 出现网络、超时、非 2xx 或响应协议异常时，按 `(chain_id, token_id)` 写入或更新失败记录；HTTP 2xx 中的结构化业务错误除外。
- auditor 实际会用 HTTP 500 返回结构化 `AGENT_CARD_NOT_FOUND`；该错误明确表示请求已处理但审计因缺少 agent card 未启动，不是漏提交，因此是唯一的跨 HTTP 状态业务例外。
- `POST /oasf/audit` 返回合法 `auditId` 即视为提交成功：不新增成功记录；如果该 agent 曾有失败记录，则删除旧记录。
- `/oasf/audit` 返回 HTTP 2xx 且包含结构化 `error` 对象，代表接口已正常处理并返回业务结果，即使没有 `auditId` 也不属于漏审；不写失败表、不轮询报告，并删除该 agent 可能残留的旧失败记录。
- 提交成功后，仍沿用现有逻辑轮询 `GET /oasf/report/{auditId}`，直到终态或轮询总超时，再按当前节奏处理下一个 agent。
- 报告轮询异常、报告终态 `failed`、`cached`、`completed` 等都不写入 `oasf_audit_fails`，因为这些情况不代表 `/oasf/audit` 提交被漏掉。

## 2. 重构前实现核验

重构前流程为：

1. `src/scan.ts` 分页请求 `SCAN_BASE_URL`，得到 agent 批次。
2. `AuditScheduler.alarm()` 每次处理一个提交或轮询步骤。
3. `src/auditor.ts` 当前把审计目标拼成 `chain_id:token_id`，然后 `await POST ${AUDITOR_BASE_URL}/oasf/audit`。
4. 返回合法 `auditId` 后，Durable Object 保存 `pendingAudit`，并轮询 `GET /oasf/report/{auditId}`。
5. 审计完成、业务失败或轮询超时后，`finishAgent()` 先向 `audit_records` 插入一行，再移动游标并调度下一个 agent。
6. Worker 还通过 `GET /records` 直接查询 `audit_records`。

因此本次实施不能只改建表语句，还必须同步调整：

- 审计 target 的构造方式；
- `/oasf/audit` 结果分类；
- `finishAgent()` 的落库职责和游标推进条件；
- 旧失败记录的清理；
- `/records` 路由及首页 endpoint 列表；
- `README.md` 和 `docs/DEPLOYMENT.md` 中关于 D1、target 和接口的说明。

重构前仓库没有自动化测试；本次实现已补充提交分类、target 构造、扫描映射和 D1
访问测试，生产发布仍需执行 smoke test。

## 3. 范围

### 3.1 本次包含

- 将 `/oasf/audit` 请求体中的 `target` 改为 agent 详情 URL。
- 仅持久化 `/oasf/audit` 提交阶段的可重试失败。
- 失败记录按 agent 幂等更新，提交成功时清理。
- 删除旧的全量审计记录表和读取接口。
- 保持当前单 agent 串行提交、异步报告轮询和间隔调度模型。
- 补充迁移、测试、日志、发布与回滚说明。

### 3.2 本次不包含

- 不实现消费 `oasf_audit_fails` 的自动重试任务；本次只为未来重试准备可靠数据。
- 不保存成功审计结果、`auditId/report_id`、`cached` 或报告业务内容。
- 不保存 HTTP 2xx 中的结构化业务错误，也不保存任意 HTTP 状态下的结构化 `AGENT_CARD_NOT_FOUND`。
- 不改变“一轮遍历全部 agent”的分页策略。
- 不把 8004scan 列表接口自身的失败写入 `oasf_audit_fails`；列表请求失败仍由当前调度恢复机制处理。
- 不改变 auditor 的业务成功/失败判定规则。

## 4. 审计目标 URL

8004scan 官方接口提供：

- 列表：`GET https://8004scan.io/api/v1/public/agents`
- 详情：`GET https://8004scan.io/api/v1/public/agents/{chainId}/{tokenId}`

提交到 auditor 的请求仍为：

```http
POST ${AUDITOR_BASE_URL}/oasf/audit
Content-Type: application/json

{
  "target": "{chain_id}:{token_id}",
  "force": false
}
```

实现约束：

- target 应以配置项 `SCAN_BASE_URL` 为基地址构造，而不是在代码中重复硬编码域名和路径。
- 构造前统一处理基地址末尾 `/`，并分别对 `chain_id`、`token_id` 做路径段编码，避免双斜杠或路径注入。
- `(chain_id, token_id)` 仍是 agent 的稳定标识；`token_id` 在应用和 D1 中按文本保存，避免超出 JavaScript 安全整数范围后发生精度损失。
- 8004scan 官方 OpenAPI 的 Agent 模型包含 `description`，扫描映射时需要将其纳入 `ScanAgent`，供失败表保存。

## 5. 失败分类

只有无法确认 `/oasf/audit` 已返回合法 `auditId`，且没有收到可识别的正常业务结果时，才进入 `oasf_audit_fails`。

| 场景 | 是否写入失败表 | `error_kind` | 后续行为 |
| --- | --- | --- | --- |
| DNS、连接、TLS、`fetch` 异常 | 是 | `network` | 写入成功后推进游标 |
| 请求超时或主动 abort | 是 | `timeout` | 写入成功后推进游标 |
| 2xx，但 body 不是合法 JSON | 是 | `protocol` | 写入成功后推进游标 |
| 2xx，且返回合法 `auditId` | 否；删除该 agent 的旧失败行 | — | 保存 `pendingAudit` 并开始轮询 |
| 2xx，无 `auditId`，但有结构化 `error` 对象 | 否；删除该 agent 的旧失败行 | — | 正常业务结果，不轮询报告；按正常间隔推进游标 |
| 2xx，既无合法 `auditId`，也无结构化业务错误 | 是 | `protocol` | 写入成功后推进游标 |
| 任意 HTTP 状态 + `error.code === "AGENT_CARD_NOT_FOUND"` | 否；删除该 agent 的旧失败行 | — | 正常业务结果，不轮询报告；按正常间隔推进游标 |
| HTTP 429 | 是 | `http` | 保存状态码和 `Retry-After`，写入成功后推进游标 |
| 其他非 2xx | 是 | `http` | 保存状态码及截断后的响应摘要，写入成功后推进游标 |
| 合法响应中的 `cached`、`status`、`reportUrl` | 否 | — | 作为内存/DO 调度信息使用，不落 D1 |
| `GET /oasf/report/{auditId}` 网络或 HTTP 错误 | 否 | — | 按现有轮询间隔重试，直到总超时 |
| 报告终态 `failed` | 否 | — | 这是审计业务结果，不是提交漏审 |
| 报告轮询总超时或未知状态 | 否 | — | 结束当前 agent，保留日志与运行时统计 |

分类顺序必须是：先读取并解析 JSON，再结合 HTTP 状态判断业务结果，最后才归类为 HTTP/协议失败。

可识别的结构化业务错误至少满足以下形态：

```json
{
  "error": {
    "code": "BUSINESS_ERROR_CODE",
    "message": "Business error details.",
    "retryable": false
  }
}
```

- HTTP 2xx 下，只要存在结构化 `error` 对象且 `error.code` 是非空字符串，就视为正常业务结果；`retryable` 为 `true` 或 `false` 都不改变“不是漏审”的判断。
- HTTP 非 2xx 原则上按 HTTP 提交失败处理；唯一例外是结构化 `error.code === "AGENT_CARD_NOT_FOUND"`。
- 不能通过对 `message` 或原始响应文本做模糊匹配来跳过记录。
- 响应无法解析时按 HTTP/协议失败处理；2xx JSON 若既没有合法 `auditId`，也没有符合上述结构的 `error`，按协议失败处理。

说明：网络超时时服务端可能已经收到请求，这是分布式调用固有的不确定性。未来重试仍应保持 `force: false`，并依赖 auditor 的幂等/缓存能力降低重复审计风险。

## 6. `oasf_audit_fails` 数据模型

推荐表结构：

```sql
CREATE TABLE IF NOT EXISTS oasf_audit_fails (
  chain_id              TEXT NOT NULL,
  token_id              TEXT NOT NULL,
  chain_type            TEXT,
  name                  TEXT,
  description           TEXT,
  owner_address         TEXT,
  target_url            TEXT NOT NULL,
  last_error_kind       TEXT NOT NULL
                          CHECK (last_error_kind IN ('network', 'timeout', 'http', 'protocol')),
  last_http_status      INTEGER,
  last_error            TEXT NOT NULL,
  last_response_excerpt TEXT,
  last_retry_after      TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 1,
  first_failed_at       TEXT NOT NULL,
  last_failed_at        TEXT NOT NULL,
  PRIMARY KEY (chain_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_oasf_audit_fails_last_failed_at
  ON oasf_audit_fails (last_failed_at);
```

字段与写入规则：

- `(chain_id, token_id)` 为联合主键，保证同一 agent 最多一条待重试记录。
- 再次失败使用 `INSERT ... ON CONFLICT ... DO UPDATE`：刷新 agent 快照、target 和最后一次错误，`attempt_count + 1`，保留 `first_failed_at`。
- `last_error` 和 `last_response_excerpt` 必须限制长度，避免上游 HTML/响应体无限写入 D1；建议分别最多 1 KiB 和 2 KiB。
- 不写请求头、API Key、完整响应体或其他可能包含凭据的信息。
- `last_retry_after` 保存 429 响应中的原始 `Retry-After` 值，未来重试器再统一解析。
- 提交成功或收到上述正常业务结果后，按联合主键执行幂等 `DELETE`；没有旧行时也视为成功。

该表表达的是“当前未解决失败”，不是历史审计日志。因此成功提交时删除旧行是必要行为，否则未来重试会处理已经成功提交的 agent。

## 7. 调度与一致性要求

### 7.1 提交失败

1. `await POST /oasf/audit` 返回或抛错后完成分类。
2. 失败时先 UPSERT `oasf_audit_fails`。
3. 只有 D1 写入成功后才清空当前 agent、推进 `state.index` 并设置下一次 alarm。
4. D1 写入失败时不得推进游标；记录 `lastError`，让 cron/alarm 恢复后重试当前 agent。
5. 提交失败后沿用非缓存请求的 `AUDIT_INTERVAL_MS`，避免紧密重试压垮上游。

这保留了现有“先持久化、再推进游标”的不漏记原则。

### 7.2 提交成功

`POST /oasf/audit` 返回合法 `auditId` 后，顺序必须保证不会因为 D1 清理失败而重复提交：

1. 先将 `pendingAudit` 持久化到 Durable Object；
2. 再幂等删除该 agent 的旧失败行；
3. 删除失败只能记日志并在后续 alarm 中重试清理，不能清除 `pendingAudit`、推进为新提交或再次调用 `/oasf/audit`；
4. 按现有逻辑轮询报告直至 `completed`、`failed` 或总超时；
5. agent 结束后再处理下一个 agent。

Durable Object 与 D1 之间没有跨存储事务，因此上述顺序和清理重试是必须显式处理的故障点。

### 7.3 正常业务错误结果

以下响应进入正常业务错误分支：

- HTTP 2xx 且具有结构化、非空的 `error.code`；
- 任意 HTTP 状态下，结构化 `error.code` 精确等于 `AGENT_CARD_NOT_FOUND`。

处理要求：

1. 将其作为已完成的正常业务结果，而不是网络/HTTP 提交失败；
2. 不创建 `pendingAudit`，因为没有可供轮询的 `auditId`；但要先在 Durable Object 中持久化“业务结果已确认、等待清理”的状态标记；
3. 幂等删除该 agent 可能遗留的 `oasf_audit_fails` 行，避免未来重试器继续处理它；
4. 清理失败时保留上述状态标记，后续 alarm 只能重试清理，不能再次调用 `/oasf/audit`；
5. 清理成功后移除状态标记，并按 `AUDIT_INTERVAL_MS` 调度下一个 agent，不做报告轮询；
6. 日志中应使用独立的业务结果标识，避免被告警系统统计为提交故障。

### 7.4 等待与间隔

- `/oasf/audit` 必须 `await`，禁止 fire-and-forget。
- 提交成功后必须等待报告终态或 `AUDIT_POLL_TIMEOUT_MS`，期间按 `AUDIT_POLL_INTERVAL_MS` 轮询。
- 正常业务错误没有 `auditId`，不进入报告轮询，但仍需等待 `AUDIT_INTERVAL_MS` 后再处理下一个 agent。
- 非缓存审计结束后，再等待 `AUDIT_INTERVAL_MS` 才处理下一个 agent。
- 保持当前行为：`cached === true` 且报告结果已确认时，可以使用短延迟立即处理下一个 agent。
- 这里的“下一个”指同一轮中的下一个 agent，不是自动启动新一轮；一轮遍历完成后仍停止。

### 7.5 运行时统计

`/status` 中现有 `audited/succeeded/failed/cached/pages` 可继续作为单轮运行时指标，但必须注明：

- `stats.failed` 包含业务终态失败或轮询超时，不等于 `oasf_audit_fails` 行数；
- 正常业务错误不计入 `stats.failed`；本次实现通过 `stats.skipped` 单独展示，且绝不计入持久化提交失败数；
- `oasf_audit_fails` 只表示尚未成功提交的唯一 agent 数量；
- 删除 `audit_records` 不应导致状态统计失效。

## 8. HTTP 接口调整

删除 `audit_records` 后，现有 `GET /records` 不能保留原查询，否则会在运行时访问不存在的表。

接口调整确定为：

- 删除首页 endpoint 列表中的 `GET /records`；
- 新增 `GET /audit-failures?limit=50`，按 `last_failed_at DESC` 返回当前失败集合，`limit` 上限保持 500；
- 直接删除 `/records` 路由，不保留别名、`410 Gone` 兼容响应或旧数据查询能力；删除后按普通未知路径返回 `404`。

如果失败查询接口会暴露公网，部署前应延续 `docs/DEPLOYMENT.md` 的安全建议，为管理接口增加鉴权；这不是本次数据重构的前置条件，但不能忽略。

## 9. 数据库迁移与发布顺序

不要修改已可能在生产执行过的 `0001_create_audit_records.sql`。本次不考虑旧表或旧 Worker 的兼容，使用一次破坏性 migration 直接完成替换。

新增 `0002_replace_audit_records.sql`，按以下顺序执行：

1. 创建 `oasf_audit_fails` 及 `idx_oasf_audit_fails_last_failed_at`；
2. 执行 `DROP TABLE IF EXISTS audit_records;`。

旧表数据不备份、不回填到新表，也不提供数据迁移脚本。该 migration 一旦在生产执行，旧审计流水即被永久删除。

新增 `0003_remove_agent_card_not_found_fails.sql`，删除旧版本已误记的
`AGENT_CARD_NOT_FOUND` 行。由于 `last_response_excerpt` 被截断而不是完整 JSON，清理条件匹配响应开头的结构化错误码文本。

由于 D1 migration 与 Worker 发布不是原子操作，发布时接受短暂维护窗口，顺序如下：

1. 调用 `/stop` 停止当前审计轮次，确认 `/status` 中 `active=false`；
2. 应用 `0002_replace_audit_records.sql`；
3. 立即发布新 Worker；
4. 验证 `/records` 返回 404、`/audit-failures` 可查询，并分别 smoke test 提交失败、HTTP 2xx 业务错误和正常审计；
5. 重新启动审计轮次。

如果第 3 步发布失败，旧 Worker 访问 `audit_records` 会报错；这是直接删表方案明确接受的发布风险。恢复时应优先修复并重新发布新 Worker，而不是回滚到依赖旧表的版本。若必须回滚，需要通过新的 D1 migration 重建旧表。

## 10. 代码影响面

| 文件 | 需要调整的职责 |
| --- | --- |
| `src/types.ts` | `ScanAgent` 增加 `description`；拆分提交成功与可持久化提交失败类型 |
| `src/scan.ts` | 映射 `description`，保持 `token_id` 文本化 |
| `src/auditor.ts` | 构造详情 URL target；解析结构化业务错误码；返回可判别的 `accepted/business_result/error_kind/http_status/retry_after`，不直接决定是否落库 |
| `src/db.ts` | 用 `upsertAuditFail`、`deleteAuditFail`、失败列表查询替换 `recordAudit` |
| `src/scheduler.ts` | 仅在提交失败时 UPSERT；成功、HTTP 2xx 业务结果或 `AGENT_CARD_NOT_FOUND` 时清理旧失败；为业务结果清理增加可恢复状态；保持 pending/poll/间隔状态机 |
| `src/index.ts` | 直接删除 `/records` 查询，增加 `/audit-failures` |
| `migrations/` | 增加一次性创建新表并删除旧表的破坏性 migration |
| `README.md`、`docs/DEPLOYMENT.md` | 更新数据语义、target、接口、迁移与排障说明 |

## 11. 实施顺序

1. 先增加类型与 target URL 构造的单元测试。
2. 将 `/oasf/audit` 返回值改为明确的分类结果。
3. 增加新表 migration 和 D1 的 UPSERT/DELETE/查询函数。
4. 调整 scheduler 的失败持久化、成功清理、pending 保存顺序。
5. 调整 HTTP 路由和运行时统计说明。
6. 更新 README、部署文档和生成的 Cloudflare binding 类型（如有变化）。
7. 运行自动化测试、`npm run typecheck`、本地 migration，并执行 Wrangler dry-run。
8. 按第 9 节在维护窗口内应用破坏性 migration 并发布新 Worker。

## 12. 测试矩阵

至少覆盖以下场景：

| 用例 | 预期结果 |
| --- | --- |
| `chain_id=56, token_id=232968` | target 为 `${SCAN_BASE_URL}/56/232968`，无双斜杠 |
| `SCAN_BASE_URL` 末尾已有 `/` | target 仍只有一个路径分隔符 |
| 网络异常/请求超时 | UPSERT 一条对应 kind 的失败记录，之后推进游标 |
| HTTP 429 + `Retry-After` | 保存 429、响应摘要和 header；不保存成功审计字段 |
| 2xx + 任意非空结构化 `error.code` | 正常业务结果；不写失败表、不轮询，删除旧失败行后按正常间隔推进 |
| 500 + 结构化 `error.code=AGENT_CARD_NOT_FOUND` | 正常业务结果；不写失败表，并删除旧失败行 |
| HTTP 4xx/5xx + 其他错误 | 保存为 `http` 失败 |
| 2xx + 非 JSON | 保存为 `protocol` 失败 |
| 2xx + 同时缺少合法 `auditId` 和结构化 `error.code` | 保存为 `protocol` 失败 |
| 2xx + 合法 `auditId` | 不新增失败行；先持久化 pending，再删除旧失败行并轮询 |
| 同一 agent 连续失败 | 表中仍为一行，`attempt_count` 增加，首次时间不变 |
| 曾失败的 agent 后续提交成功 | 对应失败行被删除 |
| 报告返回 `failed` | 不写失败表，按非缓存间隔处理下一个 agent |
| 报告轮询 HTTP 错误后恢复 | 不写失败表，继续轮询至终态 |
| 报告轮询总超时 | 不写失败表，运行时 `stats.failed` 增加 |
| 提交失败记录写 D1 失败 | 不推进游标，后续 alarm 仍处理同一 agent |
| 成功后的失败行清理 D1 失败 | 保留 pending，不重复 POST；后续重试清理 |
| 正常业务错误后清理 D1 失败 | 保留业务结果清理状态，不重复 POST；后续只重试清理 |
| `/records` | 路由已直接移除并返回 404，不查询已删除表 |
| `/audit-failures?limit=...` | 限制最大条数，按最近失败倒序返回 |

## 13. 验收标准

- auditor 收到的 target 是 `chain_id:token_id` 形式；`token_id` 全程保留为字符串。
- `/oasf/audit` 调用始终被 await，同一时刻不会越过当前 agent 提交下一个 agent。
- D1 中不再新增任何成功审计或报告业务结果记录。
- `/oasf/audit` 网络、超时、除 `AGENT_CARD_NOT_FOUND` 外的非 2xx、无效 2xx 响应均能留下唯一且可更新的失败记录。
- HTTP 2xx 的结构化业务错误不写失败表、不进入报告轮询，并最终清除该 agent 的历史失败行。
- 任意 HTTP 状态下的结构化 `AGENT_CARD_NOT_FOUND` 同样不写失败表。
- 合法 `auditId` 返回后，对应旧失败记录最终被清除，且清理故障不会导致重复提交。
- `/oasf/report` 的错误与业务终态不会污染 `oasf_audit_fails`。
- 非缓存任务在报告结束后遵守 `AUDIT_INTERVAL_MS`；缓存命中保持现有快速推进逻辑。
- 删除 `audit_records` 后不存在任何运行时代码或文档仍依赖该表。
- 类型检查、自动化测试、本地 D1 migration、部署 dry-run 全部通过。

## 14. 实施前默认决策

以下是本文为消除歧义采用的默认决策；若产品语义不同，应在改代码前先调整本文：

1. `oasf_audit_fails` 保存当前未解决失败，而非永久错误历史。
2. 2xx 但 JSON 无效，或同时缺少合法 `auditId` 与结构化 `error.code`，属于可重试的协议失败。
3. 已获得 `auditId` 后发生的任何报告轮询错误都不属于 `/oasf/audit` 漏审。
4. `audit_records` 历史数据按需求可删除，不迁移到新表。
5. 未来重试器不在本次实现范围内。
6. HTTP 2xx 中的结构化业务错误均不属于漏审；非 2xx 原则上属于提交失败，但 `AGENT_CARD_NOT_FOUND` 是依据 auditor 实际协议确认的唯一例外。

## 15. 参考

- 8004scan Builder Hub：<https://8004scan.io/developers>
- 8004scan OpenAPI：<https://8004scan.io/api/v1/public/docs/openapi.json>
