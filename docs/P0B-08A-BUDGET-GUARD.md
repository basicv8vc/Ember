# P0B-08a — 确定性 Mock 预算守卫

> 状态：仅创建 **Draft PR**，未合并 `main`。
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
- `maxConcurrentSlots: 0` 是合法配置（失败关闭），不是错误。
- `utcDay` 由调用方显式传入（`YYYY-MM-DD`），代码内不读 `Date.now()`，因此判定可复现。

## 3. 账本原语与不变量

```text
createBudgetLedger({ tenantId, runId, utcDay })   → 空账本
reserveBudget(state, { operationId, amount })    → 预留（幂等）
consumeBudgetReservation(state, { operationId, consumed }) → 结算
releaseBudgetReservation(state, operationId)     → 按 0 消费结算（幂等、不退款）
snapshotFromLedger(state, tenantDailyUnits)      → BudgetSnapshot（下一步判定输入）
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

## 4. 与 P0B-08b 的接口

P0B-08b 负责接线与持久化，需要的接口已经固定：

1. 读侧：由宿主提供 `BudgetSnapshot`（`utcDay` 与租户当日用量），P0B-08a 只做判定；
2. 决策：`evaluateBudget` 返回 `BudgetDecision`；拒绝时用 `toBudgetDeniedError` 得到
   `BUDGET_EXCEEDED`（`retryable: 'not_retryable'`，不含任何内部数字或 id）；
3. 写侧：宿主用 `reserveBudget` → 执行 → `consumeBudgetReservation` / `releaseBudgetReservation`
   更新自己的账本值，并把它持久化；P0B-08a 不落盘、不联网、不读时钟。
