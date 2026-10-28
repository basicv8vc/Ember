# P0B-05 — 验收报告（Execution Router / 确定性执行）

> 本报告只记录**实际执行过**的命令与输出；未运行项在 §7 明确列出。
> 实现语义见 [P0B-05-IMPLEMENTATION.md](./P0B-05-IMPLEMENTATION.md)。

## 1. 执行环境

| 项         | 值                                                        |
| ---------- | --------------------------------------------------------- |
| OS         | macOS（darwin, arm64）                                    |
| Node       | `v24.22.1`（`.nvmrc` = `24.22.1`）                        |
| pnpm       | `12.15.0`                                                 |
| PostgreSQL | `17.11`（Docker `ember-local-postgres`，库 `ember_test`） |
| TypeScript | `5.9.3`                                                   |
| Vitest     | `5.0.5`                                                   |
| 分支       | `feature/p0b-05-execution-router`                         |
| 基线       | `main` @ `7379f7d`（P0B-04）                              |

## 2. 交付前仓库状态核验

```text
$ git status --short
 M apps/worker/package.json
 M apps/worker/src/config.ts
 M apps/worker/src/index.ts
 M apps/worker/src/run-handler.ts
 M apps/worker/tsconfig.build.json
 M apps/worker/tsconfig.json
 M packages/contracts/src/interfaces.ts
 M packages/postgres/src/index.ts
 M packages/postgres/src/lease-queue/postgres-lease-queue.ts
 M packages/postgres/src/lease-queue/validation.ts
 M pnpm-lock.yaml
 M tsconfig.build.json
 M tsconfig.json
 M vitest.integration.config.ts
 M vitest.unit.config.ts
?? apps/worker/src/poll-loop.ts
?? packages/execution/
?? packages/postgres/src/repositories/run-execution-context-reader.ts
?? tests/integration/execution-worker.test.ts
?? tests/unit/{deterministic-executor,execution-router,fake-llm,fake-sandbox,run-handler,worker-poll-loop}.test.ts
?? docs/P0B-05-{IMPLEMENTATION,ACCEPTANCE}.md
```

## 3. 验收命令与结果

| #   | 命令                                                                   | 结果                                                          |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`                                       | ✅ 无 lockfile 变更报错                                       |
| 2   | `pnpm typecheck`（`tsc -p tsconfig.json`，含 apps + packages + tests） | ✅ 0 error                                                    |
| 3   | `pnpm lint`（`eslint .`）                                              | ✅ 0 problem                                                  |
| 4   | `pnpm format:check`（`prettier --check .`）                            | ✅ All matched files use Prettier code style                  |
| 5   | `pnpm test:unit`                                                       | ✅ **17 files / 345 tests passed**                            |
| 6   | `pnpm build`（`tsc -b tsconfig.build.json`）                           | ✅ 0 error                                                    |
| 7   | `pnpm test:integration`（真实 PostgreSQL）                             | ✅ **8 files / 83 tests passed**                              |
| 8   | `pnpm db:migrate` ×2                                                   | ✅ 第二次 `migrations complete: 0 applied, 4 already applied` |
| 9   | 构建产物 ESM 消费（`node --input-type=module`）                        | ✅ 见 §3.3                                                    |
| 10  | `/healthz` / `/readyz`（构建产物，端口 8853）                          | ✅ `200` / `200`                                              |
| 11  | Worker 进程 smoke（`poll` 模式 + SIGTERM）                             | ✅ 见 §3.4                                                    |
| 12  | Worker 配置守卫（`poll` 未显式开启模拟执行）                           | ✅ `exitCode = 1`                                             |
| 13  | `git diff --check`                                                     | ✅ clean                                                      |

### 3.1 单元测试实际输出

```text
 ✓ tests/unit/execution-router.test.ts (13 tests)
 ✓ tests/unit/fake-llm.test.ts (11 tests)
 ✓ tests/unit/fake-sandbox.test.ts (15 tests)
 ✓ tests/unit/deterministic-executor.test.ts (15 tests)
 ✓ tests/unit/run-handler.test.ts (11 tests)
 ✓ tests/unit/worker-poll-loop.test.ts (15 tests)
 ✓ tests/unit/{domain-contracts,env,healthz,lease-queue-policy,migrator,
              p0b03-schema-vocabulary,run-state-machine,task-digest,
              task-schemas,task-state-machine,worker-loop}.test.ts（现有回归）
 Test Files  17 passed (17)
      Tests  345 passed (345)
```

### 3.2 集成测试实际输出

```text
 ✓ tests/integration/durable-task-inbox.test.ts   (19 tests)
 ✓ tests/integration/migrations.test.ts            (7 tests)
 ✓ tests/integration/lease-claim.test.ts           (9 tests)
 ✓ tests/integration/lease-recovery.test.ts       (14 tests)
 ✓ tests/integration/lease-fencing.test.ts        (10 tests)
 ✓ tests/integration/task-idempotency.test.ts      (6 tests)
 ✓ tests/integration/cancellation-retry.test.ts    (9 tests)
 ✓ tests/integration/execution-worker.test.ts      (9 tests)   ← P0B-05 新增
 Test Files  8 passed (8)
      Tests  83 passed (83)
```

### 3.3 构建产物 ESM 消费

```text
$ node --input-type=module -e "await import('./packages/execution/dist/index.js')"
execution exports: DeterministicExecutionRouter,DeterministicExecutor,EXECUTABLE_TASK_KINDS,
FAKE_LLM_LIMITS,FAKE_LLM_MODEL,FAKE_SANDBOX_IMAGE_DIGEST,FAKE_SANDBOX_LIMITS,
FAKE_SANDBOX_OPERATIONS,FakeLlm,FakeSandboxProvider,ROUTER_POLICY_VERSION,ROUTER_THRESHOLDS,
ROUTE_REASONS,SUPPORTED_COMPUTE_OPERATIONS,assertSupportedComputeOperation,computeSha256,
isExecutableTaskKind,linkAbortSignals,realSleeper,runMockCompute,sha256Hex,simulatedId,
systemExecutionClock

$ node --input-type=module -e "await import('./apps/worker/dist/run-handler.js'); \
    await import('./apps/worker/dist/poll-loop.js')"
worker esm ok: createRunHandler runPollLoop
```

### 3.4 Worker 进程 smoke

```text
$ EMBER_WORKER_MODE=poll EMBER_WORKER_SIMULATED_EXECUTION=local-only \
  EMBER_WORKER_CONCURRENCY=2 EMBER_WORKER_ID=worker-smoke \
  node --env-file-if-exists=.env.local apps/worker/dist/index.js
{"message":"worker starting","mode":"poll","env":"local","simulatedExecution":"local-only",
 "workerId":"worker-smoke","leaseDurationMs":30000,"heartbeatIntervalMs":10000,
 "reaperIntervalMs":2000,"concurrency":2,"claimableKinds":["mock.chat","mock.compute"]}
# SIGTERM
{"message":"worker stopping","signal":"SIGTERM"}
{"message":"poll loop stopped","claimed":0,"finished":0,"rejectedFinishes":0,"abandoned":0}
{"message":"worker stopped","workerId":"worker-smoke"}
```

```text
$ EMBER_WORKER_MODE=poll node apps/worker/dist/index.js ; echo EXIT=$?
worker failed: poll mode requires EMBER_WORKER_SIMULATED_EXECUTION=local-only: P0B-05 has no
durable execution result, so a claimed Task must not be treated as fully processed
EXIT=1
```

## 4. P0B05-T01 — Router 确定性证据

`tests/unit/execution-router.test.ts`（13 tests）断言：

- 每个阈值在 `== 阈值` 与 `== 阈值 + 1` 两侧行为不同（chat 256/256、compute 512、
  file 8192），边界不会漂移；
- 同输入两次调用返回 `toEqual` 且 `Object.isFrozen(decision) === true`；
- 含 `SENTINEL-PROMPT-CONTENT-42` 的 prompt：`JSON.stringify(decision)` 不含哨兵，
  `reason ∈ ROUTE_REASONS`；
- 未知 kind（`mock.shell`）、错配输入（`mock.chat` 带 `path`、`mock.compute` 带 `prompt`）、
  非法 `policyVersion`（`-1`/`1.5`/`NaN`）全部 `INVALID_ARGUMENT`；
- `decide(ctx, cmd)` 与 `decideForExecution(ctx)` 对同一内容返回相同 decision（双入口同策略）；
- `decision.policyVersion` 反映可信策略版本（7），`ROUTER_POLICY_VERSION === 1`。

## 5. P0B05-T02 — Claim → 执行 → Finish 证据

集成测试（真实 PostgreSQL，`workerId = worker-p0b05`）：

- `mock.chat`：任务终态 `completed`，Run 终态 `succeeded` 且 `runs.worker_id` 为 Worker id，
  Event 序列包含 `started` 与 `completed`，且**不含** `artifact_created`；
- `mock.compute`：走完整 FakeSandbox 生命周期后任务终态 `completed`；
- 循环计数：`claimed ≥ 1`、`finished ≥ 1`、`abandoned === 0`；
- `mock.file` 任务在配置 `claimableKinds` 的队列上 `claimed === 0`，任务保持
  `queued` 且 `attempt_count = 0`；同一任务在**不带过滤**的队列上可被 Claim（证明隔离来自
  能力过滤，而不是任务不可见）。

## 6. P0B05-T03 / T04 / T05 / T06 证据

**T03 Fencing**

- Live Lease 能读到 `RunExecutionContext`（`tenantId`/`taskId`/`runId`/`leaseEpoch`/`attempt`
  与 Claim 一致，`policyVersion = 3`，对象 frozen）；
- 推进时钟越过 Lease 后：`reader.read()` → `STALE_LEASE`，`heartbeat()` → `false`，
  `finish('succeeded')` → `false`（迟到结果无法覆盖）；
- 用其他 `runId` 读取 → `NOT_FOUND`（跨引用不可见）。

**T04 失败分类**

- 注入 `tool_failed`：任务 `retryable_failed`、`attempt_count = 1`、Event 含
  `retry_scheduled`、`next_run_at` 被推后；
- 注入 `denied`：任务 `failed`、Run `failed_terminal`、Event 含 `failed`；
- deadline 已过的任务不会被标记成功，最终 `failed`。

**T05 不支持 kind 隔离**：见 §5 最后一条（`claimableKinds` 过滤，且非过滤队列仍可见）。
单元测试另行断言 `EXECUTABLE_TASK_KINDS = ['mock.chat','mock.compute']`，以及
`DeterministicExecutor` 对 `mock.file`/`mock.approval` 返回 `POLICY_DENIED`。

**T06 优雅关闭**

- 关闭时在飞执行被 abort：`abandoned === 1`、`finished === 0`、`finish()` 从未被调用，
  任务与 Run 均保持 `running`，内存并发计数回到 0；
- 之后推进时钟并调用 `reapExpired()`：回收 ≥ 1，任务不再处于 `running`（恢复完全交给
  P0B-04 的 Reaper）；
- 循环单元测试另覆盖：`heartbeat === false` 跳过 `finish()`、`finish === false` 只记一次、
  `concurrency` 上限不被突破、claim 失败有界退避、`concurrency = 0` 抛 `INVALID_ARGUMENT`。

## 7. 未运行项 / 未覆盖项

- 未接真实 LLM、真实工具、真实 Shell/Python/Playwright、容器或云 Sandbox（本就不在 P0B-05
  范围）；
- 未做多进程 Worker 压测、长时稳定性测试、容量/延迟基准；
- 未在 CI 之外的其他操作系统上运行；
- 未验证 `mock.file` / `mock.approval` 的执行（P0B-06 / P0B-08）；
- 未做生产部署、镜像构建或密钥注入验证。

## 8. 安全、隐私与成本

- 无任何外部网络调用，因此无 API 成本；进程内 SHA-256 与词表生成是唯一的"执行"；
- prompt / 文件内容 / 生成文本不进入日志、Event 或错误消息（单测用哨兵字符串断言）；
- 错误只按稳定 `DomainErrorCode` 分类，跨 tenant 引用统一 `NOT_FOUND` / `POLICY_DENIED`；
- 模拟执行在 `EMBER_ENV=production` 下被硬性拒绝，默认模式仍是 `reaper-only`；
- FakeSandbox 的能力声明全部为 `false`，文档与代码都不声称容器级隔离。

## 9. 偏差、未决问题与剩余风险

| 项               | 说明                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `succeeded` 语义 | 仅代表模拟执行完成；`durable: false`，重启不可恢复（P0B-06 补）     |
| `heavy` 路径     | 只是路由结论，没有真实资源分级或隔离                                |
| 能力过滤范围     | 只在配置了 `claimableKinds` 的队列实例上生效；Worker 入口已强制使用 |
| 阈值来源         | 编译期常量，没有 Agent 级策略表（P0B-07）                           |
| FakeSandbox 隔离 | 进程内记录隔离，非安全边界                                          |

## 10. 结论

P0B-05 的验收条件全部满足：确定性路由与模拟执行已接入**真实** PostgreSQL Lease/Fencing 流程，
执行结果明确标记为非持久化，`mock.file`/`mock.approval` 不会被无能力 Worker Claim，优雅关闭
不产生任何假终态，且全部既有 P0B-02/03/04 回归仍然通过。本分支只创建 **Draft PR**，不合并
`main`。
