# Ember · P0B-04 Pi Agent 工程实施 Prompt

> **正式任务**：P0B-04 — Durable Worker, PostgreSQL Lease Queue, Heartbeat, Fencing & Bounded Retry  
> **项目**：[basicv8vc/Ember](https://github.com/basicv8vc/Ember)  
> **基线**：`origin/main`，已合并 P0B-03 的 SHA `01ef99723134339daccf79db43765c68f8b00a7a`  
> **建议分支**：`feature/p0b-04-durable-worker-lease`  
> **状态**：CTO 下发，等待 Pi Agent 实施；完成后只创建 **Draft PR**，不得合并  
> **成本边界**：本地开发及 GitHub Actions 临时 PostgreSQL 17；不使用付费云、生产数据或真实模型 API Key

## 你的角色、目标与工作方式

你是 Ember 的 Senior Backend / Distributed Systems Engineer。你需要在 **P0B-03 已合并的真实 PostgreSQL Schema 和 Repository** 之上，实现可持久恢复的任务领取与运行尝试管理：两个 Worker 不能同时领取同一 Task；Crash/Lease 超时后可以安全重试；任何迟到的旧 Run 都不能覆盖新 Run；取消与重试的竞争遵守已确定的 OQ-1。

**真正交付代码、迁移、单元/集成测试、文档和 Draft PR。** 不得只提交架构文字或模拟成功的空实现。保留 P0B-01/02/03 已审核的语义与测试。

### 开工前必须执行

1. 读取 `README.md`、`docs/P0B-03-IMPLEMENTATION.md`、`docs/P0B-03-ACCEPTANCE.md`、`packages/domain/src/{types,task-state-machine,run-state-machine,errors}.ts`、`packages/contracts/src/interfaces.ts`、`packages/postgres/src/repositories/{task-repository,support}.ts`，以及 `migrations/0001`～`0003`。确认 P0B-03 已在 `main`。
2. `git fetch origin` 后验证 `origin/main` 的实际 HEAD。若不是上述基线，检查新增差异并在报告中说明；不得静默覆盖他人的提交。
3. 检查当前 worktree 是否干净，有无用户未提交改动。创建独立功能分支（必要时独立 worktree），不得修改或推送 `main`、不得强推、不得删除他人数据。
4. 使用仓库已经锁定的 Node.js 24 LTS、pnpm 12、TypeScript strict、NodeNext ESM、Zod 4、`pg`、PostgreSQL 17、Vitest。禁止未经审批引入 ORM、Redis、Kafka、云 Queue、新执行框架或更换运行时。
5. 列出本次预计修改的模块、所需 Migration，以及 B-T09～B-T11 测试策略，再开始实现。不要为尚未支持的功能创建空包或伪造 Adapter。

## 范围与验收目标

| ID    | 本阶段必须实现                       | 验收含义                                                                             |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| B-T09 | 真实 PostgreSQL 多 Worker 并发 Claim | **一个 Task、最多一个有效 Lease/Run**；两独立 Pool 并发，无重复执行尝试              |
| B-T10 | Lease 到期、Reaper、重新派发         | 旧 Run 持久终结为 `lease_expired`，Task 在策略允许时可领取新 Run；重启不依赖内存状态 |
| B-T11 | Fencing                              | 旧 Run 的 heartbeat、finish 和写入入口被拒绝；新 Run 与 Task 的持久状态不受影响      |
| OQ-1  | 取消和重试协作                       | `retryable_failed → cancelled`；取消后不得创建新 Run；竞争以数据库事务串行化裁决     |
| 回归  | P0B-01～03 全量测试                  | 原子 Durable Ack、并发 Idempotency、Tenant 隔离与安全 Event Schema 不回退            |

本阶段的 **Worker 只负责调度与 Lease 生命周期，不执行 Agent 业务工具**。P0B-05 才接入 Execution Router、FakeLLM/FakeSandbox；P0B-06 才实现 Artifact/Checkpoint/Workspace CAS；P0B-07 才提供 `/v1/tasks` / SSE / AuthZ；P0B-08 才补齐真实执行过程的合作式取消、审批与预算。不要将数据库 Run 领取成功说成 Task 业务执行成功。

## 必须写入仓库的架构决策：ADR-0001（已批准）

新建 `docs/adr/0001-cancellation-and-retry-coordination.md`，状态 `Accepted`，日期 `2026-10-28`，完整记录下列规则并在 README / 实施文档链接。

**状态机：** 在 `@ember/domain` 的 Task 转换图中新增且仅新增已批准的 OQ-1 边：`retryable_failed → cancelled`。维持其他现有边、终态及“同状态赋值非法”的纯状态机语义。更新全矩阵单测，保留 7×7 的负向断言，修改旧的 OQ-1 `open` 注释。`waiting_external` 仍不实现。

**取消语义：**

| 当前 Task 状态                       | `requestCancel` 的事务效果                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `queued`                             | 一次事务内记录首次 `cancel_requested_at`，转换 `cancelled`，写入唯一 `cancelled` Event |
| `retryable_failed`                   | 同上，**不**先转 `queued`，不创建新 Run                                                |
| `waiting_approval`                   | 按已有状态边转换 `cancelled`；审批实体/外部传播留 P0B-08                               |
| `running`                            | 记录首次取消时间；仍保持 `running`，等待当前合法 Run 的 `finish` 或 Reaper 收敛        |
| `completed` / `failed` / `cancelled` | 幂等 no-op，不改既有终态、时间戳和 Event                                               |

- `cancel_requested_at` 是单调的取消意图：首次设置后不可被调度器、Worker 或重试逻辑清空。
- **取消请求事务提交后，绝不能创建任何新的 Run。** 对 `queued`、`retryable_failed` 不得继续领取；已经领取的 `running` Run 不得再生成后续重试 Run。
- `claimNext` / Retry Promoter 必须在持有 Task 行锁后再次检查取消标记（不得只靠无锁的预筛选）。
- 正常有效 Run 的 `finish` 若发现此前已提交取消意图，以取消为优先：将该 Run 与 Task 原子收敛至 `cancelled`，不提交业务成功终态；`finish=true` 表示此有效租约已成功终结，最终终态可能被取消策略覆盖。若原 Task 已先提交终态，后来的取消为 no-op。
- Heartbeat 发现取消意图后不再续租，返回 `false`（解释为**未续租**，可能由于 stale/expired/cancel）；Worker 应停止继续执行。没有及时合作式停止的 Run 在租约到期后由 Reaper 收敛：Run=`lease_expired`，Task=`cancelled`，无重试。
- 两个竞争事务按 PostgreSQL Task 行锁及实际提交顺序裁决，而不是按网络请求抵达时间。无论结果如何，Task 只能有一个最终状态；重复取消不能多发 `cancelled` Event。
- 取消不等于撤销已经发生的外部副作用；不得对用户或测试宣称具有外部事务回滚能力。

## 模块、接口与建议目录

在已有 Monorepo 中按实际需要增量建设，可合理调整路径，但必须解释和测试接口行为：

```text
apps/
  worker/                      # 可选：最小进程生命周期、轮询/重启框架；禁止伪执行
packages/
  domain/src/                 # OQ-1 最小状态机变更
  contracts/src/interfaces.ts # 保持 LeaseQueue 既有签名；必要最小改动需说明
  postgres/src/
    lease-queue/               # PostgresLeaseQueue、事务/事件追加/重试策略
    repositories/              # requestCancel 行锁与终态语义
migrations/
  0004_*.sql                  # 只在确有新约束/索引需要时新增
tests/unit/
tests/integration/
docs/adr/0001-cancellation-and-retry-coordination.md
docs/P0B-04-IMPLEMENTATION.md
docs/P0B-04-ACCEPTANCE.md
```

优先实现并导出一个明确的 `PostgresLeaseQueue`，满足 P0B-02 已定义的接口：

```ts
interface LeaseQueue {
  claimNext(workerId: string, now: Date): Promise<LeasedRun | null>;
  heartbeat(run: LeasedRun, now: Date): Promise<boolean>;
  reapExpired(now: Date): Promise<number>;
  finish(run: LeasedRun, outcome: RunTerminalStatus): Promise<boolean>;
}
```

`LeasedRun` 已有 `tenantId, taskId, runId, attempt, leaseEpoch, leaseExpiresAt`，不得擅自丢字段。`finish(false)` **专指无有效当前租约/已过期/被 fencing 拒绝且未写入**；不能拿 `false` 假装数据库失败或业务重试成功。`heartbeat(false)` 表示**租约没有成功续期**（可能已取消），文档和测试要区分两者。数据库异常应产生已审核的固定安全 `DomainError`，不能吞成 `null` / `false`。

WorkerId 长度与字符集、now 的合法性、Pool 配置均需验证。所有 Repository/Queue 对不同 Tenant 的定位必须使用 `tenant_id`，不得通过单独的 `task_id` 或 `run_id` 读写。内部 Worker 接口不是公开的 HTTP 身份认证端点；P0B-07 负责外部 AuthN/AuthZ，不能把 UUID 或 WorkerId 当作认证凭据。

若实现一个 `apps/worker` 进程：必须具有显式启动/停止、可取消 Poll、错误退避与优雅关闭；不得在没有 P0B-05 Executor 的情况下自动领取并标记任务成功。可以提供 `reaper-only` 本地模式；如需测试完整 Poll，请**只注入 tests 内的确定性 RunHandler**，不能在生产入口注册假的成功执行器。README 必须如实说明 `pnpm dev` 是否启动 Worker，并明确未完成业务执行。

## PostgreSQL 事务与状态不变量

**领取（Claim）**

1. 以事务和 `FOR UPDATE SKIP LOCKED` 选择已到期、可执行、无取消请求的 Task；排序必须确定（例如 `next_run_at, created_at, id`），不得用进程内锁代替数据库排他性。
2. 取得 Task 行锁后再次检查 `status`、`cancel_requested_at`、`deadline_at`、`next_run_at`、`attempt_count < max_attempts`，并确保不存在有效当前 Run。不能因 `SKIP LOCKED` 返回空就声称没有任何待处理任务。
3. `queued → running` 是合法领取边。**不能直接执行 `retryable_failed → running`**：重试到期必须先执行已批准的 `retryable_failed → queued`，再执行 `queued → running`，两次转换及对应事件可在同一 DB 事务内按顺序提交。
4. 原子递增 `attempt_count` 与 `lease_epoch`，生成随机新 Run ID；插入 Run（按 Run FSM 经 `created → running`），设置 `worker_id / leased_until / started_at`，再将 Task 的 `current_run_id` 指向它。注意 `0003` 的 `(tenant_id, id, current_run_id) → runs(tenant_id, task_id, id)` 复合 FK：**必须先插入 Run，再更新 Task 指针**。
5. 在同一事务内追加不泄露输入数据的 `leased` / `started` 等合规 Event；**COMMIT 后**才返回 `LeasedRun`。若事务、事件或 COMMIT 失败，不得返回假 Lease；确保可重试且不会生成半套 Run。
6. 一个 Task 同时至多有一个有效 Run。考虑额外的 DB 部分唯一索引约束 `(tenant_id, task_id)` 对 `runs.status IN ('created','running')` 唯一，前提是验证状态生命周期兼容；如增加，使用新的前向 Migration。`0001`～`0003` 的内容与 checksum 不得变动。

**心跳（Heartbeat）**

- 验证 `tenantId + taskId + currentRunId + leaseEpoch`、Run 归属与状态，以及未到期 `lease_expires_at / leased_until`；只有**当前有效** Run 可以续约。
- 心跳更新 `tasks.lease_expires_at` 和 `runs.leased_until` 必须在同一事务中，并保证时间向前延长；过期、被替换、已终结、已取消的 Run 不得续约。
- 不能用“只验证 runId 存在”替代 fencing；旧 Lease Epoch、旧 Run ID、跨 Tenant 数据必须返回 `false`，并证明所有持久状态未被更改。

**结束（Finish）**

- 在事务中获取 Task 行锁；校验当前 Run 与 Epoch、Run=`running`、Task=`running`、租约尚未过期；检查取消优先规则。
- `succeeded` → Run=`succeeded`，Task=`completed`；`failed_terminal` → Run=`failed_terminal`，Task=`failed`；`cancelled` → Run=`cancelled`，Task=`cancelled`。
- `failed_retryable` → Run 终结为 `failed_retryable`，若还有重试预算且未超 Deadline，Task=`retryable_failed` 并计算下一次 `next_run_at`；否则 Task=`failed`。一条 Run 只能终结一次，重复/迟到 `finish` 返回 `false` 不修改结果。
- `lease_expired` 由 Reaper 管理，禁止业务 Worker 直接调用 `finish(..., 'lease_expired')` 伪装超时；对此输入作明确安全拒绝并写测试。
- **同一事务**更新 Run、Task、租约字段与 Event。合法终结后不得有有效 Lease，旧 Run/epoch 不能通过晚到响应污染 Task；不准在事务里运行 Sandbox、外部网络、慢任务或文件操作。

**到期回收（Reaper）**

- 以可配置小批量、`FOR UPDATE SKIP LOCKED` 抢占 `status=running` 且租约已到期的 Task/Run；不允许两个 Reaper 重复终结同一 Run。
- 原 Run → `lease_expired`（终态）。Task 若已取消 → `cancelled`；否则按剩余重试次数和 Deadline 进入 `retryable_failed` 或 `failed`。
- 重试调度必须创建 **新 Run、新 Epoch**；不得复活 `lease_expired` 的 Run；崩溃后只依赖数据库恢复，不能依赖 Worker 进程内存。
- 对无效/孤儿引用、Task/Run 不一致、时间字段不一致的异常数据应安全失败并留下受限诊断，禁止静默“修复”跨 Tenant 数据。

**事件序列**

- 遵守现有 `task_events` 唯一 `(tenant_id, task_id, sequence)` 与 Payload 严格白名单；不得将 Prompt、Token、SQL、堆栈、主机路径或自由文本写入 Event。
- 统一一个基于 Task 行锁的持久 sequence 分配/append 路径。`MAX(sequence)+1` 只有在所有写入方均持有该 Task 行锁时才合法；禁止内存自增计数器。
- 取消、Finish、Reaper 与 Retry 同时竞争时，最多一条对应终态 `completed` / `failed` / `cancelled` Event，顺序与事务一致；`accepted` 必须继续是 sequence=1 且不重复。

## 重试、截止时间和时钟

1. P0 默认 `max_attempts=3`，遵守已有 `tasks.max_attempts`。重试仅针对明确的 `failed_retryable` 或合法的 Lease 超时；用户取消、终态失败和明确非重试型输入错误不得重试。
2. 实现**有界指数退避**：建议第一轮 `base=1s`、上限 `cap=30s`，第 n 次可重试失败的延迟为 `min(cap, base × 2^(n-1))`。P0 可不引入 Jitter，但必须说明未来多 Worker 惊群风险。配置 Zod 校验、限制上界，禁止负数/零间隔导致忙等或无界重试。
3. `deadline_at` 不得被重试延长。每次 Claim、Finish、Reaper、Retry Promoter 都要检查 Deadline 和 attempt budget。若 `next_run_at >= deadline_at`，不能安排必然无法执行的下一次重试，应直接按合法状态边收敛为失败。到期后不得生成新 Run；运行中到期按既有 `running → failed` 处理。
4. **显式处理边界：**现有 Task FSM 没有 `queued → failed`。如果 Task **领取前**已过 Deadline，不能伪造一次 `queued → running` 和假 Run 仅为绕过状态机。候选方案是增加仅用于“未开始即 Deadline 到期”的 `queued → failed` 边，并在 PR 中以独立的 `OQ-2` 状态机提案、负向测试及兼容性分析突出列出，等待 CTO Review 认可后才能视为正式通过。不可暗中改变状态图，也不可把到期 Task 永久留在队列却标记 Deadline 验收 PASS。
5. 时间必须可重复测试。`claimNext/heartbeat/reapExpired` 按接口接收 `now`，`finish` 接口没有 `now` 参数，应在 `PostgresLeaseQueue` 构造时注入可替换 `Clock`（生产默认真实 UTC 时钟、测试可控），或提出等价且接口兼容的单一时钟设计；**禁止在一个 Lease 生命周期中无解释地混用测试时钟、JS Date.now 与 DB now()**。测试时钟不能任意设在已有 Task `created_at` 或 Run `started_at` 之前，否则会与现有 PostgreSQL 时间 CHECK 冲突；必须以测试已创建数据的持久时间为基准推进。
6. `lease_epoch` 在 DB 中是 `bigint`，现有领域 `LeasedRun.leaseEpoch` 是 JS `number`。必须在解析前检查 `Number.isSafeInteger` / 上界，并对 epoch 溢出明确失败，禁止精度损失导致 fencing 被绕过。可采用向前 Migration 增加上界 CHECK，不要修改原有 migration。
7. 建议可配置 `leaseDuration=30s`、`heartbeatInterval=10s`，且间隔必须严格小于租约时间。使用适合本地测试的短周期；所有参数需有安全上下限。Worker 服务发生 DB 故障时不得空转或吞错。

## 数据模型、索引和迁移要求

尽可能复用 P0B-03 的 `tasks`：`attempt_count, max_attempts, lease_epoch, lease_expires_at, next_run_at, deadline_at, cancel_requested_at, current_run_id`，以及 `runs`：`attempt, lease_epoch, worker_id, leased_until, status, started_at, finished_at`。不要把已存在字段又复制出第二套会分叉的状态源。

SQL 层必须维持：

- 每个 Tenant 的 Task/Run 复合引用完整性；不可通过只引用 UUID 的 FK 绕过。
- `runs (tenant_id, task_id, attempt)` 唯一；`tasks.current_run_id` 继续受 0003 的同 Tenant/同 Task FK 保护。
- `TaskStatus` 与 `RunStatus` 的 CHECK 词汇对应现有领域类型。不要将 `accepted` 添加为 Task 状态。
- 支持按 `(status, next_run_at, created_at, id)` 找候选、按租约到期回收、按 Tenant/Task/Run 定位。实际 `EXPLAIN` 简单验证关键查询能使用目标索引；不为了臆测的千 Agent 吞吐量引入复杂队列架构。
- 如果新增迁移，必须是 `0004_*.sql`（若当前 main 已新增，则选择下一个未占用版本）；无 `down migration` 要求。确认连续执行 `pnpm db:migrate` 幂等，校验旧 migration 的 checksum 未改变。

## Worker 运行边界与可观察性

- 尽量将 `LeaseQueue` 持久事务、纯 RetryPolicy、Worker Loop/进程生命周期、日志分开。业务执行接口留一个受类型约束的接入点给 P0B-05；绝不为了演示成功伪造 LLM/Sandbox/Artifact。
- Worker 循环采用可停止轮询和有界故障退避；监听 SIGTERM/SIGINT 时停止新 Claim，优雅释放连接。**不得随意将未完成有效 Run 标记为 succeeded**。已领取但未完成的 Run 交给 Lease/Reaper 恢复。
- 日志仅输出 `tenantId`（内部受控）、`taskId`、`runId`、`attempt`、`leaseEpoch`、安全状态/错误码/耗时；保留现有白名单与脱敏纪律。不得输出 Task 输入、Prompt、数据库连接串或任意异常堆栈到公开日志。
- 清楚注明“有 Durable Worker 基础设施”不等于“具备 Task 业务执行、真实进度或自动 Resume”。后者必须由 P0B-05/06 接入后才能验收。

## 必须运行的测试（真实 PostgreSQL 17，不接受 Fake DB 代替）

继续使用每个集成套件独立随机 `ember_it_<hex>` schema，只删除测试本次创建的 schema。至少覆盖以下场景，逐项记录实际 SQL 行数/状态/事件数、数据库连接数和 CI 证据：

### B-T09 · 双 Worker Claim

- 两个独立 Pool/Worker 同时 `claimNext` 同一个可执行 Task：只有一个获得 `LeasedRun`，另一个得到 `null` 或领取其他 Task；相同 Task 最多一个 `running` Run。
- 24 个以上同时尝试 Claim 的压力式集成测试，验证没有重复有效 Run 和重复 attempt/epoch。不能让所有调用经过同一个进程级互斥锁；尽量给出每个 Pool 至少一条真实独立连接证据。
- 不同 Task、不同 Tenant 能正常并发领取；结果不会引用错误 Tenant 的 Run。
- 若 Claim 事务中 Run 插入、FK 更新、Event 写入或 COMMIT 失败，整个事务回滚，Task 不被虚假占用。

### B-T10 · Lease 超时、Crash/Restart 与 Retry

- Claim 后不 Heartbeat/Finish（模拟 Worker 崩溃）；可控时钟推进至到期；Reaper 原子标记旧 Run=`lease_expired`，Task=`retryable_failed` 并安排有界 backoff。
- backoff 未到不可新 Claim；到期经 `retryable_failed → queued → running` 领取 **新 Run**，`attempt` 与 `leaseEpoch` 严格递增，旧 Run 不复活。
- 同时启动两个 Reaper，旧 Run 只被终结一次；跨进程/新 Pool 重启后能继续恢复。
- max attempts 用尽、Deadline 到期、非法时间、数据库不可达均有负向场景；不能无限重试或吞掉 DB 错误。

### B-T11 · Fencing 与迟到结果

- 旧 Run 在新的 Run 领取后发 `heartbeat`、`finish(succeeded)`、`finish(failed_retryable)`，全部被拒绝；Task、新 Run、事件、时间戳不变。
- 仅 RunId 正确但 epoch 错误、仅 epoch 正确但 RunId 错误、跨 Tenant Run、已经过期但 Reaper 还没处理的 Run，均不能成功完成或续租。
- 同 Run 重复 `finish` 不能产生第二个终态 Event；Run 不能从任何终态重新变成 `running`。

### OQ-1 · 取消与重试竞争

- queued / retryable_failed / waiting_approval 取消后直接终结并只有一个 `cancelled` Event；重复取消保持首次时间戳。
- 两个事务竞争取消与 Retry Promoter、取消与 Claim：取消事务先提交则**零个新增 Run**；Claim 先提交则记录取消意图并阻止后续 Run。
- running 时取消使心跳停止续租；有效 Finish / 过期 Reaper 都按照取消优先规则收敛；旧 Worker 晚到成功不得改写取消终态。
- Task 已先 `completed` / `failed` 的取消是 no-op，不改状态、时间戳或事件；同状态赋值仍由纯 FSM 拒绝，Repository 幂等处理不等于非法转换被放开。
- 已提交取消后，即使 `next_run_at` 已到、重试名额尚有，也不可能领取新的 Run。

### 额外回归和安全测试

- 全量 Task/Run 状态图矩阵；`retryable_failed→cancelled` 新边通过，其他未授权边保持拒绝。
- Accepted Event 不重复、持久 sequence 严格递增；所有 TaskEvent Payload 通过 Zod + PostgreSQL 白名单。
- `lease_epoch` 精度/溢出、WorkerId 无效、时钟边界（恰好到期）、异常触发回滚、无跨 Tenant 写入。
- P0B-03 的 B-T06（Durable Ack）、B-T07（24 并发 Idempotency）、B-T08（Digest Conflict）完整回归。
- 所有异常对外仅固定 `DomainError.publicMessage`，不泄漏 SQL、Prompt、Token、host path、连接串。

## CI、验收与交付流程

必须实际执行并记录下列命令的结果（未运行的项目明确标为 `NOT RUN`，禁止谎报）：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm build
pnpm dev:db
pnpm db:migrate
pnpm db:migrate
pnpm test:integration
git diff --check
```

必要时检查构建后 ESM 入口能够实际导入并使用 `PostgresLeaseQueue`，避免只靠 Vitest alias 成功。CI 继续使用 PostgreSQL 17 临时 Service Container、最小 `contents: read` 权限，不接入付费环境/真实外部 Key。若本地 Docker/PG 不可用，报告 `BLOCKED/NOT RUN` 并用真实 GitHub Actions 证据验证，绝不冒充本地已跑。

**强制验收门槛：**

- [ ] B-T09、B-T10、B-T11 均有可复现的真实 PG 测试，非内存 Mock。
- [ ] `claimNext/heartbeat/finish/reapExpired` 契约成立，任务跨 Worker/进程崩溃可恢复。
- [ ] P0B-03 Tenant-safe FK、Durable Ack、并发幂等、Event 白名单无回归。
- [ ] 所有 Task/Run 持久变更具有事务原子性、明确状态机边、正确 fencing、单调 epoch 和有界重试。
- [ ] ADR-0001 的取消不变量及必要并发测试成立；`retryable_failed→cancelled` 已纳入纯领域模型。
- [ ] 任何 Deadline 前置状态机增补须明确提案，不得悄悄修改既有边并冒充已获批准。
- [ ] `apps/worker`（若创建）不会伪装已具备真实执行能力；本地启动、停止、恢复说明准确。
- [ ] `pnpm lint/format:check/typecheck/test:unit/build/test:integration` 及 CI 完整通过。

文档要求：

- `docs/adr/0001-cancellation-and-retry-coordination.md`：记录 OQ-1 已接受决策、竞争优先级与 P0B-08 后续边界。
- `docs/P0B-04-IMPLEMENTATION.md`：模块、接口、表结构/索引/迁移、事务时序、Claim/Heartbeat/Finish/Reaper、RetryPolicy/Clock、事件、故障和部署边界；明确 OQ-2 提案（若有）。
- `docs/P0B-04-ACCEPTANCE.md`：每项测试命令、PG/Node/pnpm 环境、实际结果、双 Worker/24 并发证据、失败与恢复 SQL、CI 运行链接、未实现项和遗留风险。
- 更新 README 本地使用与 P0B 状态，但不要修改 P0B-01～03 历史验收记录。

**禁止扩大的范围：**真实执行路由、FakeLLM/FakeSandbox、Shell/Python/Playwright、云 Sandbox、Artifact/Checkpoint/Workspace CAS、HTTP `/v1/tasks`、SSE、Dev Token/OAuth/BYOK、真实预算/审批、生产部署、付费云、Redis/Kafka、复杂高可用编排、对外性能承诺。不得为了“演示成功”引入假的任务完成路径。

**Git/PR 交付：**

1. 从已验证的 `origin/main` 创建 `feature/p0b-04-durable-worker-lease`；保留原始工作区未提交改动；提交粒度合理、可审核。
2. 推送功能分支，创建 **Draft PR**，建议标题：`feat(p0b): durable worker leasing, fencing and bounded retries (P0B-04)`；base=`main`，不能合并，不能自行转 Ready for Review。
3. PR 描述包含 `Scope / Architecture / Durable Transactions / Lease & Fencing / Retry & Cancellation (ADR-0001) / Tests B-T09–11 / CI / Security & Cost / Deviations / Non-goals / Risks`。
4. 最终向 CTO 报告：分支、base SHA、代码 HEAD、PR 最终 HEAD、Draft URL、CI URL，修改文件、设计决策、实际测试数、并发样本/SQL 结果、OQ-2 等待决策状态、未运行项及剩余风险。
5. 未经 CTO 审核和用户明确授权，**不得修改 `main`、不得合并 PR、不得强推、不得删除未经验证的资源**。不要提前启动 P0B-05。

**完成定义：**P0B-04 通过真实 PostgreSQL 证实双 Worker Claim 不重叠、Lease 到期可恢复、迟到旧 Worker 被 fencing、取消绝不触发后续重试，并且全部结果在 Draft PR 与测试证据中可审计。不是在本阶段证明业务 Agent 已经能执行。
