# Cloudflare 部署指南

本文档用于将 `8004-audit-robot` 部署到 Cloudflare Workers。

部署后的 Worker 会：

- 从 8004scan 分页读取 agent；
- 通过 Durable Object alarm 逐个提交审计；
- 只将 `/oasf/audit` 的网络、超时、非 2xx 和协议失败写入 D1；结构化
  `AGENT_CARD_NOT_FOUND` 是跨 HTTP 状态的业务结果例外；
- 每 5 分钟执行一次 Cron，恢复意外丢失的 alarm；
- 提供 `/start`、`/stop`、`/status` 和 `/audit-failures` 管理接口。

> Cron 不会自动启动新的审计轮次。首次启动以及每轮结束后的再次启动，都需要调用
> `POST /start`。

## 1. 部署前检查

需要准备：

- Cloudflare 账户；
- 已部署且可以正常响应的 `auditor-agent`；
- Node.js 和 npm；
- 当前 Cloudflare 账户中创建 Workers、D1 和 Durable Objects 的权限。

安装依赖并登录 Cloudflare：

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

确认 auditor 服务健康：

```bash
curl https://auditor-agent.infrasika.workers.dev/oasf/health
```

预期响应：

```json
{
  "status": "ok",
  "service": "AgentAudit",
  "version": "1.0.0"
}
```

如果本机直连 `workers.dev` 超时，但通过系统代理可以访问，可以继续部署。部署后的
Worker 从 Cloudflare 网络发出请求，不依赖本机到 `workers.dev` 的网络链路。

## 2. 创建并配置 D1

首次部署时创建生产数据库：

```bash
npx wrangler d1 create audit_robot
```

命令会输出真实的 `database_id`。将其写入 `wrangler.jsonc`：

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "audit_robot",
      "database_id": "<真实的 D1 database_id>"
    }
  ]
}
```

不要保留仓库中的占位值：

```text
REPLACE_WITH_D1_DATABASE_ID
```

如果数据库已经存在，不要重复创建。可以查询当前账户中的 D1：

```bash
npx wrangler d1 list
```

应用生产迁移：

```bash
npm run db:migrate:remote
```

检查远程迁移状态：

```bash
npx wrangler d1 migrations list audit_robot --remote
```

`0002_replace_audit_records.sql` 会创建 `oasf_audit_fails` 并直接删除
`audit_records`。这是不可逆的数据删除，不保留旧审计流水。

`0003_remove_agent_card_not_found_fails.sql` 会删除旧版本误写入的
`AGENT_CARD_NOT_FOUND` 失败行。

## 3. 配置审计服务调用

当前代码使用以下公网地址：

```jsonc
"AUDITOR_BASE_URL": "https://auditor-agent.infrasika.workers.dev"
```

### 方案 A：Service Binding（推荐）

如果 `8004-audit-robot` 和 `auditor-agent` 位于同一个 Cloudflare 账户，推荐使用
Service Binding。它不会经过公开的 `workers.dev` 地址，并能避免同区域
Worker-to-Worker `fetch()` 的路由限制。

先确保目标 Worker 已经部署，然后在 `wrangler.jsonc` 中加入：

```jsonc
{
  "services": [
    {
      "binding": "AUDITOR",
      "service": "auditor-agent"
    }
  ]
}
```

还需要完成两处代码适配：

1. 在 `Env` 类型中加入 `AUDITOR: Fetcher`；
2. 将 `src/auditor.ts` 中的全局 `fetch()` 改为 `env.AUDITOR.fetch()`。

示例：

```ts
const request = new Request("https://auditor/oasf/audit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});

const resp = await env.AUDITOR.fetch(request);
```

传给 `Request` 的 hostname 只是构造完整 URL 所需；请求实际由 Service Binding
发送到 `auditor-agent`。

### 方案 B：继续使用公开 URL

如果暂时不改代码，可以继续使用 `AUDITOR_BASE_URL`。当两个 Worker 位于同一个
Cloudflare 区域时，应在 `wrangler.jsonc` 中启用公开路由兼容标志：

```jsonc
"compatibility_flags": [
  "nodejs_compat",
  "global_fetch_strictly_public"
]
```

否则部署后可能出现 Cloudflare `1042` Worker-to-Worker 错误。

对于长期运行的生产任务，仍建议使用方案 A。

## 4. 检查生产参数

运行参数位于 `wrangler.jsonc`，以下只展示结构；部署值以实际配置文件为准：

```jsonc
"vars": {
  "SCAN_BASE_URL": "https://8004scan.io/api/v1/public/agents",
  "SCAN_PAGE_LIMIT": "<每页数量>",
  "AUDITOR_BASE_URL": "https://auditor-agent.infrasika.workers.dev",
  "AUDIT_INTERVAL_MS": "<审计间隔毫秒>",
  "AUDIT_POLL_INTERVAL_MS": "<轮询间隔毫秒>",
  "AUDIT_POLL_TIMEOUT_MS": "<轮询总超时毫秒>"
}
```

参数说明：

| 参数 | 说明 |
| --- | --- |
| `SCAN_BASE_URL` | 8004scan agent 列表接口 |
| `SCAN_PAGE_LIMIT` | 每页读取数量 |
| `AUDITOR_BASE_URL` | 公开 URL 调用模式下的 auditor 地址 |
| `AUDIT_INTERVAL_MS` | 非缓存审计及 HTTP 2xx 业务结果后的等待时间 |
| `AUDIT_POLL_INTERVAL_MS` | 报告轮询间隔 |
| `AUDIT_POLL_TIMEOUT_MS` | 报告轮询总超时 |

`AUDIT_INTERVAL_MS` 用于非缓存审计结束后以及 HTTP 2xx 业务错误后的等待。
auditor 返回 `cached: true` 且报告已确认时会立即处理下一条。

8004scan 的 agent 数量较多，一轮完整扫描可能运行很久。首次生产验证建议启动后观察
少量 agent 的日志和 `/status`，再通过 `/stop` 停止，不要为了测试直接把审计间隔调得非常小。

## 5. 部署前验证

执行类型检查：

```bash
npm test
npm run typecheck
```

可选：重新生成 Cloudflare binding 类型：

```bash
npm run cf-typegen
```

检查最终部署配置：

```bash
npx wrangler deploy --dry-run
```

重点确认：

- D1 `database_id` 不再是占位符；
- `AUDITOR_BASE_URL` 指向正确环境，或 Service Binding 已配置；
- `auditor-agent` 已先部署；
- Durable Object migration `v1` 存在；
- Cron 为 `*/5 * * * *`。

## 6. 部署

```bash
npm run deploy
```

Wrangler 完成后会输出 Worker 地址，例如：

```text
https://8004-audit-robot.<你的 workers.dev 子域>.workers.dev
```

下面用环境变量保存地址：

```bash
export ROBOT_URL="https://8004-audit-robot.<你的 workers.dev 子域>.workers.dev"
```

检查 Worker 基础响应：

```bash
curl "$ROBOT_URL/"
```

检查初始状态：

```bash
curl "$ROBOT_URL/status"
```

## 7. 启动并验证第一轮

先打开实时日志：

```bash
npx wrangler tail 8004-audit-robot --format pretty
```

在另一个终端启动一轮：

```bash
curl -X POST "$ROBOT_URL/start"
```

重复查询进度：

```bash
curl "$ROBOT_URL/status"
```

查询当前未解决的提交失败：

```bash
curl "$ROBOT_URL/audit-failures?limit=20"
```

正常日志应依次出现：

```text
[scan] request
[scan] response
[round] auditing agent
[audit] request
[audit] accepted | business result | submission failed
```

验证规则：

- 返回合法 `auditId` 的提交不写 D1，并进入报告轮询；
- HTTP 2xx 的结构化业务错误不写 D1，也不进入报告轮询；
- 结构化 `AGENT_CARD_NOT_FOUND` 即使使用 HTTP 500 返回，也不写 D1；
- 网络、超时、其他非 2xx 或无效 2xx 响应会按 agent 联合主键写入失败表；
- 同一 agent 后续正常提交或返回上述业务结果时，旧失败行会被删除。

完成少量生产验证后，可停止当前轮次：

```bash
curl -X POST "$ROBOT_URL/stop"
```

停止不会清空 `oasf_audit_fails` 中尚未解决的提交失败。

## 8. Cron 和 Durable Object

`wrangler.jsonc` 中的生产 Cron：

```jsonc
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

Cron 每 5 分钟检查一次单例 Durable Object：

- 当前轮次未运行时，不执行任何审计；
- 当前轮次正在运行且 alarm 正常时，不重复调度；
- 当前轮次正在运行但 alarm 丢失时，重新设置 alarm 继续执行。

因此：

- 不需要为每个 agent 创建 Cron；
- 重复调用 `/start` 不会创建并行轮次，活动轮次存在时返回 HTTP `409`；
- Worker 发布新版本后，活动状态仍由 Durable Object storage 保存。

## 9. 安全要求

当前代码没有对以下接口进行身份认证：

- `POST /start`
- `POST /stop`
- `GET /status`
- `GET /audit-failures`

直接部署到 `workers.dev` 后，知道地址的任何人都可以调用这些接口。

正式生产环境至少应采用一种保护措施：

- 为管理接口增加 Bearer Token 校验，并通过 `wrangler secret` 保存 token；
- 绑定自定义域名，并使用 Cloudflare Access 保护管理接口；
- 禁用公开 `workers.dev` 地址，只允许受控入口访问。

完成鉴权前，不建议公开传播 Worker URL。`/audit-failures` 中还可能包含 agent owner 地址和
审计错误信息。

## 10. 常见问题

### 本地运行始终在 60 秒后失败

日志示例：

```text
ms: 60004
error: "The operation was aborted due to timeout"
```

这是 `src/auditor.ts` 中 `AbortSignal.timeout(60_000)` 主动取消请求。若 auditor
健康接口通过代理可访问、直连不可访问，原因通常是本机到 `workers.dev` 的网络链路。
部署到 Cloudflare 或改用 Service Binding 后再验证，不建议只增加超时时间。

### 部署后出现错误 1042

原因是一个 Worker 通过普通 `fetch()` 调用同一区域内的另一个 Worker。

处理方式：

1. 优先改用 Service Binding；
2. 或启用 `global_fetch_strictly_public` compatibility flag。

### D1 提示 database ID 无效

确认 `wrangler.jsonc` 中已经使用 `npx wrangler d1 create audit_robot` 返回的真实 ID，
而不是 `REPLACE_WITH_D1_DATABASE_ID`。

### 查询失败记录时提示表不存在

生产迁移尚未执行：

```bash
npm run db:migrate:remote
```

### `/start` 返回 409

已有活动轮次。先查看状态：

```bash
curl "$ROBOT_URL/status"
```

如需结束当前轮次：

```bash
curl -X POST "$ROBOT_URL/stop"
```

然后再调用 `/start`。

### auditor 返回 429

当前公开 URL 请求没有携带 auditor API Key，可能受到匿名调用速率、每日新 agent
数量或并发限制。应查看 auditor 的响应正文及日志，并根据 auditor 的生产策略配置
内部 Service Binding 或认证方式。

### `/status` 长时间没有变化

依次检查：

1. `npx wrangler tail 8004-audit-robot --format pretty` 是否有异常；
2. `SCAN_BASE_URL` 是否能被 Cloudflare Worker 访问；
3. auditor health 是否正常；
4. D1 迁移是否完成；
5. 当前轮次是否被 `/stop` 停止；
6. Cloudflare 控制台中的 Cron trigger 和 Durable Object binding 是否存在。

## 11. 更新与回滚

更新前执行：

```bash
npm ci
npm run typecheck
npx wrangler deploy --dry-run
npm run deploy
```

本次 `0002_replace_audit_records.sql` 会直接删除旧表。发布前先停止活动轮次，然后执行：

```bash
npm run db:migrate:remote
npm run deploy
```

不要再回滚到依赖 `audit_records` 的旧 Worker。D1 migration 不会随 Worker 版本回滚；
如必须恢复旧版本，需要先通过新的 migration 重建旧表。

## 12. 官方参考

- [Cloudflare Workers 部署](https://developers.cloudflare.com/workers/get-started/guide/)
- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [D1 Wrangler 命令](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers 日志和 Tail](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
