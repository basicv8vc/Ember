# M1-E Global budget authority evidence

[Raw latency samples](./global-budget-workerd-raw.json) measure each request from the local Node test client through a Worker fetch and Durable Object RPC to the SQLite authority. The different-operation burst starts with a cold Object. Its successful requests measure reserve and authorize sequentially per operation while other operations are still in flight. The duplicate bursts each send 32 concurrent calls against one operation. P95 uses the nearest-rank sample.

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

The isolated fixture mounts the M1-E implementation in workerd. Runtime package registration and Agent Head integration depend on the merged M1 shared interfaces. The latency samples include local harness contention and cannot establish the 50 ms near-region production target.

Run from the repository root with the workspace dependencies installed.

```sh
pnpm exec vitest run --config vitest.unit.config.ts tests/unit/v2-m1-global-budget.test.ts
WRANGLER_SEND_METRICS=false EMBER_GLOBAL_BUDGET_EVIDENCE=/tmp/global-budget-workerd-raw.json pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m1-global-budget-workerd.test.ts
```
