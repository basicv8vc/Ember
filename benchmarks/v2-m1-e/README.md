# M1-E Global budget authority evidence

[Raw latency samples](./global-budget-workerd-raw.json) from the isolated implementation at `3432745` measure each request from the local Node test client through a Worker fetch and Durable Object RPC to the SQLite authority. The different-operation burst starts with a cold Object. Its successful requests measure reserve and authorize sequentially per operation while other operations are still in flight. The duplicate bursts each send 32 concurrent calls against one operation. P95 uses the nearest-rank sample.

| Burst                | Operation           | Samples |       P95 |
| -------------------- | ------------------- | ------: | --------: |
| Different operations | Reserve             |      32 |  86.22 ms |
| Different operations | Authorize           |      12 |  38.30 ms |
| Different operations | Reserve + authorize |      12 | 103.96 ms |
| Different operations | Settle              |      12 |  25.39 ms |
| Same operation       | Reserve             |      32 |  39.69 ms |
| Same operation       | Authorize           |      32 |  39.55 ms |
| Same operation       | Settle              |      32 |  41.78 ms |

The first burst admitted 12 of 32 operations against a 3,000 micro-USD daily ceiling at 250 micro-USD each. The duplicate bursts produced one grant, one send authorization and one applied settlement. An idle alarm test evicted the Object before expiry and inspected SQL after the alarm without sending another budget RPC.

These historical measurements include local harness contention. The integrated Cold/Warm benchmarks and the 50 ms target are tracked by Agent D.

## Local runtime wiring

Export `GlobalBudgetDO` from `@ember/runtime-v2/global-budget-do` in the Worker and bind it as `GLOBAL_BUDGET` with a SQLite class migration. Keep the binding on the hosting Worker so the DO can verify its canonical ID. Spread `createAgentHeadGlobalBudgetOptions(env)` from `@ember/runtime-v2` into every `AgentHeadCore` constructor, and give Agent B's relay the existing `agentHead.createGlobalBudgetSettlePort()` adapter. Worker bindings select the same platform instance across Agent identities.

The DO and Agent Head share the trusted `GLOBAL_DAILY_CEILING_MICRO_USD` configuration, defaulting to the V1 global daily limit. A configuration change applies to new UTC buckets. A bucket opened with the previous setting preserves its original cap for existing obligations and declines new reserves until the next UTC day.

Run from the repository root with the workspace dependencies installed.

```sh
pnpm build
pnpm exec vitest run --config vitest.unit.config.ts tests/unit/v2-m1-global-budget.test.ts
WRANGLER_SEND_METRICS=false EMBER_GLOBAL_BUDGET_EVIDENCE=/tmp/global-budget-workerd-raw.json pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m1-global-budget-workerd.test.ts
```
