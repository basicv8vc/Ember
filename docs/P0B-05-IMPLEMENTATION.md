# P0B-05 — Execution Router 与确定性执行

> 状态：实现完成，仅创建 **Draft PR**，未合并 `main`。
> 基线：`main` @ `7379f7d7b23bd9d574f09001dc4c2f6db07b37ed`（P0B-04 已合并）。
> 本文件描述**实际代码与执行语义**；实际命令、测试数、CI 与未运行项见
> [P0B-05-ACCEPTANCE.md](./P0B-05-ACCEPTANCE.md)。

## 1. 目标与边界

P0B-05 只解决一个问题：**一个已经被合法 Claim 的 Run，如何被确定性地路由到一个执行路径，
并在真实 Lease/Fencing 约束下完成一次「模拟执行」，同时不伪造任何持久化结果。**

已实现：

- `@ember/execution`：`DeterministicExecutionRouter`、`FakeLlm`、`FakeSandboxProvider`、
  `runMockCompute`、`DeterministicExecutor`；
- `@ember/contracts`：`RunExecutionContext` / `RunExecutionContextReader` 契约；
- `@ember/postgres`：`PostgresRunExecutionContextReader`（可信上下文读取）与
  `PostgresLeaseQueue` 的 `claimableKinds` 能力过滤；
- `apps/worker`：`createRunHandler`（上下文 → 路由 → 执行）、`runPollLoop`
  （Claim/Heartbeat/Finish 并发循环）、`reaper-only` 与 `poll` 双模式入口；
- 显式、默认关闭的本地模拟执行开关（`EMBER_WORKER_SIMULATED_EXECUTION=local-only`）；
- 真实 PostgreSQL 17 的 P0B05-T01 ~ T06 集成测试。

**明确未实现，也不在本 PR 声称完成：**

- 真实 LLM、真实 API Key、真实 Tool/HTTP/SDK 调用；
- 真实 Shell / Python / Playwright / 容器 / VM / 云 Sandbox；
- ArtifactStore、Workspace CAS、Checkpoint / Snapshot / Resume；
- 执行结果持久化、`/v1/tasks`、SSE、审批实体、预算执行；
- 多进程编排、Redis/Kafka、云队列、生产部署或性能承诺。

`finish('succeeded')` 在 P0B-05 表示**模拟执行已按确定性规则完成**，不表示任何真实模型
输出、文件或沙箱产物被持久化。`SimulatedExecutionResult.durable` 恒为 `false`，代码路径中
不存在把它写成 `true` 的分支。

## 2. 模块与依赖方向

```text
@ember/domain
  TaskKind / ExecutionPath / MockTaskInput / RunTerminalStatus
      ▲
@ember/contracts
  RunExecutionContext / RunExecutionContextReader   （新增）
  ExecutionRouter / RouteDecision                   （P0B-02 已定义，未改签名）
      ▲                                    ▲
@ember/postgres                        @ember/execution
  lease-queue/postgres-lease-queue.ts    execution-router.ts       纯策略
    + claimableKinds                     validation.ts             执行边界校验
  repositories/run-execution-            fake-llm.ts               确定性生成器
    context-reader.ts                    fake-sandbox.ts           SandboxProvider 实现
      ▲                                  mock-compute.ts           纯 SHA-256
      │                                  deterministic-executor.ts
      └──────────────┬───────────────────────────┘
                 apps/worker
                   run-handler.ts   上下文 → 路由 → 执行
                   poll-loop.ts     Claim / Heartbeat / Finish
                   config.ts        模式与显式开关
                   index.ts         reaper-only | poll 分发
```

依赖方向保持单向：`execution` 不依赖 `postgres`；`postgres` 不依赖 `execution`；两者只在
`apps/worker` 汇合。`@ember/execution` 通过结构化 `Clock`/`Sleeper` seam 与
`@ember/postgres` 的 `Clock` 兼容，而不引入其依赖。

## 3. Execution Router

### 3.1 两个入口，一份策略

`DeterministicExecutionRouter` 同时实现：

- `ExecutionRouter.decide(ctx: AuthContext, cmd: TaskCommand)`：为未来的请求路径调用方
  （已有已验证 `AuthContext`，P0B-07）保留的契约方法；
- `ExecutionRouterForRun.decideForExecution(ctx: TrustedRouteContext)`：Worker 入口，
  只接受 `Pick<RunExecutionContext, 'policyVersion' | 'kind' | 'input'>`。

两者都调用同一个纯函数 `routeFor()`。Worker 侧**不会伪造 `AuthContext`**：执行时没有已验证
的终端用户主体，因此不构造假的 `principalId`，而是使用数据库中可信、经过 Fencing 校验的
执行上下文。

两个方法都以 **Promise rejection** 表达校验失败（不使用同步 throw），调用方只有一种失败
模式。

### 3.2 阈值（内容无关、有界）

| 条件                                                               | 路径       | reason                           |
| ------------------------------------------------------------------ | ---------- | -------------------------------- |
| `mock.chat`，`prompt.length ≤ 256` 且 `maxOutputTokens ?? 0 ≤ 256` | `fast`     | `chat_short_prompt_fast`         |
| `mock.chat`，`prompt.length > 256`                                 | `standard` | `chat_long_prompt_standard`      |
| `mock.chat`，`maxOutputTokens > 256`                               | `standard` | `chat_large_output_cap_standard` |
| `mock.compute`，`text.length ≤ 512`                                | `fast`     | `compute_small_input_fast`       |
| `mock.compute`，`text.length > 512`                                | `standard` | `compute_large_input_standard`   |
| `mock.file`，`content.length ≤ 8192`                               | `standard` | `file_small_content_standard`    |
| `mock.file`，`content.length > 8192`                               | `heavy`    | `file_large_content_heavy`       |
| `mock.approval`                                                    | `standard` | `approval_policy_standard`       |

阈值是 `ROUTER_THRESHOLDS` 常量；路由只看**已校验输入的长度**，没有随机数、时钟、网络、
数据库或可变状态，因此同输入必然同结果。`heavy` 只表示**路由结论**，P0B-05 不分配任何昂贵
资源。

### 3.3 `policyVersion` 的语义

`RouteDecision.policyVersion` 是**调用方/Agent 的可信策略版本**（数据库中
`agents.policy_version`，或已校验的 `AuthContext.policyVersion`），不是路由表版本。路由表
版本是 `ROUTER_POLICY_VERSION = 1`（`DeterministicExecutionRouter.policyVersion`）。两者名称
相近但语义不同，文档与测试都显式区分，避免把「策略版本」误读成「代码修订」。

`policyVersion` 必须是非负安全整数；负数、小数、`NaN` 一律 `INVALID_ARGUMENT`，不做强制
转换。

### 3.4 闭合的 reason 集合

`ROUTE_REASONS` 是 `as const` 闭合集合，任何 reason 都不得包含 prompt、文件内容、标识符
或其他可变数据；测试直接断言 reason ∈ 集合，并对含哨兵字符串的 prompt 断言 decision 序列化
结果中不含该哨兵。`RouteDecision` 为 frozen 对象。

## 4. FakeLLM / Mock Compute / FakeSandbox

### 4.1 FakeLLM

- 输出由 `SHA-256(prompt)` 逐字节选取闭合 12 词词表，长度等于
  `min(maxOutputTokens ?? 32, 512)`；同一请求永远得到同样的文本与 usage；
- `usage.promptTokens = ceil(prompt.length / 4)`，仅用于模拟计费形状；
- 无 HTTP/SDK/环境变量读取，因此不可能使用任何真实 API Key；
- prompt 不写日志、不落库、不被解释为 shell/tool 指令，输出也不会回显 prompt 内容；
- 注入故障：`tool_failed → MOCK_TOOL_FAILED`、`timeout → EXECUTION_TIMEOUT`、
  `denied → POLICY_DENIED`；当 `delayMs >= timeoutMs` 时只等待 `timeoutMs` 就失败，不会
  超时等待。

### 4.2 Mock Compute

`sha256` 是唯一允许的算子（`SUPPORTED_COMPUTE_OPERATIONS`），纯进程内 `node:crypto` 计算，
输入字符上限取自 `TASK_INPUT_LIMITS.computeTextMaxChars`；空字符串是合法输入。未知算子 →
`POLICY_DENIED`，且错误信息不回显算子或输入内容。

### 4.3 FakeSandbox

实现 `SandboxProvider` 完整生命周期：`create → waitReady → exec → readOutput → usage →
stop → destroy`。

- 仅允许 `sha256 <text>` 一条 argv（`FAKE_SANDBOX_OPERATIONS`）。其他命令（`sh`、`python`
  等）在任何状态变更前即以 `POLICY_DENIED` 拒绝，且不记录 usage；
- Provider 实例绑定单一 tenant：跨 tenant 的 spec 直接 `POLICY_DENIED`；其他 tenant 的
  sandbox id 与不存在的 id 不可区分（`NOT_FOUND`）；
- `capabilities()` 全为 `false`：没有 shell、浏览器、快照、恢复、持久卷、网络策略执行；
  磁盘内容不跨 `stop()` 存活；
- `putFile`/`getFile`/`snapshot`/`resume` 一律 **fail-closed**（`POLICY_DENIED`），因为它们
  需要 P0B-06 的 ArtifactStore/Workspace CAS；返回成功就是在伪造持久化；
- `destroy()` 丢弃内存输出；`usage` 在 destroy 后不可读（`SANDBOX_NOT_READY`）；
- sandbox id 由 `simulatedId()` 生成（UUIDv8 形状，可被 `z.uuid()` 接受），同一
  tenant + run + clock 恒定，因此同 Run 重复创建会以 `POLICY_DENIED` 拒绝而不是静默复制。

这里的隔离是**进程内记录隔离**，不是容器/VM/云沙箱隔离；文档与日志都不做反向声明。

## 5. DeterministicExecutor 与 Claim Eligibility

`EXECUTABLE_TASK_KINDS = ['mock.chat', 'mock.compute']` 是唯一的能力清单：

- `mock.chat` → `FakeLlm.generate`，结果 `{ type: 'text', text, usage }`；
- `mock.compute` → 完整 FakeSandbox 生命周期，结果 `{ type: 'sha256', sha256, usage }`；
- 其他 kind → `POLICY_DENIED`（正常路径下 Worker 根本不会 Claim 到它们）。

同一份清单同时驱动 `PostgresLeaseQueue` 的 `claimableKinds`，因此「能 Claim 的 kind」与
「能执行的 kind」在代码层面无法漂移。P0B-06（文件产物）与 P0B-08（审批）必须同时扩展该清单
与执行分支。

执行前还会重新校验 `ctx.kind` 与 `ctx.input`（数据库行是数据，不是类型保证），并检查
`deadlineAt`：已过期的 deadline → `DEADLINE_EXCEEDED`。所有等待都经由注入的 `Sleeper`，
执行路径不直接读取 `Date.now()`（唯一时间来源是注入的 `Clock`）。

## 6. 可信执行上下文（`PostgresRunExecutionContextReader`）

Worker 不信任自己内存里的任何字段，也不把 Task 输入当成上下文：执行上下文一律从数据库读取。

- 单条 `SELECT`（Task ⨝ Run ⨝ Agent）在同一个 PostgreSQL 快照内求值，三张表的列彼此一致，
  **不开事务、不加行锁**，因此慢执行期间不会持锁；
- 定位键是 `tenant + task + run`（`LeasedRun`），不是裸 task id 或 run id；
- 逐项复核 Claim 返回的 Fencing 字段：`task.status = running`、`current_run_id`、
  `task.lease_epoch`、`run.lease_epoch`、`run.attempt`、`attempt_count`、Task/Run 的
  `lease_expires_at`/`leased_until`；任一不匹配 → `STALE_LEASE`；
- 缺失、跨 tenant、错 task 的引用一律 `NOT_FOUND`（不可区分，避免探测）；
- **取消优先**（ADR-0001）：`cancel_requested_at IS NOT NULL` 时即使 Lease 也已过期，也返回
  `CANCELLED`；
- 已过 deadline → `DEADLINE_EXCEEDED`；
- 持久化 kind/input 解析失败 → `DB_UNAVAILABLE`（数据损坏，不是客户端输入错误）；
- 返回 frozen 的 `RunExecutionContext`，`policyVersion` 来自 `agents.policy_version`。

## 7. Worker Poll Loop（`runPollLoop`）

每个 Claim 到 Run 的生命周期：

```text
claimNext() ──▶ read context ──▶ route ──▶ execute ──▶ finish()
     │                                        ▲
     └──── Heartbeat(heartbeatIntervalMs) ─────┘
```

安全规则：

- `heartbeat() === false` → 中止执行并**跳过** `finish()`：这不是 Task 失败，而是「本 Worker
  不再拥有执行权」，后续由数据库状态与 Reaper 决定；
- `finish() === false` 只记录一次，**永不重试**，避免迟到结果覆盖更新的 Run；
- 执行被中止（shutdown / Lease 丢失 / 取消）时**不提交结果**，因此 Worker 无法用被切断的工作
  伪造终态；
- 并发上限 `concurrency`：达到上限时不再 Claim，只在有执行完成或 stop 时继续；
- 队列为空且有在飞执行时不空转（等 `Promise.race(inFlight)`），否则按 `idleIntervalMs` 退避；
- Claim 抛错 → 固定 code + `errorBackoffMs` 退避后继续；
- 优雅关闭：共享一个 stop signal，先停止 Claim，再 `Promise.allSettled` 等在飞执行结束；
  Handler 的 signal 会同步 abort，因此执行能及时退出。

计数器（`PollLoopSummary`）：`claimed` / `finished` / `rejectedFinishes` / `abandoned`。
循环本身不写任何 Task/Run 行，只有 `LeaseQueue.finish()` 是终态写入者，Fencing 与重试调度
仍完全属于 P0B-04。

## 8. Worker 配置与安全开关

| 变量                               | 默认           | 约束                          |
| ---------------------------------- | -------------- | ----------------------------- |
| `EMBER_ENV`                        | `local`        | `local｜test｜ci｜production` |
| `EMBER_WORKER_MODE`                | `reaper-only`  | `reaper-only｜poll`           |
| `EMBER_WORKER_SIMULATED_EXECUTION` | `disabled`     | `disabled｜local-only`        |
| `EMBER_WORKER_CONCURRENCY`         | `4`            | 1–16                          |
| `EMBER_WORKER_ID`                  | `worker-local` | 1–128 个安全字符              |
| `EMBER_WORKER_INTERVAL_MS`         | 2000           | 100–60000（空闲轮询间隔）     |
| `EMBER_WORKER_ERROR_BACKOFF_MS`    | 1000           | 100–60000                     |

两个硬性守卫（抛 `WorkerConfigError`，进程 `exitCode = 1`）：

1. `mode = poll` 但 `simulatedExecution != local-only` → 拒绝启动。P0B-05 没有持久化执行
   结果，Claim 后不落任何产物，不能悄悄当成「已处理」；
2. `EMBER_ENV = production` 且启用模拟执行 → 拒绝启动。模拟执行在 P0B-06 提供持久化结果之前
   只能是 local/test 能力。

`poll` **不是默认模式**：默认仍是 `reaper-only`，只有显式设置两个变量才会进入 Claim 循环。

## 9. Event、安全与日志

- 不新增 Event 类型：P0B-05 只通过 P0B-04 的 `finish()` 产生既有 `started`/`completed`/
  `failed`/`retry_scheduled`/`cancelled` 事实；
- 不写 Artifact/Checkpoint 行，不写任何「产物已生成」的字段；
- 日志只包含 `taskId`/`runId`/`attempt`/`leaseEpoch`/`kind`/`route`/`reason`/
  稳定 `code`/耗时；prompt、文件内容、生成文本、digest 明文一律不出现；
- 错误只按 `DomainErrorCode` 分类，不匹配人类可读文本；未知错误记为 `UNEXPECTED`；
- 无新网络出口：`@ember/execution` 不引入 HTTP 客户端、SDK、shell 或文件系统调用。

## 10. 失败 → 终态映射

| 执行侧错误                         | Run 终态            | 理由                                          |
| ---------------------------------- | ------------------- | --------------------------------------------- |
| `CANCELLED`                        | `cancelled`         | 已提交取消意图，队列按 ADR-0001 收敛          |
| `DB_UNAVAILABLE`                   | `failed_retryable`  | 基础设施抖动，有限次数内可恢复                |
| `EXECUTION_TIMEOUT`                | `failed_retryable`  | 超时可能来自瞬时资源竞争                      |
| `MOCK_TOOL_FAILED`                 | `failed_retryable`  | 模拟工具故障，允许有界重试                    |
| `DEADLINE_EXCEEDED`                | `failed_terminal`   | deadline 已过，重试无意义（队列自身也会复核） |
| `POLICY_DENIED`                    | `failed_terminal`   | 策略拒绝，重放不会改变结果                    |
| `INVALID_ARGUMENT`                 | `failed_terminal`   | 持久化输入非法，重试必然同样失败              |
| 未知异常                           | `failed_retryable`  | 仅在 Attempt 预算内重试，绝不报成功           |
| 上下文 `STALE_LEASE` / `NOT_FOUND` | 不写终态（abandon） | Lease 已不属于本 Worker                       |

## 11. 测试映射

| 测试                                         | 覆盖                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/execution-router.test.ts`        | P0B05-T01：阈值边界、确定性、reason 闭合集、无内容泄漏、非法 kind/输入/policyVersion、双入口同策略                                                 |
| `tests/unit/fake-llm.test.ts`                | 确定性、词表闭合、输出上限、无 prompt 回显、延迟/超时/故障注入、非法请求                                                                           |
| `tests/unit/fake-sandbox.test.ts`            | 生命周期、命令白名单、tenant 隔离、fail-closed 能力、usage 记账、稳定 id                                                                           |
| `tests/unit/deterministic-executor.test.ts`  | `mock.chat`/`mock.compute` 结果、确定性、deadline、abort、能力清单、故障码                                                                         |
| `tests/unit/run-handler.test.ts`             | 上下文 → 路由 → 执行链路、`STALE_LEASE`/`NOT_FOUND` 上抛、失败分类、日志不含内容                                                                   |
| `tests/unit/worker-poll-loop.test.ts`        | P0B05-T02/T03/T06 的循环语义：finish 语义、心跳丢失、并发上限、claim 退避、shutdown、配置守卫                                                      |
| `tests/integration/execution-worker.test.ts` | 真实 PostgreSQL：P0B05-T02（Claim→执行→Finish）、T03（Fencing）、T04（重试/终态/deadline）、T05（不支持 kind 隔离）、T06（优雅关闭 + Reaper 恢复） |

## 12. 遗留风险与已知偏差

- **结果不持久化**：`succeeded` 只代表模拟执行完成，重启不可恢复；这是 P0B-05 的显式边界，
  由 `durable: false` 与配置守卫共同表达，P0B-06 才提供产物与结果持久化；
- **`heavy` 路径不是真实调度**：只是路由结论，没有资源隔离或队列分级；
- **FakeSandbox 隔离强度**：进程内隔离，不能作为安全边界；真实隔离在 P0B-09+；
- **`mock.file` / `mock.approval` 可被其他未过滤队列 Claim**：能力过滤只在配置了
  `claimableKinds` 的 Worker 上生效，生产 Worker 必须使用该配置（当前入口已强制）；
- **单进程并发**：`runPollLoop` 是单进程内并发，没有跨进程协调（由 Lease 保证正确性）；
- **路由阈值是常量**：没有 Agent 级策略表或动态配置，P0B-07 的策略版本才有真实语义。
