# P0B-04 — Durable Worker, Lease, Fencing and Bounded Retry

> 状态：实现完成，仅创建 **Draft PR**，未合并 `main`。
> 基线：`main` @ `01ef99723134339daccf79db43765c68f8b00a7a`（P0B-03 已合并）。
> 本文件描述**实际代码与事务语义**；实际命令、测试数、CI 与未运行项见
> [P0B-04-ACCEPTANCE.md](./P0B-04-ACCEPTANCE.md)。
> 取消/重试的已批准决策见
> [ADR-0001](./adr/0001-cancellation-and-retry-coordination.md)。

## 1. 目标与边界

P0B-04 只解决一个问题：**一个 Task 在同一时刻最多有一个有效 Lease/Run；进程崩溃、租约
过期或调度竞争后，系统可以只依赖 PostgreSQL 恢复，迟到 Worker 无法覆盖更新的尝试。**

已实现：

- `PostgresLeaseQueue`：`claimNext` / `heartbeat` / `reapExpired` / `finish`；
- `FOR UPDATE SKIP LOCKED` 多 Worker Claim、Task 行锁二次校验、原子 Run/Epoch/Attempt；
- Lease 心跳、到期 Reaper、新 Run/新 Epoch 重试；
- 基于 Tenant + Task + current Run + `lease_epoch` 的 Fencing；
- 有界指数退避、Deadline 与 Attempt Budget 检查；
- ADR-0001 的取消语义与 `retryable_failed → cancelled` 领域边；
- 前向 Migration `0004_lease_fencing_and_retry.sql`；
- 最小 `apps/worker` 进程：可显式启动/停止、可取消轮询、错误退避、优雅关闭，
  生产入口只运行 `reaper-only`；
- 真实 PostgreSQL 17 的 B-T09 / B-T10 / B-T11 / OQ-1 集成测试与 P0B-03 回归。

**明确未实现，也不在本 PR 声称完成：**

- Execution Router、FakeLLM、FakeSandbox、真实 Shell/Python/Playwright；
- Agent 业务执行、真实进度、自动 Resume；
- Artifact / Checkpoint / Workspace CAS；
- `/v1/tasks`、SSE、外部 AuthN/AuthZ、Dev Token/OAuth/BYOK；
- 完整合作式取消、审批实体、预算；
- 云 Sandbox、Redis/Kafka、云 Queue、生产部署或性能承诺。

`claimNext` 成功只表示 **Lease 与 Run 持久化成功**，不代表 Task 业务成功。P0B-04 的
Worker 没有任何“假成功”执行器。

## 2. 模块与依赖方向

```text
@ember/domain
  Task/Run 状态机（新增 ADR-0001 边；OQ-2 提案边）
      ▲
@ember/contracts
  LeaseQueue 接口（签名不变，仅补充 false 语义注释）
      ▲
@ember/postgres
  lease-queue/
    clock.ts                单一 Clock seam、时间校验
    config.ts               Lease/Retry/Batch 配置（Zod，含上下界）
    retry-policy.ts         纯有界指数退避与 Deadline 判定
    validation.ts           WorkerId / LeasedRun / Epoch / 时间校验
    postgres-lease-queue.ts 事务、Claim/Heartbeat/Finish/Reaper
  repositories/
    event-store.ts          Task 行锁下的持久 sequence + 白名单 Event Append
    task-repository.ts      ADR-0001 requestCancel 语义
      ▲
apps/worker
  config.ts                 进程配置（Zod）
  reaper-loop.ts            可停止 Reaper 轮询 + 有界错误退避
  run-handler.ts            P0B-05 受类型约束的执行接入点（无实现）
  index.ts                  仅 reaper-only 生产入口
      ▲
tests/integration          真实 PostgreSQL 17，随机 ember_it_<hex> schema
```

没有新增 ORM、Redis、Kafka、消息队列或第二个数据库。`pg` 仍是唯一驱动。

## 3. 领域状态机变更

### 3.1 ADR-0001：`retryable_failed → cancelled`

`TASK_TRANSITION_TABLE` 新增且仅新增该已批准边。全矩阵单测继续覆盖 7×7 组合、同状态
赋值拒绝、终态不可离开；旧的 OQ-1 `open` 注释改为引用 ADR-0001。
`retryable_failed → queued → running` 仍是重试领取的唯一合法路径，禁止直接
`retryable_failed → running`。

### 3.2 OQ-2 提案：`queued → failed`

**这是一个等待 CTO Review 的独立提案，不是 ADR-0001 的一部分。**

问题：Task 在**首次领取前**已经过 `deadline_at`。现有 Task FSM 只有 `queued →
running|cancelled`，没有 `queued → failed`。若不新增边，只能：

1. 非法地伪造 `queued → running` + 一个不存在的 Run；或
2. 把到期 Task 永久留在队列，却声称 Deadline 验收通过。

两者都不可接受。因此本 PR **显式**新增 `queued → failed`，仅用于“从未开始的 Task 已过
Deadline / 不具备可领取预算”的收敛路径，并在实现、测试和本文档中标注为 OQ-2 Proposal。

兼容性分析：

- 不改变任何既有边的语义，不新增 `waiting_external`，不放开同状态赋值；
- `queued → failed` 只能由 Claim 的 Deadline/预算前置检查或 Reaper 的过期扫描触发；
- 运行中的 Deadline 仍走既有 `running → failed`；
- 若 CTO 拒绝该边，需要替换为显式 OQ-2 决策；当前实现不能静默改为伪造 Run；
- 7×7 负向矩阵与正向边清单均已更新并有测试。

## 4. Schema、Migration 与索引

新增前向 Migration：`migrations/0004_lease_fencing_and_retry.sql`。
`0001`～`0003` 内容与 checksum 未修改。

| 变更                               | 作用                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tasks_lease_epoch_safe_int_check` | `lease_epoch <= 9007199254740991`，防止 JS number 精度损失绕过 fencing                                    |
| `runs_lease_epoch_safe_int_check`  | 同上                                                                                                      |
| `runs_one_active_per_task_idx`     | `(tenant_id, task_id) WHERE status IN ('created','running')` 唯一，数据库兜底“一个 Task 至多一个有效 Run” |
| `tasks_claim_order_idx`            | `(status, next_run_at, created_at, id)` 支撑确定性候选顺序                                                |
| `tasks_deadline_open_idx`          | 非终态且带 Deadline 的扫描                                                                                |

状态生命周期兼容性：Claim 在 Task 行锁内先插入 Run=`created`，立即按 Run FSM
`created → running` 更新为 `running`；Finish/Reaper 在创建新 Run 前先把旧 Run 终结，
因此部分唯一索引不会与合法生命周期冲突。

复用 P0B-03 字段，无第二套状态源：

- `tasks.attempt_count / max_attempts / lease_epoch / lease_expires_at / next_run_at /
deadline_at / cancel_requested_at / current_run_id`；
- `runs.attempt / lease_epoch / worker_id / leased_until / status / started_at / finished_at`；
- `tasks.current_run_id` 继续受 `(tenant_id, id, current_run_id) → runs(tenant_id, task_id, id)`
  复合外键保护。

所有 Repository/Queue 定位都带 `tenant_id`，没有仅按 `task_id` 或 `run_id` 的读写。

## 5. Claim 事务时序

`PostgresLeaseQueue.claimNext(workerId, now)`：

1. 事务外校验 WorkerId（1–128，`[A-Za-z0-9][A-Za-z0-9._:-]*`）与 `now`。
2. `BEGIN`。
3. `SELECT … FROM tasks WHERE status IN ('queued','retryable_failed') AND next_run_at <= $now
ORDER BY next_run_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`。
4. 取得 Task 行锁后**再次**检查：状态、`cancel_requested_at`、`deadline_at`、
   `next_run_at`、`attempt_count < max_attempts`，并查询该 Task 是否已有
   `created/running` Run。不能因为 `SKIP LOCKED` 返回空就声称“系统没有待处理任务”。
5. 到期/已取消/预算耗尽的候选：按合法边收敛（`queued → failed|cancelled`、或
   `retryable_failed → failed|cancelled`），追加合规 Event，然后在**同一事务内**继续尝试
   下一个候选（最多 16 次）。不会伪造 Run。
6. 可领取时：
   - `attempt = attempt_count + 1`，`epoch = lease_epoch + 1`（安全整数检查）；
   - 若原状态为 `retryable_failed`，先在代码中执行 `retryable_failed → queued`，再执行
     `queued → running`；两次转换在同一 DB 事务中；
   - 先 `INSERT runs(..., status='created', lease_epoch, worker_id, leased_until, started_at)`；
   - 再按 Run FSM `created → running` 更新 Run；
   - 再更新 Task（状态、attempt、epoch、lease、`current_run_id`，满足 0003 复合 FK 的
     “先 Run 后指针”顺序）；
   - 追加 `leased`、`started` Event。
7. `COMMIT` 成功后才返回 `LeasedRun`。任何 Run 插入、Task 更新、Event 插入或 COMMIT
   失败都会整体回滚，不会返回假 Lease，也不会留下半套 Run。

确定性排序不依赖进程锁；两个独立 `pg.Pool` 的 Worker 由 PostgreSQL 行锁与
`SKIP LOCKED` 裁决。

## 6. Heartbeat

`heartbeat(run, now)` 在单个事务中：

1. 按 `tenant_id + task_id` `FOR UPDATE` 锁定 Task；
2. 校验 Task=`running`、`current_run_id = run.runId`、`cancel_requested_at IS NULL`；
3. 校验 `Task.lease_epoch == run.leaseEpoch` 且 `lease_expires_at > now`（恰好到期不续租）；
4. 校验 Deadline 尚未到达；
5. 锁定 Run，校验 Run=`running`、Run Epoch/Attempt 与 Lease 一致；
6. 同一事务更新 `runs.leased_until` 与 `tasks.lease_expires_at`，新时间严格向前
   （即使测试时钟回拨也不会缩短租约）。

返回值语义：

- `true`：租约成功续期；
- `false`：**没有续租**，可能因为 stale/expired/fenced/cancelled/deadline。它不是“Task 失败”
  的同义词，也不写 Event、不改 Task 终态。

旧 Run、旧 Epoch、错误 RunId、跨 Tenant 引用、已过期但 Reaper 尚未处理的 Lease 都返回
`false`，且持久状态不变。

## 7. Finish

`finish(run, outcome)` 使用构造时注入的 `Clock`（接口没有 `now` 参数）。事务内：

1. `FOR UPDATE` 锁定 Task；校验 Tenant/Task/current Run/Epoch、Task=`running`、
   Run=`running`、Attempt 匹配、Task 与 Run 租约均未过期。
2. `lease_expired` 是 Reaper 专属结果。业务 Worker 调用
   `finish(..., 'lease_expired')` 会收到固定 `INVALID_ARGUMENT` 拒绝，不写任何状态。
3. 取消优先：若 `cancel_requested_at` 非空，则 Run/Task 原子终结为 `cancelled`，
   不提交 `completed` / `failed` / 重试。`finish=true` 表示“这个有效租约已成功终结”，
   最终终态可能被取消策略覆盖。
4. 否则若已过 Deadline：Run=`failed_terminal`，Task=`failed`，Event `failed` +
   `DEADLINE_EXCEEDED`；成功结果也不能越过 Deadline。
5. 正常结果：
   | outcome                                                      | Run                | Task               | Event             |
   | ------------------------------------------------------------ | ------------------ | ------------------ | ----------------- |
   | `succeeded`                                                  | `succeeded`        | `completed`        | `completed`       |
   | `failed_terminal`                                            | `failed_terminal`  | `failed`           | `failed`          |
   | `failed_retryable` 且预算/Deadline 允许                      | `failed_retryable` | `retryable_failed` | `retry_scheduled` |
   | `failed_retryable` 且预算耗尽或 `next_run_at >= deadline_at` | `failed_retryable` | `failed`           | `failed`          |
   | `cancelled`                                                  | `cancelled`        | `cancelled`        | `cancelled`       |
6. 同一事务更新 Run（`finished_at`、`leased_until=NULL`）、Task（终态、`lease_expires_at=NULL`、
   可选 `next_run_at`）并追加 Event。合法终结后不存在有效 Lease。

重复或迟到 `finish` 返回 `false`，不修改 Run、Task、时间戳或 Event。数据库错误抛出固定
`DomainError`，不吞成 `false`。事务内不执行 Sandbox、网络、慢任务或文件操作。

## 8. Reaper

`reapExpired(now)` 使用配置批量（默认 50）和 `FOR UPDATE SKIP LOCKED`：

1. 先收敛 `queued/retryable_failed` 且 `deadline_at <= now` 的未开始 Task：
   `queued → failed`（OQ-2 提案）或 `retryable_failed → failed`，Event `failed` +
   `DEADLINE_EXCEEDED`。
2. 再选择 `status='running'` 且 `lease_expires_at <= now` 或 `deadline_at <= now` 的 Task，
   锁定 Task 及其 `current_run_id` 指向的 Run。
3. 取消优先：Task=`cancelled`；若租约已过期，Run=`lease_expired`，否则 Run=`cancelled`；
   **不安排重试**。
4. 租约过期且未取消：Run=`lease_expired`（终态）；按 attempt 预算与 Deadline 决定
   Task=`retryable_failed` + 有界 `next_run_at` 或 Task=`failed`。
5. 仅 Deadline 到期但租约尚未过期：Run=`failed_terminal`，Task=`failed`。
6. 新重试永远创建 **新 Run、新 Epoch**；`lease_expired` Run 不会复活。
7. 无效/孤儿引用（例如 `running` 但没有当前 Run）会以固定 `DB_UNAVAILABLE` 安全失败并
   回滚整批，不静默“修复”跨 Tenant 或缺失数据。

Reaper 返回本次收敛的 Task 数。两个 Reaper 并发时，同一 Task/Run 只会被一个事务终结；
崩溃恢复只依赖数据库状态，不依赖 Worker 内存。

## 9. RetryPolicy、Deadline 与 Clock

- 默认：`baseDelayMs=1000`、`capDelayMs=30000`、`leaseDurationMs=30000`、
  `heartbeatIntervalMs=10000`、`reaperBatchSize=50`。
- 第 n 次失败后的延迟：`min(cap, base × 2^(n-1))`。P0 不加 Jitter；未来多 Worker 同时到期
  存在惊群风险，必须在 P0B-09/生产化时加入有界 Jitter。
- Zod 校验所有上下界，并要求 `heartbeatIntervalMs < leaseDurationMs`；
  禁止零/负间隔导致忙等或无界重试。
- 每次 Claim、Finish、Reaper、Retry 决策都检查 Deadline 与 Attempt Budget。
  `next_run_at >= deadline_at` 时不安排下一次重试，直接按合法边收敛为失败。
  Deadline 不会被重试延长。
- `claimNext/heartbeat/reapExpired` 接收显式 `now`，`finish` 使用构造时注入的 `Clock`。
  生产默认 `systemClock`，集成测试使用 `ManualClock`；同一个 Lease 生命周期不混用
  `Date.now()`、数据库 `now()` 和测试时钟。测试时钟以已持久化数据的 `now()` 为基准推进。
- `lease_epoch` 在 DB 是 `bigint`，解析前后都检查 `Number.isSafeInteger` 上界；
  溢出抛固定 `DB_UNAVAILABLE`，不会因精度损失绕过 Fencing。

## 10. 取消与重试协作（ADR-0001）

`PostgresTaskRepository.requestCancel(ctx, taskId)` 现在在 Task 行锁事务内执行：

| 当前状态                     | 结果                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `queued`                     | 记录首次 `cancel_requested_at`、转 `cancelled`、写唯一 `cancelled` Event |
| `retryable_failed`           | 同上；不先转 `queued`，不创建新 Run                                      |
| `waiting_approval`           | 按既有边转 `cancelled`；审批实体留 P0B-08                                |
| `running`                    | 只记录首次取消时间，保持 `running`，不写终态 Event                       |
| `completed/failed/cancelled` | 幂等 no-op，状态/时间戳/Event 不变                                       |

- `cancel_requested_at` 单调、写一次；重复取消不改首次时间。
- Claim/Retry 在取得 Task 行锁后再次检查取消标记；取消提交后不会创建新 Run。
- 有效 Run 的 Finish 观察到取消意图时，以取消为优先，原子收敛 Run/Task=`cancelled`。
- Heartbeat 观察到取消意图返回 `false`，停止续租；Worker 应停止执行。
- 未及时合作式停止的 Run 在租约到期后由 Reaper 收敛：Run=`lease_expired`、
  Task=`cancelled`、无重试。
- 以数据库 Task 行锁与实际提交顺序裁决，不按网络抵达时间；最多一个终态 Event。
- 取消不等于撤销已经发生的外部副作用；本阶段没有外部事务回滚能力。

原有 P0B-03 “只记录取消意图、保持 queued”的测试已按 ADR-0001 更新为原子取消语义；
P0B-03 的历史验收文档未被改写。

## 11. Event、安全与日志

- 所有 P0B-04 事件与状态变更在同一事务提交；sequence 由
  `MAX(sequence)+1` 在 **Task 行锁** 下分配，禁止内存计数器。
- `accepted` 继续是 sequence 1 且唯一。
- Event Payload 继续通过 `@ember/contracts` 的 Zod 白名单与 PostgreSQL
  `ember_task_event_payload_is_valid`；没有 Prompt、Token、SQL、堆栈、宿主路径或自由文本。
- 新事件使用 `runId`、`attempt`、`fromStatus`、`toStatus`、`runStatus`、`errorCode`、
  `cancelRequested` 等允许字段。
- Worker 日志只输出 worker id、mode、计数、耗时、固定错误码与白名单数据库元数据；
  不输出 Task 输入、Prompt、连接串或原始异常文本。
- WorkerId 是内部运行标签，不是认证凭据；P0B-07 才提供外部 AuthN/AuthZ。
- 所有公开错误只使用固定 `DomainError.publicMessage`；诊断文本不会进入 `toJSON()`。

## 12. Worker 进程边界

`apps/worker`：

- `pnpm dev:worker` / `pnpm start:worker` 启动最小进程；
- 生产入口只接受 `EMBER_WORKER_MODE=reaper-only`，周期调用 `reapExpired`；
- `poll` 模式会被明确拒绝，因为 P0B-05 尚无 Execution Router / FakeLLM / FakeSandbox；
- 收到 SIGINT/SIGTERM 时停止新轮询、等待当前 tick、关闭连接池；
- 数据库错误使用有界 backoff，不忙等、不吞错；
- `RunHandler` 只定义受类型约束的 P0B-05 接入点，没有生产假实现。

**有 Durable Worker 基础设施不等于具备 Task 业务执行、真实进度或自动 Resume。**
这些必须等 P0B-05/06 接入后才能验收。`pnpm dev` 仍只启动 API，不启动 Worker。

## 13. 故障与回滚

| 故障                            | 行为                                             |
| ------------------------------- | ------------------------------------------------ |
| Claim 中 Event 插入失败         | 整个 Claim 回滚；Task 仍 queued，无 Run          |
| Claim 的 COMMIT 失败            | 不返回 Lease；Task/Run/Event 全部不可见          |
| Worker 崩溃 / 停止心跳          | 租约到期后 Reaper 终结 Run，按预算/Deadline 重试 |
| 旧 Worker 迟到 heartbeat/finish | 返回 `false`，不写任何状态                       |
| 两个 Worker 同时 Claim          | 只有一个取得 Task 行锁；另一个 `SKIP LOCKED`     |
| 两个 Reaper 同时回收            | 同一 Run 只终结一次                              |
| 取消与 Claim/Retry 竞争         | Task 行锁串行化；取消提交后零新 Run              |
| 数据库不可达                    | 固定 `DB_UNAVAILABLE`，不吞成 `null`/`false`     |
| Lease Epoch 溢出                | 显式失败；DB CHECK + JS 安全整数检查             |
| 孤儿 running Task               | Reaper 安全失败并回滚，不静默修复                |

## 14. 测试映射

| 要求                                                | 测试                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| B-T09 双 Worker / 24 并发 Claim / 事务回滚          | `tests/integration/lease-claim.test.ts`                     |
| B-T10 Lease 到期 / Crash / Reaper / 重试 / Deadline | `tests/integration/lease-recovery.test.ts`                  |
| B-T11 Fencing / 迟到结果 / 单次终态                 | `tests/integration/lease-fencing.test.ts`                   |
| OQ-1 取消与重试竞争                                 | `tests/integration/cancellation-retry.test.ts`              |
| 状态机全矩阵（含 ADR-0001/OQ-2）                    | `tests/unit/task-state-machine.test.ts`                     |
| RetryPolicy / Clock / Epoch / WorkerId              | `tests/unit/lease-queue-policy.test.ts`                     |
| Worker 配置 / 可停止循环 / 安全错误码               | `tests/unit/worker-loop.test.ts`                            |
| P0B-03 Durable Ack / 幂等 / Tenant FK 回归          | 既有 `durable-task-inbox`、`task-idempotency`、`migrations` |

## 15. 遗留风险

1. **OQ-2 未获正式批准**：`queued → failed` 目前是提案边；若 CTO 拒绝，必须替换为明确
   决策，不能把到期 Task 永久留在队列。
2. P0 重试无 Jitter；多 Worker 大规模同时到期时存在惊群风险。
3. Finish/Reaper 只保证数据库最终状态，不保证外部副作用被撤销或远端执行已物理停止。
4. 取消的审批传播、Worker 合作式中止与外部 API 留给 P0B-08。
5. Worker 生产入口只有 reaper-only；完整 Claim 循环与执行必须等 P0B-05。
6. `tasks.current_run_id` 保留最近一次 Run 指针（可能是终态 Run）；Claim 通过状态与
   `runs` 活跃唯一索引判断是否存在有效 Run，而不是只看该指针是否为 `NULL`。
7. 本阶段没有性能承诺；索引只经过简单 `EXPLAIN`/集成查询验证。
