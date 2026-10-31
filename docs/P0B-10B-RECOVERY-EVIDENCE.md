# P0B-10B — Crash/Recovery 与可靠性不变量验收报告 (Process Recovery Evidence)

> **任务标识**：P0B-10B — Crash/Recovery 与不变量验收补强  
> **基线分支/Commit (Base SHA)**：`origin/main` @ `2ec04f6c7459820c20813554a749c60447d33e88` (PR #24 merge commit)  
> **Head 追踪 (Dynamic Head)**：分支 `feature/p0b-10b-process-recovery` (PR [#25](https://github.com/basicv8vc/Ember/pull/25))
> **工作区 (Worktree)**：`/Users/lj/Downloads/worktrees/ember-p0b-10b-process-recovery`  
> **交付分支**：`feature/p0b-10b-process-recovery`  
> **角色**：Senior Distributed Systems / Reliability Engineer  
> **核心交付**：真实 OS Worker 子进程 `SIGKILL` 强杀与自主断点恢复测试、确定性并发取消与提交竞态双分支测试、B-T24～27 审计矩阵、5 轮稳定性证据、Draft PR。严格禁止自动合并或推送至 main。

---

## 1. 变更清单与环境信息

### 1.1 修改与新增文件清单

```text
新增文件：
  tests/chaos/harness/worker-subprocess.ts             - 真实 Worker OS 子进程生命周期控制器 (PID 级强杀、隔离 schema、确定性超时)
  tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts - 真实 OS 进程 SIGKILL 强杀后 Checkpoint 恢复与 Reaper 收敛测试
  docs/P0B-10B-RECOVERY-EVIDENCE.md                   - 本验收与证据报告

修改文件 (只针对测试与微秒时钟补偿，零修改生产代码)：
  tests/chaos/harness/index.ts                         - 导出 worker-subprocess
  tests/chaos/b-t26-artifact-checkpoint-atomic.test.ts - 消除测试 claimNext microsecond 截断抖动
  tests/chaos/b-t27-lease-fencing-concurrency.test.ts  - 新增 Commit-first 与 Cancel-first 确定性双分支竞态测试 + 消除时钟抖动
  tests/integration/lease-claim.test.ts                - 消除 syncClock 边界截断抖动
  tests/integration/lease-fencing.test.ts              - 消除 syncClock 边界截断抖动
  tests/integration/lease-recovery.test.ts             - 消除 syncClock 边界截断抖动
```

### 1.2 执行环境与 CI 状态

- **OS**: macOS Darwin 24.6.0 (Apple Silicon)
- **Node.js**: v22.14.0 (本地) / Node 24 LTS (GitHub Actions CI)
- **pnpm**: 10.6.5
- **PostgreSQL**: PostgreSQL 17.4 (Homebrew Local / CI PostgreSQL 17, port 5432)
- **数据库隔离**: 每次测试独立动态生成 `ember_it_*` Schema，测试退出执行完整 `DROP SCHEMA ... CASCADE` 清理。
- **GitHub Actions CI**: **通过** (PR #25 CI/Verify `Node 24 LTS + PostgreSQL 17` 全量检查通过，0 failing, 0 cancelled)。

---

## 2. 现有覆盖审计矩阵 (Existing Coverage Audit)

| 场景编号    | 故障与可靠性场景                                                  | 对应测试文件 / 测试名称                                                                                                                                                                                                                                                                                                                            |         是否真进程故障          |                                                                           独立 PostgreSQL 证据                                                                            |                             安全与确定性保障                              | 审计结论                                                                                        |
| :---------- | :---------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-----------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------- |
| **B-T25.1** | DB Commit 前连接中断 (Tx 未提交)                                  | `tests/chaos/b-t25-durable-ack-crash.test.ts`<br>`cancels transaction and preserves zero accepted events`                                                                                                                                                                                                                                          |      否 (DB Backend 中断)       |                                                                     是 (独立 Schema, 查询 tasks 为 0)                                                                     |                 是 (pg_terminate_backend 仅中断特定 pid)                  | **已覆盖**：原有测试严谨，无需重写                                                              |
| **B-T25.2** | DB Commit 后、HTTP Ack 前断连                                     | `tests/chaos/b-t25-durable-ack-crash.test.ts`<br>`persists task when backend dies after commit but before ack`                                                                                                                                                                                                                                     |         否 (连接池中断)         |                                                          是 (Task/accepted 事件存在，重试同 key 返回相同 taskId)                                                          |                     是 (确定性断开 client connection)                     | **已覆盖**：原有测试完整满足幂等与持久化标准                                                    |
| **B-T25.3** | 幂等键冲突与租户隔离安全                                          | `tests/chaos/b-t25-durable-ack-crash.test.ts`<br>`rejects payload mismatch under same idempotency key`                                                                                                                                                                                                                                             |               否                |                                                          是 (返回 IDEMPOTENCY_PAYLOAD_MISMATCH，零 SQL/DSN 泄露)                                                          |                         是 (纯契约与错误映射断言)                         | **已覆盖**：无内部凭据泄露风险                                                                  |
| **B-T26.1** | Blob 已落盘、DB Commit 前崩溃                                     | `tests/chaos/b-t26-artifact-checkpoint-atomic.test.ts`<br>`orphan blob uncommitted crash recovery`                                                                                                                                                                                                                                                 |         否 (模拟未提交)         |                                                                是 (Blob 孤立存在但 artifacts 关系表不可见)                                                                |                        是 (隔离 artifact 目录检查)                        | **已覆盖**：孤立 blob 路径受控，查询不可见                                                      |
| **B-T26.2** | Checkpoint 提交后 Worker 逻辑中断恢复                             | `tests/chaos/b-t26-artifact-checkpoint-atomic.test.ts`<br>`recovers execution from committed step checkpoint`                                                                                                                                                                                                                                      |        否 (模拟租约回拨)        |                                                                       是 (断点数据在 DB 中正确读取)                                                                       |                      是 (手动 clock 回拨触发 reaper)                      | **存在缺口**：仅通过 SQL 时间回拨模拟，未验证真实 Worker OS 进程崩溃与文件描述符/未提交事务释放 |
| **B-T26.3** | **【新增】真实 Worker OS 子进程 SIGKILL 与自主断点恢复**          | `tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts`<br>`SIGKILLs real Worker OS process after Step 1 checkpoint; recovered Worker resumes from checkpoint`                                                                                                                                                                                 | **是 (真实 OS 子进程 SIGKILL)** |                                                     **是 (真实 PostgreSQL advisory_lock 屏障 + 跨进程租约/断点对账)**                                                     |           **是 (严格限定 child.pid，无 sleep 竞态，超时保护)**            | **已补齐**：真实 OS 强杀并验证已提交步骤零重复执行                                              |
| **B-T26.4** | **【新增】真实 Worker 初始阶段崩溃完全回滚**                      | `tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts`<br>`SIGKILLs Worker OS process before any checkpoint is committed`                                                                                                                                                                                                                     | **是 (真实 OS 子进程 SIGKILL)** |                                                             **是 (断言无半提交 checkpoint，新进程全量执行)**                                                              |                       **是 (锁定 pg_locks 后强杀)**                       | **已补齐**：验证无断点时系统干净重试                                                            |
| **B-T26.5** | **【新增】独立 Reaper 进程跨进程收敛已强杀 Worker 任务**          | `tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts`<br>`demonstrates standalone Reaper process independently converging a task`                                                                                                                                                                                                            |   **是 (独立 Reaper 子进程)**   |                                                     **是 (Reaper 将 running 状态转换为 retryable_failed 并重新排队)**                                                     |                         **是 (双子进程分别托管)**                         | **已补齐**：验证纯 Reaper 模式的独立发现与自愈能力                                              |
| **B-T27.1** | 旧 Run 延迟/旧 epoch 提交防护 (Fencing)                           | `tests/chaos/b-t27-lease-fencing-concurrency.test.ts`<br>`rejects late commitStep from stale worker with FAILED_PRECONDITION`                                                                                                                                                                                                                      |       否 (模拟过期 grant)       |                                                                    是 (ResultCommitter CAS 校验 epoch)                                                                    |                        是 (精确 grant/epoch 传递)                         | **已覆盖**：版本栅栏可靠                                                                        |
| **B-T27.2** | 任务终态竞争唯一性                                                | `tests/chaos/b-t27-lease-fencing-concurrency.test.ts`<br>`guarantees exactly one winning execution terminal state`                                                                                                                                                                                                                                 |      否 (多并发 committer)      |                                                               是 (仅 1 个 terminal event，Task 仅一个终态)                                                                |                         是 (Barrier 同步并发触发)                         | **已覆盖**：行级锁防止双写                                                                      |
| **B-T27.3** | **【强化】并发 Cancellation 与 Terminal Commit 确定性双分支竞争** | `tests/chaos/b-t27-lease-fencing-concurrency.test.ts`<br>1. `verifies Commit-first branch: commit wins task row lock, concurrent cancel queues and cannot overturn completed terminal state`<br>2. `verifies Cancel-first branch: cancel wins task row lock, commit receives CANCELLED, zero artifacts committed, and task converges to cancelled` |  否 (行级锁与触发器确定性拦截)  | 是 (分支 A 证明 commit 先获取锁后 cancel 无法颠覆终态且零 duplicate event；分支 B 证明 cancel 先写入后 commit 被坚决拒绝，零非法写入，Reaper/Worker 协同推进至 cancelled) | 是 (使用 PostgreSQL advisory lock 与行锁等待检测，两分支完全独立、可重复) | **已补齐并强化**：消除单次竞争的不确定性，双分支均有独立证据                                    |
| **B-T24**   | 安全隔离与 Artifact Root 越权防护                                 | `tests/integration/artifact-integrity.test.ts`<br>`tests/integration/http-artifact-api.test.ts`                                                                                                                                                                                                                                                    |               否                |                                                           是 (路径穿越 `../` 拦截、软链接越界拦截、跨租户 404)                                                            |                     是 (文件系统与 HTTP 边界双重断言)                     | **已覆盖**：租户隔离与文件系统边界完备                                                          |

---

## 3. 新增进程级与可靠性场景设计

### 3.1 架构与工具链：`worker-subprocess.ts`

为了安全、确定性地在 CI/本地运行真实 Worker 进程，实现了 `WorkerSubprocessHarness`：

- **进程启动**：以独立子进程执行 `node --import tsx apps/worker/src/index.ts`，工作目录设为 `apps/worker`。
- **环境隔离**：注入 `DATABASE_URL="${testDbUrl}?options=-csearch_path%3D${schema}"`，确保 Worker 子进程的所有连接无缝路由到当前测试的隔离 Schema，不干扰其他测试或系统表。
- **PID 严密受控**：仅通过显式获得的 `child.pid` 注入信号（`child.kill('SIGKILL')`），严禁使用全局 `pkill` 或 `killall`，杜绝误杀宿主进程。
- **优雅与强杀生命周期**：
  - `sigkill()`：直接发送 `SIGKILL`，等待 `exit` 事件；
  - `sigterm()`：发送 `SIGTERM`，带有 bounded timeout，超时自动升级为 `SIGKILL`；
  - `finally cleanup`：测试套件在 `afterEach`/`afterAll` 兜底清理所有存活子进程。

### 3.2 真实 SIGKILL 与自主恢复 (B-T26)

#### 场景 1：多步骤执行中途强杀与断点续传

1. **断点注入与精准暂停**：
   - 任务包含两步：`produce` (产生 `data.txt`) 与 `publish` (汇总输出)。
   - 在测试 Schema 中安装 PostgreSQL 触发器：当向 `step_checkpoints` 插入 `step_id = 'publish'` 时，触发器调用 `pg_advisory_lock(998877)`。
   - 测试主线程预先持有该 advisory lock。因此 Worker 1 成功完成 `produce` 步骤并提交 checkpoint 后，在开始提交 `publish` 时自动挂起在锁等待队列中。
2. **零竞态强杀 (SIGKILL)**：
   - 测试通过轮询 `pg_locks` 确认 Worker 1 处于等待状态（`NOT granted`）。
   - 确认数据库中已存在 `produce` 的 checkpoint 记录。
   - 对 Worker 1 的 PID 执行 `sigkill()`，子进程立即暴毙（退出码 `null`，信号 `SIGKILL`）。
   - 释放测试端持有的 advisory lock，清理挂起触发器。
3. **租约收敛与自主恢复 (Worker 2)**：
   - 启动 Worker 2（新 OS 子进程）与快速 Reaper。
   - Worker 1 死亡后租约到期，Reaper 自动将任务标记为可重试并重新入队。
   - Worker 2 竞争获得任务租约，执行 `durable-run-handler`。
   - **核心断言**：Worker 2 检查 `step_checkpoints` 发现 `produce` 步骤已存在，**跳过 `produce` 步骤的重新执行**，直接从 checkpoint 读取输出，仅执行未完成的 `publish` 步骤。
   - 任务最终状态达到 `completed`。

#### 场景 2：首个 Checkpoint 提交前强杀与干净回滚

- 在 Worker 1 刚启动执行、尚未提交任何 checkpoint 时对其执行 `SIGKILL`。
- 确认数据库中没有任何残存的 step_checkpoints。
- Worker 2 启动接管，完整按序执行 `produce` 与 `publish` 两步，成功达到终态。

#### 场景 3：独立 Reaper 进程跨进程收敛

- 启动一个仅开启 Reaper 模式的独立子进程 (`mode: 'reaper-only'`)。
- 模拟执行 Worker 突然断电崩溃。
- Reaper 进程独立通过定时扫描 `tasks` 表，发现过期的 `lease_expires_at`，自主调用收敛逻辑将其置为 `retryable_failed` 并安排下次重试。

### 3.3 并发取消与终态提交确定性双分支竞争 (B-T27)

针对 CTO Review 提出的单次并发 race 无法保证两个获胜路径均被覆盖的问题，通过 PostgreSQL 咨询锁与行级锁等待机制，分别构建了两个**完全确定性、可独立重复验证**的分支用例：

#### 分支 A：Commit-First 确定性路径

- **机制**：在 `artifacts` 插入前设置 Advisory Lock 触发器。`committer.commitStep` 首先获取 `tasks` 行的 `FOR UPDATE` 排他锁，在插入 artifact 时进入触发器等待。
- **并发到达**：随后发起 `tasks.cancel`，由于 `tasks` 行锁已被占用，cancel 请求必然在 PostgreSQL 内核中排队等待行锁释放。
- **释放与收敛**：释放 Advisory Lock，`commitStep` 完成事务提交（状态置为 `completed` 并写入 terminal event）。随后 `tasks.cancel` 获得行锁，感知到任务已处于终态，返回 `terminal: true, status: 'completed'`，零覆盖、不追加任何事件。
- **不变量**：Task 终态严格为 `completed`，审计事件中 terminal event 严格为 1 条（`completed`），绝无 `cancelled` 事件。

#### 分支 B：Cancel-First 确定性路径

- **机制**：在 `tasks` 表更新 `cancel_requested_at` 之后设置 Advisory Lock 触发器。`tasks.cancel` 首先获取 `tasks` 行排他锁并记录取消意图，随后在触发器处暂停。
- **并发到达**：并发发起 `committer.commitStep`，被排队阻塞在 `tasks` 行锁上。
- **释放与拦截**：释放 Advisory Lock，`tasks.cancel` 提交事务。`commitStep` 获得行锁后，在执行前检查检测到 `task.cancel_requested_at !== null`，坚决抛出 `DomainError('CANCELLED')`，事务完整回滚。
- **不变量与零污染**：`artifacts` 表中该任务的产物记录为 0（零非法写入）。Worker 捕获 `CANCELLED` 后协同调用 `queue.finish('cancelled')`，最终 Task 终态严格为 `cancelled`，terminal event 严格为 1 条（`cancelled`），绝无 `completed` 事件。

---

## 4. B-T24～27 验收结果与执行证据

| 编号        | 测试用例全名                                                         | 测试文件路径                                                                                    | 判定结果 | 验证方式                                                                   | 剩余风险与说明                     |
| :---------- | :------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- | :------: | :------------------------------------------------------------------------- | :--------------------------------- |
| **B-T24**   | Artifact traversal, symlink, cross-tenant isolation                  | `tests/integration/artifact-integrity.test.ts`<br>`tests/integration/http-artifact-api.test.ts` | **PASS** | 实际运行 19 + 7 项断言，覆盖 `../` 越界、绝对路径绕过、跨租户隔离          | 无。内核基于规范化根目录与受限沙箱 |
| **B-T25**   | Durable Ack, uncommitted abort, idempotency key replay               | `tests/chaos/b-t25-durable-ack-crash.test.ts`                                                   | **PASS** | 实际运行 6 项混沌断言，终止事务与连接断开                                  | 无。PostgreSQL WAL 事务保证原子性  |
| **B-T26**   | Real OS Worker Process SIGKILL & Autonomous Recovery                 | `tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts`                                     | **PASS** | **真实子进程 SIGKILL 强杀** (3 项)，断点恢复与 Reaper 收敛                 | 无。依赖数据库级锁屏障，无时间竞争 |
| **B-T26-A** | Uncommitted Blob Orphan & Step Checkpoint Isolation                  | `tests/chaos/b-t26-artifact-checkpoint-atomic.test.ts`                                          | **PASS** | 实际运行 9 项断言，验证孤立文件隔离与幂等覆盖                              | 无。本地 Blob 存储校验完整         |
| **B-T27**   | Old Run vs New Run Interleaving, Fencing & Cancel/Commit Dual Branch | `tests/chaos/b-t27-lease-fencing-concurrency.test.ts`                                           | **PASS** | 实际运行 6 项断言 (包含 Commit-first 与 Cancel-first 确定性双分支竞态测试) | 无。Epoch 乐观锁与 Advisory 锁保障 |

---

## 5. 状态机与数据库不变量对账证明 (Reconciliation & Invariants)

在真实 OS 进程 `SIGKILL` 强杀并重启恢复后的数据库对账结果如下：

### 5.1 Task 状态变迁链路

```text
Task: [accepted] (run 1, epoch 1)
   │
   ▼
[leased] -> [started] -> [progress (produce checkpoint committed)]
   │
   💥 (Worker 1 OS Process PID SIGKILLed)
   │
   ▼ (Lease expires in DB)
[retry_scheduled] (Task marked retryable_failed by Reaper)
   │
   ▼ (Worker 2 OS Process claims task)
[retry_scheduled] -> [leased] (run 2, epoch 2) -> [started]
   │
   ▼ (Produce step SKIPPED because checkpoint exists)
[progress (publish executed)]
   │
   ▼
[completed] (Final Terminal State)
```

### 5.2 数据库对账数据证据

1. **Task 表记录**：
   - `status`: `'completed'`
   - `failure_count`: `1` (真实记录了一次 Worker 崩溃引发的重试)
   - `current_run_id`: 指向 Run 2
   - `lease_owner`: 指向 Worker 2 标识

2. **Step Checkpoints 表记录**：
   - `produce`: 仅有一条记录，`completed_at` 时间戳为 Worker 1 提交时的原始时间戳，Run 2 未覆写该记录。
   - `publish`: 仅有一条记录，由 Worker 2 提交。
   - 记录总数严格等于 2，证明已提交步骤绝无重复执行。

3. **Events 审计事件表**：
   - 完整事件链：
     `['accepted', 'leased', 'started', 'progress', 'retry_scheduled', 'retry_scheduled', 'leased', 'started', 'completed']`
   - 严格单调递增，无事件乱序或非法跃迁。
   - 终端事件（`phase = 'completed'`）严格为 1 条。

4. **Workspace CAS 与目录不变量**：
   - Worker 1 写入的阶段产物未损坏，Worker 2 在相同的 Workspace 路径上无冲突继续执行。

---

## 6. 全量测试与重复稳定性验证

### 6.1 代码质量门禁

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && git diff --check
```

- `eslint`: PASS (0 警告, 0 错误)
- `prettier --check`: PASS (All matched files use Prettier code style)
- `tsc -p tsconfig.json`: PASS (TypeScript 无类型错误)
- `tsc -b tsconfig.build.json`: PASS (全工程构建输出干净)
- `git diff --check`: PASS (无多余空白字符或合并冲突标记)

### 6.2 测试套件全量执行结果

| 测试套件类型          | 执行命令                | 测试文件数 | 通过测试数 |  耗时  |                    结果                     |
| :-------------------- | :---------------------- | :--------: | :--------: | :----: | :-----------------------------------------: |
| **GitHub Actions CI** | CI Workflow (PR #25)    |    全部    |  全量通过  | 1m45s  |   **PASS (Node 24 LTS + PostgreSQL 17)**    |
| **Unit Tests**        | `pnpm test:unit`        |     43     | 670 / 670  | 1.76s  |                **100% PASS**                |
| **Integration Tests** | `pnpm test:integration` |     24     | 251 / 251  | 4.60s  |                **100% PASS**                |
| **Chaos Tests**       | `pnpm test:chaos`       |     4      |  24 / 24   | 10.18s |                **100% PASS**                |
| **E2E Tests**         | `pnpm test:e2e`         |     -      |     -      |   -    | **NOT AVAILABLE ON BASE** (由 Agent A 负责) |

### 6.3 真实 SIGKILL 恢复用例 5 轮连续重复验证

针对新增的真实进程崩溃测试 `tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts` 进行 5 轮连续独立运行，检验抗偶发（flakiness）能力与时钟鲁棒性：

```bash
for i in {1..5}; do node --env-file-if-exists=.env.local ./node_modules/vitest/vitest.mjs run tests/chaos/b-t26-worker-process-sigkill-recovery.test.ts --config vitest.chaos.config.ts; done
```

|      轮次       | 测试数 | 通过数 | 失败数 |    执行耗时    |        测试套件状态         |
| :-------------: | :----: | :----: | :----: | :------------: | :-------------------------: |
| **Iteration 1** |   3    |   3    |   0    |     9.03s      |          **PASS**           |
| **Iteration 2** |   3    |   3    |   0    |     8.89s      |          **PASS**           |
| **Iteration 3** |   3    |   3    |   0    |     8.83s      |          **PASS**           |
| **Iteration 4** |   3    |   3    |   0    |     8.76s      |          **PASS**           |
| **Iteration 5** |   3    |   3    |   0    |     8.95s      |          **PASS**           |
|  **汇总统计**   | **15** | **15** | **0**  | **平均 8.89s** | **100.0% 通过率 (0 Flake)** |

### 6.4 B-T27 确定性双分支竞态用例 5 轮连续重复验证

针对 B-T27 中强化的 Commit-first 与 Cancel-first 双分支确定性同步用例进行 5 轮连续独立运行：

```bash
for i in {1..5}; do node --env-file-if-exists=.env.local ./node_modules/vitest/vitest.mjs run tests/chaos/b-t27-lease-fencing-concurrency.test.ts --config vitest.chaos.config.ts; done
```

|      轮次       | 测试数 | 通过数 | 失败数 |    执行耗时    |        测试套件状态         |
| :-------------: | :----: | :----: | :----: | :------------: | :-------------------------: |
| **Iteration 1** |   6    |   6    |   0    |     0.77s      |          **PASS**           |
| **Iteration 2** |   6    |   6    |   0    |     0.82s      |          **PASS**           |
| **Iteration 3** |   6    |   6    |   0    |     0.74s      |          **PASS**           |
| **Iteration 4** |   6    |   6    |   0    |     0.75s      |          **PASS**           |
| **Iteration 5** |   6    |   6    |   0    |     0.78s      |          **PASS**           |
|  **汇总统计**   | **30** | **30** | **0**  | **平均 0.77s** | **100.0% 通过率 (0 Flake)** |

---

## 7. 跨边界影响、已知缺口与回滚风险

### 7.1 跨边界代码分析

- **生产代码影响**：本次交付修改的生产代码量为 **0**。所有改动严格限制在 `tests/chaos/**`、`tests/integration/**` 内部及相关测试 fixture 中。
- **与 Agent A / C 并行碰撞风险**：零。未修改 `apps/api/**`、`apps/worker/**`、`packages/**` 的导出 API，未修改根目录构建脚本，未引入任何外部 npm 依赖包。

### 7.2 已知边界与架构说明

1. **真实进程与执行器模型**：
   - Ember P0-B 当前垂直切片中 Worker 进程运行在基于 TypeScript 的轮询循环中，执行的是 DeterministicExecutor / FakeLLM / FakeSandbox。
   - 本次测试验证的是**真实的 Node.js Worker 操作系统进程 (PID)** 被操作系统直接内核强杀 (`kill -9`) 后的状态机一致性与断点自愈。
2. **时钟截断修复 (Microsecond Clocks)**：
   - PostgreSQL 内部 `now()` 具有微秒级精度（`6` 位小数），而 JavaScript `Date` 仅支持毫秒级精度（`3` 位小数）。
   - 在高并发混沌测试中，毫秒对齐可能导致 `claimNext` 的 `WHERE next_run_at <= now` 偶发因微秒之差过滤。测试 harness 中通过给测试基准时间微调 +5ms～+10ms，彻底消除了偶发跳过，未破坏任何生产逻辑。

### 7.3 回滚策略

本分支所有改动集中于 `feature/p0b-10b-process-recovery`。若需要回滚，直接撤销相关提交或关闭 PR 即可，对主分支及其他功能分支没有任何残留副作用。
