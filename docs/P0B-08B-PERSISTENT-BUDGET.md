# P0B-08b — 持久化事务预算强制（PostgreSQL）

> 状态：P0B-08b 交付件（Draft PR）。是否已合并以 PR 为准，本文件不跟踪合并状态。
> 范围：`migrations/0006_p0b08b_persistent_budget.sql`、
> `packages/postgres/src/storage/budget-ledger.ts`、`apps/worker/src/budget-plan.ts`、
> `apps/worker/src/config.ts`、`apps/worker/src/durable-run-handler.ts` 及相关测试。

## 1. 目标与边界

P0B-08a 交付的是**纯策略**：`evaluateBudget` 是纯函数，本地账本是不可变值，它明确声明
「持久化存储、跨进程原子性、exactly-once 扣减、Worker 执行路径接线」不在其范围内（见
`docs/P0B-08A-BUDGET-GUARD.md` §6.1）。P0B-08b 承接的正是这四项：

已实现：

- **持久化权威**：`budget_operations` 表，一行描述一次操作的「预留 + 终态结算」，Run 与
  Tenant 当日用量**从行推导**，不存在第二个可变计数器可以漂移；
- **跨进程原子性**：`reserve` 在单个事务内持有 Tenant 级 advisory lock，串行化
  「聚合用量 → 评估策略 → 写入预留」整段序列，两个 Worker 无法同时看到同一份额度都放行；
- **exactly-once 扣减**：唯一键 `(tenant_id, run_id, operation_id)`，operation id **不含 UTC 日**，
  丢失 ACK 的重放返回已有行（`replayed: true`），绝不会第二次扣费；
- **执行路径接线**：`durable-run-handler` 的 `produce` / `publish` 两步都包在
  `runBudgetedStep` 内：**先预留、再产生副作用、最后结算**；被拒绝的步骤不会产生任何字节。

**明确未实现，也不在本 PR 声称完成：**

- 真实计费（USD、账单、发票）、月度/账期预算、折扣与退款；
- 真实模型或沙箱的成本估算：`budget-plan.ts` 的价目表是本构建的常量（§4）；
- 多租户共享配额池、跨租户公平调度、优先级/抢占；
- 管理后台、`/v1` 预算查询接口、SSE 展示；
- 预算维度的动态扩缩容（预留 id 与维度在写入后不可变）。

## 2. 数据模型（migration 0006）

`budget_operations` 一行 = 一次操作的全部预算事实：

| 列                               | 说明                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `id`                             | 行主键（随机 uuid），不是幂等键                            |
| `tenant_id`, `task_id`, `run_id` | 租户所有权；`(tenant_id, task_id, run_id)` 外键指向 `runs` |
| `lease_epoch`                    | 产生该预留的租约代次（fencing）                            |
| `policy_version`                 | 决策时使用的可信策略版本（审计）                           |
| `operation_id`                   | 调用方稳定操作标识，`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`  |
| `reserved_*`                     | `steps` / `units` / `elapsed_ms` / `slots` 四项预留额度    |
| `consumed_*`                     | 终态实际消费；`reserved` 状态时恒为 0                      |
| `state`                          | `reserved` \| `settled` \| `released` \| `expired`         |
| `utc_day`                        | 取额度的 UTC 日（`date`）；结算不会重新归属日期            |
| `expires_at`                     | 该预留随租约死亡的边界；由租户串行点清扫                   |
| `settled_at`                     | 进入终态的时刻（`reserved` 状态必须为 `NULL`）             |

数据库层面强制的约束（不是只写在 TypeScript 里）：

1. `UNIQUE (tenant_id, run_id, operation_id)` —— 一个 Run 内一次操作最多扣一次；
2. `consumed_* <= reserved_*`（四维同时）—— 结算只能**收缩**预留，不能放大；
3. `state IN ('settled','expired') OR consumed_* = 0` —— 只有终态才可能报告消费；
4. `state <> 'expired' OR consumed_* = reserved_*` —— 过期必须**全额**计费，
   杀 Worker 不是退款手段；
5. `(state = 'reserved') = (settled_at IS NULL)` —— 状态与时间戳不可自相矛盾；
6. `reserved_slots BETWEEN 0 AND 1` —— 一步是一份工作，不是扇出。

索引服务于三种聚合：`(tenant_id, run_id, state)`（Run 累计）、
`(tenant_id, utc_day, state)`（租户当日）、部分索引
`(tenant_id, expires_at) WHERE state = 'reserved'`（过期清扫）。

## 3. 判定与记账顺序

```text
reserve:  pg_advisory_xact_lock('ember.budget', tenant)
          → tasks 行 → runs 行 → clock_timestamp()
          → 租约/取消/截止时间复检
          → 清扫已死亡租约的预留（全额计费）
          → 聚合 Run / 租户当日 / 并发 gauge
          → evaluateBudget（P0B-08a 纯函数）
          → INSERT 预留（冲突则重放已有行）
settle:   行锁一行预留 → consumed <= reserved → UPDATE state='settled'
release:  行锁一行预留 → UPDATE state='released'
```

关键顺序性质：

- **先付费后执行**：`reserve` 的拒绝发生在任何模型调用、字节落盘、提交之前；拒绝会回滚
  整个事务，因此「被拒绝的步骤」留下的是零行、零副作用，不需要补偿；
- **锁顺序与 `result-committer.ts` 完全一致**（advisory → tasks → runs → 业务行），
  预算事务永远不会成为死锁环里的第二个持有者；
- **`settle` / `release` 不取 advisory lock**：已经执行完的操作绝不排在别的 Run 的决策后面；
- **无 fence 复检的结算**：跳过结算会让已发生的消费凭空消失，因此 `settle` 以「行自身的
  lease epoch」为栅栏——只有同一代次能结算，且只能收缩。

## 4. 可信价目表与幂等键

`apps/worker/src/budget-plan.ts` 是本构建唯一的「价格来源」，它是**编译期常量**，不是 Task
字段，也不是请求字段：Task 载荷无法声明自己的工作免费。

| 步骤                                      | steps | units | elapsedMs | slots |
| ----------------------------------------- | ----- | ----- | --------- | ----- |
| `produce`（模拟模型/沙箱调用 + 暂存写入） | 1     | 5     | 50        | 1     |
| `publish`（Workspace CAS + 终态提交）     | 1     | 1     | 10        | 1     |

幂等键：

```text
operationId = step:<step>:<inputDigest 前 16 位>:<leaseEpoch>
```

- **同一尝试内稳定**：丢失 ACK 的重放变成「重放」而不是第二次扣费；
- **不含 UTC 日**：昨天重放的操作今天不会被当成新账（P0B-08a §6.1 规则 1）；
- **绑定租约代次**：被重新认领的 Run 确实重新执行了该步骤，因此重试按自己的账计费，
  而死亡尝试的预留仍保持已计费（P0B-08b §6）。

## 5. 执行路径接线

```text
handle(run, signal)
  → contextReader.read → grant（服务端派生，含 leaseEpoch/workerId）
  → router.decideForExecution
  → checkpoints.list（恢复判定）
      ├─ 已提交且 inputDigest 一致 → 只跑 publish（不重复 produce、不重复计费）
      └─ 无可用检查点 → 跑 produce
  produce: runBudgetedStep{ reserve → execute → stage → commitStep → settle }
  publish: runBudgetedStep{ reserve → commitStep → (replayed ? release : settle) }
```

`runBudgetedStep` 的三条语义：

1. **拒绝即停**：`reserve` 抛 `BUDGET_EXCEEDED` → 步骤未执行，Run 以 `failed_terminal` 结束
   （`BUDGET_EXCEEDED` 不可重试，重试只会再付一次钱去再失败一次）；
2. **执行前已中止 → 归还**：`signal.aborted` 为真时 `release` 并抛 `CANCELLED`，因为什么都没开始；
3. **执行失败 → 全额计费**：`settle(consumed = 预留额)`。失败不是拿回额度的理由；
   真正的重放（`replayed === true`，即终态提交被重试）才 `release`。

记账本身永远不会让 Run 失败：`closeReservation` 是 best-effort，失败只写 `warn`。因为到达
那里时副作用已经提交，把记账错误升级成 Run 失败等于用重复执行换一次日志。未关闭的预留会在
租约过期时被全额计费，这正是安全方向。

## 6. 崩溃、重放与 UTC 日

| 场景                                    | 结果                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Worker 在执行中断言前被杀               | 预留随 `expires_at` 过期，被下一个 `reserve` 全额计费（`expired`）          |
| Worker 在副作用后、结算前被杀           | 同上：全额计费，不退款                                                      |
| 预留 ACK 丢失，同一尝试重试 `reserve`   | 返回已有行，`replayed: true`，不重复扣费                                    |
| 同 id 但金额不同                        | `INVALID_ARGUMENT` / `budget_reservation_conflict`，原预留不变              |
| 终态提交被重试（`commitStep.replayed`） | `release`，因为这次尝试没有产生新副作用                                     |
| 结算重复提交（金额相同）                | 返回已记录状态，`replayed: true`                                            |
| 结算金额与已记录不同                    | `INVALID_ARGUMENT` / `budget_settlement_conflict`                           |
| 结算/释放已 `released` 的操作           | `INVALID_ARGUMENT` / `budget_operation_released`                            |
| 结算/释放已 `expired` 的操作            | 返回当前行（已全额计费，既不重复计费也不退款）                              |
| 结算/释放已 `settled` 的操作            | 返回当前行；`release` 则 `budget_operation_already_charged`                 |
| 用另一代次结算同一行                    | `STALE_LEASE`                                                               |
| 跨 UTC 日重放同一 operation id          | 行本身仍在（终态）→ `budget_operation_already_terminal`，不会变成新一天的账 |
| Run 累计计数                            | 覆盖该 Run **所有** UTC 日的已提交用量，日期变化不会重置                    |
| 租户当日计数                            | 只覆盖 `utc_day` 那一列匹配的行，因此新的一天额度重新可用                   |
| 并发 gauge                              | 只统计 `state = 'reserved'` 的行；结算/释放/过期即刻归还槽位                |

## 7. 配置（Worker 可信配置，不是 Task 字段）

`apps/worker/src/config.ts` 读取以下环境变量；`0` 合法且显式失败关闭，负数、小数、非数值、
空 `policyId` 与超出安全整数的值一律让 Worker 拒绝启动（`WorkerConfigError`）：

| 变量                                         | 默认值                | 含义                           |
| -------------------------------------------- | --------------------- | ------------------------------ |
| `EMBER_WORKER_BUDGET_POLICY_ID`              | `p0b08b-simulated-v1` | 策略标识（审计用，1–128 字符） |
| `EMBER_WORKER_BUDGET_POLICY_VERSION`         | `1`                   | 策略版本（非负安全整数）       |
| `EMBER_WORKER_BUDGET_MAX_RUN_STEPS`          | `8`                   | 单 Run 步骤上限                |
| `EMBER_WORKER_BUDGET_MAX_RUN_UNITS`          | `100`                 | 单 Run 单位上限                |
| `EMBER_WORKER_BUDGET_MAX_RUN_ELAPSED_MS`     | `120000`              | 单 Run 累计耗时上限            |
| `EMBER_WORKER_BUDGET_MAX_TENANT_DAILY_UNITS` | `5000`                | 租户当日单位上限               |
| `EMBER_WORKER_BUDGET_MAX_CONCURRENT_SLOTS`   | `8`                   | 租户并发槽位上限               |

`loadWorkerConfig` 返回的 `budget` 是冻结对象，`PostgresBudgetLedger` 在构造时持有它：
判定与写行在同一个事务内，配置事后被改写也无法影响已经做出的决定。

`createDurableRunHandler` 的 `budget` 依赖是**必填**的，不是可选注入：可静默跳过预留的
Worker 会让所有上限重新变成建议。

## 8. 测试

单元（不触库）：

- `tests/unit/budget-plan.test.ts` —— 价目表数值与深冻结、幂等键的确定性/宽度/日无关性/
  代次与步骤区分，并断言其落在 migration 0006 的 `operation_id` 正则内；
- `tests/unit/budget-ledger-validation.test.ts` —— 金额与 operation id 的全部拒绝路径
  （未知字段、小数、负数、`NaN`、`Infinity`、非安全整数、`slots > 1`、129 字符 id），
  并以「桩 pool 从未被调用」证明它们在开事务之前就失败；零金额必须通过校验；
- `tests/unit/worker-poll-loop.test.ts` —— 预算配置的默认值、`0` 的合法性、非法值拒绝、
  冻结性。

集成（真实 PostgreSQL，每个文件一个一次性 schema）：

- `tests/integration/persistent-budget.test.ts`
  - 预留 → 快照 → 结算 → 快照的完整记账，含槽位归还；
  - 丢失 ACK 的重放、冲突重放（不同金额）、终态重放；
  - 拒绝在前：`run_units` / `run_steps` / `concurrency_slots` 三个维度的拒绝都留下零行；
  - 零上限 `maxConcurrentSlots: 0` 的失败关闭语义；
  - 12 个并发 `reserve` 争夺 1 个槽位 → 恰好 1 个成功（advisory lock）；
  - 崩溃与重试：`expires_at` 过期后全额计费（`expired`）、死亡尝试不能再结算（`STALE_LEASE`）、
    重试在 1 个槽位的策略下仍能拿到槽位（证明清扫归还了槽位）、重试按自己的账计费；
  - 归还语义：`released` 之后不可结算、已结算不可退款；
  - UTC 日：昨天的账不占今天的租户额度、Run 累计不因日期重置、跨日重放不产生第二笔账；
  - 租户隔离：相同 operation id 在两个租户下互不可见、不共享并发 gauge；
  - 端到端：预算不足时 produce 被拒 → Run `failed_terminal`、零 Artifact / 零检查点 / 零暂存字节；
    预算充足时两步各计费一次、两步共用一个槽位、Task 终态为 `completed`。
- `tests/integration/durable-worker.test.ts` —— 该套件只证明持久性，因此注入真实
  `PostgresBudgetLedger` 并给足余量；预算行为的断言全部在 `persistent-budget.test.ts`。
- `tests/integration/migrations.test.ts` —— 空 schema 应用 0001–0006、重复运行幂等、
  重命名/篡改已应用迁移被拒绝。

## 9. 已知限制

- **价目表是常量**：`SIMULATED_STEP_COSTS` 不来自配置，也不需要；真实成本估算属于后续阶段；
- **并发槽位的粒度是「一个操作」**：一次预留最多 1 槽（数据库 `CHECK` 同样限制），
  因此本设计不支持单步骤扇出；
- **过期清扫是按需触发**：只有在同一租户有新的 `reserve` 时才清扫该租户的过期预留。
  一个完全静默的租户的过期行会一直保持 `reserved` 状态直到下一次决策——它不会使额度
  被重复使用（`reserved` 按预留额计入），因此是安全的，只是行状态更新滞后；
- **不做信用/负余额**：任何维度超限即拒绝，没有「先透支后对账」；
- **`operation_id` 由调用方决定**：本构建只由 `stepOperationId` 生成。换一个调用方时，
  它的稳定性就是预算正确性的一部分（见 §4）；
- **未覆盖**：真实计费、账单、管理接口、跨租户配额池与优先级调度。
