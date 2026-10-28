# P0B-04 — 验收报告（Durable Lease / Fencing / Bounded Retry）

> 本文件只记录**实际执行过**的命令与结果。未执行项明确标记 `NOT RUN` / `BLOCKED`。
> 本 PR **不**声称 Agent 业务执行、真实进度、自动 Resume、Artifact/Checkpoint、HTTP API、
> SSE、审批或预算已完成。
> 结论以真实 PostgreSQL 17 的 B-T09 / B-T10 / B-T11 / OQ-1 测试为准，不使用内存 Mock DB
> 代替并发证据。

## 1. 执行环境

| 项目       | 值                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 日期       | 2026-10-28（本地时区 UTC+9）                                                                                  |
| OS         | macOS 26.3（Darwin 25D125，arm64）                                                                            |
| Node.js    | **v24.22.1 LTS**（与 `.nvmrc` 一致；系统默认 `node` 为 23.11.0，验收显式使用 24.22.1）                        |
| pnpm       | **12.15.0**（`packageManager` 固定）                                                                          |
| TypeScript | 5.9.3，`strict: true`，NodeNext ESM                                                                           |
| Zod        | 4.6.7                                                                                                         |
| Vitest     | 5.0.5                                                                                                         |
| PostgreSQL | **17.11**（Docker `postgres:17-alpine`，容器 `ember-local-postgres`）                                         |
| Docker     | Client/Server 29.0.1 + Compose v2                                                                             |
| Base       | `origin/main` @ `01ef99723134339daccf79db43765c68f8b00a7a`（P0B-03 merge）                                    |
| 分支       | `feature/p0b-04-durable-worker-lease`                                                                         |
| ADR 来源   | `origin/docs/adr-0001-cancellation-retry-coordination` @ `04dad2e`，原样引入（Prettier 表格对齐），未改写语义 |

本地测试数据库为 `ember_test`，每个集成测试文件创建自己的 `ember_it_<12 hex>` Schema；
没有对 `public` 或其他 Schema 执行 TRUNCATE/DROP。ESM smoke 使用独立
`ember_esm_<hex>` Schema 并只删除该 Schema。

## 2. 交付前仓库状态核验

| 检查                 | 命令 / 结果                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前分支             | `feature/p0b-04-durable-worker-lease`（从 `origin/main` @ `01ef997` 创建）                                                                                                                                                  |
| 远端 main            | 分支创建时 `origin/main` = `01ef99723134339daccf79db43765c68f8b00a7a`；Review Round 1 修复提交后合入最新 `origin/main` = `5c91a6f0ef361cb97efe7c95ba048016b25ccaad`（仅 ADR-0001 文档合并，无代码差异），合并提交 `9d16f53` |
| 用户未提交参考资料   | 6 个本地 Prompt/RFC Markdown 保持未跟踪，不纳入提交、不修改 `main`                                                                                                                                                          |
| P0B-01～03 Migration | `0001`～`0003` 未修改；新增 `0004_lease_fencing_and_retry.sql`                                                                                                                                                              |
| ADR                  | ADR-0001 来自 CTO 已批准远端分支，内容未改写；ADR-0002 为本轮新增（OQ-2 有条件批准）                                                                                                                                        |
| `main`               | 未修改、未合并、未强推                                                                                                                                                                                                      |

## 3. 验收命令与结果

所有命令在仓库根目录执行，使用 Node 24.22.1 + pnpm 12.15.0。

| #   | 命令                             | 实际结果                                                                                                        | 状态 |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `pnpm install --frozen-lockfile` | `Lockfile is up to date`，0 错误（lockfile 已包含 `apps/worker`）                                               | PASS |
| 2   | `pnpm lint`                      | `eslint .` 退出码 0                                                                                             | PASS |
| 3   | `pnpm format:check`              | `All matched files use Prettier code style!`                                                                    | PASS |
| 4   | `pnpm typecheck`                 | `tsc -p tsconfig.json` 退出码 0（strict，包含 queue、worker、全部测试）                                         | PASS |
| 5   | `pnpm test:unit`                 | **11 个文件 / 265 个测试通过**（P0B-03 的 249 + P0B-04 新增 16）                                                | PASS |
| 6   | `pnpm build`                     | `tsc -b tsconfig.build.json` 退出码 0；生成 `packages/postgres/dist` 与 `apps/worker/dist`                      | PASS |
| 7   | `pnpm dev:db`                    | `ember-local-postgres` Running/Healthy                                                                          | PASS |
| 8   | `pnpm db:migrate`（0004 首次）   | `applied migration 0004_lease_fencing_and_retry.sql in 42ms`；`1 applied, 3 already applied`                    | PASS |
| 9   | `pnpm db:migrate`（重复两次）    | `0 applied, 4 already applied`；重复迁移零变更                                                                  | PASS |
| 10  | `pnpm test:integration`          | **7 个文件 / 72 个测试通过**（真实 PostgreSQL 17；P0B-03 32 个回归 + P0B-04 40 个）                             | PASS |
| 11  | `git diff --check`               | 无 whitespace 错误                                                                                              | PASS |
| 12  | 构建后 ESM 消费                  | `node` 直接导入 `packages/postgres/dist/index.js`，Claim/Heartbeat/Finish 成功（见 3.3）                        | PASS |
| 13  | Worker 进程 smoke                | `reaper-only` 启动、SIGTERM 优雅关闭；`poll` 模式明确拒绝（见 3.4）                                             | PASS |
| 14  | GitHub Actions                   | run [40647395247](https://github.com/basicv8vc/Ember/actions/runs/40647395247) — success（代码 HEAD `9d16f53`） | PASS |
| 15  | Draft PR                         | [#5](https://github.com/basicv8vc/Ember/pull/5)，Draft/Open，base `main`，未合并                                | PASS |

> 本地默认 Node 23.11.0 不满足 `engines >=24 <25`；验收显式使用 Node 24.22.1。
> 没有通过降低 `engines`、关闭 strict、删除测试或使用 `--ignore-engines` 获得通过。

### 3.1 单元测试实际输出

```text
$ pnpm test:unit

 Test Files  11 passed (11)
      Tests  265 passed (265)
   Duration  572ms
```

P0B-04 新增/更新的单元覆盖：

- `tests/unit/task-state-machine.test.ts`：完整 7×7 矩阵；`retryable_failed → cancelled`
  （ADR-0001）与 `queued → failed`（ADR-0002）正向边；其余边、快捷边、同状态赋值继续拒绝。
- `tests/unit/lease-queue-policy.test.ts`（11 个）：
  - `min(cap, base × 2^(n-1))`、attempt 非法值、attempt/deadline 预算；
  - Lease/Retry/Batch 默认值与非法上下界、Heartbeat 必须严格短于 Lease；
  - WorkerId 字符集/长度、LeasedRun 严格结构、Terminal outcome；
  - `bigint` Epoch 安全整数解析、溢出失败、Epoch 上限分配失败。
- `tests/unit/worker-loop.test.ts`（4 个）：
  - reaper-only 默认配置；非法 WorkerId/Mode/Heartbeat；
  - 可停止 Reaper 循环；数据库错误固定 `DB_UNAVAILABLE` 记录且不输出注入文本；
  - 长 sleep 可在 AbortSignal 下立即结束。

### 3.2 集成测试实际输出

```text
$ pnpm test:integration

 Test Files  7 passed (7)
      Tests  72 passed (72)
   Duration  1.92s
```

| 文件                                           | 测试数 | 覆盖                                                                                        |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `tests/integration/lease-claim.test.ts`        | 9      | B-T09：双 Pool、24 并发、16 并行跨 Tenant、Event/COMMIT 回滚、Epoch 安全、活跃 Run 唯一索引 |
| `tests/integration/lease-recovery.test.ts`     | 12     | B-T10 + P1-1：崩溃、双 Reaper、重启、预算耗尽、重试中间态持久化、Event 审计、Claim 原子回滚 |
| `tests/integration/lease-fencing.test.ts`      | 10     | B-T11 + P1-2/P1-3：Fencing、迟到结果、缺失 Run Lease、锁等待期间过期与仍有效的正向对照      |
| `tests/integration/cancellation-retry.test.ts` | 9      | OQ-1：queued/retryable/approval/running/终态、Reaper、Cancel vs Claim/Retry、错误脱敏       |
| `tests/integration/durable-task-inbox.test.ts` | 19     | P0B-03 回归 + ADR-0001 queued cancel                                                        |
| `tests/integration/task-idempotency.test.ts`   | 6      | P0B-03 24 并发幂等 / B-T08 回归                                                             |
| `tests/integration/migrations.test.ts`         | 7      | `0001`–`0004` 全新 Schema、重复迁移、改名/checksum 拒绝                                     |

### 3.3 构建产物 ESM 消费

```text
$ node --env-file-if-exists=.env.local /tmp/ember-p0b04-esm-smoke.mjs
{
  "appliedMigrations": ["0001", "0002", "0003", "0004"],
  "leased": true,
  "attempt": 1,
  "leaseEpoch": 1,
  "heartbeated": true,
  "finished": true,
  "finalTaskStatus": "completed",
  "eventPhases": ["accepted", "leased", "started", "completed"],
  "configuration": {
    "baseDelayMs": 1000,
    "capDelayMs": 30000,
    "leaseDurationMs": 30000,
    "heartbeatIntervalMs": 10000,
    "reaperBatchSize": 5
  }
}
```

该脚本直接导入 `packages/postgres/dist/index.js`（不是 Vitest alias），在
`ember_esm_<hex>` 临时 Schema 中执行真实 Migration、Agent/Task 创建、Claim、Heartbeat、
Finish 与 Event 读取；结束后只删除该临时 Schema。

### 3.4 Worker 进程 smoke

```text
$ EMBER_WORKER_MODE=reaper-only EMBER_WORKER_ID=smoke-reaper \
  EMBER_WORKER_INTERVAL_MS=200 node --env-file-if-exists=.env.local apps/worker/dist/index.js
{"level":"info","message":"worker starting","mode":"reaper-only","workerId":"smoke-reaper",
 "database":{"host":"127.0.0.1","port":55432,"database":"ember"}, ...}
# SIGTERM
{"level":"info","message":"worker stopping","signal":"SIGTERM"}
{"level":"info","message":"worker stopped","workerId":"smoke-reaper"}
exit=0

$ EMBER_WORKER_MODE=poll node --env-file-if-exists=.env.local apps/worker/dist/index.js
worker failed: poll mode requires the P0B-05 execution router and a real RunHandler;
the production worker refuses to claim Tasks without one
exit=1
```

证明生产入口只运行 Reaper，不会在没有 P0B-05 Executor 时 Claim 或伪造 Task 成功。

## 4. B-T09 — 双 Worker Claim 证据

`tests/integration/lease-claim.test.ts` 在真实 PostgreSQL 中实际断言：

1. **两个独立 Pool**：主 Pool 与 observer Pool 的 `pg_backend_pid()` 不同。
2. **双 Worker 同 Task**：`queueA.claimNext('worker-a')` 与 `queueB.claimNext('worker-b')`
   同时执行，结果只有 1 个 `LeasedRun`；Task=`running`、`attempt_count=1`、
   `lease_epoch=1`、`current_run_id` 指向唯一 Run；`runs` 行数=1；
   Event=`accepted → leased → started`，sequence=`1,2,3`。
3. **24 并发压力**：同 Task 24 个独立 `claimNext` 调用，恰好 1 个成功；
   `runs` 行数=1，`running` Run 数=1，Task 只推进一次 attempt/epoch。
4. **16 并行跨 Tenant**：Tenant A/B 各 8 个 Task，共 32 个 Claim，16 个成功；
   16 个 RunId/TaskId 互不重复；每个 Run 都指向正确 Tenant/Task，`current_run_id`、
   `lease_epoch` 与 Run 一致；两租户各 8 个 `running` Run。
5. **Event 写入失败**：注入 `leased` Event 触发器异常，`claimNext` 返回
   `DB_UNAVAILABLE`；Task 仍 `queued`、attempt=0、epoch=0、`current_run_id=NULL`、
   `runs`=0、Event 只有 `accepted`。移除触发器后同一 Task 可成功领取。
6. **COMMIT 失败**：`AFTER INSERT ON runs DEFERRABLE INITIALLY DEFERRED` 触发器在
   COMMIT 抛错，`claimNext` 返回 `DB_UNAVAILABLE`；Task/Run 均未持久化，重试成功。
7. **非法输入**：空/超长/含空格/换行 WorkerId 与非法 `now` 均返回
   `InvalidArgumentError`，Task 状态不变。
8. **数据库唯一兜底**：`runs_one_active_per_task_idx` 存在；直接 SQL 插入第二个
   `running` Run 被 PostgreSQL `23505` 拒绝。
9. **Epoch 安全边界**：直接 SQL 写 `9007199254740992` 到 Task/Run `lease_epoch` 均被
   `23514` 拒绝。

## 5. B-T10 — Lease 超时、Crash/Restart 与 Retry 证据

`tests/integration/lease-recovery.test.ts` 实际断言：

| 场景                                    | 实际结果 / SQL 行状态                                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim 后不 Heartbeat/Finish             | 推进时钟到 `lease_expires_at`；Reaper 返回 1；旧 Run=`lease_expired`、`finished_at` 非空、`leased_until=NULL`；Task=`retryable_failed`、`lease_expires_at=NULL`、`next_run_at=reapedAt+baseDelay`                                                          |
| Backoff 未到                            | 同 `next_run_at` 时刻之前 Claim 返回 `null`                                                                                                                                                                                                                |
| Backoff 到期                            | 同一 Task 领取 **新 Run**：`attempt=2`、`lease_epoch=2`、新 RunId；`runs`=2，旧 Run 仍 `lease_expired`，新 Run=`running`                                                                                                                                   |
| 两个独立 Reaper 同时回收                | 目标 Run 只终结一次；`retry_scheduled` Event 恰好 1 条                                                                                                                                                                                                     |
| 新 Pool / 新 Queue 实例重启             | 仍能回收旧 Lease；Task 进入 `retryable_failed` 或 `failed`，不依赖 Worker 内存                                                                                                                                                                             |
| `max_attempts=1` 用尽                   | 旧 Run=`lease_expired`；Task=`failed`；Event 末尾 `failed`，无 `retry_scheduled`                                                                                                                                                                           |
| Claim 前已过 Deadline（ADR-0002）       | Claim 返回 `null`；Task=`queued → failed`；`attempt_count=0`；无 Run；Event `failed` + `DEADLINE_EXCEEDED`                                                                                                                                                 |
| Claim 前预算已耗尽（ADR-0002）          | Claim 返回 `null`；Task=`queued → failed`；`attempt_count=max_attempts` 不递增；`lease_epoch=0`；无 Run；Event `failed`，无伪造 errorCode                                                                                                                  |
| 重试领取的真实数据库转换（P1-1）        | 审计触发器记录 `queued→running`、`running→retryable_failed`、`retryable_failed→queued`、`queued→running` 四次 `tasks` 行更新；Event 序列为 `accepted, leased, started, retry_scheduled, retry_scheduled, leased, started`，`leased` 的 `fromStatus=queued` |
| 重试领取中途失败回滚（P1-1）            | 注入第二次 `leased` Event 失败后 Claim 抛 `DB_UNAVAILABLE`；Task 仍 `retryable_failed`、`attempt_count=1`、`lease_epoch=1`、`current_run_id` 不变；无新 Run、无 promotion Event、无状态快照变化                                                            |
| running 时 Deadline 到期                | Heartbeat 返回 `false`；Reaper 将 Run=`failed_terminal`、Task=`failed`；Event `failed` + `DEADLINE_EXCEEDED`                                                                                                                                               |
| Finish `failed_retryable` + 近 Deadline | Task=`failed`（不安排必然超期的 retry）；Run=`failed_retryable`；Event `failed` + `DEADLINE_EXCEEDED`                                                                                                                                                      |
| 孤儿 running Task（无 current Run）     | Reaper 整批回滚并抛固定 `DB_UNAVAILABLE`；Task 仍 `running`，无新 Event                                                                                                                                                                                    |
| 数据库不可达 / 非法时钟                 | 固定 `DB_UNAVAILABLE` / `InvalidArgumentError`；不吞错、不忙等、不返回假结果                                                                                                                                                                               |

## 6. B-T11 — Fencing 与迟到结果证据

`tests/integration/lease-fencing.test.ts` 实际断言：

1. **旧 Run 在新 Run 后迟到**：旧 Run 的 `heartbeat`、`finish(succeeded)`、
   `finish(failed_retryable)` 全部返回 `false`；Task/新 Run/Event/时间戳快照完全不变。
2. **仅 RunId 正确、Epoch 错误**：返回 `false`，持久状态不变。
3. **仅 Epoch 正确、RunId 错误**：返回 `false`，持久状态不变。
4. **跨 Tenant 引用**：伪造 Tenant 后 `heartbeat`/`finish` 返回 `false`；两个 Tenant 的
   Task/Run/Event 快照均不变。
5. **恰好到期但 Reaper 尚未处理**：`heartbeat` 和 `finish` 返回 `false`；随后 Reaper 才能
   把 Run 终结为 `lease_expired`，旧 Worker 之后仍不能完成。
6. **同 Run 重复 Finish**：首次 `finish(succeeded)` 返回 `true`；再次 `finish` 返回
   `false`；Task/Run/Event 快照不变；`completed` Event 恰好 1 条。
7. **终态不可复活**：完成后 Reaper 运行，Run 仍 `succeeded`、Task 仍 `completed`；
   `claimNext` 返回 `null`。
8. **Reaper-only outcome**：Worker 调用 `finish(..., 'lease_expired')` 被
   `InvalidArgumentError` 拒绝，状态不变。
9. **DB 错误不被伪装成 false**：不可达 Pool 上 `finish` 抛 `DB_UNAVAILABLE`。
10. **Run Lease Expiry 缺失（P1-2 负向）**：直接 SQL 将 `runs.leased_until` 置 `NULL`；
    `finish(succeeded)` 返回 `false`；Task/Run/Event 快照完全不变，Run 仍 `running`。
11. **锁等待期间 Lease 到期（P1-3 Heartbeat）**：调用方以有效租约发起 Heartbeat，独立连接
    持有 Task 行锁；`pg_blocking_pids` 确认其造成阻塞后推进时钟到期并释放锁；返回 `false`，
    状态快照不变。
12. **锁等待期间 Lease 到期（P1-3 Finish）**：同一构造下 `finish(succeeded)` 返回 `false`，
    不产生 `completed` Event / Task 终态 / `leased_until` 变化。
13. **正向对照**：锁等待期间租约仍有效时，Heartbeat 返回 `true` 并按锁后时间续租，随后
    Finish 成功，证明重新采样没有误拒有效租约。

## 7. OQ-1 — 取消与重试竞争证据

`tests/integration/cancellation-retry.test.ts` 实际断言：

- `queued` 取消：Task 直接 `cancelled`，写入首次 `cancel_requested_at`，只写 1 个
  `cancelled` Event；重复取消保持首次时间戳与 `updated_at`；`claimNext` 返回 `null`。
- `retryable_failed` 取消：直接 `cancelled`（ADR-0001 新边），不先 `queued`、不创建新 Run；
  即使原 backoff 时刻到达，`claimNext` 仍返回 `null`。
- `waiting_approval` 取消：直接 `cancelled`，`fromStatus=waiting_approval`。
- `running` 取消：Task 保持 `running` 并记录意图；重复取消不覆盖时间；Heartbeat 返回
  `false`；有效 Finish(`succeeded`) 被取消优先规则覆盖为 Run/Task=`cancelled`；
  只写 1 个 `cancelled` Event，无 `completed`。
- `running` 取消后租约过期：Reaper 得到 Run=`lease_expired`、Task=`cancelled`，无重试。
- 已 `completed` 后取消：Task/时间戳/Event 完全不变，`cancel_requested_at` 保持 `NULL`。
- **Cancel vs Claim 8 轮并发**：每轮要么 Task=`cancelled` 且 0 Run；要么 Claim 先赢、
  Task=`running` + 取消意图 + 1 Run，随后有效 Finish 仍收敛为 `cancelled`。
  每轮 `cancelled` Event 恰好 1 条。
- **Cancel vs 到期 Retry 并发**：要么取消先赢且只有旧 `failed_retryable` Run；要么
  Claim 先赢创建新 Run，但 Task 带取消意图、Heartbeat 返回 `false`。两种情况都不会在
  取消后再创建 Run。
- 跨 Tenant 取消返回固定 `NOT_FOUND` DTO，不含 SQL、Task 输入或内部诊断。

## 8. P0B-03 回归证据

- B-T06 Durable Ack、Event/COMMIT 注入失败回滚、丢失 ACK 重放：通过。
- B-T07 24 并发同 Key 幂等：通过；B-T08 kind/input/agent/deadline 冲突：通过。
- Tenant-safe 复合 FK、`current_run_id` 正反例、Event sequence/白名单、Migration
  checksum/rename 保护：通过。
- P0B-03 的 `requestCancel` 单元/集成测试按 ADR-0001 更新为原子取消；历史验收文档未改写。
- 全量集成测试仍为真实 PostgreSQL 17，不使用 Fake DB。

## 9. Migration / 索引 / EXPLAIN 简单验证

- 全新临时 Schema 依次应用 `0001` + `0002` + `0003` + `0004` 成功；
- 重复 `pnpm db:migrate` 为 `0 applied, 4 already applied`；
- `0001`～`0003` 未被编辑；改名/checksum 篡改继续被拒绝；
- 新增：
  - `tasks_lease_epoch_safe_int_check`、`runs_lease_epoch_safe_int_check`；
  - `runs_one_active_per_task_idx`（部分唯一）；
  - `tasks_claim_order_idx`、`tasks_deadline_open_idx`。
- 在 `ember_explain_<hex>` 临时 Schema 中插入 2,000 个 Task（含 queued、retryable_failed、
  running 及过期 lease）并 `ANALYZE`，实际 `EXPLAIN (COSTS OFF)`：

```text
Claim:
Limit
  -> LockRows
      -> Sort (next_run_at, created_at, id)
          -> Index Scan using tasks_claim_order_idx on tasks
              Index Cond: ((status = ANY ('{queued,retryable_failed}'::text[]))
                           AND (next_run_at <= now()))

Reaper:
Limit
  -> LockRows
      -> Sort (lease_expires_at, id)
          -> Bitmap Heap Scan on tasks
              -> BitmapOr
                  -> Bitmap Index Scan on tasks_lease_expiry_idx
                  -> Bitmap Index Scan on tasks_deadline_open_idx
```

证明 Claim 使用 `(status, next_run_at, created_at, id)`，Reaper 使用
`lease_expires_at` 与 deadline 索引。本阶段不做吞吐承诺。

## 10. CTO Review Round 1 修复证据

CTO 结论为 **Changes Requested**。本轮在同一个 Draft PR 分支内逐项修复，未强推、未改
`main`、未合并 PR、未修改 `0001`–`0003` Migration。逐项说明：

| 项       | 结论           | 代码位置                                                                                          | 修复要点                                                                                                                                                                 | 测试证据                                                                                                     |
| -------- | -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **P1-1** | 已修复         | `packages/postgres/src/lease-queue/postgres-lease-queue.ts`：`PROMOTE_RETRY_SQL`、`createLease()` | 生产路径先经 Domain FSM `retryable_failed → queued`，再用状态守卫 SQL 持久化 `queued`，追加 `retry_scheduled` Event，再 `queued → running`；全部同一事务、同一 Task 行锁 | `lease-recovery.test.ts`：审计触发器断言四次真实行更新；完整 Event 序列/payload；注入 Event 失败验证整体回滚 |
| **P1-2** | 已修复         | 同文件 `finish()`：`runRow.leased_until === null` 分支                                            | `leased_until IS NULL` 立即 `false`，不更新 Run/Task、不追加 Event                                                                                                       | `lease-fencing.test.ts`：Run Lease 缺失负向测试（快照完全不变）                                              |
| **P1-3** | 已修复         | 同文件 `sampleAfterLock()`、`heartbeat()`、`renewLease()`、`finish()`                             | 仅在取得 Task **与** Run 行锁后采样时钟；Heartbeat 取调用方时间与锁后时间的较晚者；Finish 锁后采样；所有租约/Deadline 判断使用锁后时间                                   | `lease-fencing.test.ts`：Heartbeat/Finish 锁等待期间到期 → `false`；租约仍有效 → `true` 正向对照             |
| **OQ-2** | 有条件批准落地 | `docs/adr/0002-preclaim-deadline-failure.md`；`packages/domain/src/task-state-machine.ts`         | ADR-0002 明确适用条件（Deadline 已过 / 预算耗尽）、取消优先、唯一 `failed` Event、禁止虚构 Run/直达边；Claim 与 Reaper 均按条件执行                                      | `lease-recovery.test.ts`：Deadline 与预算耗尽两条收敛路径；`cancellation-retry.test.ts` 取消优先级           |

**Domain 状态机未被绕过：** `transitionTask()` 仍是唯一转换入口；`PROMOTE_RETRY_SQL` 的
`WHERE status = 'retryable_failed'` 只是持久化层对同一前态的二次确认，不构成新边。

**Migration：** 本轮未新增或修改 Migration；`0001`–`0003` checksum 不变，`0004` 未变。

**Git：** 修复提交（`a689e1b`、`6f7fd01`）后合入最新 `origin/main`（`5c91a6f`，仅
ADR-0001 文档合并），合并提交 `9d16f53`，无代码差异；未强推。

**测试有效性：** 逐个临时回退修复后，对应测试均按预期失败（P1-1 数据库审计断言、
P1-2 缺失 Run Lease 断言、P1-3 Heartbeat/Finish 锁后采样断言），恢复修复后全部通过，
证明这些测试不是恒真断言。

## 11. GitHub Actions / Draft PR

| 项目                 | 值                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| 分支                 | `feature/p0b-04-durable-worker-lease`                                                                       |
| Base SHA             | 分支基线 `01ef997`；当前 PR base ref `5c91a6f`（仅 ADR merge，PR `mergeable: MERGEABLE` / `CLEAN`）         |
| 代码 HEAD            | `9d16f5375e1b3860d1772d2c164d0c04f6dc9708`（含 Review Round 1 修复与 `origin/main` 合并）                   |
| Draft PR             | [#5](https://github.com/basicv8vc/Ember/pull/5)（`isDraft: true`，`state: OPEN`，base `main`）              |
| CI 运行（代码 HEAD） | [40647395247](https://github.com/basicv8vc/Ember/actions/runs/40647395247) — success                        |
| CI 日志核对          | unit `265 passed`；integration `72 passed`；migration 首次 `4 applied`，重复 `0 applied, 4 already applied` |
| `main` 状态          | 未修改、未合并、未强推                                                                                      |
| 强制推送 / 自动合并  | 无                                                                                                          |
| 修改保护规则 / 部署  | 无                                                                                                          |

CI 工作流未修改：仍为 `permissions: contents: read`、临时 `postgres:17-alpine` service
container、无 secrets、无付费云、无部署。

## 12. 安全与成本

- 没有使用真实 API Key、OAuth Token、生产数据或付费云服务。
- 没有调用 LLM、Sandbox Provider 或外部收费 API。
- Worker 只运行 Reaper；没有生产假执行器、Shell/Python/Playwright 或云 Sandbox。
- Lease 以 Tenant + Task + current Run + Epoch 做 Fencing；跨 Tenant 引用被拒绝。
- Event 继续受 Zod 与 PostgreSQL 双重白名单约束；不写 Prompt/Token/SQL/堆栈/宿主路径。
- 公开错误只使用固定 `DomainError.publicMessage`；内部诊断不序列化。
- 本地 PostgreSQL 仅绑定 `127.0.0.1:55432`；`.env.local` 被 gitignore。
- 本阶段唯一成本为本地机器资源。

## 13. 偏差、未决问题与剩余风险

| 项目              | 处理                                                                           | 原因 / 归属                                      |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| ADR-0001 来源     | 原样引用 CTO 已批准分支 `origin/docs/adr-0001-cancellation-retry-coordination` | 避免复制/改写已批准决策                          |
| `queued → failed` | ADR-0002 有条件批准：仅 Deadline 已过或预算耗尽时使用；取消优先；不虚构 Run    | 否则无法合法收敛“领取前不可执行”的 Task          |
| `apps/worker`     | 仅 reaper-only；`poll` 明确拒绝                                                | P0B-05 尚无 Execution Router/FakeLLM/FakeSandbox |
| 重试无 Jitter     | P0 使用纯指数退避，文档标注未来多 Worker 惊群风险                              | 任务书允许 P0 不引入 Jitter                      |
| 取消              | 持久化语义已实现；合作式远端中止、审批传播、外部 API 留 P0B-08                 | 本阶段不声称外部副作用可回滚                     |
| 真实执行          | 未实现                                                                         | P0B-05/06；Claim 成功不等于业务成功              |
| `current_run_id`  | 保留最近一次 Run 指针；有效 Run 由 `runs` 活跃部分唯一索引与状态判断           | 保留审计历史，避免只靠空指针判断                 |
| 本地 Node 版本    | 验收显式使用 Node 24.22.1，未降低 `engines`                                    | 本机默认 23.11.0 不满足要求                      |

**剩余风险：**

1. ADR-0002 为有条件批准：实现必须持续满足其条件，不得扩大为通用失败捷径。
2. 重试无 Jitter，大规模同时到期可能惊群。
3. 数据库最终状态正确，不保证远端外部副作用被撤销或执行已物理停止。
4. 本阶段无真实执行、进度、Resume、Artifact/Checkpoint、HTTP/SSE、审批或预算。
5. 无生产性能/高可用承诺；索引只做简单验证。

## 14. 结论

P0B-04 已在真实 PostgreSQL 17 上验证：

- 两个独立 Pool 与 24 并发 Worker 不会重复领取同一 Task；
- Lease 到期/进程崩溃后 Reaper 只终结一次旧 Run，并能用新 Run/新 Epoch 恢复；
- 旧 Run 的 Heartbeat/Finish 因 Tenant/Task/Run/Epoch/过期检查被 Fencing 拒绝；
- ADR-0001 取消提交后绝不创建新 Run，running 取消由有效 Finish 或 Reaper 收敛；
- ADR-0002 的 `queued → failed` 仅用于领取前 Deadline/预算不可执行且取消优先；
- 重试领取的 `retryable_failed → queued → running` 以真实数据库更新与 Event 双重审计；
- 缺少 Run Lease / 锁等待期间到期的 Finish 与 Heartbeat 均被拒绝且无副作用；
- P0B-03 Durable Ack、并发幂等、Tenant FK、Event 白名单全部回归通过。

未实现的 Agent 执行、Sandbox、Artifact、HTTP/SSE、完整取消/审批/预算均明确列为后续阶段。
等待 CTO Review Round 2。
