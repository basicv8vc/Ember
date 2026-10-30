# P0B-08c — 取消接口与协作式取消（Cancellation API & Cooperative Cancellation）

> 状态：P0B-08c 交付件（Draft PR）。是否已合并以 PR 为准，本文件不跟踪合并状态。
> 范围：`apps/api/src/tasks/routes.ts`、`apps/api/src/tasks/dto.ts`、`apps/api/src/tasks/task-store.ts`、
> `packages/postgres/src/repositories/task-repository.ts`、`apps/worker/src/poll-loop.ts`、
> `apps/worker/src/run-handler.ts`、`apps/worker/src/durable-run-handler.ts` 及相关单元与集成测试。

---

## 1. 目标与边界

本任务承接 Ember 垂直切片中核心的可靠性与并发状态一致性要求，提供公开的取消 HTTP 接口，并建立端到端的 Worker 协作式取消机制。

### 已实现

- **Cancellation HTTP API (`POST /v1/tasks/:taskId/cancel`)**：
  - 经由现有 Dev Token Bearer 认证中间件，提取由系统可信注入的 `AuthContext`；
  - 严格的租户隔离：跨租户任务与不存在任务均返回语义和结构完全一致的 `404 NOT_FOUND`，防止侧信道探测；
  - 严格的 DTO 契约：`TaskCancelDto` 返回标准 camelCase/snake_case 安全字段，杜绝内部 SQL、数据库连接、Worker 标识或任务输入泄露；
  - 幂等性：针对任意状态的 Task 重复调用，均保持确定性状态响应，不重复追加终态事件；
  - 明确的状态码区分：
    - `200 OK`（`terminal: true`）：任务已处于终态（`cancelled`、`completed`、`failed`），或由未运行态（`queued`、`retryable_failed`、`waiting_approval`）直接原子转换至 `cancelled`；
    - `202 Accepted`（`terminal: false`）：任务处于 `running` 状态，已持久化记录 `cancel_requested_at`，等待 Worker 协作收敛。
- **Queued / Retryable 任务立即取消**：
  - 针对 `queued`、`retryable_failed` 及 `waiting_approval`，在单事务中行锁判定并原子转移至 `cancelled`，记录 `cancel_requested_at`；
  - 追加单条 `cancelled` 审计事件，不可被 Worker 再次 Claim，不创建任何虚构 Run。
- **Running 任务的协作式取消 (Cooperative Cancellation)**：
  - 取消请求首先通过 `SELECT ... FOR UPDATE` 在 PostgreSQL 中持久记录 `cancel_requested_at`；
  - Worker poll loop 在后台心跳检测（`heartbeat()`）发现取消意图时，主动中止正在运行的 `execution.signal`；
  - `durable-run-handler` 在步骤边界（开始前、执行前、步骤间）显式复检 Task 存活状态；
  - 若取消发生在多步骤任务的步骤之间（如 `produce` 之后），严格禁止启动未开始的逻辑步骤（`publish`）；
  - 已发生并持久化的不可逆副作用（`produce` 生成的 Artifact 与 Checkpoint）保持完整可见，严禁回滚或删除。
- **与持久化预算（P0B-08b）协同**：
  - 步骤执行前（预留后未执行）取消：调用 `budget.release` 全额退回预留额度，消费记录为 0；
  - 步骤执行中或副作用产生后取消：调用 `budget.settle` 全额扣减该步骤成本，严禁退款；
  - Worker 崩溃/断租场景下取消：到期预留自动转为 `expired` 并全额计费，杀 Worker 无法逃费。
- **PostgreSQL 状态权威与并发事务一致性**：
  - 验证了 Cancel vs Claim、Cancel vs Heartbeat、Cancel vs Finish、Cancel vs Checkpoint Commit、Cancel vs Reaper、Fencing 等 15 项真实并发竞争场景，保证状态、事件与权威结果一致。

### 明确未实现与非目标

- 真实 Shell 进程的操作系统级 SIGKILL / SIGTERM 强杀（Ember 垂直切片仅运行模拟执行器）；
- 真实 LLM 的流式中断；
- 引入 Redis、Kafka 或内存消息总线（PostgreSQL 仍为唯一状态权威）；
- 修改已经由 ADR-0001 和 ADR-0002 批准的状态机转换图。

---

## 2. API 契约与 DTO 规格

### 端点定义

```http
POST /v1/tasks/:taskId/cancel
Authorization: Bearer <tenant-dev-token>
```

### 响应模型

```typescript
export interface TaskCancelDto {
  readonly task_id: string;
  readonly status: TaskStatus;
  readonly cancel_requested: boolean;
  readonly cancel_requested_at: string | null;
  readonly terminal: boolean;
  readonly updated_at: string;
}
```

### 状态码与响应体语义

| 当前任务状态       | HTTP 状态码        | `terminal` | `cancel_requested` | 行为与数据库变迁                                                             |
| :----------------- | :----------------- | :--------- | :----------------- | :--------------------------------------------------------------------------- |
| `queued`           | `200 OK`           | `true`     | `true`             | 原子转移至 `cancelled`，写入单条 `cancelled` 事件                            |
| `retryable_failed` | `200 OK`           | `true`     | `true`             | 原子转移至 `cancelled`，清除下次重试计划                                     |
| `waiting_approval` | `200 OK`           | `true`     | `true`             | 原子转移至 `cancelled`                                                       |
| `running`          | `202 Accepted`     | `false`    | `true`             | 仅持久记录 `cancel_requested_at`，保持 `running`，待 Worker 收敛             |
| `cancelled`        | `200 OK`           | `true`     | `true`             | 幂等操作，无变更，不追加事件                                                 |
| `completed`        | `200 OK`           | `true`     | `false`            | 终态不可覆写，保持 `completed`，无变更                                       |
| `failed`           | `200 OK`           | `true`     | `false`            | 终态不可覆写，保持 `failed`，无变更                                          |
| 跨租户 / 不存在    | `404 NOT_FOUND`    | -          | -                  | 返回统一的 `{ error: { code: 'NOT_FOUND', message: 'Resource not found' } }` |
| 无 Token / 伪造    | `401 UNAUTHORIZED` | -          | -                  | 返回认证失败错误，不触碰数据库                                               |
| 非 UUID 路径参数   | `400 BAD_REQUEST`  | -          | -                  | 参数校验失败                                                                 |

---

## 3. Queued / Running / Terminal 取消语义与状态机（ADR-0001）

```text
       ┌───────────┐
       │  queued   ├──────────────────────────────┐ (POST /cancel -> 200 OK)
       └─────┬─────┘                              │
             │ claimNext                          │
             ▼                                    ▼
       ┌───────────┐                        ┌───────────┐
  ┌───►│  running  ├─(POST /cancel -> 202)─►│ cancelled │
  │    └─────┬─────┘ (Worker cooperatively  └─────▲─────┘
  │          │        converges)                  │
  │ retry    │                                    │ (POST /cancel -> 200 OK)
  │          ▼                                    │
  │    ┌──────────────────┐                       │
  └────┤ retryable_failed ├───────────────────────┘
       └──────────────────┘
```

1. **Queued / Retryable 取消**：
   - 处于排队或等待退避重试中的任务尚未分配活动 Worker。
   - API 在单事务内对 `tasks` 行加 `FOR UPDATE` 排他锁，原子将状态更新为 `cancelled`，`cancel_requested_at = now()`，`updated_at = now()`。
   - 在同一个事务中向 `task_events` 写入带有 `{ fromStatus, toStatus: 'cancelled', cancelRequested: true }` 的终态事件。
   - 杜绝生成虚构 Run；Worker 在调用 `claimNext` 时条件 `status IN ('queued', 'retryable_failed')` 无法选出该行。
2. **Waiting Approval 取消（P0B-08d Mock Approval 集成）**：
   - 处于 `waiting_approval` 的任务在单事务内对 `tasks` 行加 `FOR UPDATE` 排他锁；
   - 原子将 Task 状态更新为 `cancelled`，`cancel_requested_at = now()`，保留前置 Run 历史引用；
   - **同步过期关联审批**：在同事务中执行 `EXPIRE_PENDING_APPROVALS_ON_CANCEL_SQL`，将关联的所有 `pending` 状态 Approval 原子置为 `expired` 并记录 `decided_at`；
   - **同步清扫预留预算**：在同事务中执行 `SWEEP_RESERVED_BUDGET_ON_CANCEL_SQL`，将任何未结算的预留预算按既定规则结算为 `expired`（`consumed = reserved`），严禁逃费或错误退款；
   - 写入单条 `{ fromStatus: 'waiting_approval', toStatus: 'cancelled' }` 事件；
   - 杜绝状态漂移：后续迟到的 `POST /v1/approvals/:approvalId/decision` 收到 `409 INVALID_STATE_TRANSITION`，任务无法恢复执行，Worker 绝不能 Claim。
3. **Running 协作取消**：
   - 处于执行中的任务已有 Worker 持有排他租约。
   - API 同样在事务内对 `tasks` 行加排他锁，但状态保持为 `running`，仅将 `cancel_requested_at` 设为 `now()`（若此前为空）。
   - 返回 `202 Accepted`，告知客户端取消请求已被持久化记录。
   - Worker 通过心跳检测或步骤边界检测感知取消标记，执行协作收敛（详见第 4 节）。
4. **Terminal 任务**：
   - 已经处于终态（`completed`、`failed`、`cancelled`）的任务不可撤销，不可转移。
   - API 返回 `200 OK`，`terminal: true`，不修改现有数据库状态，不产生重复事件。

---

## 4. Worker 协作取消机制与步骤边界

### 心跳与 AbortSignal

Worker 的 `poll-loop` 为每个被认领的 Run 启动后台心跳协程：

- 周期调用 `queue.heartbeat(run, now)`；
- `heartbeat` 内部在数据库中检查 `tasks.cancel_requested_at`，若发现已记录取消意图，则心跳返回 `false`；
- 心跳协程检测到 `false` 且并非进程关闭时，触发执行上下文的 `execution.signal`（`AbortController.abort()`）；
- `durable-run-handler` 正在执行的内部异步操作响应中断，捕获后返回 `{ type: 'finish', outcome: 'cancelled' }`；
- Worker 调用 `queue.finish(run, 'cancelled')`，由数据库验证租约代次并收敛 Task/Run 状态为 `cancelled`。

### 步骤边界防御（Step Boundaries）

在多步骤执行流中（如 `produce` -> `publish`）：

```text
[Step 1: produce]
  ├── assertStepLive (检查 Task 未被取消且租约有效)
  ├── budget.reserve (预留预算)
  ├── assertStepLive (预留后、执行前复检取消) ──► 若已取消: budget.release(0 consumed) ──► return 'cancelled'
  ├── execute(simulatedExecutor) ────────────► 若执行中被中止: budget.settle(full cost) ──► return 'cancelled'
  └── commitStep(progress, Artifact + Checkpoint)

[Step Boundary: 检查取消意图]
  └── assertStepLive (检测到 cancel_requested_at) ──► return 'cancelled' (终止后续步骤)

[Step 2: publish] ──► 绝不被启动！
```

- **已产生的副作用保持完整**：`produce` 已经提交至 PostgreSQL 的 Artifact 元数据与 Checkpoint 记录严格保留，不可由于后续取消而删除；
- **未开始的步骤严格阻断**：在 `produce` 完成且检测到取消后，`publish` 步骤绝不被调用，Workspace 不会被篡改。

---

## 5. Persistent Budget（持久化预算）交互规范

与 P0B-08b 规范完全契合，防止逃费或误退款：

1. **预留后、执行前取消**：
   - Worker 成功执行 `budget.reserve`，但在开始调用执行器之前检测到取消；
   - Worker 立即调用 `budget.release(grant, { operationId })`；
   - 数据库记录 `state: 'released'`，`consumed_units: 0`，`consumed_slots: 0`；
   - 租户额度与并发 Slot 立即释放。
2. **执行中或产生副作用后取消**：
   - 正在执行模型/沙箱操作时收到取消，或已产生局部副作用；
   - Worker 调用 `budget.settle(grant, { operationId, consumed: stepCost })`；
   - 数据库记录 `state: 'settled'`，实际消耗按完整步长扣减，**绝不退还**。
3. **Worker 终止 / 租约超时场景**：
   - 若 Worker 在预留后崩溃或失联，Reaper 收敛 Run 为 `lease_expired`，Task 为 `cancelled`；
   - 该预留随租约失效而在数据库中达到 `expires_at`；
   - 后续清扫或结算依据数据库时间戳 `expires_at <= clock_timestamp()`，将状态转为 `expired` 并全额计费（`consumed = reserved`），严禁退回。

---

## 6. 并发竞争与事务一致性（Race Conditions）

所有并发竞争均依靠 PostgreSQL 行锁（`SELECT ... FOR UPDATE`）或 Advisory Lock 严格串行化：

| 竞争场景                        | 串行化机制与执行序列                                                                                                                                                                                                                                                                                                                                                | 最终状态保证                                                                   |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------- |
| **Cancel vs Claim**             | Task 行锁争夺。<br>1. 若 Cancel 先获取锁：Task 转为 `cancelled`，Claim 跳过该行返回 `null`。<br>2. 若 Claim 先获取锁：Task 转为 `running`，Cancel 后续获取锁观察到 `running` 并设置 `cancel_requested_at`（202），随后由 Worker 收敛为 `cancelled`。                                                                                                                | 绝无在已取消任务上启动新 Run 的可能；最终一致收敛至 `cancelled`。              |
| **Cancel vs Heartbeat**         | Cancel 写入 `cancel_requested_at`；Heartbeat 查得该字段非空，主动返回 `false` 并触发 Worker 中断信号。                                                                                                                                                                                                                                                              | Worker 主动中止，不越权延长租约。                                              |
| **Cancel vs Finish**            | Task 行锁争夺。<br>1. 若 Cancel 先获取锁：设置 `cancel_requested_at`；随后 Finish(`succeeded`) 事务内复检发现该标记，ADR-0001 规定强制收敛 Task/Run 为 `cancelled`。<br>2. 若 Finish 先提交：Task 已为 `completed`；随后 Cancel 观察到终态返回 `200 OK`，保持 `completed`。                                                                                         | 严格单终态事件，无双终态漂移。                                                 |
| **Cancel vs Checkpoint Commit** | `commitStep` 事务调用 `lockAndAssertLive`，同时锁定 Task 与 Run 行。若 Cancel 先获取 Task 锁并记录取消意图，`lockAndAssertLive` 断言抛出 `CANCELLED` 异常并回滚整个事务。                                                                                                                                                                                           | 被取消的任务不会有任何后续 Checkpoint 或 Artifact 产生。                       |
| **Cancel vs Reaper**            | Task/Run 行锁争夺。当 Run 租约已超时且存在 `cancel_requested_at` 时，Reaper 明确将其收敛为 `run.status = 'lease_expired'` 且 `task.status = 'cancelled'`。                                                                                                                                                                                                          | 不会重新排队重试，直接进入取消终态。                                           |
| **Cancel vs Approval Decision** | Task 行锁争夺。<br>1. 若 Cancel 先获取锁：Task 转为 `cancelled`，同事务同步将关联的 pending Approval 置为 `expired`，并清扫预留预算；随后迟到的 Approve 请求因状态冲突返回 `409 INVALID_STATE_TRANSITION`，任务不可恢复。<br>2. 若 Approve 先获取锁：Approval 置为 `approved`，Task 重新排队为 `queued`；随后 Cancel 观察到 `queued` 并将其原子收敛为 `cancelled`。 | 绝无 Task=cancelled 但 Approval=pending 的不一致；被取消的任务不可被批准唤醒。 |
| **Fencing / Stale Epoch**       | 迟到的旧 Epoch Worker 尝试在 Task 终态取消后提交 `commitStep` 或 `finish`，由于 `task.status = 'cancelled'` 且 `current_run_id` 已经失效，被 `STALE_LEASE` 拒绝。                                                                                                                                                                                                   | 旧 Worker 绝不能覆写权威终态。                                                 |

---

## 7. 验收与测试矩阵

所有 16 个并发与可靠性场景（共 19 项独立用例）均在真实的 PostgreSQL 17 上通过排他行锁与确定性 Latch 验证（`tests/integration/cooperative-cancellation.test.ts`）：

| 编号 | 测试用例描述                                                                          |  验证结果  |
| :--: | :------------------------------------------------------------------------------------ | :--------: |
|  1   | Queued Task 立即取消（200 OK，terminal=true，阻止 Claim 与 Run 创建）                 | **PASSED** |
|  2   | Running Task 协作式取消（心跳 -> AbortSignal -> finish('cancelled')）                 | **PASSED** |
|  3   | Retryable (`retryable_failed`) Task 立即取消并清除重试计划                            | **PASSED** |
|  4   | 重复取消幂等性（包含 completed 任务），无重复终态事件                                 | **PASSED** |
|  5   | 不存在的 Task 返回标准 404 NOT_FOUND                                                  | **PASSED** |
|  6   | 跨 Tenant 取消返回与 404 相同响应，外租户状态零污染                                   | **PASSED** |
|  7   | 无 Token、无效 Token 及非 UUID 参数前置拦截（401 / 400）                              | **PASSED** |
|  8   | Cancel 与 Claim 并发竞争（确定性行锁屏障，两种序均状态一致）                          | **PASSED** |
|  9   | Cancel 与 Finish 并发竞争（Cancel 先锁收敛 cancelled；Finish 先锁保持 completed）     | **PASSED** |
|  10  | Cancel 与 Checkpoint Commit 并发竞争（拒绝 commit，零字节与 Checkpoint 写入）         | **PASSED** |
|  11  | Cancel 与 Reaper 并发竞争（过期 Run 收敛 lease_expired，Task 收敛 cancelled，不重试） | **PASSED** |
|  12  | 取消后不得执行下一个步骤（阻止 publish，保留已提交的 produce Artifact/Checkpoint）    | **PASSED** |
|  13  | 旧 Epoch 迟到提交被 Fencing 拦截，不可覆写 cancelled 终态                             | **PASSED** |
|  14  | SSE 流断线重连（`Last-Event-ID`）可靠补发最后的 `cancelled` 终态事件                  | **PASSED** |
| 15a  | 预算预留后、执行前取消：正确释放（`released`，0 消费）                                | **PASSED** |
| 15b  | 步骤执行中/副作用后取消：全额结算（`settled`，不可退款）                              | **PASSED** |
| 15c  | Worker 终止后租约到期：清扫为 `expired` 并全额计费（无错误退款）                      | **PASSED** |
| 16a  | waiting_approval 取消：同步过期 Approval 与清扫预算，迟到 approve 报 409，不可恢复    | **PASSED** |
| 16b  | Cancel 与 Approval 决策并发竞争：行锁严格串行化，双向序均收敛，杜绝不一致与非法 Claim | **PASSED** |
| 16c  | PostgresTaskRepository 中 requestCancel 与 cancel 事务语义等价性与 Approval 清理共享  | **PASSED** |
