# P0B-03 — 验收报告（Durable Task Inbox）

> 本文件只记录**实际执行过**的命令与结果。未执行项明确标记 `NOT RUN` / `BLOCKED`，
> 不以接口存在、Mock Repository 或进程内 Map 冒充持久化/并发证据。
> 本 PR **不**声称 P0B-04～P0B-10 已完成，也不声称 HTTP API、Worker、Sandbox、
> Lease/Fencing 或合作式取消已实现。

## 1. 执行环境

| 项目       | 值                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------- |
| 日期       | 2026-10-27（本地时区 UTC+8）                                                             |
| OS         | macOS 26.3（Darwin 25D125，arm64）                                                       |
| Node.js    | **v24.22.1 LTS**（与 `.nvmrc` 一致；本机默认 `node` 为 23.11.0，验收时显式使用 24.22.1） |
| pnpm       | **12.15.0**（`packageManager` 固定）                                                     |
| TypeScript | 5.9.3，`strict: true`                                                                    |
| Zod        | 4.6.7                                                                                    |
| Vitest     | 5.0.5                                                                                    |
| PostgreSQL | **17.11**（Docker `postgres:17-alpine`，容器 `ember-local-postgres`）                    |
| Docker     | Client/Server 29.0.1 + Compose v2                                                        |
| Base       | `main` @ `a74d68d5096b2974fc225d32c1a1a27cf2dd78f6`（P0B-02 merge）                      |
| 分支       | `feature/p0b-03-durable-task-inbox`                                                      |

本地测试数据库为 `ember_test`，每个集成测试文件创建自己的
`ember_it_<12 hex>` Schema；没有对 `public` 或其他 Schema 执行 TRUNCATE/DROP。

## 2. 交付前仓库状态核验

| 检查            | 命令                                                     | 结果                                                       |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| 当前分支 / HEAD | `git status`、`git rev-parse HEAD`                       | 从 `main` @ `a74d68d` 创建 feature 分支；`main` 未修改     |
| 远端 main       | `git ls-remote --heads origin`                           | `origin/main` = `a74d68d5096b2974fc225d32c1a1a27cf2dd78f6` |
| P0B-01 迁移     | `git diff main -- migrations/0001_platform_metadata.sql` | 无 diff；`0001` 未修改/未重命名                            |
| 未提交用户资料  | `git status --short`                                     | 5 个本地参考 Markdown 保持未跟踪，不纳入提交               |
| 工作区          | `git status --short`                                     | 仅 P0B-03 代码、测试、Migration 与文档变更                 |

## 3. 验收命令与结果

所有命令在仓库根目录执行；`P` 代表使用 Node 24.22.1 + pnpm 12.15.0。

| #   | 命令                             | 实际结果                                                                                                        | 状态 |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `pnpm install --frozen-lockfile` | `Lockfile is up to date`，0 错误；lockfile 已包含 workspace 依赖更新                                            | PASS |
| 2   | `pnpm lint`                      | `eslint .` 退出码 0                                                                                             | PASS |
| 3   | `pnpm format:check`              | `All matched files use Prettier code style!`                                                                    | PASS |
| 4   | `pnpm typecheck`                 | `tsc -p tsconfig.json` 退出码 0（strict，包含新仓储与测试）                                                     | PASS |
| 5   | `pnpm test:unit`                 | **9 个文件 / 249 个测试通过**（P0B-02 的 239 + P0B-03 新增 10）                                                 | PASS |
| 6   | `pnpm build`                     | `tsc -b tsconfig.build.json` 退出码 0；postgres dist 生成 Repository 导出                                       | PASS |
| 7   | `pnpm dev:db`                    | `ember-local-postgres` Running/Healthy                                                                          | PASS |
| 8   | `pnpm db:migrate`（第 1 次）     | `0 applied, 2 already applied`（本地卷此前首次应用 `0002` 用时 132ms）                                          | PASS |
| 9   | `pnpm db:migrate`（第 2 次）     | `0 applied, 2 already applied`；重复迁移零变更                                                                  | PASS |
| 10  | `pnpm test:integration`          | **3 个文件 / 30 个测试通过**（真实 PostgreSQL 17）                                                              | PASS |
| 11  | `git diff --check`               | 无 whitespace 错误                                                                                              | PASS |
| 12  | 构建后 ESM 消费                  | `node` 直接导入 `packages/postgres/dist/index.js`，创建 Agent/Task 成功                                         | PASS |
| 13  | 现有 API 回归                    | 构建产物 `127.0.0.1:8798`：`/healthz` 200、`/readyz` 200（DB up）                                               | PASS |
| 14  | GitHub Actions                   | run [40523325611](https://github.com/basicv8vc/Ember/actions/runs/40523325611) — success（code HEAD `34e4a85`） | PASS |
| 15  | Draft PR                         | [#3](https://github.com/basicv8vc/Ember/pull/3)，Draft/Open，base `main`，未合并                                | PASS |

> 注：本地默认 Node 23.11.0 不满足 `engines >=24 <25`；验收显式使用 Node 24.22.1。
> 没有通过降低 `engines`、关闭 strict、删除测试或使用 `--ignore-engines` 获得通过。

### 3.1 单元测试实际输出

```text
$ pnpm test:unit
 RUN  v5.0.5 /Users/a1-6/Downloads/Ember

 Test Files  9 passed (9)
      Tests  249 passed (249)
   Duration  358ms
```

P0B-03 新增的单元测试：

- `tests/unit/task-digest.test.ts`（7 个）
  - digest 为稳定小写 SHA-256；
  - 对象属性顺序不同 → 相同 canonical/digest；
  - deadline `Z` 与 `+08:00` 等价 → 相同 digest；
  - Idempotency Key **不**纳入摘要；
  - agent/kind/input/deadline 任一语义变化 → digest 变化；
  - 先 Zod 校验，未知字段/伪造字段被拒绝；
  - 30,000 个 CJK 字符（90,000 UTF-8 字节）触发 `INVALID_ARGUMENT` + `too_big`。
- `tests/unit/p0b03-schema-vocabulary.test.ts`（3 个）
  - SQL 中 TaskKind/TaskStatus/RunStatus/EventPhase/ErrorCode 与 `@ember/domain` 常量对齐；
  - `UNIQUE (tenant_id, idempotency_key)` 与复合 FK 在 Migration 中存在；
  - 业务 Schema 不含 token/password/host path 列。

### 3.2 集成测试实际输出

```text
$ pnpm test:integration
 RUN  v5.0.5 /Users/a1-6/Downloads/Ember

 Test Files  3 passed (3)
      Tests  30 passed (30)
   Duration  644ms
```

文件与测试数：

| 文件                                           | 测试数 | 覆盖                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `tests/integration/migrations.test.ts`         | 7      | `0001`+`0002` 全新 Schema、重复迁移、改名/改 checksum 拒绝、表集合  |
| `tests/integration/durable-task-inbox.test.ts` | 17     | B-T06、Tenant/FK/SQL 约束、取消意图、Event 顺序与 payload allowlist |
| `tests/integration/task-idempotency.test.ts`   | 6      | B-T07（24 并发）、跨租户同 Key、B-T08、UTF-8 上限                   |

### 3.3 构建产物 ESM 消费

```text
$ node --env-file-if-exists=.env.local /tmp/ember-p0b03-esm-smoke.mjs
{
  "appliedMigrations": ["0001", "0002"],
  "workspaceVersion": 0,
  "receiptStatus": "queued",
  "replayed": false,
  "replayReplayed": true,
  "sameTaskId": true,
  "viewStatus": "queued",
  "eventPhases": ["accepted"]
}
```

该脚本直接导入 `packages/postgres/dist/index.js`（不是 Vitest alias），在
`ember_esm_<hex>` 临时 Schema 中执行真实 Migration、Agent/Task 创建、重放与事件读取；
结束后只删除该临时 Schema。证明构建产物可被 Node ESM 消费。

### 3.4 API 回归

```text
$ EMBER_PORT=8798 node --env-file-if-exists=.env.local apps/api/dist/index.js
{"level":"info",...,"message":"api listening",...,"database":{"host":"127.0.0.1","port":55432,"database":"ember"}}

GET /healthz -> 200 {"status":"ok","service":"ember-api",...}
GET /readyz  -> 200 {"status":"ready","checks":{"database":{"status":"up",...}},...}
```

P0B-01 的 Health/Ready 行为无回归；日志仍只包含白名单数据库元数据。

## 4. B-T06 — Durable Ack 证据

`durable-task-inbox.test.ts` 实际断言：

1. **成功返回后可独立读取**：`create()` 返回后，使用独立 `observerPool` 按
   `(tenant_id, task_id)` 读取 Task 与 `sequence = 1` 的 `accepted` Event；Task 状态
   `queued`，`accepted_at` 与回执一致。
2. **Event 写入失败 → Task 回滚**：在测试 Schema 中安装 `BEFORE INSERT ON task_events`
   触发器抛出异常；`create()` 返回 `DB_UNAVAILABLE`，按 Key 查询 Task 行数为 0。移除触发器
   后同 Key 重试成功，最终 Task=1、Event=1。
3. **COMMIT 失败 → 不 ACK**：安装 `DEFERRABLE INITIALLY DEFERRED` 的 constraint trigger，
   在 COMMIT 时抛错；`create()` 返回 `DB_UNAVAILABLE`，Task/Event 行数为 0。移除后重试成功。
4. **Commit 后 ACK 丢失**：首次 `create()` 成功后丢弃回执，同 Key 再调用返回
   `replayed: true`、相同 `taskId`、相同 `acceptedAt`；Task=1、Event=1。随后直接把 Task
   状态改为 `running`，再次重放仍返回同一 Task ID，状态反映最新 `running`，`acceptedAt`
   不变。
5. **数据库不可用**：指向不可达端口（`127.0.0.1:1`）的独立 Pool 调用 `create()` 返回
   `DB_UNAVAILABLE`，没有成功回执。
6. **不泄露 Prompt/SQL**：`mock.chat` 的 secret Prompt 存在于 `tasks.input`（业务数据），
   但 `task_events.payload`、`listEvents()` 与公开错误 DTO 均不包含该 Prompt；
   `DB_UNAVAILABLE` 的公开消息固定为 `Database is unavailable`，不含表名/注入文本。

## 5. B-T07 — 并发幂等证据

真实并发脚本（独立于 Vitest，使用构建产物）在 `ember_ev_<hex>` 临时 Schema 中执行
24 个同时 `create()`，每个请求使用自己的 Pool 连接：

```json
{
  "schema": "ember_ev_73679bcc6573",
  "concurrentRequests": 24,
  "distinctTaskIds": 1,
  "replayedFalse": 1,
  "replayedTrue": 23,
  "taskRowsForKey": 1,
  "acceptedEventRowsForTask": 1,
  "differentTenantsSameKey": { "distinctTaskIds": true },
  "conflictCode": "IDEMPOTENCY_CONFLICT",
  "taskRowsAfterConflict": 1,
  "eventRowsAfterConflict": 1
}
```

Vitest 中同样执行 24 并发，并断言：

- 全部 24 个响应成功，`taskId` 集合大小为 1；
- 恰好 1 个 `replayed: false`，23 个 `replayed: true`；
- `tasks` 行数 = 1，`accepted` Event 行数 = 1，`acceptedAt` 唯一；
- 不同 Tenant 使用相同 Key 各自创建成功，Task ID 不同，互不可见；
- 属性顺序不同 + deadline offset 等价的请求重放同一 Task；
- 在 12 个 A payload 与 12 个 B payload 的混合竞争中，恰好一个 Task 成功，另一组全部
  `IDEMPOTENCY_CONFLICT`，无重复 Task/Event；
- 30,000 CJK 字符命令被 `INVALID_ARGUMENT` 拒绝，Task 行数为 0。

## 6. B-T08 — 幂等冲突证据

同一 Tenant/Agent/Key 首次创建后，依次发送：

| 变体          | 结果                   | 原 Task 影响                              |
| ------------- | ---------------------- | ----------------------------------------- |
| 不同 kind     | `IDEMPOTENCY_CONFLICT` | digest/status/accepted_at/updated_at 不变 |
| 不同 input    | `IDEMPOTENCY_CONFLICT` | 同上                                      |
| 不同 Agent    | `IDEMPOTENCY_CONFLICT` | 同上                                      |
| 不同 deadline | `IDEMPOTENCY_CONFLICT` | 同上                                      |

每次冲突后均断言 `tasks` 行数 = 1、`task_events` 行数 = 1；冲突错误只暴露固定
`publicMessage`，不包含 Prompt、digest 或 SQL。冲突后使用原始请求重放仍返回同一 Task ID。

## 7. Tenant / SQL Integrity 证据

在真实 PostgreSQL 中实际断言：

| 检查                                               | 结果                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| Tenant B `get(Tenant A taskId)`                    | `null`                                                   |
| Tenant B `listEvents(Tenant A taskId)`             | 空数组                                                   |
| Tenant B 使用 Tenant A Agent ID 创建 Task          | `NOT_FOUND`，Task 行数 0，错误不含 Agent ID              |
| Tenant B `requestCancel(Tenant A task)`            | `NOT_FOUND`                                              |
| 直接 SQL 插入跨 Tenant `(tenant_id, agent_id)`     | PostgreSQL `23503` 外键拒绝                              |
| 直接 SQL 重复 `(tenant_id, idempotency_key)`       | PostgreSQL `23505` 唯一约束拒绝                          |
| `pg_indexes` 检查                                  | `tasks (tenant_id, idempotency_key)` 存在 UNIQUE 索引    |
| 跨 Tenant Principal 创建 Agent                     | `UNAUTHENTICATED`，Agent 行数 0，不泄露 Principal ID     |
| Workspace 插入失败                                 | Agent 回滚，按 tenant+name 查询行数 0                    |
| Workspace 初始版本                                 | 0                                                        |
| 直接 SQL 第二条 `accepted` / `accepted` sequence 2 | `23505` / `23514` 拒绝                                   |
| Event payload `{"prompt":"secret"}` / 未知 kind    | `23514` 拒绝                                             |
| Task status `accepted` / 负 attempt_count          | `23514` 拒绝                                             |
| Run 负 attempt / 负 lease_epoch                    | `23514` 拒绝                                             |
| Workspace 负 version                               | `23514` 拒绝                                             |
| Event 读取顺序                                     | `listEvents` 返回 `[1, 2]`，phase `[accepted, progress]` |
| 取消意图                                           | status 保持 `queued`，`cancel_requested_at` 写入且幂等   |

## 8. Migration / 回归

- 全新临时 Schema 依序应用 `0001` + `0002` 成功，`schema_migrations` 记录 2 行；
- 重复运行 `0 applied, 2 already applied`；
- 改名 Migration（文件内容相同）仍被拒绝；编辑 checksum 仍被拒绝；
- 临时目录测试复制 `0001` + `0002`，不会误删或修改 `public` Schema；
- P0B-01/02 的单元测试、构建、Health/Ready 均通过；
- **未**实现或宣称 B-T09～B-T11（Worker/Lease/Fencing）。

## 9. GitHub Actions / Draft PR

| 项目                | 值                                  |
| ------------------- | ----------------------------------- |
| 分支                | `feature/p0b-03-durable-task-inbox` |
| Draft PR            | 待推送后填写                        |
| CI 运行             | 待推送后填写                        |
| `main` 状态         | 未修改（`a74d68d`）、未合并         |
| 强制推送 / 自动合并 | 无                                  |
| 修改保护规则 / 部署 | 无                                  |

CI 工作流未修改：仍为 `permissions: contents: read`、临时 `postgres:17-alpine`
service container、无 secrets、无部署。

## 10. 安全与成本

- 没有使用真实 API Key、OAuth Token、生产数据或付费云服务。
- 没有调用 LLM、Sandbox Provider 或外部收费 API。
- 没有实现宿主机 Shell/Python/Playwright；没有 Token 列，也没有把 Dev Token 存入数据库。
- 本地 PostgreSQL 仅绑定 `127.0.0.1:55432`；`.env.local` 被 gitignore。
- Event 通过数据库 CHECK + Contract 双重封闭 allowlist，不存 Prompt/Token/Tool 输出。
- 公开错误只使用 Domain 固定消息；SQL/驱动文本仅存在于内部 `diagnostic`。
- 本阶段唯一成本为本地机器资源。

## 11. 与上游/任务书的偏差与未决问题

| 项目                   | 处理                                                                 | 原因 / 归属                    |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------ |
| `runs` 表提前建立      | 只建表、约束与索引，不实现 claim/lease/fencing                       | 任务书要求为 P0B-04 预留结构   |
| Workspace 双向 FK      | 采用 `workspaces` 复合 PK/FK，无 `agents.workspace_id`               | 避免循环 FK，同时保证一对一    |
| 取消                   | 只写 `cancel_requested_at`，状态保持 `queued`                        | P0B-08 才实现合作式取消        |
| OQ-1                   | `retryable_failed → cancelled` 仍未加入状态图                        | P0B-04 调度前需 CTO 决策       |
| 本地 Node 版本         | 验收显式使用 Node 24.22.1，未降低 `engines`                          | 本机默认 23.11.0，不满足要求   |
| 事件 sequence 严格递增 | 依赖 `UNIQUE (tenant_id, task_id, sequence)` + accepted=1 + 读取排序 | 未来事件写入器需继续遵守该约束 |
| Migration 单文件       | 仅新增 `0002`，未拆分更多文件                                        | 本阶段最小业务关系             |

**风险**：

1. 纯 Schema 预留不等于 Lease/Fencing 安全；P0B-04 必须实现并测试。
2. 取消意图与 `retryable_failed` 的交互未决（OQ-1），P0B-04 调度前必须确定。
3. 幂等创建依赖 PostgreSQL `READ COMMITTED` 与 `ON CONFLICT` 语义；未来若改隔离级别，
   需重新验证并发测试。
4. Event sequence 目前只保证唯一与读取排序，不阻止未来写入器制造空洞；事件追加服务
   必须在同一 Task 锁/事务下生成 sequence。
5. 64 KiB 上限只覆盖 Repository 入口；未来 HTTP Gateway 仍需独立限流、body limit 与认证。

## 12. 结论

P0B-03 的 Durable Task Inbox 已在真实 PostgreSQL 17 中通过原子 Task + `accepted` Event、
Commit 后 ACK、24 并发同 Key 幂等、跨 Tenant 隔离、B-T08 冲突与 Migration 回归验证。
所有实测命令见第 3 节；未实现的 Worker/Lease/Fencing、HTTP/API、Sandbox 与完整取消语义
均明确标注为后续工作。等待 CTO Review。
