# P0B-08a — 确定性 Mock 预算守卫

> 状态：P0B-08a 交付件，代码随 PR #12 评审（Ready for Review）；是否已合并以 PR 为准，本文件不跟踪合并状态。
> 范围：`packages/execution/src/budget-guard.ts`（纯策略 + 纯本地账本）与其单元测试。

## 1. 目标与边界

P0B-08a 只解决一个问题：**在真正调用任何模型/沙箱之前，如何用一个纯函数、无副作用的规则
引擎，对一次 Run 的下一步开销做出可复现的 Allow / Deny 判定。**

已实现：

- `evaluateBudget(policy, snapshot, cost)`：纯判定，返回 `BudgetDecision`；
- `toBudgetDeniedError(decision)`：把拒绝映射为既有的 `BUDGET_EXCEEDED` 领域错误；
- `toUtcDayKey(instant)`：显式 UTC 日键（`YYYY-MM-DD`），不读系统时钟；
- 本地账本原语：`createBudgetLedger`、`reserveBudget`、`consumeBudgetReservation`、
  `releaseBudgetReservation`、`snapshotFromLedger`；
- 全部输入校验：未知字段、负数、小数、`NaN` / `Infinity`、非安全整数、非法 id、非法日键、
  求和溢出均以 `INVALID_ARGUMENT` 失败关闭；
- 所有返回值深冻结（`Object.freeze`），调用方无法通过修改结果影响后续判定。

**明确未实现，也不在本 PR 声称完成：**

- 预算的持久化存储、跨进程/跨副本的原子性、exactly-once 扣减；
- Worker 执行路径中的实际拦截接线（预算检查注入点）；
- 真实计费、货币金额（USD 等）、租户结算与账单；
- 月度/账期预算、折扣、退款；
- `/v1/tasks`、SSE、UI 展示。

`BudgetLedgerState` 是不可变值，**不是**存储：它只保证「同一进程内、同一份值」上的
幂等与不变量，不提供任何跨进程原子性或并发保证。

## 2. 预算维度

`BUDGET_DIMENSIONS` 顺序固定（多维度同时超限时按此顺序报告）：

| 维度                 | 含义                    | 比较对象                     |
| -------------------- | ----------------------- | ---------------------------- |
| `run_steps`          | 本 Run 累计步骤数       | `policy.maxRunSteps`         |
| `run_units`          | 本 Run 累计计算单位     | `policy.maxRunUnits`         |
| `run_elapsed_ms`     | 本 Run 累计耗时（毫秒） | `policy.maxRunElapsedMs`     |
| `tenant_daily_units` | 租户当日累计单位        | `policy.maxTenantDailyUnits` |
| `concurrency_slots`  | 并发占用的槽位          | `policy.maxConcurrentSlots`  |

语义约定：

- **上限是闭区间**：投影值恰好等于上限 → `Allow`；大于才 `Deny`。
- `units` 同时计入 `run_units` 与 `tenant_daily_units` 两道上限。
- 任一季度超限即整体拒绝，不做部分扣减。
- `maxConcurrentSlots: 0` 是合法、显式、失败关闭的配置，不是错误：它表示「本租户任何占用槽位的
  步骤都不得执行」，因此 `concurrencySlots: 0` 的工作请求仍然允许，`concurrencySlots: 1` 一律拒绝；
  若快照的并发 gauge 已 > 0（其他 Run 持槽），连零槽位请求也会被拒绝。
- `maxTenantDailyUnits` 是**租户级**上限，`tenantDailyUnits` 必须包含本 Run 自己的贡献且只计一次，
  见 §3。
- `utcDay` 由调用方显式传入（`YYYY-MM-DD`），代码内不读 `Date.now()`，因此判定可复现。

## 3. 计数归属：Tenant 当日用量 vs. Run 累计用量

两个计数器的生命周期不同，因此**不从彼此推导**，而是各自显式定义：

```text
runSteps         = runCarryOver.steps     + consumed.steps     + reserved.steps
runUnits         = runCarryOver.units     + consumed.units     + reserved.units
runElapsedMs     = runCarryOver.elapsedMs + consumed.elapsedMs + reserved.elapsedMs
tenantDailyUnits = tenantDayUnitsFromOtherRuns + consumed.units + reserved.units
concurrentSlots  = heldSlotsFromOtherRuns      + reserved.concurrencySlots
```

- `snapshotFromLedger(state, { tenantDayUnitsFromOtherRuns, heldSlotsFromOtherRuns })` 的第二个参数
  只描述**其他 Run** 的用量，必须完全排除本 Run；本 Run 的「已提交 units + 未结算预留 units」
  由函数自己加一次。这样既不会漏算未结算预留，也不会重复计算。
- 因此**未结算的预留额度会立刻占用租户当日额度**：日上限 10、连续两次各预留 6 units，第二次必定
  以 `tenant_daily_units` 拒绝（回归测试 `counts an outstanding reservation against the Tenant-day cap`）。
- 预留被释放后额度归还；被结算后只按实际消费计入（多余部分既不计 `consumed`，也不再占用租户额度）。
- 宿主如果把「租户当日总量」（已含本 Run）传给 `snapshotFromLedger`，就会重复计算；传裸数字会被
  拒绝（`invalid_object`），传未知字段会被拒绝（`unknown_field`）——接口刻意不给歧义留空间。
- `tenantDayUnitsFromLedger(state)` 返回「应当计入本 Run 的租户当日用量」
  （`consumed.units + reserved.units`），供 P0B-08b 聚合时使用；并发 gauge 的对应值为
  `state.reserved.concurrencySlots`。

## 4. 账本原语与不变量

```text
createBudgetLedger({ tenantId, runId, utcDay, runCarryOver? }) → 空账本
reserveBudget(state, { operationId, amount })    → 预留（幂等）
consumeBudgetReservation(state, { operationId, consumed }) → 结算
releaseBudgetReservation(state, operationId)     → 按 0 消费结算（幂等、不退款）
rollBudgetLedgerToUtcDay(state, nextUtcDay)      → 跨日结转（Run 计数保留、当日计数归零）
tenantDayUnitsFromLedger(state)                  → 本 Run 应计入租户当日额度的单位数
snapshotFromLedger(state, tenantUsage)           → BudgetSnapshot（下一步判定输入）
```

- `operationId` 幂等：同 id 同金额重复预留返回同一值；同 id 不同金额 → `budget_reservation_conflict`；
  已结算过的 id 再次预留 → `budget_reservation_already_settled`。
- 结算后预留整体离开 `reserved`，只有实际用掉的部分进入 `consumed`；**已消耗永不被退回**。
- 同 id 重复结算：数值一致则幂等返回，不一致 → `budget_settlement_conflict`；
  结算未知 id → `budget_unknown_reservation`；结算超过预留 → `budget_consumption_exceeds_reservation`。
- 操作日志上限 `BUDGET_GUARD_LIMITS.maxLedgerOperations`（1024），超出 → `budget_ledger_capacity`，
  防止无界增长。
- `parseLedgerState` 每次入口都从操作日志**重新推导** `reserved` / `consumed`，并拒绝与记录值
  不一致的状态（`budget_ledger_invariant`），因此被篡改的值不会被继续使用。
- `runCarryOver` 是唯一无法从日志推导的字段（它描述本值之外的历史日分段）：按严格 usage 校验
  （三个非负安全整数、拒绝多余字段）。**它不提供任何安全保证**：`createBudgetLedger` 允许调用方
  显式传入该值，而本模块无法校验它是否真的来自历史记录，因此它既可能被伪造得偏大（只会抬高
  Run 计数），也可能被错传为 0（会静默重置 Run 累计预算）。来源可信性由持久化层负责，
  见 §6.1 第 2 条。

## 5. 跨 UTC 日语义（Run 累计预算不会被日期重置）

Ledger 绑定 `(tenantId, runId, utcDay)`，但**Run 可以跨日**。因此：

- Run 计数器（步骤 / Units / 耗时）在跨日后继续累计，绝不因为 `utcDay` 变化而归零；
  `runCarryOver` 保存「本 Run 在更早 UTC 日已消耗的用量」。
- 只有租户当日计数器随 `utcDay` 归零。
- `rollBudgetLedgerToUtcDay(state, nextUtcDay)` 是唯一的跨日手段（纯函数）：
  `consumed` 归档进 `runCarryOver`，`consumed` / `reserved` / 当日操作日志清零；
  `nextUtcDay` 必须**严格晚于**当前日，否则 `budget_day_rollover_not_forward`；
  仍有**未结算**预留时拒绝结转（`budget_day_rollover_with_outstanding_reservation`），
  已结算的记录不阻塞结转 —— 这样不会出现「昨日预留、今日消耗」的归属歧义。
- 回归测试：日 1 消耗 3 steps / 30 units / 300 ms → 结转后快照仍为 3 / 30 / 300 且
  `tenantDailyUnits = 0`；日 2 再预留 2 steps → `runSteps = 5`，`maxRunSteps: 5` 时恰好允许、
  再多 1 step 拒绝（与跨日前完全一致）。
- 重建历史日分段的唯一合法方式是把持久化的 `runCarryOver` 传给 `createBudgetLedger`
  （`runCarryOver?` 缺省为 0，仅用于 Run 的第一天）。
- 已知语义：结转后 `operationId` 的唯一性作用于新的日分段。适配器不得重放已结束日分段的 id
  （预期的 `operationId` 是 Run 内唯一的步骤 id）。

## 6. 与 P0B-08b 的接口

P0B-08b 负责接线与持久化，需要的接口已经固定：

1. 读侧：宿主提供 `BudgetSnapshot`，数据来源必须如下：

   | 快照字段                                 | 数据来源                                                        |
   | ---------------------------------------- | --------------------------------------------------------------- |
   | `tenantId` / `runId`                     | 可信执行上下文，绝不取自 Task payload                           |
   | `utcDay`                                 | 由注入的时钟经 `toUtcDayKey` 格式化，显式 `YYYY-MM-DD`          |
   | `runSteps` / `runUnits` / `runElapsedMs` | 本 Run 累计用量（含更早日分段），即 `runCarryOver + 当日已消耗` |
   | `tenantDailyUnits`                       | 其他 Run 当日 units + 本 Run `tenantDayUnitsFromLedger(state)`  |
   | `concurrentSlots`                        | 其他 Run 持有的槽位 + 本 Run `state.reserved.concurrencySlots`  |

   使用 `snapshotFromLedger(state, { tenantDayUnitsFromOtherRuns, heldSlotsFromOtherRuns })` 即可
   得到上表所需的合并结果（本 Run 部分由函数自己加）。

2. 决策：`evaluateBudget` 返回 `BudgetDecision`；拒绝时用 `toBudgetDeniedError` 得到
   `BUDGET_EXCEEDED`（`retryable: 'not_retryable'`，不含任何内部数字或 id）。
3. 写侧：宿主用 `reserveBudget` → 执行 → `consumeBudgetReservation` / `releaseBudgetReservation`
   更新自己的账本值，并把它持久化；跨 UTC 日时先结算/释放未完成预留，再调用
   `rollBudgetLedgerToUtcDay` 并把结果持久化。P0B-08a 不落盘、不联网、不读时钟。
4. 需要宿主在同一事务内完成「读快照 → 判定 → 预留 → 落盘」的串行化。P0B-08a 不提供跨进程
   原子性：两个进程各自持有同一份快照时可能都得到 Allow。这属于 P0B-08b 的范围。

### 6.1 P0B-08b 必须承担的两条约束（本模块结构上无法提供）

这两条是复审确认的边界，适配器不得视为「已由 P0B-08a 解决」：

1. **跨日 `operationId` 幂等由持久化层负责。** `rollBudgetLedgerToUtcDay` 会**清空**当日操作日志，
   因此结转后的纯账本无法识别「昨日已经执行过」的操作 —— 它既不知道历史 id，也不会拒绝重放。
   P0B-08b 必须以 `(tenantId, runId, 稳定操作 id)` 作为持久化幂等键（例如 Run 内唯一的步骤 id +
   唯一约束/去重表），保证同一个操作跨 UTC 日也只扣减一次。若把结转后的账本当唯一依据，
   「昨日预留并执行、今日重放同一操作」会被当成全新操作再扣一次。
2. **`runCarryOver` 必须来自可信历史记录，不能由调用方随意重建。** `createBudgetLedger` 接受
   `runCarryOver`，但 P0B-08a 只能校验**形状**（三个非负安全整数、拒绝多余字段），无法校验**来源**。
   因此适配器必须从本 Run 的持久化账本/事件记录读取该值；**读不到时不得传 0**（或省略）——
   对非首个日分段传 0 会静默把 Run 累计预算重置，正是 P0B-08a 要消除的行为。
   注意不对称性：伪造偏大的 carry-over 只会抬高 Run 计数（失败关闭），而错传 0 会静默放宽判定，
   所以「缺省 0」只允许用于 Run 的第一个日分段。
