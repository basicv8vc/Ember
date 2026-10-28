# P0B-03 — Durable Task Inbox 实现说明

> 状态：P0B-03 已实现 PostgreSQL 业务 Schema、Tenant-scoped Repository、规范化请求摘要、
> 原子任务创建与并发幂等；仅创建 **Draft PR**，未合并 `main`。
> 本文件描述**实际代码**。未实现项与实测证据见
> [P0B-03-ACCEPTANCE.md](./P0B-03-ACCEPTANCE.md)。
> 上游：P0-B Minimum Vertical Slice 任务书、Architecture RFC v0.2、P0B-03 工程任务 Prompt。
> 基线：`main` @ `a74d68d5096b2974fc225d32c1a1a27cf2dd78f6`（P0B-02 已合并）。

## 1. 目标与边界

本阶段的定义只有一句话：**Task 创建回执返回时，Task 及其首条 `accepted` Event 必须已经
在 PostgreSQL 中提交；同一 Tenant 的重复请求不能产生第二个逻辑 Task。**

已实现：

- 前向 Migration `0002_durable_task_inbox.sql`：`tenants`、`principals`、`agents`、
  `workspaces`、`tasks`、`runs`（仅结构）、`task_events`。
- 前向 Migration `0003_tasks_current_run_tenant_fk.sql`：为 `tasks.current_run_id` 增加
  Tenant + Task 安全的复合外键（PR #3 P1-1）。
- `PostgresAgentRepository`：原子创建 Agent + 唯一初始 Workspace；Tenant-scoped 查找。
- `PostgresTaskRepository`：`create` / `get` / `listEvents` / `requestCancel`。
- 规范化 SHA-256 请求摘要与 64 KiB UTF-8 字节上限。
- 基于 `UNIQUE (tenant_id, idempotency_key)`、`ON CONFLICT DO NOTHING` 与事务内重读的
  并发幂等；不使用进程内 Map、Mutex 或全局串行锁。
- 真实 PostgreSQL 集成测试：B-T06 / B-T07 / B-T08、Tenant/FK/约束负向测试。

**未实现，也不在本 PR 声称完成**：

- Worker、`FOR UPDATE SKIP LOCKED` claim、Lease/Heartbeat/Reaper/Fencing、Retry Backoff；
- Run 的真实执行生命周期（仅预留 Schema）；
- Execution Router、FakeLLM、FakeSandbox、真实 Shell/Browser；
- Artifact / Workspace CAS / Checkpoint / Orphan GC；
- `/v1/tasks`、HTTP 4xx、Dev Token Gateway、SSE、Approval、Budget；
- 合作式取消与 `retryable_failed → cancelled` 状态边（P0B-08；见 OQ-1）；
- 云 Sandbox、真实 LLM、OAuth、BYOK、支付或云部署。

`runs` 表、`tasks.lease_epoch`、`tasks.lease_expires_at` 等字段只是为 P0B-04 预留的
**Schema**，没有任何 claim/lease/fencing 行为。B-T09～B-T11 仍为 `DEFERRED`。

## 2. 包职责与依赖方向

```text
@ember/domain（纯领域）
      ▲
@ember/contracts（Zod 契约、仓储接口）
      ▲
@ember/postgres
  src/task-digest.ts
  src/repositories/agent-repository.ts
  src/repositories/task-repository.ts
  src/repositories/support.ts
      ▲
tests/integration（真实 PostgreSQL）
```

- SQL 状态/kind/phase/error code 列表与 `@ember/domain` 保持一致，并有
  `tests/unit/p0b03-schema-vocabulary.test.ts` 固定。
- PostgreSQL 包没有另造 TaskStatus、TaskKind、RunStatus 或 DomainErrorCode 的 TypeScript
  枚举；它复用 `@ember/contracts` 的 `TaskCommandSchema`、`TaskEventSchema`、
  `AuthContextSchema` 和 `@ember/domain` 的 `DomainError`。
- `@ember/postgres` 新增 workspace 依赖 `@ember/domain`、`@ember/contracts`；`pg` 仍是唯一
  数据库驱动，没有 ORM、Redis、队列或第二种数据库。

## 3. SQL Schema、约束与索引

Migration 文件：`migrations/0002_durable_task_inbox.sql` 与
`migrations/0003_tasks_current_run_tenant_fk.sql`（`0001` 未修改）。

### 3.1 Tenant 与身份

| 表           | 关键列                                          | 约束                                                                         |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `tenants`    | `id uuid PK`、`name`、`created_at timestamptz`  | 名称长度 1–128                                                               |
| `principals` | `id uuid PK`、`tenant_id`、`role`、`created_at` | `UNIQUE (tenant_id, id)`；role 仅 `owner/member/service`；**不存任何 Token** |

Principal 是本地 Fixture/Gateway 派生的服务端身份，不是 Task Command 的客户端字段；
`TaskCommandSchema` / `CreateTaskRequestSchema` 仍是 strict object，伪造 `tenantId`、
`tenant_id`、`principalId` 会被拒绝。

### 3.2 Agent / Workspace

| 表           | 关键列                                                                       | 约束 / 索引                                                                            |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agents`     | `id uuid PK`、`tenant_id`、`name`、`policy_version`、时间戳                  | `UNIQUE (tenant_id, id)`；`policy_version >= 0`；`(tenant_id, created_at, id)` 索引    |
| `workspaces` | `id uuid UNIQUE`、`tenant_id`、`agent_id`、`version`、`manifest_ref`、时间戳 | `PRIMARY KEY (tenant_id, agent_id)`（一 Agent 一 Workspace）；`version >= 0`，默认 `0` |

Workspace 的 `(tenant_id, agent_id)` 复合外键指向 `agents (tenant_id, id)`。没有
`agents.workspace_id` 反向列，因此建表与插入都没有循环 FK；Agent 与 Workspace 的“关联”
就是 Workspace 的主键。AgentRepository 在同一个事务中插入两行，任一失败全部回滚。
`manifest_ref` 只允许未来引用，不存宿主路径或文件内容。

### 3.3 Tasks

| 列                                                       | 说明                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `id uuid PK`、`tenant_id`、`agent_id`                    | 服务端生成 `id`；复合 FK `(tenant_id, agent_id) → agents (tenant_id, id)`      |
| `kind`                                                   | CHECK 限定四个 P0-B mock kind                                                  |
| `input jsonb`                                            | 已校验 TaskCommand.input；业务数据（Prompt/文件内容）只存这里                  |
| `digest`                                                 | 64 位小写 hex SHA-256；CHECK 格式                                              |
| `idempotency_key`                                        | 8–128 字符、header-safe 字符集                                                 |
| `status`                                                 | CHECK 限定 7 个 TaskStatus，默认 `queued`                                      |
| `attempt_count`、`max_attempts`                          | 非负 / ≥1                                                                      |
| `current_run_id`、`lease_epoch >= 0`、`lease_expires_at` | 仅为 P0B-04 预留；本阶段不写入/不 lease；`current_run_id` 受 0003 复合 FK 保护 |
| `next_run_at`、`deadline_at`                             | `timestamptz`；`next_run_at` 默认 `now()`                                      |
| `cancel_requested_at`                                    | 仅记录取消意图；不改变状态（P0B-08）                                           |
| `accepted_at`、`created_at`、`updated_at`                | `timestamptz NOT NULL DEFAULT now()`                                           |

关键约束：

- `UNIQUE (tenant_id, idempotency_key)`：同一 Tenant 唯一，不同 Tenant 可复用同一个 Key。
- `UNIQUE (tenant_id, id)`：让子表使用复合外键，而不是“只检查 UUID 全局存在”。
- 调度索引：`tasks (status, next_run_at, created_at)`、`(tenant_id, status, created_at, id)`、
  `(tenant_id, agent_id, created_at, id)`、部分索引 `lease_expires_at`。
- 所有时间列使用 `TIMESTAMPTZ`，不保存本地时区字符串。

#### `current_run_id` 的 Tenant-safe 复合外键（P1-1）

`0003` 增加：

```sql
ALTER TABLE runs
  ADD CONSTRAINT runs_tenant_task_id_key UNIQUE (tenant_id, task_id, id);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_current_run_fk
  FOREIGN KEY (tenant_id, id, current_run_id)
  REFERENCES runs (tenant_id, task_id, id)
  ON DELETE RESTRICT;
```

`current_run_id` 为 `NULL` 时复合外键不生效（MATCH SIMPLE）；一旦非空，它必须同时满足：

- `tasks.tenant_id` = `runs.tenant_id`：跨 Tenant 的 Run 被拒绝；
- `tasks.id` = `runs.task_id`：同 Tenant 但属于另一个 Task 的 Run 也被拒绝。

因此不只是 `(tenant_id, current_run_id) → runs(tenant_id, id)` 的租户隔离，还保证
`current_run_id` 确实是该 Task 的 Run。创建 Task 时 `current_run_id` 始终为 `NULL`，
先插入 Task、再插入 Run、最后更新指针，所以没有循环插入依赖。删除被引用的 Run 受
`ON DELETE RESTRICT` 保护；未来 Run 清理必须先清空 Task 指针（P0B-04）。本阶段没有
claim/lease/fencing，也没有任何写入 `current_run_id` 的业务路径。

### 3.4 Runs（仅为 P0B-04 预留）

`runs` 包含 `id`、`tenant_id`、`task_id`、`attempt >= 1`、`lease_epoch >= 0`、Run 状态 CHECK、
`worker_id`、`leased_until`、`started_at`、`finished_at`，以及
`UNIQUE (tenant_id, id)`、`UNIQUE (tenant_id, task_id, attempt)`、
`UNIQUE (tenant_id, task_id, id)`（供 `tasks.current_run_id` 复合 FK 使用）和
`(tenant_id, task_id) → tasks (tenant_id, id)` 复合外键。

本阶段**没有** `claimNext`、`FOR UPDATE SKIP LOCKED`、Heartbeat、Reaper、Fencing 或 Retry
Backoff 的实现或测试。`RUN_TRANSITION_TABLE` 仍只由 `@ember/domain` 使用。

### 3.5 Task Events

| 列                                         | 说明                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `id uuid PK`、`tenant_id`、`task_id`       | 事件 ID 服务端生成；复合 FK 指向 `tasks (tenant_id, id)`          |
| `sequence integer >= 1`                    | `UNIQUE (tenant_id, task_id, sequence)`                           |
| `phase`                                    | CHECK 限定 11 个 TaskEventPhase                                   |
| `payload jsonb`                            | 数据库函数 `ember_task_event_payload_is_valid` 强制封闭 allowlist |
| `trace_id uuid`、`occurred_at timestamptz` | 服务端生成/默认 `now()`                                           |

事件完整性：

- 部分唯一索引 `task_events_one_accepted_idx` 保证每个 Task 最多一条 `accepted`。
- `CHECK (phase <> 'accepted' OR sequence = 1)`：`accepted` 只能是 sequence 1；创建事务
  仅写入这一条。
- `task_events_task_order_idx (tenant_id, task_id, sequence)` 支撑未来按 Task + sequence
  读取；`TaskRepository.listEvents()` 已按 sequence 升序返回。
- Payload 没有自由文本通道。数据库 CHECK 与 `TaskEventPayloadSchema` 都只允许枚举、UUID、
  非负整数和布尔值；直接 SQL 插入 `{"prompt":"secret"}` 或未知 key 会被 `23514` 拒绝。
- 创建 Task 时只写 `{taskKind, policyVersion, replayed:false}`，不写 Prompt、Token、SQL、
  Tool 输出或宿主路径。

## 4. 事务边界与 Durable Ack

`TaskRepository.create(ctx, cmd)` 的顺序：

1. 在获取连接前校验 `AuthContext` 与 `TaskCommandSchema`。
2. 生成规范化 canonical JSON 与 SHA-256 digest，并执行 64 KiB UTF-8 检查。
3. 获取独立连接，`BEGIN`。
4. Tenant-scoped 检查 Agent：`WHERE tenant_id = ctx.tenantId AND id = cmd.agentId`。
   不存在与属于其他 Tenant 都返回同一个 `NOT_FOUND`，不泄露存在性。
5. `INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING ...`。
6. 若插入成功：在同一事务内写入 sequence 1 的 `accepted` Event。
7. `COMMIT` 成功后才构造并返回 `TaskReceipt`。
8. 任一步失败：`ROLLBACK`，抛出固定公开消息的 `DomainError`；不会返回 Task ID。

因此不存在“客户端拿到 Task ID 但数据库没有 Task”的假回执。事务内不调用 LLM、Sandbox、
HTTP 或任何长耗时外部操作；摘要计算也在事务外完成。

如果 COMMIT 已成功但客户端未收到 ACK，同 Key 重试会命中已提交 Task 并返回
`replayed: true`；不会插入第二条 Task 或第二条 `accepted` Event。

## 5. 规范化 Digest

实现：`packages/postgres/src/task-digest.ts`。

- 先执行 `TaskCommandSchema` 校验，再进行序列化；未知 kind、跨 kind input、伪造
  tenant/principal/status 字段均在摘要前失败。
- 覆盖字段：`agentId`、`kind`、按 kind 校验的 `input`、规范化后的 `deadlineAt`。
- `deadlineAt` 先转换为 UTC ISO 8601，因此 `2026-12-01T00:00:00Z` 与
  `2026-12-01T08:00:00+08:00` 产生相同摘要。
- 采用确定性规范 JSON：对象 key 递归排序；数组顺序保留（顺序具有语义）；不依赖
  locale、数据库 JSON 序列化或属性插入顺序。
- 摘要输入带版本前缀 `ember.task-command.v1`，摘要为小写 hex SHA-256。
- **Idempotency Key 不纳入摘要**：它是查找地址，不是请求正文。相同正文使用不同 Key
  会各自创建 Task；相同 Key + 相同正文重放；相同 Key + 不同正文冲突。
- 64 KiB 上限按 canonical JSON 的 **UTF-8 字节数**计算。例如 30,000 个 CJK 字符约
  90,000 字节，会以 `INVALID_ARGUMENT`（issue code `too_big`）拒绝。未来 HTTP Gateway
  仍必须独立执行请求体大小限制与限流。

## 6. 幂等与并发策略

创建事务内：

```text
INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING ...
  ├─ 返回行：本请求创建 Task → 写 accepted Event → COMMIT → replayed:false
  └─ 无返回行：同一事务内 SELECT ... WHERE tenant_id + idempotency_key
       ├─ digest 相同：返回当前 status + 原 accepted_at → replayed:true
       └─ digest 不同：IDEMPOTENCY_CONFLICT
```

- 唯一性由数据库 `UNIQUE (tenant_id, idempotency_key)` 保证；没有只依赖进程内 Map、
  Mutex 或 `SELECT` 后 `INSERT` 的非原子检查。
- 不持有全局串行锁。冲突只发生在相同 Key 上；不同 Tenant、不同 Key 仍可并发。
- 在 PostgreSQL `READ COMMITTED` 下，冲突的 `INSERT` 会等待首个事务结束；随后新语句
  读取已提交流。若首个事务回滚导致 `DO NOTHING` 未插入且读不到行，会在同一事务内做
  有界重试，而不是伪造成功。
- 重放返回 **当前** `status` 与原始 `acceptedAt`；Task ID 永远相同，不会因状态变化
  创建新 Task。
- 冲突不会修改原 Task 的 digest、status、accepted_at、updated_at，也不会新增 Event。

## 7. Repository、错误与取消边界

### 7.1 AgentRepository

```ts
create(ctx, { name, policyVersion? }): Promise<AgentView>
get(ctx, agentId): Promise<AgentView | null>
```

- Tenant/Principal 均来自已验证 `AuthContext`；客户端不能指定 Tenant。
- `create` 先确认 Principal 属于该 Tenant（否则 `UNAUTHENTICATED`），再在同一事务内插入
  Agent 与其唯一 Workspace。
- `get` 只按 `ctx.tenantId` 查询；跨 Tenant 与不存在都返回 `null`。

### 7.2 TaskRepository

```ts
create(ctx, cmd): Promise<TaskReceipt>
get(ctx, taskId): Promise<TaskView | null>
listEvents(ctx, taskId): Promise<readonly TaskEvent[]>
requestCancel(ctx, taskId): Promise<void>
```

- 所有读写均以 `ctx.tenantId` 限定；不存在与跨 Tenant 不可区分。
- `listEvents` 是用于验证持久事件可读的 Repository 能力，不是 SSE/轮询 API。
- `requestCancel` **只**写入 `cancel_requested_at`，不改变 Task 状态、不停止 Run、不写
  `cancelled` Event，也不声称合作式取消已完成。第二次调用保留首次时间戳。
  P0B-08 才能完成取消语义；`retryable_failed → cancelled`（OQ-1）仍未加入状态图。

### 7.3 错误与日志

- 复用 `@ember/domain` 的固定 `DomainError.publicMessage`：`NOT_FOUND`、
  `UNAUTHENTICATED`、`IDEMPOTENCY_CONFLICT`、`INVALID_ARGUMENT`、`DB_UNAVAILABLE`。
- 连接池错误、SQL 错误、约束名、驱动文本只进入内部 `diagnostic`；不进入
  `toJSON()` / `toErrorResponse()`。Repository 本身不写访问日志，调用方只应记录 opaque
  task ID、digest、结果类别。
- 没有新增错误码、状态枚举或 TaskKind；SQL 值列表由单元测试与 Domain 常量对齐。

## 8. Migration 与后续 Worker 依赖

- 新增单向前向 Migration `0002_durable_task_inbox.sql` 与
  `0003_tasks_current_run_tenant_fk.sql`；`0001` 内容和位置未变，`0002` 不因后续修复被篡改。
- 沿用 P0B-01 的 filename guard、checksum、advisory lock、每迁移独立事务；重复运行零变更。
- CI 与本地集成测试均在全新 `ember_it_<hex>` Schema 内按序应用 `0001` + `0002` + `0003`，
  重复运行不产生变更；测试只 DROP 自己创建的 Schema。
- P0B-04 可以在现有 `tasks` 调度索引、`runs` 表、`lease_epoch` / `lease_expires_at`
  字段上实现 claim/lease/fencing，但届时必须新增向前的 Migration 和真实并发测试；
  本阶段的 Schema 存在不等于 Lease Safety 已完成。
- OQ-1：`retryable_failed → cancelled` 仍待 CTO 决定；P0B-04 调度开发前必须明确它与
  `cancel_requested_at` 的交互规则。

## 9. 验证映射

| 要求                        | 测试                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| B-T06 Durable Ack           | `tests/integration/durable-task-inbox.test.ts`                        |
| B-T07 并发幂等              | `tests/integration/task-idempotency.test.ts`（24 个真并发请求）       |
| B-T08 幂等冲突              | `tests/integration/task-idempotency.test.ts`                          |
| Tenant-safe FK / Repo scope | `durable-task-inbox.test.ts`（跨租户读取、Agent、直接 SQL FK）        |
| Event / 约束                | `durable-task-inbox.test.ts`（sequence、accepted、payload allowlist） |
| Migration 回归              | `tests/integration/migrations.test.ts`、`tests/unit/migrator.test.ts` |
| Digest 规范化 / UTF-8 字节  | `tests/unit/task-digest.test.ts`                                      |
| SQL 词汇与 Domain 对齐      | `tests/unit/p0b03-schema-vocabulary.test.ts`                          |

实际命令结果、并发数、行数核对与 CI 状态见
[P0B-03-ACCEPTANCE.md](./P0B-03-ACCEPTANCE.md)。未运行项会明确标记 `NOT RUN/BLOCKED`，
不以接口存在或 Mock 冒充通过。
