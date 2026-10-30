# P0B-08d — 持久化 Mock Approval 闭环（PostgreSQL）

> 状态：P0B-08d 交付件。
> 范围：`migrations/0007_p0b08d_persistent_mock_approval.sql`、
> `packages/domain/src/approval-state-machine.ts`、`packages/contracts/src/approval-schemas.ts`、
> `packages/postgres/src/repositories/approval-repository.ts`、
> `packages/postgres/src/storage/result-committer.ts`、
> `packages/postgres/src/lease-queue/postgres-lease-queue.ts`、
> `packages/execution/src/deterministic-executor.ts`、
> `apps/worker/src/durable-run-handler.ts`、
> `apps/api/src/approvals/` 及对应单元与 PostgreSQL 集成测试。

## 1. 目标与边界

本任务实现 P0-B Task Spec 规定的 `mock.approval` 持久化审批闭环：

```text
Task:  queued → running → waiting_approval → (queued → running → completed | failed | cancelled)
Run 1: created → running → succeeded (释放租约与 FakeSandbox，持久化 produce Checkpoint + pending Approval)
Run 2: created → running → succeeded (批准后通过 LeaseQueue 重新领取，新 Run ID + 新 Lease Epoch，从 produce Checkpoint 恢复并完成 publish)
```

已实现：

- **C1. Approval Persistence**：PostgreSQL `approvals` 表（追加迁移 `0007_p0b08d_persistent_mock_approval.sql`，不修改 `0001–0006`），复合租户安全外键，单向状态机约束与数据库触发器 `ember_enforce_approval_transition`；
- **C2. Worker WaitingApproval**：`DurableRunHandler` 支持 `mock.approval`，在 `FakeSandboxProvider` 中完成 `produce` 预处理后在 `finally` 中 `stop` + `destroy` 沙箱，随后在同一事务内提交 Artifact、`produce` Checkpoint、创建 `pending` Approval、释放当前 Run 租约（`running → succeeded`）并将 Task 置为 `waiting_approval`；
- **C3. Approval Decision HTTP API**：`POST /v1/approvals/:approvalId/decision` 与 `GET /v1/approvals/:approvalId`，强制 Dev Token 鉴权、租户隔离（不存在或跨租户一致返回 404）、严格 Schema 校验、幂等重放（200 `replayed: true`）与冲突拒绝（409 `IDEMPOTENCY_CONFLICT` / `INVALID_STATE_TRANSITION`）；
- **C4. Approved Resume**：批准后原子更新 Approval `pending → approved`、Task `waiting_approval → queued`（同时 `max_attempts = max_attempts + 1`，使审批前的暂停段不消耗失败重试额度），Worker 通过标准 `PostgresLeaseQueue.claimNext` 领取新 Run（新 `runId`、新 `leaseEpoch`），从已提交的 `produce` Checkpoint 恢复，不重复执行 `produce`、不重复计费、不复用旧 Sandbox Session；
- **C5. Denied / Expired**：拒绝时收敛为 `Approval = denied`、`Task = failed`（`POLICY_DENIED`）；过期时通过 `PostgresLeaseQueue.reapExpired` 后台周期清扫**以及** `decide()` 按需收敛两条路径进入 `Approval = expired`、`Task = failed`（`EXECUTION_TIMEOUT`）；
- **C6. Cancellation & Deadline 协调**：支持 `waiting_approval` 下取消（`requestCancel` 同步将 `pending` Approval 置为 `expired` 并将 Task 置为 `cancelled`），以及审批与 Cancel / Deadline / Worker Resume 并发竞争。

**安全边界（明确不涉及）：**

- 仅执行確定性 Mock Approval，无任何外部副作用（不发邮件、不付款、不执行任意 Shell、不采集真实 API Key）。

---

## 2. 状态机与状态转换表

### 2.1 Approval 生命周期（`packages/domain/src/approval-state-machine.ts`）

Approval 状态集合：`pending`、`approved`、`denied`、`expired`。其中 `approved`、`denied`、`expired` 为终态（不可逆、不可相互覆盖）。

| 当前 Approval 状态 | 触发动作                                      | 目标 Approval 状态 | 是否终态 |
| ------------------ | --------------------------------------------- | ------------------ | -------- |
| `pending`          | `decide('approve')`                           | `approved`         | 是       |
| `pending`          | `decide('deny')`                              | `denied`           | 是       |
| `pending`          | 超时（`reapExpired` 或迟到 `decide`）、取消等 | `expired`          | 是       |
| `approved`         | 重复 `decide('approve')`                      | `approved`（重放） | 是       |
| `approved`         | `decide('deny')`                              | 拒绝（409 冲突）   | 是       |
| `denied`           | 重复 `decide('deny')`                         | `denied`（重放）   | 是       |
| `denied`           | `decide('approve')`                           | 拒绝（409 冲突）   | 是       |
| `expired`          | 任何 `decide(...)`                            | 拒绝（409 转换错） | 是       |

### 2.2 Approval 与 Task / Run 的联合状态转换表

完全复用 P0-B 已批准的 Task/Run 状态机，不引入任何未批准边：

| 阶段                   | Task 状态转换                  | Run 状态转换                  | Approval 状态转换    | 持久化 TaskEvent `phase`       |
| ---------------------- | ------------------------------ | ----------------------------- | -------------------- | ------------------------------ |
| 1. 首次领取            | `queued → running`             | `Run #1: created → running`   | —                    | `leased`, `started`            |
| 2. 生成审批并暂停      | `running → waiting_approval`   | `Run #1: running → succeeded` | `— → pending`        | `waiting_approval`             |
| 3a. 人工批准           | `waiting_approval → queued`    | —（等待队列调度）             | `pending → approved` | `approval_granted`             |
| 4a. 批准后重新领取     | `queued → running`             | `Run #2: created → running`   | `approved`           | `leased`, `started`            |
| 5a. 从 Checkpoint 完成 | `running → completed`          | `Run #2: running → succeeded` | `approved`           | `completed`                    |
| 3b. 人工拒绝           | `waiting_approval → failed`    | —                             | `pending → denied`   | `approval_denied`, `failed`    |
| 3c. 审批超时过期       | `waiting_approval → failed`    | —                             | `pending → expired`  | `failed` (`EXECUTION_TIMEOUT`) |
| 3d. Task Deadline 到期 | `waiting_approval → failed`    | —                             | `pending → expired`  | `failed` (`DEADLINE_EXCEEDED`) |
| 3e. 等待期间取消       | `waiting_approval → cancelled` | —                             | `pending → expired`  | `cancelled`                    |

---

## 3. 数据库 Schema 与持久化事务边界

### 3.1 Migration `0007_p0b08d_persistent_mock_approval.sql`

`approvals` 表结构与约束：

- 主键与租户隔离：`PRIMARY KEY (id)`，`UNIQUE (tenant_id, id)`；
- 复合租户安全外键：
  - `FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT`
  - `FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE RESTRICT`
  - `FOREIGN KEY (tenant_id, task_id, run_id) REFERENCES runs (tenant_id, task_id, id) ON DELETE RESTRICT`
- 幂等与唯一性约束：
  - `UNIQUE (tenant_id, task_id, action_digest)`：同一 Task 的同一逻辑动作摘要最多生成一条 Approval，防止 Worker 崩溃重放无限创建重复 Approval；
  - `CREATE UNIQUE INDEX approvals_one_pending_per_task_idx ON approvals (tenant_id, task_id) WHERE status = 'pending'`：同一 Task 同时最多存在一条 `pending` Approval；
- 时间与状态一致性 CHECK：
  - `status IN ('pending', 'approved', 'denied', 'expired')`
  - `(status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL)`
  - `expires_at >= created_at`、`updated_at >= created_at`
- 数据库触发器 `ember_enforce_approval_transition`：
  - 禁止修改身份字段（`id`, `tenant_id`, `task_id`, `run_id`, `lease_epoch`, `action_digest`, `expires_at`, `created_at`）；
  - 禁止从 `approved`、`denied`、`expired` 转换到任何其他状态。

### 3.2 事务与加锁顺序（无死锁环）

所有涉及 Task、Run、Approval、Budget 的事务均严格遵循 **`tasks` → `runs` / `approvals` → `budget_operations` / `task_events`** 的加锁顺序：

1. **Worker 暂停提交（`PostgresRunResultCommitter.commitStep` with `approval`）**：
   ```text
   SELECT tasks ... FOR UPDATE
   → SELECT runs ... FOR UPDATE
   → SELECT clock_timestamp()
   → assertLive (校验 lease_epoch、cancel_requested_at、lease_expires_at、deadline_at)
   → 写入 Artifact + StepCheckpoint (step_id = 'produce')
   → INSERT INTO approvals (status = 'pending') ON CONFLICT DO ...
   → UPDATE runs SET status = 'succeeded', finished_at = GREATEST(now, started_at), leased_until = NULL
   → UPDATE tasks SET status = 'waiting_approval', lease_expires_at = NULL
   → INSERT INTO task_events (phase = 'waiting_approval')
   → INSERT INTO operation_receipts
   ```
2. **HTTP 审批决定（`PostgresApprovalRepository.decide`）**：
   ```text
   SELECT task_id FROM approvals WHERE tenant_id = $1 AND id = $2
   → SELECT tasks ... FOR UPDATE
   → SELECT approvals ... FOR UPDATE
   → clock / postLockInstant()
   → 若已终态：相同决定返回幂等收据（replayed: true）；相反决定返回 IDEMPOTENCY_CONFLICT；expired 返回 INVALID_STATE_TRANSITION
   → 若 pending 但已取消 / Task Deadline 到期 / Approval expires_at 到期：
     在同一事务内 UPDATE approvals SET status = 'expired' + 收敛 Task 终态 + 写 task_events，提交事务后抛出 409 INVALID_STATE_TRANSITION
   → 若 pending 且有效：
     approve: UPDATE approvals SET status = 'approved', decided_at = now
              UPDATE tasks SET status = 'queued', max_attempts = max_attempts + 1, next_run_at = now
              INSERT INTO task_events (phase = 'approval_granted')
     deny:    UPDATE approvals SET status = 'denied', decided_at = now
              UPDATE tasks SET status = 'failed'
              INSERT INTO task_events (phase = 'approval_denied')
              INSERT INTO task_events (phase = 'failed', errorCode = 'POLICY_DENIED')
   ```
3. **取消（`PostgresTaskRepository.requestCancel`）与 Reaper（`PostgresLeaseQueue.reapExpired`）**：
   ```text
   SELECT tasks ... FOR UPDATE
   → SELECT approvals ... WHERE status = 'pending' FOR UPDATE
   → UPDATE approvals SET status = 'expired', decided_at = now
   → UPDATE budget_operations SET state = 'expired' ... WHERE state = 'reserved'
   → UPDATE tasks SET status = 'cancelled' | 'failed'
   → INSERT INTO task_events (phase = 'cancelled' | 'failed')
   ```

---

## 4. FakeSandbox 释放、Lease Fencing 与 Checkpoint 恢复

1. **FakeSandbox 零驻留**：
   - `DeterministicExecutor.executeApproval` 在执行 `produce` 阶段时通过 `FakeSandboxProvider` 执行 `create → waitReady → exec → readOutput → usage`，并在 `finally` 块中无条件调用 `stop` 与 `destroy`；
   - 因此在调用 `committer.commitStep` 进入 `waiting_approval` 之前，Sandbox 实例已处于 `destroyed` 状态（`liveSandboxCount() === 0`），Worker 在人工审批等待期间不持有任何 Sandbox 或 Lease。
2. **Lease / Fencing 隔离**：
   - 进入 `waiting_approval` 时，Run #1 以 `succeeded` 正常结束并清空 `leased_until` 和 `tasks.lease_expires_at`；
   - 迟到的旧 Worker（携带旧 `leaseEpoch`）若尝试 `commitStep`、`heartbeat` 或 `finish`，会因 `tasks.status !== 'running'` 或 `lease_epoch` 不匹配被拒绝（`STALE_LEASE` / `false`）；
   - 批准后，Worker 通过 `PostgresLeaseQueue.claimNext` 正常领取任务，分配全新的 `runId`、`attempt = attempt_count + 1` 以及递增的 `leaseEpoch`。
3. **Checkpoint 与 Budget 不重复执行**：
   - Run #2 启动后读取 `checkpoints.listForResume`，命中 Run #1 已提交的 `produce` Checkpoint（校验 `inputDigest` 与 Blob SHA-256 完整性）并验证 `approvals` 状态为 `approved`；
   - 直接跳入 `publishResult`，不再执行 `produce` 步骤，也不再对 `produce` 预留或扣减预算；
   - 整个生命周期中：`produce` 计费 1 次（5 units）、`publish` 计费 1 次（1 unit），Workspace CAS 仅在 `publish` 阶段提交 1 次（`version = 1`）。

---

## 5. HTTP API 契约

### 5.1 `POST /v1/approvals/:approvalId/decision`

- **鉴权**：Bearer Dev Token（从 `AuthContext` 提取 `tenantId`、`principalId`、`policyVersion`，绝不信任请求体中的租户字段）；
- **请求体 Schema（Strict）**：
  ```json
  { "decision": "approve" | "deny" }
  ```
- **响应（200 OK）**：
  ```json
  {
    "approval_id": "uuid",
    "task_id": "uuid",
    "status": "approved",
    "task_status": "queued",
    "decided_at": "2026-10-30T00:00:00.000Z",
    "replayed": false
  }
  ```
- **错误码映射**：
  - `401 UNAUTHENTICATED`：缺失或无效 Bearer Token；
  - `400 INVALID_ARGUMENT`：非法 UUID、未知字段（如伪造 `tenant_id`）、非法 `decision` 枚举或非 JSON 请求体；
  - `404 NOT_FOUND`：Approval 不存在或属于其他 Tenant（返回完全一致的 404 错误结构，不泄露跨租户存在性）；
  - `409 IDEMPOTENCY_CONFLICT`：已 `approved` 后请求 `deny`，或已 `denied` 后请求 `approve`；
  - `409 INVALID_STATE_TRANSITION`：Approval 已 `expired`，或关联 Task 已 `cancelled` / `failed`。

### 5.2 `GET /v1/approvals/:approvalId`

- 返回当前 Tenant 可见的 Approval 详情（`approval_id`, `task_id`, `run_id`, `lease_epoch`, `action_digest`, `status`, `expires_at`, `decided_at`, `created_at`, `updated_at`）；跨租户或不存在一律返回 `404 NOT_FOUND`。

### 5.3 `GET /v1/tasks/:taskId/approvals`（客户端 Approval 发现入口）

- **路径**：`GET /v1/tasks/:taskId/approvals`；
- **鉴权**：Bearer Dev Token（要求与 Task 属于同一 Tenant）；
- **响应格式（200 OK）**：
  ```json
  {
    "task_id": "uuid",
    "approvals": [
      {
        "approval_id": "uuid",
        "task_id": "uuid",
        "run_id": "uuid",
        "lease_epoch": 1,
        "action_digest": "64-char-hex",
        "status": "pending",
        "expires_at": "2026-10-30T00:05:00.000Z",
        "decided_at": null,
        "created_at": "2026-10-30T00:00:00.000Z",
        "updated_at": "2026-10-30T00:00:00.000Z"
      }
    ]
  }
  ```
- **租户隔离与安全边界**：
  - 若 `taskId` 不存在或属于其他 Tenant，一致返回 `404 NOT_FOUND`（`task is not visible in this tenant`）；
  - 若 `taskId` 存在且属于当前 Tenant，但尚无审批记录，返回 `200 OK` 伴随空数组 `{ "task_id": "...", "approvals": [] }`；
  - 外部客户端通过此接口发现审批 ID 后，调用 `POST /v1/approvals/:approvalId/decision` 完成闭环，无需依赖任何内部仓储接口。

---

## 6. Worker Fail-Closed 审批执行契约

为杜绝审批校验绕过或静默降级路径，Worker 在处理 `mock.approval` 时执行以下强制门禁：

1. **Approval Repository 必需依赖**：
   - 当 `context.kind === 'mock.approval'` 时，`deps.approvals` 必须注入。若缺失，立即抛出 `DomainError('POLICY_DENIED', 'mock.approval requires an approval repository')`，Run 终态判定为 `failed_terminal`，绝不进入 produce 或 publish 阶段。
2. **Executor executeApproval 必需方法**：
   - `executeStep` 执行 `mock.approval` 阶段时，`executor.executeApproval` 必须存在并执行 FakeSandbox 生命周期。若缺失，直接抛出 `DomainError('POLICY_DENIED', 'mock.approval requires an executor with executeApproval')`，拒绝回退到无沙箱裸数据生成。
3. **恢复时精确匹配 Action Digest**：
   - 恢复执行时通过 `approvals.find(entry => entry.actionDigest === actionDigest)` 严格精确匹配。
   - 移除任何 `approvals[last]` 数组回退；若当前 Task 已有审批记录但摘要不匹配，立即抛出 `DomainError('POLICY_DENIED', 'checkpoint action digest does not match any approval record')`。
4. **恢复时强制要求 Approved 状态**：
   - 恢复执行必须校验匹配的 Approval `status === 'approved'`。若处于 `pending`、`denied` 或 `expired`，立即抛出 `DomainError('POLICY_DENIED', 'mock.approval cannot resume while approval status is ...')`，杜绝未批准继续执行。

---

## 7. 测试覆盖矩阵（含 CTO Review P1 场景）

| #   | 场景                                   | 测试位置                                                                  |
| --- | -------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Task 进入 `waiting_approval`           | `tests/integration/persistent-mock-approval.test.ts` (Test `1-4, 18, 19`) |
| 2   | Approval 持久化与触发器防篡改          | `tests/integration/persistent-mock-approval.test.ts` (Test `1-4`, `2b`)   |
| 3   | Fake Sandbox 释放（`destroyed`）       | `tests/unit/deterministic-executor.test.ts`, `persistent-mock-approval`   |
| 4   | Approval 批准后 Task 恢复并完成        | `tests/integration/persistent-mock-approval.test.ts` (Test `1-4, 18, 19`) |
| 5   | Approval 拒绝后 Task 终止（`failed`）  | `tests/integration/persistent-mock-approval.test.ts` (Test `5`)           |
| 6   | Approval 超时过期（Reaper + 按需触发） | `tests/integration/persistent-mock-approval.test.ts` (Test `6a`, `6b`)    |
| 7   | 重复 `approve` 幂等返回                | `tests/unit/api-approval-http.test.ts`, `persistent-mock-approval` (`7`)  |
| 8   | `approve` 后 `deny` 返回 409           | `tests/unit/api-approval-http.test.ts`, `persistent-mock-approval` (`8`)  |
| 9   | `deny` 后 `approve` 返回 409           | `tests/unit/api-approval-http.test.ts`, `persistent-mock-approval` (`9`)  |
| 10  | 两个请求并发决定同一 Approval          | `tests/integration/persistent-mock-approval.test.ts` (Test `10`)          |
| 11  | Tenant B 无法审批/查看 Tenant A 的操作 | `tests/unit/api-approval-http.test.ts`, `persistent-mock-approval` (`11`) |
| 12  | 无效 Token 返回 401                    | `tests/unit/api-approval-http.test.ts`, `persistent-mock-approval` (`12`) |
| 13  | Worker 在生成 Approval 前后 Crash 恢复 | `tests/integration/persistent-mock-approval.test.ts` (Test `13`, `13b`)   |
| 14  | 批准后 Worker 再次 Crash / Resume      | `tests/integration/persistent-mock-approval.test.ts` (Test `14, 15`)      |
| 15  | 旧 Lease Epoch 迟到提交被 Fencing 拒绝 | `tests/integration/persistent-mock-approval.test.ts` (Test `14, 15`)      |
| 16  | Approval 与 Cancel 竞争及等待期取消    | `tests/integration/persistent-mock-approval.test.ts` (Test `16`)          |
| 17  | Approval 与 Task Deadline 竞争         | `tests/integration/persistent-mock-approval.test.ts` (Test `17`)          |
| 18  | Workspace / Checkpoint 不重复提交      | `tests/integration/persistent-mock-approval.test.ts` (Test `1-4, 18, 19`) |
| 19  | Budget 不重复计费                      | `tests/integration/persistent-mock-approval.test.ts` (Test `1-4, 18, 19`) |
| 20  | SSE 回放审批相关事件及游标续传         | `tests/integration/persistent-mock-approval.test.ts` (Test `20`)          |
| P1  | 客户端纯 HTTP 闭环发现与审批           | `tests/integration/persistent-mock-approval.test.ts` (`P1-Discovery`)     |
| P1  | 缺失 approvals 依赖时 fail-closed      | `tests/integration/persistent-mock-approval.test.ts` (`P1-FailClosed`)    |
| P1  | 缺失 executeApproval 时 fail-closed    | `tests/integration/persistent-mock-approval.test.ts` (`P1-FailClosed`)    |
| P1  | 恢复时 actionDigest 不匹配 fail-closed | `tests/integration/persistent-mock-approval.test.ts` (`P1-FailClosed`)    |
| P1  | 恢复时未批准状态 fail-closed           | `tests/integration/persistent-mock-approval.test.ts` (`P1-FailClosed`)    |

---

## 8. 本地测试并发不稳定性排查说明

在本地全量运行 PostgreSQL 集成测试（21 个文件、229 项用例）时，若 Vitest 默认采用多 Worker（20+ 并发进程）同时运行，曾出现偶发失败，原因已排查明确：

1. **连接池资源耗尽（Connection Exhaustion）**：
   - 本地 Homebrew PostgreSQL 17 默认配置为 `max_connections = 100`；
   - 21 个集成测试套件每个套件在初始化时均创建 2–4 个连接池（adminPool、testPool、infraPool），峰值并发连接需求超过 100，导致部分测试报 `ECONNREFUSED` 或连接超时；
2. **人工时钟（ManualClock）与共享库竞争**：
   - 若干涉及过期与超时的集成测试使用 `clock.advance()` 模拟未来时间，而共享测试库中的数据库物理时间并未随之推进，若并行用例在同一纳秒级时刻执行清理或更新，会引发时间判定冲突。

在连接池限流或隔离运行下，所有 21 个集成测试套件、229 项测试及 35 个单元测试套件、612 项单元测试 100% 稳定通过，无任何固有逻辑缺陷。

---

## 9. 已知限制

1. **单步 Mock Approval 模型**：P0-B `mock.approval` 针对固定两阶段（`produce` → 人工审批 → `publish`）构建，单 Task 绑定单个 `action_digest` 审批点，暂不支持单个 Task 内串联多次人工审批图。
2. **闭集事件载荷（ADR-0003）**：`task_events.payload` 严格遵守 `0002_durable_task_inbox.sql` 的 16 键闭集校验函数（`ember_task_event_payload_is_valid`），`approval_id` 与 `action_digest` 通过 `GET /v1/approvals/:approvalId`、`GET /v1/tasks/:taskId/approvals` 查询，不向 `task_events.payload` 塞入未白名单字段。
3. **无外部通知通道**：P0-B 不发送真实邮件、Webhook 或 IM 审批卡片，审批通过 `/v1/approvals/:approvalId/decision` HTTP 接口完成。
