# Ember V2-M0-A — Agent Head、Interactive Fast Path 与统一执行状态机契约

- **状态**: Proposed — 等待 Architect / CTO 审核冻结后进入 M1
- **日期**: 2026-11-19
- **工作包**: V2-M0-A（Agent Core / Fast Path）
- **分支**: `feat/v2-m0-runtime-contract`
- **上位决策与规范基准**:
  - [ADR-0006: Experience-first, Device-powered Runtime V2](../adr/0006-experience-first-device-powered-runtime-v2.md)
  - [ADR-0005: Cloudflare-native Cloud Runtime V2](../adr/0005-cloudflare-native-runtime-v2.md)
  - [ADR-0004: Beta V1 Live Platform Contract](../adr/0004-beta-v1-live-platform-contract.md) 与 [B1 Platform Contract](../product/B1_PLATFORM_CONTRACT.md)
  - [ADR-0001: Cancellation and Retry Coordination](../adr/0001-cancellation-and-retry-coordination.md)、[ADR-0002: Pre-claim Deadline Failure](../adr/0002-preclaim-deadline-failure.md)、[ADR-0003: P0B-06 Persistence Contract Freeze](../adr/0003-p0b-06-persistence-contract-freeze.md)

> **范围约束**: 本文件冻结 M0 最小工程契约与 M1 实施计划；**不**在本阶段建设完整 Runtime、**不**重写 V1、**不**引入通用多数据库抽象框架、**不**修改已冻结的 V1 Wire Contract，也不授权任何云资源创建、部署或付费 API 调用。

---

## 1. 目标拓扑与三条访问路径

依据 ADR-0006，V2 将 **Agent Head Durable Object（DO）** 作为单 Agent 状态的权威协调面，把耗时 I/O（LLM、Sandbox、Tools、设备节点）保留在 DO 外部：

```text
  iPhone / Mac / Web Client
        |                              ^
        | HTTPS / SSE                  | (future M2) Device Execution / Progress
        v                              |
  Edge API Worker (auth, route, B1 API, Interactive Executor + SSE Streaming)
        |                              ^
        | DO RPC (prepareTurn,         | Fenced commit / renew / handoff
        |   commitTurn, Direct reads)  |
        v                              |
  Agent Head DO (per tenant+agent; SQLite, FSM, Lease/Epoch, Local Budget, Outbox, 1 Alarm)
        |                    |
        | Fast Path          | Durable Path (Task / >120s Handoff / Recovery / Schedule)
        | (after prepareTurn)|
        v                    v
  Interactive Executor     Queues --> Execution Worker --> LLM / Daytona / Device
        |                                                       |
        +-----------------------+-------------------------------+
                                v
                   GlobalBudgetAuthority (Global Daily Cap + Halt)
                   D1 Recovery Registry (Agent B, uncovered/due markers only)
                   R2 (immutable blobs / staged uploads / artifacts)
```

### 1.1 三条路径职责边界

1. **Direct Path**: 读历史消息（`GET .../messages`）、查询 Turn/Task/Result 状态、会话管理、清除 Transcript（`DELETE /v1/me/conversation/messages`）。不触发 LLM、Queue 或 Sandbox。
2. **Interactive Fast Path**: 常规对话 Turn 与可快速响应的交互请求。Edge API Worker 鉴权后调用 `AgentHeadDO.prepareTurn`，在一个本地 SQLite 事务内原子接受消息并完成租约/预算预留（`send_started_at_ms` 保持 `NULL`）；随后在发起外部 Provider 请求前必须调用 `AgentHeadDO.markAttemptSent` 完成单次发送授权与有效租约复核；由 Edge API Worker 内的 **Interactive Executor** 直接流式或异步调用 Model Gateway，最后调用 `AgentHeadDO.commitTurn` 落盘结果并原子提交本地结算与 `budget_sync` Outbox。依据 ADR-0006（_"Target two core DO RPCs (prepare and fenced commit) for a simple turn, not an invariant"_），M1 采用 **3 次核心 DO RPC（`prepareTurn` → `markAttemptSent` → `commitTurn`）**，绝不为追求 2 次 RPC 牺牲单次发送防重与租约/取消/预算停机围栏的正确性。
3. **Durable Path**: 委派任务（`notes.action_items`、`python.agent`、`POST /v1/tasks`）、超过交互窗口上限的移交任务（SSE `120 s` 或 `waitUntil` `22 s`）、定时调度（Schedule）、审批恢复及独立异常恢复。通过 `v2_dispatch_outbox` + DO Alarm + Cloudflare Queues 投递到无状态 `Execution Worker`（或授权设备执行器），受同一套 `Run / Lease / Epoch` Fencing 保护。

---

## 2. V1 代码复用清单（Deliverable: V1 Reuse Inventory）

分析现有仓库源码后，按“直接复用”、“增量扩展（M1）”与“语义迁移（不引入通用多 DB 抽象）”三类明确边界。

### 2.1 可直接复用的模块（零修改或仅作为 Workspace 依赖引入）

| 包 / 路径                                                                                               | 可复用符号与能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 复用理由与边界                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/domain/src/types.ts`                                                                          | `Id`, `AuthContext`, `ExecutionPath`, `TASK_KINDS`, `TaskCommand`, `TaskStatus`, `TASK_STATUSES`, `TASK_TERMINAL_STATUSES`, `RunStatus`, `RUN_STATUSES`, `RUN_TERMINAL_STATUSES`, `LeasedRun`, `ApprovalStatus`, `APPROVAL_STATUSES`, `ApprovalDecision`, `TaskEventPhase`, `TASK_EVENT_PHASES`, `TaskEventPayload`, `TaskEvent`                                                                                                                                                                      | 纯 TypeScript 领域词表，零 HTTP/DB/Clock/Node 依赖，Edge/DO Worker 原生兼容。                  |
| `packages/domain/src/task-state-machine.ts`                                                             | `TASK_TRANSITION_TABLE`, `canTransitionTask`, `transitionTask`, `isTerminalTaskStatus`                                                                                                                                                                                                                                                                                                                                                                                                                | V1 权威 Task 状态机（含 ADR-0001/0002 规则）。                                                 |
| `packages/domain/src/run-state-machine.ts`                                                              | `RUN_TRANSITION_TABLE`, `canTransitionRun`, `transitionRun`, `isTerminalRunStatus`                                                                                                                                                                                                                                                                                                                                                                                                                    | V1 权威 Run 状态机，禁止 `lease_expired -> succeeded`。                                        |
| `packages/domain/src/approval-state-machine.ts`                                                         | `APPROVAL_TRANSITION_TABLE`, `canTransitionApprovalStatus`, `assertApprovalStatusTransition`, `isApprovalTerminalStatus`                                                                                                                                                                                                                                                                                                                                                                              | 审批状态转换纯函数。                                                                           |
| `packages/domain/src/errors.ts`                                                                         | `DOMAIN_ERROR_CODES`, `DomainError`, `isDomainError`, `InvalidStateTransitionError`, `InvalidArgumentError`, `Retryability`                                                                                                                                                                                                                                                                                                                                                                           | 封闭错误码表与脱敏诊断通道（`publicMessage` vs `diagnostic`）。                                |
| `packages/contracts/src/b1-live-schemas.ts`                                                             | 全部 B1 Wire DTO 与 Zod `strictObject` Schema（`B1Session*`, `B1MeResponseSchema`, `B1ConversationMessageSchema`, `B1SendMessageRequestSchema`, `B1SendMessageReceiptSchema`, `B1MessageSubmissionReconciliationDtoSchema`, `B1ConversationPageSchema`, `B1AssistantTurnDtoSchema`, `B1TaskResultDtoSchema`, `B1TaskSummaryDtoSchema`, `B1TaskCancelDtoSchema`, `B3StagedUploadReceiptDtoSchema`, `B3TaskArtifactsListDtoSchema`）                                                                    | 保持 B1 Wire 字节级兼容的单一权威。                                                            |
| `packages/contracts/src/task-schemas.ts`                                                                | `TASK_INPUT_LIMITS`, `PYTHON_AGENT_LIMITS`, `DELEGATION_TOOL_NAMES`, `CreateTaskRequestSchema`, `TaskCommandSchema`, `TaskReceiptSchema`, `TaskReceiptDtoSchema`, `toCreateTaskBody`, `toTaskCommand`, `toTaskReceiptDto`                                                                                                                                                                                                                                                                             | 输入字符上限与 Snake/Camel 转换逻辑。                                                          |
| `packages/contracts/src/event-schemas.ts`                                                               | `TaskEventPayloadSchema`, `TaskEventSchema`, `TaskEventDtoSchema`, `toTaskEventDto`                                                                                                                                                                                                                                                                                                                                                                                                                   | 封闭脱敏事件载荷（禁止明文 Prompt/Token 泄漏）。                                               |
| `packages/contracts/src/error-schemas.ts`                                                               | `DomainErrorCodeSchema`, `ErrorResponse`, `ErrorResponseSchema`, `toErrorResponse`                                                                                                                                                                                                                                                                                                                                                                                                                    | 统一错误响应体构造器。                                                                         |
| `packages/contracts/src/persistence.ts` & `interfaces.ts`                                               | `RunGrant`, `BudgetReservationAmount`, `BudgetOperationState`, `BudgetOperation`, `BudgetLedgerSnapshot`, `BudgetReserveRequest`, `BudgetSettleRequest`, `BudgetReleaseRequest`, `RouteDecision`, `RunExecutionContext`, `ArtifactRef`, `WorkspaceManifest`                                                                                                                                                                                                                                           | 端口类型与语义契约不变；`pg` 实现被 DO SQLite 适配器替代。                                     |
| `packages/execution/src/budget-guard.ts`                                                                | `BUDGET_DIMENSIONS`, `evaluateBudget`, `toBudgetDeniedError`, `toUtcDayKey`, `BudgetPolicy`, `BudgetSnapshot`, `BudgetAmount`                                                                                                                                                                                                                                                                                                                                                                         | 纯确定性预算裁决逻辑。                                                                         |
| `packages/execution/src/execution-router.ts`                                                            | `DeterministicExecutionRouter`, `ROUTER_POLICY_VERSION`, `ROUTER_THRESHOLDS`, `ROUTE_REASONS`                                                                                                                                                                                                                                                                                                                                                                                                         | 无状态路由策略函数。                                                                           |
| `packages/execution/src/sentinel-lite.ts`                                                               | `createDefaultSentinelPolicy`, `evaluateSentinelPolicy`, `toSentinelDeniedError`, `SENTINEL_POLICY_VERSION`                                                                                                                                                                                                                                                                                                                                                                                           | 无副作用安全策略门禁。                                                                         |
| `packages/execution/src/clock.ts`                                                                       | `linkAbortSignals`, `ExecutionClock`, `systemExecutionClock`                                                                                                                                                                                                                                                                                                                                                                                                                                          | `AbortSignal` 级联与时间抽象。                                                                 |
| `packages/execution/src/fake-llm.ts`, `fake-sandbox.ts`, `deterministic-executor.ts`                    | `FakeLlm`, `FAKE_LLM_MODEL`, `FakeSandboxProvider`, `DeterministicExecutor`                                                                                                                                                                                                                                                                                                                                                                                                                           | M1 本地隔离 Fake Provider 测试直接复用。                                                       |
| `packages/model-gateway/src/{limits,rates,config,context,preflight,errors,credentials,gateway,fake}.ts` | `MODEL_LIMITS`, `MODEL_BUDGET_ABSOLUTE_CEILINGS`, `estimateTokensConservative`, `APPROVED_REAL_MODELS`, `MODEL_RATE_ROWS`, `estimateCostMicroUsd`, `evaluateApproval`, `isPastShutdown`, `resolveModelExecution`, `isModelExecutionAuthorized`, `buildBoundedContext`, `preflightConversationTurn`, `preflightNotesActionItems`, `preflightPythonAgentStep`, `MODEL_FAILURE_CODES`, `ModelGatewayFailure`, `ModelInputRefused`, `ModelAuthorizationRefused`, `FakeModelGateway`, `createModelGateway` | 非流式调用、Token 预估、费率计算、审批有效期与下线日期检查、Pinned Routing 全部直接复用。      |
| `packages/postgres/src/storage/r2-blob-store.ts`                                                        | `R2BucketPort`, `uploadKeyFor`, `putR2Bytes`, `readR2Bytes`, `deleteR2Keys`, `sha256HexBytes`                                                                                                                                                                                                                                                                                                                                                                                                         | 零 `node:*` 依赖的 Edge-safe R2 操作原语（后续可提取至共享 edge-storage 包或直接子路径导入）。 |
| `apps/api/src/http/{error-mapping,bounded-body,app-context}.ts`                                         | `HTTP_STATUS_BY_DOMAIN_ERROR`, `respondWithDomainError`, `toInternalErrorResponse`, `readJsonBody`                                                                                                                                                                                                                                                                                                                                                                                                    | Edge API Worker 直接复用，确保 400/401/404/409/429/503/504 映射一致。                          |
| `apps/api/src/auth/*`, `conversation/*`, `turns/*`, `tasks/b1-task-routes.ts`                           | `requireSessionAuth`, `createB1SessionRoutes`, `createConversationMessageWriteRoutes`, `createConversationMessageReadRoutes`, `createB1TurnRoutes`, `createB1TaskRoutes`                                                                                                                                                                                                                                                                                                                              | 保持路由校验与 Handler 结构，底层注入 V2 Repository / DO RPC 适配器即可复用。                  |

### 2.2 M1 需要的增量扩展（不破坏 V1 现有接口）

1. **`@ember/model-gateway` 流式能力增量**:
   - **现状缺口**: `packages/model-gateway/src/index.ts` 注释明确说明当前刻意未实现 Streaming。
   - **M1 扩展**: 在 `ModelGateway` 增加可选或新方法 `streamConversationTurn(input, signal): AsyncIterable<ModelStreamEvent>`（或在独立接口 `StreamingModelGateway` 中定义），`FakeModelGateway` 优先实现确定性分片流、延迟注入、断流故障、缺失 Usage 故障与 `provider_job_handle` 模拟；`OpenAiModelGateway` / `OpenRouterModelGateway` 仅在后续获得独立 Canary 批准后启用真实 SSE 解析。必须保持 `isAuthorized()` Egress 门禁、`AbortSignal` 级联、`usage: ModelUsage | null` 一等语义和 `ModelFailureCode` 封闭异常映射。
2. **交互窗口 Deadline 与 Turn/Task 总 Deadline 分离**:
   - **现状**: `packages/postgres/src/repositories/b1-conversation-write.ts` 定义 `B1_TURN_DEADLINE_SECONDS = 60`；`packages/model-gateway/src/limits.ts` 定义 `attemptTimeoutMs = 20_000`、`turnDeadlineMs = 60_000`。
   - **M0 契约**: 显式分离 `interactive_deadline_ms`（交互窗口上限：V2 流式 `120_000 ms`，B1 `waitUntil` `22_000 ms`）与 `turn.deadline_at_ms`（Turn 总生命期上限：B1 兼容轮询保留 `60_000 ms`，V2 长推理移交 Turn 设为 `600_000 ms`）及 `task.deadline_at_ms`。交互窗口到期触发 Fenced 移交，不直接把可延续 Turn 误杀为超时。详见第 6.1 节。
3. **跨 Agent 租户级 `client_submission_id` 唯一性说明**:
   - **现状**: V1 规定 1 Consumer = 1 Tenant = 1 Default Agent = 1 Main Conversation，因此 `client_submission_id` 租户内唯一与 Agent Head DO 内唯一等价。
   - **约束**: 本契约冻结单 Tenant 单 Agent 映射到同一 `AgentHeadDO`；若 M3+ 引入单 Tenant 多 Agent，必须由 D1 或租户级协调索引维护 `(tenant_id, client_submission_id)` 唯一性，不得静默降级为单 Conversation 唯一。

### 2.3 不复用、仅继承语义的模块

- **`packages/postgres/src/repositories/*` 与 `packages/postgres/src/lease-queue/*`**: 强绑定 `pg.Pool`、`pg_advisory_xact_lock`、`SELECT ... FOR UPDATE SKIP LOCKED` 与 PostgreSQL `clock_timestamp()`。V2 **不**建立跨 PG/SQLite 的通用 ORM 或多数据库抽象层，而是将其事务不变量（如 `b1-conversation-write.ts`、`b1-turn-publication.ts`、`b2-model-turn-execution-repository.ts`、`b2-spend-ledger.ts`、`task-cancellation.ts`、`postgres-lease-queue.ts`）直接精确翻译为 Agent Head DO SQLite `transactionSync` + GlobalBudgetAuthority + D1 Recovery Registry 契约。

---

## 3. 统一执行状态机与 Fencing 不变量

V2 Fast Path 与 Durable Path **共享同一套状态机、Run/Lease/Epoch Fencing、取消与预算规则**，不建立两套平行状态机。

### 3.1 Assistant Turn 生命周期（兼容 B1 外部状态）

外部 B1 DTO（`B1AssistantTurnDto`）状态集保持严格封闭：`'running' | 'completed' | 'failed' | 'cancelled'`。内部增加执行模式与移交状态字段，使客户端不可见内部调度迁移，只感知合法收敛结果：

```text
                       [prepareTurn]
                             |
                             v
   +------------------->  running  <-------------------+
   |            (execution_mode: fast_interactive      |
   |             or durable_queue / device)            |
   |                         |                         |
   |   [handoff >120s /      |                         | [Queue / Alarm recovery
   |    delegate / fallback] |                         |  reclaims expired lease,
   +-------------------------+                         |  lease_epoch += 1]
   |                                                   |
   |   +--------------------+--------------------+-----+
   |   |                    |                    |
   v   v                    v                    v
 completed               failed              cancelled
(response_message_id    (response_message_id  (response_message_id = NULL
 NOT NULL;               NOT NULL; fixed safe  allowed per B1 T-2;
 optional task_ref)      msg; reason =         terminates active lease)
                         timeout|internal_error)
```

**不变量**:

1. `completed`、`failed`、`cancelled` 为不可逆终态；一旦进入终态，任何迟到 Executor（即使曾持有旧租约）的 `commitTurn` 必须被 Fence 拒绝并丢弃输出文本。
2. `running -> running` 仅允许内部 `execution_mode` 转换（如 `fast_interactive -> durable_queue`）或租约续期/重领（`lease_epoch += 1`），且受同一锁与单调 `lease_epoch` 串行化保护。
3. Transcript 删除（`clearTranscript`）在单个 `transactionSync` 内将所有 `running` Turn 置为 `cancelled`、`transcript_epoch += 1`，并清除 `conversation_messages` / `assistant_turns`；关联或已创建的 `tasks` / `runs` / `task_results` **不受影响**（B1 C-6）。

### 3.2 Task、Run 与 Approval 状态机（直接复用 `@ember/domain`）

- **Task (`task-state-machine.ts`)**: `queued -> {running, cancelled, failed}`；`running -> {completed, waiting_approval, retryable_failed, failed, cancelled}`；`waiting_approval -> {queued, failed, cancelled}`；`retryable_failed -> {queued, failed, cancelled}`；终态 `{completed, failed, cancelled}` 无出边。
- **Run (`run-state-machine.ts`)**: `created -> running -> {succeeded, failed_retryable, failed_terminal, lease_expired, cancelled}`。`lease_expired` 永不可转换为 `succeeded`；长任务 >120s 移交时，当前 Run 标记为 `handoff_state = 'handed_off'` 并收敛为 `succeeded`（若分阶段）或由新 Run 接力同一逻辑 Task（`attempt += 1`, `lease_epoch += 1`，携带同一 `provider_job_handle` / `checkpoint_ref`），**绝不允许两个 Run 同时持有同一个 Task/Turn 的写租约**。
- **Approval (`approval-state-machine.ts`)**: `pending -> {approved, denied, expired}`；取消 Task 时同步将 `pending` 审批过期并结算挂起预算。

### 3.3 Run / Lease / Epoch 四维 Fencing 契约

每次对 Turn 或 Task 的任何受保护写操作（`markAttemptSent`、`renewTurnLease`、`handoffTurnToDurable`、`commitTurn`、`commitDurableResult`），Agent Head DO 必须验证全部四项条件同时成立：

1. **Tenant & Agent 归属匹配**: `agent_head_meta.tenant_id === caller.tenantId && agent_head_meta.agent_id === caller.agentId`（不匹配返回 `NOT_FOUND`）。
2. **主体仍处于活跃态**: Turn 为 `status = 'running'`（或 Task 为 `status = 'running'` 且对应 Run `status = 'running'`），且 `cancel_requested_at_ms IS NULL`（注：已请求取消时允许 Executor 提交 `cancelled` 收敛，但禁止提交正常 `completed` 回复或开启新付费 Egress）。
3. **Epoch 与 Owner 精确相等**: `row.lease_epoch === cmd.leaseEpoch && row.lease_owner === cmd.leaseOwner`。
4. **租约与截止时间未过期**: `nowMs < row.lease_expires_at_ms` 且 `nowMs < row.deadline_at_ms`（以 DO 服务端单调采样时钟 `nowMs` 为准，绝不信任客户端或 Worker 传来的时钟用于延长预算）。

---

## 4. Agent Head 最小 SQLite Schema 与事务边界

每个 Agent Head DO 使用独立 SQLite 数据库（CF DO SQLite Storage API）。所有时间戳以 `INTEGER` UTC Unix 毫秒（`*_ms`）存储，日期桶 `utc_day` 以 `TEXT` (`YYYY-MM-DD`) 存储，金额以 `INTEGER` 微美元（`micro_usd`）存储（禁止浮点数）。

### 4.1 最小 Schema DDL（M1 基准）

```sql
-- 0. Schema 版本控制（DO 激活时在 blockConcurrencyWhile 内幂等执行）
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL,
  checksum      TEXT    NOT NULL
);

-- 1. Agent Head 身份锚点（单行，防止路由错乱或跨租户越权）
CREATE TABLE IF NOT EXISTS agent_head_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id      TEXT    NOT NULL,
  agent_id       TEXT    NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  home_region    TEXT,
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);

-- 2. 会话与 B1 消息表（继承 0012_conversation.sql 约束）
CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT    PRIMARY KEY,
  kind             TEXT    NOT NULL DEFAULT 'main' CHECK (kind = 'main'),
  last_sequence    INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  transcript_epoch INTEGER NOT NULL DEFAULT 0 CHECK (transcript_epoch >= 0),
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                   TEXT    PRIMARY KEY,
  conversation_id      TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence             INTEGER NOT NULL CHECK (sequence >= 1),
  kind                 TEXT    NOT NULL CHECK (
    kind IN ('user', 'ember', 'activity', 'task_reference', 'commitment_reference', 'outcome_reference')
  ),
  text                 TEXT,
  model_label          TEXT,
  simulated            INTEGER CHECK (simulated IS NULL OR simulated IN (0, 1)),
  source               TEXT,
  task_id              TEXT,
  commitment_id        TEXT,
  outcome_json         TEXT,
  client_submission_id TEXT,
  created_at_ms        INTEGER NOT NULL,
  UNIQUE (conversation_id, sequence),
  CHECK (
    (kind = 'user' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 4096
      AND client_submission_id IS NOT NULL AND model_label IS NULL AND simulated IS NULL
      AND source IS NULL AND task_id IS NULL AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'ember' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 8192
      AND model_label IS NOT NULL AND simulated IN (0, 1)
      AND client_submission_id IS NULL AND source IS NULL AND task_id IS NULL
      AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'activity' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 280
      AND source IS NOT NULL AND model_label IS NULL AND simulated IS NULL
      AND client_submission_id IS NULL AND task_id IS NULL AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'task_reference' AND task_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND client_submission_id IS NULL AND commitment_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'commitment_reference' AND commitment_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND client_submission_id IS NULL AND task_id IS NULL AND outcome_json IS NULL)
    OR
    (kind = 'outcome_reference' AND outcome_json IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND client_submission_id IS NULL AND task_id IS NULL AND commitment_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_submission
  ON conversation_messages (client_submission_id) WHERE client_submission_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_task_link
  ON conversation_messages (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
  ON conversation_messages (conversation_id, sequence);

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id  TEXT    NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),
  upload_id   TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  media_type  TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_key      TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  PRIMARY KEY (message_id, position)
);

-- 3. Assistant Turns（含 Fast/Durable 移交与 Lease/Epoch Fencing）
-- 注意区分 interactive_deadline_ms（交互窗口上限）与 deadline_at_ms（Turn 总生命期上限）
CREATE TABLE IF NOT EXISTS assistant_turns (
  id                      TEXT    PRIMARY KEY,
  conversation_id         TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id       TEXT    NOT NULL UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  response_message_id     TEXT    UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  status                  TEXT    NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  failure_reason          TEXT    CHECK (failure_reason IS NULL OR failure_reason IN ('timeout', 'internal_error')),
  execution_mode          TEXT    NOT NULL DEFAULT 'fast_interactive'
    CHECK (execution_mode IN ('fast_interactive', 'durable_queue', 'device')),
  deadline_at_ms          INTEGER NOT NULL,
  interactive_deadline_ms INTEGER,
  lease_epoch             INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner             TEXT,
  lease_expires_at_ms     INTEGER,
  claim_count             INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  cancel_requested_at_ms  INTEGER,
  provider_job_handle     TEXT,
  handoff_reason          TEXT,
  linked_task_id          TEXT,
  created_at_ms           INTEGER NOT NULL,
  updated_at_ms           INTEGER NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at_ms IS NULL)),
  CHECK (status != 'running' OR response_message_id IS NULL),
  CHECK (status NOT IN ('completed', 'failed') OR response_message_id IS NOT NULL),
  CHECK ((status = 'failed' AND failure_reason IS NOT NULL) OR (status != 'failed' AND failure_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_turns_running_lease
  ON assistant_turns (status, lease_expires_at_ms, deadline_at_ms) WHERE status = 'running';

-- 4. Tasks, Runs, Events, Results, Approvals（Durable Path 与长任务）
CREATE TABLE IF NOT EXISTS tasks (
  id                     TEXT    PRIMARY KEY,
  kind                   TEXT    NOT NULL CHECK (
    kind IN ('mock.chat', 'mock.compute', 'mock.file', 'mock.approval', 'notes.action_items', 'python.agent')
  ),
  title                  TEXT,
  input_json             TEXT    NOT NULL,
  digest                 TEXT    NOT NULL,
  idempotency_key        TEXT    NOT NULL UNIQUE,
  status                 TEXT    NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'waiting_approval', 'retryable_failed', 'completed', 'failed', 'cancelled')
  ),
  execution_path         TEXT    NOT NULL CHECK (execution_path IN ('fast', 'standard', 'heavy')),
  execution_target       TEXT    NOT NULL DEFAULT 'cloud' CHECK (execution_target IN ('cloud', 'device')),
  attempt_count          INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts           INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  current_run_id         TEXT,
  lease_epoch            INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at_ms    INTEGER,
  next_run_at_ms         INTEGER NOT NULL,
  deadline_at_ms         INTEGER,
  cancel_requested_at_ms INTEGER,
  provider_job_handle    TEXT,
  linked_message_id      TEXT,
  created_at_ms          INTEGER NOT NULL,
  updated_at_ms          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks (status, next_run_at_ms) WHERE status IN ('queued', 'retryable_failed');

CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT    PRIMARY KEY,
  task_id             TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt             INTEGER NOT NULL CHECK (attempt >= 1),
  lease_epoch         INTEGER NOT NULL CHECK (lease_epoch >= 1),
  status              TEXT    NOT NULL CHECK (
    status IN ('created', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'lease_expired', 'cancelled')
  ),
  worker_id           TEXT    NOT NULL,
  executor_kind       TEXT    NOT NULL CHECK (executor_kind IN ('interactive', 'queue_worker', 'device')),
  leased_until_ms     INTEGER NOT NULL,
  provider_job_handle TEXT,
  checkpoint_ref      TEXT,
  started_at_ms       INTEGER NOT NULL,
  finished_at_ms      INTEGER,
  updated_at_ms       INTEGER NOT NULL,
  UNIQUE (task_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_events (
  id             TEXT    PRIMARY KEY,
  task_id        TEXT    NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  sequence       INTEGER NOT NULL CHECK (sequence >= 1),
  phase          TEXT    NOT NULL CHECK (
    phase IN ('accepted', 'leased', 'started', 'progress', 'waiting_approval',
              'approval_granted', 'approval_denied', 'retry_scheduled', 'completed', 'failed', 'cancelled')
  ),
  payload_json   TEXT    NOT NULL,
  trace_id       TEXT    NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE (task_id, sequence),
  CHECK (phase != 'accepted' OR sequence = 1)
);

CREATE TABLE IF NOT EXISTS task_results (
  task_id      TEXT    PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  summary_text TEXT,
  detail_text  TEXT,
  model_label  TEXT    NOT NULL,
  simulated    INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  truncated    INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  reason_code  TEXT    NOT NULL,
  produced_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT    PRIMARY KEY,
  task_id       TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  lease_epoch   INTEGER NOT NULL,
  action_digest TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- 5. 统一模型调用账本与本地预算（Turn & Task 共用，替代 0014/0020 独立表）
CREATE TABLE IF NOT EXISTS model_attempts (
  subject_type            TEXT    NOT NULL CHECK (subject_type IN ('turn', 'task')),
  subject_id              TEXT    NOT NULL,
  attempt_no              INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 6),
  operation_id            TEXT    NOT NULL UNIQUE,
  principal_id            TEXT    NOT NULL,
  utc_day                 TEXT    NOT NULL,
  lease_epoch             INTEGER NOT NULL CHECK (lease_epoch >= 0),
  provider_id             TEXT    NOT NULL CHECK (provider_id IN ('fake', 'openai', 'openrouter')),
  model_label             TEXT    NOT NULL,
  rate_version            TEXT    NOT NULL,
  budget_mode             TEXT    NOT NULL CHECK (budget_mode IN ('disabled_echo_only', 'simulated_full_protocol', 'real')),
  state                   TEXT    NOT NULL CHECK (
    state IN ('reserved', 'settled', 'unknown_billed', 'released', 'conservative_billed')
  ),
  outcome_code            TEXT,
  reserved_micro_usd      INTEGER NOT NULL CHECK (reserved_micro_usd BETWEEN 0 AND 5000),
  applied_cost_micro_usd  INTEGER,
  observed_cost_micro_usd INTEGER,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  billing_basis           TEXT,
  overage_micro_usd       INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0),
  global_grant_id         TEXT,
  global_grant_expires_ms INTEGER,
  global_synced_at_ms     INTEGER,
  send_authorizing_at_ms  INTEGER, -- durable intent before global send authorization
  send_started_at_ms      INTEGER,
  started_at_ms           INTEGER NOT NULL,
  settled_at_ms           INTEGER,
  PRIMARY KEY (subject_type, subject_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS agent_spend_days (
  scope_kind         TEXT    NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id           TEXT    NOT NULL,
  utc_day            TEXT    NOT NULL,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  overage_micro_usd  INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0),
  turns_started      INTEGER NOT NULL DEFAULT 0 CHECK (turns_started >= 0),
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, utc_day)
);

CREATE TABLE IF NOT EXISTS agent_budget_incidents (
  id                    TEXT    PRIMARY KEY,
  scope_kind            TEXT    NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id              TEXT    NOT NULL,
  utc_day               TEXT    NOT NULL,
  reason                TEXT    NOT NULL CHECK (reason IN ('day_ceiling_exceeded', 'reservation_exceeded', 'usage_missing')),
  subject_type          TEXT,
  subject_id            TEXT,
  attempt_no            INTEGER,
  observed_micro_usd    INTEGER NOT NULL,
  applied_micro_usd     INTEGER NOT NULL,
  overage_micro_usd     INTEGER NOT NULL,
  reservation_micro_usd INTEGER NOT NULL,
  detected_at_ms        INTEGER NOT NULL,
  resolved_at_ms        INTEGER,
  resolved_by           TEXT,
  resolution_note       TEXT
);

-- 6. Outbox、定时调度与独立恢复覆盖记录（与 Agent B V2-M0-B 表结构对齐）
CREATE TABLE IF NOT EXISTS v2_dispatch_outbox (
  outbox_id             TEXT    PRIMARY KEY, -- e.g. 'turn:<id>' | 'task:<id>:ep:<epoch>' | 'budget_sync:<opId>'
  entity_kind           TEXT    NOT NULL CHECK (entity_kind IN ('turn', 'task', 'schedule_occurrence', 'handoff', 'budget_sync')),
  entity_id             TEXT    NOT NULL,
  queue_name            TEXT    CHECK (queue_name IS NULL OR queue_name IN ('durable_turn', 'agent_task')),
  payload_json          TEXT    NOT NULL, -- Queue 唤醒信封或 budget_sync 确定性载荷（无 Prompt/凭据）
  state                 TEXT    NOT NULL CHECK (state IN ('pending', 'enqueued', 'acked', 'dead_lettered', 'cancelled')),
  next_attempt_at_ms    INTEGER NOT NULL,
  last_enqueued_at_ms   INTEGER,
  publish_attempts      INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  dlq_count             INTEGER NOT NULL DEFAULT 0 CHECK (dlq_count >= 0),
  fence_epoch           INTEGER NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),
  last_error_code       TEXT,
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_outbox_due
  ON v2_dispatch_outbox (next_attempt_at_ms, outbox_id)
  WHERE state IN ('pending', 'enqueued', 'dead_lettered');

CREATE TABLE IF NOT EXISTS v2_schedules (
  schedule_id     TEXT    PRIMARY KEY,
  source_kind     TEXT    NOT NULL,
  source_id       TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('interval', 'cron_tz')),
  next_fire_at_ms INTEGER NOT NULL,
  last_fired_at_ms INTEGER,
  status          TEXT    NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  recurrence_rule TEXT,
  updated_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_schedules_due
  ON v2_schedules (next_fire_at_ms, schedule_id) WHERE status = 'active';

-- 单行恢复覆盖与 Alarm 状态记录（与 Agent B `v2_recovery_coverage` 严格对齐）
CREATE TABLE IF NOT EXISTS v2_recovery_coverage (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id              TEXT    NOT NULL,
  agent_id               TEXT    NOT NULL,
  generation             INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
  coverage_state         TEXT    NOT NULL DEFAULT 'uncovered'
    CHECK (coverage_state IN ('uncovered', 'registering', 'covered')),
  covered_recovery_at_ms INTEGER,
  pending_kind           TEXT CHECK (pending_kind IN ('ensure', 'postpone', 'retire')),
  pending_prev_generation INTEGER,
  pending_target_at_ms   INTEGER,
  armed_alarm_at_ms      INTEGER,
  alarm_fail_count       INTEGER NOT NULL DEFAULT 0 CHECK (alarm_fail_count >= 0),
  last_d1_sync_at_ms     INTEGER,
  updated_at_ms          INTEGER NOT NULL
);
```

### 4.2 事务边界、并发交错纪律与 Alarm 重新武装规则

1. **禁止事务内阻塞 I/O**: 所有 `ctx.storage.transactionSync(() => { ... })` 内部只允许执行 SQLite 读写与平台 Alarm 操作（`setAlarm` / `deleteAlarm`），严禁包含 `fetch`、Queue 发送、R2 读写、D1 查询或 `GlobalBudgetAuthority` RPC。
2. **Await 后的二次校验（TOCTOU 防护）**: Durable Object 在单个事件循环中一旦执行 `await`（如等待 `GlobalBudgetAuthority` 预留或 D1 覆盖登记），其他 RPC（如 `clearTranscript`、`cancelTurn` 或 Sweeper 退休询问）可以交错进入并修改 SQLite。因此所有跨 `await` 的状态变更必须在最后的 `transactionSync` 中**重新校验**前提条件（`transcript_epoch`、`client_submission_id`、`v2_recovery_coverage.generation/coverage_state`、取消标记），校验失败则回滚本地意图并对已获取的外部资源执行补偿释放。
3. **单一 Alarm 精确重算与重新武装（Re-arming）规则**:
   - 每个 `AgentHeadDO` 仅持有**唯一一个平台 Alarm**，`armed_alarm_at_ms` 持久化在 `v2_recovery_coverage` 中。
   - 每次写入事务结束前，统一计算全库所有未终态义务的最早到期时间：
     $$T_{\text{alarm}} = \min\Big(\text{v2\_dispatch\_outbox}(\text{pending/enqueued/dead\_lettered}),\; \text{assistant\_turns}(\text{running: lease/deadline}),\; \text{tasks}(\text{open: lease/next\_run/deadline}),\; \text{approvals}(\text{pending: expires}),\; \text{v2\_schedules}(\text{active: next\_fire})\Big)$$
   - **进入 `alarm()` 或 `reconcileFromRegistry()` 时**：因为平台触发 `alarm()` 后原有一次性 Alarm 已被消费，进入处理时必须视当前平台 `prevArmed = null`（或在 `alarm()` 内的最终 `transactionSync` 强制按最新 $T_{\text{alarm}}$ 重新武装）。
   - **重装条件（允许向更早移动，也允许向更晚移动）**:
     - 若 $T_{\text{alarm}} = \text{null}$（全量空闲）：仅当 `armed_alarm_at_ms !== null` 时调用 `ctx.storage.deleteAlarm()` 并置 `armed_alarm_at_ms = null`。
     - 若 $T_{\text{alarm}} \ne \text{null}$：只要 `T_alarm !== prevArmed`（**无论更早还是在当前最早义务完成后推进到更晚的未来 Schedule / Deadline**），均调用 `ctx.storage.setAlarm(T_alarm)` 并更新 `armed_alarm_at_ms = T_alarm`。
   - **批处理与错误隔离**：`alarm()` 先在一个 `transactionSync` 内收敛到期租约、推进批次（默认上限 10 条）并重装下一个 $T_{\text{alarm}}$，随后在事务外发布 Queue / 刷新 `budget_sync`；单条外部发布失败仅更新该条的退避 `next_attempt_at_ms` 并重算 $T_{\text{alarm}}$，不阻塞同批次其他实体。若 `alarm()` 本身抛出异常导致 CF 最多 6 次重试全部耗尽，第 8 节的外部 D1 `RecoverySweeper` 保证在 `<= 2 min` 检出、`<= 5 min` 恢复派发与重装未来 Alarm。

---

## 5. `prepareTurn` / `commitTurn` 与 Agent Head 内部 RPC 契约

### 5.1 最小内部接口定义（TypeScript 契约）

```typescript
export type TurnExecutionMode = 'fast_interactive' | 'durable_queue' | 'device';

export interface AgentHeadCallerScope {
  readonly tenantId: Id;
  readonly principalId: Id;
  readonly agentId: Id;
  readonly policyVersion: number;
  readonly requestId: Id;
}

export interface PrepareTurnRequest {
  readonly scope: AgentHeadCallerScope;
  readonly conversationId: Id;
  readonly request: B1SendMessageRequest;
  readonly workerId: string;
  readonly leaseMs: number; // 45_000 (SSE stream) or 25_000 (B1 waitUntil)
  readonly interactiveDeadlineMs: number; // 120_000 (SSE stream) or 22_000 (B1 waitUntil soft handoff)
  readonly turnDeadlineMs: number; // 60_000 (B1 poll compat) or 600_000 (V2 long-turn handoff budget)
  readonly executionMode: TurnExecutionMode;
  readonly modelReservation?: {
    readonly budgetMode: 'disabled_echo_only' | 'simulated_full_protocol' | 'real';
    readonly providerId: 'fake' | 'openai' | 'openrouter';
    readonly modelLabel: string;
    readonly rateVersion: string;
    readonly maxAttempts: number;
    readonly estimatedMicroUsd: number;
  };
}

export type PrepareTurnResult =
  | {
      readonly kind: 'prepared';
      readonly replayed: false;
      readonly receipt: B1SendMessageReceipt;
      readonly turnId: Id;
      readonly attemptNo: number;
      readonly operationId: Id;
      readonly leaseEpoch: number;
      readonly leaseExpiresAtMs: number;
      readonly interactiveDeadlineMs: number;
      readonly turnDeadlineMs: number;
      readonly utcDay: string;
      readonly reservedMicroUsd: number;
      readonly globalGrantId: string | null;
      readonly context: readonly B2TurnContextRow[];
      readonly attachments: readonly B2MessageAttachmentMeta[];
    }
  | {
      readonly kind: 'replay';
      readonly replayed: true;
      readonly receipt: B1SendMessageReceipt;
      readonly currentTurnStatus: 'running' | 'completed' | 'failed' | 'cancelled';
    };

/** 单次发送授权与有效租约/预算停机前置门禁（位于实际 Provider HTTP Egress 之前） */
export interface MarkAttemptSentRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly subjectType: 'turn' | 'task';
  readonly subjectId: Id;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
}

export type MarkAttemptSentResult =
  | { readonly authorized: true; readonly sentAtMs: number; readonly startBeforeMs: number }
  | {
      readonly authorized: false;
      readonly reason:
        'fenced' | 'expired' | 'cancelled' | 'already_sent' | 'budget_halted' | 'not_found';
    };

export interface RenewTurnLeaseRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly extendMs: number; // 45_000
}

export type RenewTurnLeaseResult =
  | { readonly renewed: true; readonly leaseExpiresAtMs: number; readonly cancelRequested: boolean }
  | { readonly renewed: false; readonly reason: 'fenced' | 'expired' | 'cancelled' | 'not_found' };

export interface HandoffTurnRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly reason: 'interactive_deadline_120s' | 'client_disconnect_handoff' | 'tool_delegation' | 'waituntil_window_handoff';
  readonly providerJobHandle?: string;
  readonly checkpointRef?: string;
}

export type HandoffTurnResult =
  | {
      readonly outcome: 'handed_off';
      readonly turnId: Id;
      readonly nextLeaseEpoch: number;
      readonly executionMode: 'durable_queue';
    }
  | {
      readonly outcome: 'fenced';
      readonly currentStatus: 'completed' | 'failed' | 'cancelled' | 'running';
    };

export interface CommitTurnRequest {
  readonly scope: Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
  readonly conversationId: Id;
  readonly turnId: Id;
  readonly leaseEpoch: number;
  readonly leaseOwner: string;
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly settlement: {
    readonly state: 'settled' | 'conservative_billed' | 'unknown_billed' | 'released';
    readonly outcomeCode:
      | 'ok'
      | 'model_timeout'
      | 'model_unavailable'
      | 'model_rate_limited'
      | 'model_auth_failed'
      | 'model_invalid_output'
      | 'client_cancelled'
      | 'not_sent'
      | 'usage_missing';
    readonly observedCostMicroUsd?: number | null;
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
  };
  readonly result:
    | {
        readonly status: 'completed';
        readonly text: string;
        readonly modelLabel: string;
        readonly simulated: boolean;
        readonly delegation?: B2TaskDelegationCommand;
      }
    | {
        readonly status: 'failed';
        readonly failureReason: 'timeout' | 'internal_error';
      }
    | {
        readonly status: 'aborted_for_retry_or_reconcile';
      };
}

export type CommitTurnResult =
  | {
      readonly outcome: 'published';
      readonly turn: B1AssistantTurnDto;
      readonly responseMessageId: Id;
      readonly sequence: number;
      readonly delegatedTaskId: Id | null;
    }
  | {
      readonly outcome: 'reconciled_only';
      readonly turn: B1AssistantTurnDto;
    }
  | {
      readonly outcome: 'fenced';
      readonly turn: B1AssistantTurnDto | null;
    };

export interface AgentHeadRpc {
  prepareTurn(req: PrepareTurnRequest): Promise<PrepareTurnResult>;
  markAttemptSent(req: MarkAttemptSentRequest): Promise<MarkAttemptSentResult>;
  renewTurnLease(req: RenewTurnLeaseRequest): Promise<RenewTurnLeaseResult>;
  handoffTurnToDurable(req: HandoffTurnRequest): Promise<HandoffTurnResult>;
  commitTurn(req: CommitTurnRequest): Promise<CommitTurnResult>;
  cancelTurn(req: {
    tenantId: Id;
    agentId: Id;
    conversationId: Id;
    turnId: Id;
  }): Promise<B1AssistantTurnDto>;
  clearTranscript(req: {
    tenantId: Id;
    agentId: Id;
    conversationId: Id;
  }): Promise<B1TranscriptClearResult>;
  // Direct Path Reads (零队列 / 零 LLM)
  readMessages(req: {
    tenantId: Id;
    agentId: Id;
    conversationId: Id;
    after: number;
    limit: number;
  }): Promise<B1ConversationPage>;
  findSubmissionReceipt(req: {
    tenantId: Id;
    agentId: Id;
    clientSubmissionId: Id;
  }): Promise<B1MessageSubmissionReconciliationDto | null>;
  getTurn(req: {
    tenantId: Id;
    agentId: Id;
    conversationId: Id;
    turnId: Id;
  }): Promise<B1AssistantTurnDto | null>;
}
```

### 5.2 `prepareTurn`、`markAttemptSent` 与 V1 模型调用上限对齐

#### (1) `prepareTurn` 三阶段执行语义

1. **Stage 1 — 本地只读/意向预检 (`transactionSync` #1)**:
   - 校验 `agent_head_meta` 与 `conversations`（不匹配抛出 `NOT_FOUND`）。
   - 校验 `request.transcript_epoch === conversations.transcript_epoch`；不等则抛出 `IDEMPOTENCY_CONFLICT` (409)。
   - 查询 `conversation_messages` 中 `client_submission_id`：
     - 若存在且 `conversation_id`、`text`、`attachment_ids` 完全一致 → 直接返回 `{ kind: 'replay', replayed: true, receipt, currentTurnStatus }`（**零外部预算调用、零 D1 I/O、零新计费**）。
     - 若存在但内容不一致 → 抛出 `IDEMPOTENCY_CONFLICT` (409)。
   - 校验 24 小时滚动消息配额（`200` 条，`BUDGET_EXCEEDED` 429）、本地日预算（`principalDailyTurns <= 60`、`principalDailyMicroUsd`、`tenantDailyMicroUsd`）及未解决的 `agent_budget_incidents`。
   - 校验附件指针有效性，读取最近 `maxContextMessages = 8` 条上下文。
   - 计算所需发现截止时间 `requiredDiscoveryMs = nowMs + leaseMs + 15_000`（Fast Path），读取 `v2_recovery_coverage`：
     - 若 `coverage_state === 'covered' && covered_recovery_at_ms !== null && covered_recovery_at_ms <= requiredDiscoveryMs`：标记 `needsRegistryUpsert = false`（**已覆盖路径零同步 D1 I/O**）。
     - 否则（`uncovered`、`registering` 或 `requiredDiscoveryMs < covered_recovery_at_ms`）：在**同一 `transactionSync` #1 内**原子推进 `generation = generation + 1`，置 `coverage_state = 'registering'`，持久化 pending_kind='ensure'、目标时间、旧世代，获取本次独占的 `intendedGen`（`needsRegistryUpsert = true`），从而保证并发请求绝不会使用同一个 `generation` 写 D1。
   - 预先生成唯一 `operationId`（UUIDv4）。
2. **Stage 2 — 外部权威预注册（仅按需，位于任何 SQLite 事务之外）**:
   - **恢复覆盖登记**: 仅当 `needsRegistryUpsert === true` 时，调用 `RecoveryRegistryPort.upsertCoverage({ tenantId, agentId, generation: intendedGen, recoveryAtMs: requiredDiscoveryMs })`。若 D1 返回 `{ accepted: false, currentGeneration }`（D1 世代超前 DO），DO 通过单次受限快进把本地 `generation` 同步至 `max(generation, currentGeneration) + 1` 并重试一次；若 D1 不可用则 **Fail Closed (`DB_UNAVAILABLE` 503)**，绝不提交未覆盖义务。
   - **全局预算预留**: 仅当 `budgetMode !== 'disabled_echo_only'`（即 `'real'` 与 M1 `'simulated_full_protocol'` 的 Fake Provider 均须执行！）且预留金额 `> 0` 时，调用 `GlobalBudgetAuthority.reserveGlobal(...)`；若超限或存在全局未解决事故，返回 `BUDGET_EXCEEDED` (429)；若不可用，返回 `DB_UNAVAILABLE` (503)。
3. **Stage 3 — 原子本地提交 (`transactionSync` #2)**:
   - 重新校验 Stage 1 所有前置条件（`transcript_epoch`、`client_submission_id`、配额、本地预算与 Incidents）以及覆盖条件（若 `needsRegistryUpsert`：要求 `v2_recovery_coverage.generation === intendedGen && coverage_state === 'registering'` 且有同代 D1 成功回执、实际时间覆盖全部现存义务和本次 D(O)，或已被并发完成且 `coverage_state === 'covered' && covered_recovery_at_ms <= requiredDiscoveryMs`；若未需要登记：要求依然满足 `coverage_state === 'covered' && covered_recovery_at_ms <= requiredDiscoveryMs`）。
   - **Stage 3 交错失败补偿**: 若校验发现已被并发 `clearTranscript` / 并发重放 / Sweeper 失效打断，且 Stage 2 已获取 `globalGrantId`：在已具备有效覆盖且证明仅是本候选未提交预留时，在**本次 `transactionSync` 内**写入一条 `v2_dispatch_outbox` 补偿行（`entity_kind = 'budget_sync'`, `payload_json = { op: 'release', operationId, globalGrantId }`）并重算 Alarm，随后立即异步尝试 `GlobalBudgetAuthority.settleGlobal({ state: 'released', ... })`，再返回 `409` / `replay` / `503`！补偿 Outbox 必须具备已确认独立恢复覆盖；若覆盖已失效，仅可安全尝试按自身未提交 Operation 释放，未知或失败由 Global TTL 保守结转，不能创建新的不可恢复义务。事务应正常返回分类结果后再映射 HTTP 错误，不能抛错回滚已持久化的补偿记录。
   - 校验全部通过后，在同一 `transactionSync` 内：
     - 分配 `sequence = last_sequence + 1`；插入 `user` 消息 + `message_attachments`；
     - 创建 `assistant_turns`（`status = 'running'`，`lease_epoch = 1`，`lease_owner = workerId`，`lease_expires_at_ms = nowMs + leaseMs`，`interactive_deadline_ms = nowMs + interactiveDeadlineMs`，`deadline_at_ms = nowMs + turnDeadlineMs`）；
     - 写入 `model_attempts`（`attempt_no = 1`，`state = 'reserved'`，**`send_started_at_ms = NULL`**，`global_grant_id`）；
     - 更新 `agent_spend_days`；
     - 写入 `v2_dispatch_outbox`（`next_attempt_at_ms = lease_expires_at_ms + 5_000`）；
     - 若本次以 `intendedGen` 完成登记，将 `v2_recovery_coverage` 推进为 `coverage_state = 'covered'`、`covered_recovery_at_ms = actualRecoveryAtMs`（权威实际值而非本地推算），确认后清除 pending，并按第 4.2 节重算重装 Alarm。

#### (2) `markAttemptSent` 单次发送授权与有效租约检查（第 2 次 DO RPC）

每次出网调用模型前（Fast/Durable），必须调用 markAttemptSent。先在本地事务验证条件并以 CAS 写入唯一 send_authorizing_at_ms 意图；计价真实/Fake 在事务外调用 GlobalBudgetAuthority.authorizeGlobalSend（匹配绑定、未过期未结算 Grant、全局 Halt、一次性授权），再在最终本地事务重验全部条件及当前意图。响应未知不重复发放授权、不自动退款；disabled_echo_only 不能调用真实供应商。最终 CAS：

- 在单个 `transactionSync` 内检查：
  1. `model_attempts` 存在且 `state === 'reserved'` 且 **`send_started_at_ms IS NULL`**（保证每个 `attempt_no` 最多一次出网发送）；
  2. 对应 Turn/Task 仍为 `status === 'running'`、`cancel_requested_at_ms IS NULL`、`lease_epoch === req.leaseEpoch`、`lease_owner === req.leaseOwner`、`nowMs < lease_expires_at_ms`、`nowMs < deadline_at_ms`；
  3. 当前无相关未解决的 `agent_budget_incidents`，Operation/Attempt/Grant 归属、Turn 原 Transcript Epoch 或 Task current_run_id、阶段截止与 Grant 期限都有效；严禁使用旧缓存代替权威检查。
- 仅当全部满足时原子写入 `send_started_at_ms = nowMs` 并返回 `{ authorized: true, sentAtMs, startBeforeMs }`（不得晚于 Grant、Lease、阶段及总截止）；否则返回 `{ authorized: false, reason }`，执行器**严禁调用 Provider**，只有能证明该 Operation 未获发送授权、未发且无不确定结果时才允许 released；already_sent 或未知授权不能退款。成功结果在 startBeforeMs 之前单次 fetch、检查 AbortSignal 与受信 Provider 配置，不作无幂等保证的 SDK 自动重发。授权后取消不能撤回已授权外部调用，应中止可中止请求并 Fence 结果。

#### (3) V1 Model Attempt 与累计成本上限对齐（强制不变量）

| 约束维度                         | V1 权威常量（来源）                                                                                                                  | V2 Agent Head 强制上限                                        | 校验位置                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Turn 最大尝试次数                | `MODEL_LIMITS.maxAttemptsPerTurn = 2`（`StagingAlpha`: `1`）                                                                         | `attempt_no <= maxAttempts`（`<= 2` 或策略指定 `1`）          | `prepareTurn` / `reserveAttempt`                           |
| 单次 Attempt 预留上限            | `MODEL_LIMITS.maxReservedMicroUsdPerAttempt = 5_000`                                                                                 | `reserved_micro_usd <= 5_000`（超过直接 `ModelInputRefused`） | `preflight` + SQLite CHECK                                 |
| 常规 Task 累计模型尝试           | `MODEL_LIMITS.maxModelAttemptsPerTask = 4`                                                                                           | 跨 Run 累计 `COUNT(model_attempts) <= 4`                      | Durable `reserveAttempt`                                   |
| 常规 Task 累计模型成本           | `MODEL_LIMITS.maxModelCostPerTaskMicroUsd = 20_000`                                                                                  | 跨 Run 累计预留+消耗 `<= 20_000 micro_usd`                    | Durable `reserveAttempt`                                   |
| `python.agent` 单 Run / 累计尝试 | `PYTHON_AGENT_LIMITS.maxLlmCallsPerRun = 4` / `maxLlmCallsPerTask = 6`                                                               | 单 Run `<= 4`，跨 Run 累计 `<= 6`                             | Durable `reserveAttempt`                                   |
| `python.agent` 累计成本          | `PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd = 30_000`                                                                                   | 跨 Run 累计预留+消耗 `<= 30_000 micro_usd`                    | Durable `reserveAttempt`                                   |
| 日预算与 Turn 次数               | `principalDailyTurns = 60`, `principalDailyMicroUsd = 250_000`, `tenantDailyMicroUsd = 1_000_000`, `globalDailyMicroUsd = 5_000_000` | 严格继承，由 `AgentHeadDO` + `GlobalBudgetDO` 原子校验        | `prepareTurn` / `reserveAttempt` + `GlobalBudgetAuthority` |

### 5.3 `commitTurn` 原子结算与发布语义（第 3 次 DO RPC）

发送前的恢复覆盖须包含后续 budget_sync 义务直至权威 ACK；取消/Transcript 清除不得删除账本和未同步记录。按 tenant/subject/attempt/operation/grant 原绑定校验每次结算。固定结算载荷不可被重复结果覆盖；迟到超额以 operationId + revision 的独立幂等修正补记，不覆盖已 ACK 的原结算。failed 的固定安全 ember 回复与终态必须同事务，取消保持 B1 T-2/T-4。

- **Fencing 失败路径**（`lease_epoch` / `lease_owner` 不匹配，或 `status !== 'running'`）：
  - **绝对禁止**写入 `conversation_messages` 或触发 `delegation`，返回 `{ outcome: 'fenced', turn }`；
  - 若 `model_attempts` 为 `'unknown_billed'` 且本次迟到提交携带真实 `observedCostMicroUsd > reserved_micro_usd`，按第 7.2 节迟到结算规则仅补记 `overage_micro_usd`、开启 Incident Halt 并原子写入 `budget_sync` Outbox（**绝不退款**）。
- **Fencing 通过路径**：
  - 在**同一个 `transactionSync`** 内：
    1. 结算 `model_attempts` 与 `agent_spend_days`（`settled` / `conservative_billed` / `unknown_billed` / `released`；超支或 `usage_missing` 时写入 `agent_budget_incidents` 并触发 Halt）；
    2. **原子写入 `budget_sync` Outbox**: 只要 `global_grant_id !== null`，必须在同一事务插入 `v2_dispatch_outbox`（`outbox_id = 'budget_sync:' + operationId`, `entity_kind = 'budget_sync'`, `state = 'pending'`, `next_attempt_at_ms = nowMs`）；
    3. 若 `result.status === 'completed'`：写入 `ember` 消息（`sequence += 1`, `model_label`, `simulated`）；若有 `delegation`，同时创建 `tasks` + `task_events(accepted)` + `task_reference` 消息（`sequence += 1`）+ `v2_dispatch_outbox(task)`；将 `assistant_turns` 置为 `completed` 并完成 Turn 的 `v2_dispatch_outbox`；按第 4.2 节重算并重装 Alarm。
  - 若 `delegation` 产生新的更早未覆盖到期时间，在进入最终 `transactionSync` 前先通过第 8.2 节协议完成 D1 `upsertCoverage`（若 D1 不可用，不允许提交未覆盖后台 Task）。
  - **事务外即时刷新**: `commitTurn` 事务提交后立即异步调用 `GlobalBudgetAuthority.settleGlobal(...)`，成功后以短 `transactionSync` 标记 `model_attempts.global_synced_at_ms = nowMs` 且 `budget_sync` Outbox 为 `acked`；若调用失败或 DO 重启，Alarm + `v2_dispatch_outbox` 自动重试直至全局结算完成。

---

## 6. Edge API Worker Streaming、断连恢复与 >120s 移交

### 6.1 M0 冻结时间参数表（区分交互窗口、`waitUntil` 窗口与总 Deadline）

| 参数                                       | V1 现状                               | V2 M0-A 冻结规范                                                                                                | 说明                                                                                               |
| ------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `leaseDurationMs`                          | `30_000` (Tasks/Turns)                | **SSE 连接流式**: `45_000` ms；**B1 `waitUntil` 加速路径**: **`25_000` ms**；Durable Path: `30_000`–`45_000` ms | B1 `waitUntil` 租约必须严格小于 CF `30 s` 硬上限，避免隔离区被杀后空等 15 s 才触发恢复。           |
| `leaseRenewalIntervalMs`                   | `10_000` (Tasks)                      | **SSE 连接流式**: `15_000` ms（仅在活跃流式执行期间续期）；B1 `waitUntil` 不续期                                | 严格小于 `leaseDurationMs / 2`，零空闲心跳。                                                       |
| 静默丢失恢复窗口                           | Cron `* * * * *`                      | **SSE 正常路径 `<= 60_000` ms**（`45 s + <= 15 s`）；**`waitUntil` 路径 `<= 40_000` ms**（`25 s + <= 15 s`）    | 非平台 SLA，为 M1 确定性故障测试目标。                                                             |
| `attemptTimeoutMs`                         | `20_000`                              | 单次非流式 HTTP 请求 `20_000` ms；流式首 Token / 空闲分片超时 `30_000` ms                                       | 绑定 `AbortSignal`，防止无限悬挂。                                                                 |
| `interactive_deadline_ms`（交互窗口上限）  | —                                     | **SSE 流式**: `120_000` ms（软移交窗口 `105–115 s`）；**B1 `waitUntil`**: **`22_000` ms**（30 s 前软移交）      | 仅在逻辑总时限仍有效时 Fenced 移交；转移/续租不延长总时限，已到期按原契约终止。                 |
| `turn.deadline_at_ms`（Turn 总生命期上限） | `60_000` (`B1_TURN_DEADLINE_SECONDS`) | **B1 兼容 Turn**: `60_000` ms；**V2 长推理移交 Turn 本地实验**: `600_000` ms（独立受信总时限，非已批准 Wire）                     | **必须与 `interactive_deadline_ms` 分离**，否则 >120 s 移交入队后会被 `expireTurnIfDue` 立即误杀。 |
| `task.deadline_at_ms`（Task 总截止时间）   | `CreateTaskRequest.deadline_at`       | 由客户端请求或 Task 策略独立设置，不受单次交互 `120 s` 窗口约束                                                 | ADR-0002 未领超时规则仅作用于 `task.deadline_at_ms`。                                              |

### 6.2 Streaming 托管、`waitUntil` 对齐与防重复规则

B1 加速窗口从权威接受时刻计时；只有在剩余 22 s 窗口可容纳授权、Provider 超时、提交或安全移交余量时才启动一次调用，否则直接以 Durable Queue 优先派发。默认可退回立即到期的 Durable Outbox（不预占 Fast Lease）；waitUntil 不能作为唯一执行保证。B1 model-disabled staging 与开发环境 on-read timeout 行为保持不变。

- **托管位置**: Interactive Executor 运行于 Edge API Worker 请求处理生命周期内，**绝不在 Agent Head DO 内持有流式连接或 `await` 模型输出**，避免 DO 产生高额 Duration 计费并阻塞同一用户的其他并发请求。
- **零 Per-Token 持久化**: 流式输出使用有界内存缓冲（仅聚合最终完整文本用于 `commitTurn`），严禁每个 Token 写入 DO SQLite。
- **B1 非流式兼容路径 (`POST /v1/conversations/{id}/messages`) 与 30 s `waitUntil` 窗口对齐**:
  - Edge Worker 在 `prepareTurn` 提交后同步返回 `201/200 B1SendMessageReceipt`；`prepareTurn` 为该加速路径签发 **`leaseMs = 25_000 ms`**、**`interactiveDeadlineMs = 22_000 ms`**、`turnDeadlineMs = 60_000 ms`（且写入 `v2_dispatch_outbox` 于 `T + 27_000 ms`）。
  - 随后在 `ctx.waitUntil(...)` 内调用 `markAttemptSent` 并执行最多 **1 次**有界尝试（`attemptTimeoutMs = 20_000 ms`）：
    - 若在 `<= 22 s` 内完成：调用 `commitTurn` 发布回复（正常 1–3 s 完成，绕过队列冷延迟）；
    - 若逼近 `22 s`（CF 30 s `waitUntil` 截断前）仍未完成，或遇到可重试错误且距 `60 s` B1 Deadline 仍有余量：立即调用 `handoffTurnToDurable(reason: 'waituntil_window_handoff')` 将控制权原子移交至 Durable Queue（`Execution Worker` 无 30 s HTTP 限制，目标于 `T + 23–25 s` 接管，在剩余 B1 总时限内合法执行或收敛（不保证模型完成））；
    - 若 `waitUntil` 在 `25 s` 内静默崩溃：租约于 `T + 25 s` 到期，DO Alarm 在 `<= T + 40 s` 触发接管并派发 Queue，仅在剩余总 Deadline 内继续可恢复/确定未发的工作；不足则按 B1 原有超时规则收敛，不盲目重发。
- **V2 流式路径（M1/M3 需经版本化 Wire 审批后启用，如 `POST /v2/conversations/{id}/messages/stream`）**:
  - 只要 HTTP 响应流保持连接，Workers Standard 不受 `waitUntil` 30 s 限制，使用 **`leaseMs = 45_000 ms`**、**`15_000 ms` 续期**、**`interactiveDeadlineMs = 120_000 ms`** 及 **`turnDeadlineMs = 600_000 ms`**；
  - `prepareTurn` 成功后下发 `event: turn.accepted`（含完整 `B1SendMessageReceipt` 与 `transcript_epoch`）；`markAttemptSent` 通过后持续推送 `event: turn.delta`（临时未提交文本，不入库）；完成时先调用 `commitTurn` 成功再下发 `event: turn.committed`；触发 >120 s 移交时在 `handoffTurnToDurable` 成功后下发 `event: turn.handed_off`。
- **断连恢复**: 客户端重连后通过 `GET /v1/conversations/{id}/messages?after=<last_confirmed_seq>` 与 `GET /v1/conversations/{id}/turns/{turn_id}` 获取权威状态，按 `message_id`/`sequence` 对账；本地 UI 丢弃未提交的临时 Stream Buffer，绝不产生重复消息。

### 6.3 断连、静默崩溃与 >120s 推理移交流程

```text
Edge API Worker (Interactive Executor)            Agent Head DO                Queue / Execution Worker
  |                                                     |                                |
  |--- 1. prepareTurn (SSE:45s/120s | B1:25s/22s) ----->| [msg+turn+reserved+outbox]     |
  |<-- prepared (epoch=1, opId, send_started=NULL) -----|                                |
  |                                                     |                                |
  |--- 2. markAttemptSent (epoch=1, opId) ------------->| [verify lease/cancel/halt;     |
  |<-- authorized (send_started_at_ms = now) -----------|  set send_started_at_ms]       |
  |                                                     |                                |
  |=== Scenario A: Observed Client Disconnect =========>|                                |
  |  1. Stop 15s lease renewal timer immediately        |                                |
  |  2. If provider_job_handle exists -> handoffTurnToDurable -------------------------->|
  |     Else -> abort provider AbortSignal; commitTurn(unknown_billed / released)        |
  |                                                     |                                |
  |=== Scenario B: Silent Worker Loss =================>|                                |
  |  (Worker killed; no renewal)                        |                                |
  |                            [Lease expires (45s SSE / 25s B1); Alarm <= +15s fires]   |
  |                                                     |--- reconcileExpiredLease()     |
  |                                                     |    - if send_started=NULL:     |
  |                                                     |        mark attempt `released`   |
  |                                                     |    - else: mark `unknown_billed`|
  |                                                     |    - if handle: enqueue Queue ->|
  |                                                     |                                |
  |=== Scenario C: Reasoning > 120s (or B1 > 22s) =====>|                                |
  |  1. Capture provider_job_handle / checkpointRef     |                                |
  |--- handoffTurnToDurable(epoch=1, handle) ---------->| [epoch=2, mode=durable_queue,  |
  |<-- handed_off (nextLeaseEpoch=2) -------------------|  outbox due=now, alarm/queue] ->|
  |  2. Emit SSE `turn.handed_off` & close stream       |                                |
  |                                                     |<-- claimDurableWork(epoch=2) --|
  |                                                     |    poll/resume handle -> commit|
```

**不可恢复 Provider 诚实降级规则**: 若模型 Provider 不支持流恢复或无 `provider_job_handle` 且结果不确定（如超时前未返回 Job Handle），严禁暗中重放非幂等调用或静默截断任务；必须将 `model_attempts` 标记为 `unknown_billed`（保留全部预留额度），并按恢复策略明确收敛为 `failed (timeout)` 或向用户展示明确的不确定结果状态。

---

## 7. 全局与单 Agent 预算权威及原子预留协议

V2 必须无条件保持 V1 四维日预算上限（`perAttemptMicroUsd <= 5_000`、`principalDailyMicroUsd <= 250_000`、`principalDailyTurns <= 60`、`tenantDailyMicroUsd <= 1_000_000`、`globalDailyMicroUsd <= 5_000_000`）及 Incident Halt（`day_ceiling_exceeded`、`reservation_exceeded`、`usage_missing`）安全性质。

### 7.1 双层协同与并发防超支协议

1. **单 Agent 权威（`AgentHeadDO` SQLite）**:
   - 拥有 `agent_spend_days`（`tenant` 与 `principal` 维度）和 `model_attempts`。
   - 因单 DO 串行执行 `transactionSync`，同租户同 Agent 下的并发前台 Turn 与后台 Task 自动串行检查与预留，零锁死风险。
2. **全局平台权威（`GlobalBudgetAuthority` — 首选单实例 SQLite DO `GlobalBudgetDO`）**:
   - 维护全局跨租户每日桶 `global_spend_days (utc_day, reserved_micro_usd, consumed_micro_usd, overage_micro_usd)`、全局预算操作表 `global_budget_reservations (operation_id PRIMARY KEY, tenant_id, principal_id, agent_id, lease_epoch, utc_day, amount_micro_usd, state, expires_at_ms, overage_micro_usd)` 与全局未解决事故表 `global_budget_incidents`。
   - **禁止使用最终一致缓存替代**: 任何 `budgetMode === 'real'` **以及 M1 测试阶段的 `budgetMode === 'simulated_full_protocol'`**（Fake Provider 必须走通完整全局与本地预算协议，不得跳过 `GlobalBudgetAuthority`！）的出网前，均必须持有来自 `GlobalBudgetAuthority` 的权威预留收据 `globalGrantId`（M1 目标：近区 P95 `<= 50 ms`，计入 `200 ms` Runtime 预算内）。

```typescript
export interface GlobalBudgetAuthority {
  reserveGlobal(req: {
    readonly tenantId: Id;
    readonly principalId: Id;
    readonly agentId: Id;
    readonly operationId: Id;
    readonly leaseEpoch: number;
    readonly utcDay: string;
    readonly amountMicroUsd: number;
    readonly ceilingMicroUsd: number;
    readonly expiresAtMs: number;
  }): Promise<
    | { readonly kind: 'reserved'; readonly globalGrantId: string; readonly replayed: boolean }
    | { readonly kind: 'budget_exceeded' }
    | {
        readonly kind: 'budget_halted';
        readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
      }
  >;

  /** Global 权威串行校验未使用、未过期 Grant 与 Incident，只发一次许可。 */
  authorizeGlobalSend(req: {
    readonly tenantId: Id;
    readonly operationId: Id;
    readonly globalGrantId: string;
  }): Promise<{ readonly authorized: boolean; readonly startBeforeMs?: number }>;

  renewGlobalGrant(req: {
    readonly tenantId: Id;
    readonly operationId: Id;
    readonly globalGrantId: string;
    readonly newExpiresAtMs: number;
  }): Promise<{ readonly renewed: boolean; readonly state: string }>;

  settleGlobal(req: {
    readonly tenantId: Id;
    readonly operationId: Id;
    readonly globalGrantId: string;
    readonly state: 'settled' | 'conservative_billed' | 'unknown_billed' | 'released';
    readonly observedCostMicroUsd?: number | null;
    readonly chargeMicroUsd: number; // 0 when released; reserved when conservative_billed/unknown_billed
    readonly reservedMicroUsd: number;
    readonly openIncidentReason?: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
  }): Promise<{
    readonly applied: boolean;
    readonly alreadySettled: boolean;
    readonly effectiveState:
      'settled' | 'conservative_billed' | 'unknown_billed' | 'released' | 'expired_consumed';
    readonly incidentOpened: boolean;
  }>;
}
```

### 7.2 预留归属、补偿释放、过期 Grant、迟到结算与 Incident Halt 规则

**权威边界（强制）**：M1 限于 B1 一个 tenant/principal 对一个 canonical Agent 的映射，不能用多个 Agent 重复获得同一作用域预算。Global 事务串行 reserve/authorize/settle/Incident；本地发现事故立即阻断相关作用域，Global 确认结算前该 Agent 禁止新计价 Attempt。跨 DO 尚未同步的事故不具备原子可见性；M1 必测其他 Agent 并发、同步失败及事故传播窗口，若不能证明 V1 全局 Halt 语义，须在真实供应商许可前采用经审核的严格权威协议，不得宣称已通过。预算预留上限不是对供应商实际超额收费的保证。Budget check 50 ms P95 包括 reserve 和 authorize 的累计关键路径，仍计入 Runtime 200 ms。

1. **预留先于 Egress 与预留归属（Ownership）**:
   - 调用链：`GlobalBudgetAuthority.reserveGlobal` → `AgentHeadDO` 本地提交（`state = 'reserved'`, `send_started_at_ms = NULL`）→ `AgentHeadDO.markAttemptSent`（校验有效租约、`cancel_requested_at_ms IS NULL`、无 Halt）→ `isModelExecutionAuthorized` → 发起 Provider 请求。
   - 每笔预留唯一归属 `(tenantId, principalId, agentId, operationId, leaseEpoch)`。新计价 Attempt 必须生成新 Operation ID；同一 provider handle 的移交或恢复保留原 Operation，仅查询原调用，不重复预留/发送。账务核对按原绑定独立于发布 Fence。并发 prepare 候选各持独立 UUID；失败方仅可释放自己的确定未提交、未授权 Grant，不得释放赢家预留。
2. **本地结算与 `budget_sync` Outbox 原子提交**:
   - 无论 `commitTurn`、`cancelTurn` 还是 DO Alarm 租约清理，只要涉及带 `global_grant_id` 的 `model_attempts` 状态转换，必须在**同一个本地 `transactionSync`** 内同时写 `v2_dispatch_outbox(entity_kind = 'budget_sync')`（含 `operationId`、`globalGrantId`、目标 `state`、`chargeMicroUsd`、`observedCostMicroUsd` 及 `openIncidentReason`），并在事务外立即刷新、失败时由 Alarm 无限期可靠重试直至 `GlobalBudgetAuthority` 确认。
3. **补偿释放（Compensating Release）**:
   - **Stage 3 TOCTOU 中止补偿**: 若 `prepareTurn` Stage 2 已获得 `globalGrantId`，但在 Stage 3 `transactionSync` 发现 `transcript_epoch` 已变、`client_submission_id` 已被并发提交或 `v2_recovery_coverage` 失效，必须在本地 `transactionSync` 内写入 `v2_dispatch_outbox('budget_sync', op='release')` 并触发即时异步 `settleGlobal(released)` 后再返回 `409` / `replay` / `503`；覆盖已失效时采用 §5.2 的保守 TTL，不建立不可恢复的本地义务。
   - **未出网释放**: 只有 Operation 未获发送授权、`send_started_at_ms IS NULL` 且无不确定授权/提交，合法结算为 `released`（`chargeMicroUsd = 0`）并全额退还本地与全局额度。
4. **过期 Grant（Expired Grant）规则**:
   - `reserveGlobal` 签发的初始有效期为 `expiresAtMs = nowMs + Math.max(leaseMs, turnDeadlineMs) + 30_000`（或随 `renewTurnLease` 同步延长），续期须在原 Grant 和本地 Lease 仍有效时权威确认，不能复活过期 Grant；每次 Egress 前检查实际有效期。
   - 当 `GlobalBudgetAuthority` 扫描到 `nowMs >= expiresAtMs` 且仍为 `reserved` 的 Grant 时，**绝不退款（Never Refund）**：将其原子转换为 `expired_consumed`，把 `amount_micro_usd` 从 `reserved_micro_usd` 转入 `consumed_micro_usd`（等价 `unknown_billed`），彻底封堵崩溃退款导致的并发超支漏洞。
5. **迟到结算（Late Settlement）规则**:
   - 若 `settleGlobal(released)` 抵达时 Grant 已转为 `expired_consumed`：拒绝退还已保守计入的额度，维持 `expired_consumed`（`applied: false, alreadySettled: true`）。
   - 若 `settleGlobal` 携带 `observedCostMicroUsd <= reservedMicroUsd` 抵达 `expired_consumed` 或本地已标 `unknown_billed` 的记录：仅作审计字段补录，不重复扣减也不退还额度。
   - **超额不可丢弃硬规则**：无论 Grant 是否已 `expired_consumed` 或本地租约是否已被 `STALE_LEASE` 拒绝，只要迟到回报的 `observedCostMicroUsd > reservedMicroUsd`（存在真实超支 `overage > 0`），**必须**补记 `overage_micro_usd = observed - applied` 并立即开启 `reservation_exceeded` / `day_ceiling_exceeded` Incident Halt，绝不允许丢弃真实账单差额。
6. **Incident Halt 阻断规则**:
   - 继承 V1 三类停机原因：`day_ceiling_exceeded`、`reservation_exceeded`、`usage_missing`（2xx 缺失 Usage 按 `conservative_billed` 全额计账并强制 Halt）。
   - 未解决（`resolved_at_ms IS NULL`）的局部 Incident 阻断对应 `tenant` / `principal`；未解决的**全局 Incident 阻断平台内全部租户**的后续 `reserveGlobal` 与 `markAttemptSent`，直至管理员通过带归因记录的审计路径显式解决（`resolved_at_ms`, `resolved_by`, `resolution_note`）。
7. **跨区延迟超 50 ms 的合规演进路径（仅作 M0/M4 预留方案，M1 默认直连权威预留）**:
   - 若实测跨洲 RTT 导致 `GlobalBudgetAuthority` 突破 `50 ms` P95，可引入**有界预分配拨款（Bounded Preallocated Grants）**——`GlobalBudgetDO` 向区域协调节点或高频 Agent 预先拨付带过期时间 `expires_at_ms` 的有界额度包，同时在 `GlobalBudgetDO` 立即计入 `reserved_micro_usd`，确保 `SUM(active_grants) + consumed <= globalDailyMicroUsd` 数学恒成立。

---

## 8. 与 Agent B（调度、恢复登记与 Outbox）的接口边界

Agent A（Agent Head / Fast Path）与 Agent B（Event Runtime / Recovery，见 `v2-m0-event-recovery-contract.md`）共享同一份 `AgentHeadDO` SQLite 状态与 D1 Generation/CAS 协议，通过以下最小接口边界解耦：

### 8.1 职责划分

| 能力域                       | Agent A 所有权（本契约主责）                                                                                                                               | Agent B 所有权（协作消费/保障）                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| DO 内状态与 Outbox           | 写入 `assistant_turns`、`tasks`、`runs`、`model_attempts`、`v2_dispatch_outbox`（含 `budget_sync`）并维护 `v2_recovery_coverage` 状态机                    | 投递 `v2_dispatch_outbox` 至 Cloudflare Queue（`V2DispatchEnvelope`）、DLQ 回放、`v2_schedules` 触发与 `Interval/Cron/DST` 计算 |
| DO Alarm                     | 在业务 `transactionSync` 结束时按第 4.2 节精确重算与重装单一 `setAlarm(T_alarm)`                                                                           | 实现 `alarm()` 有界批处理循环（推进到期 Lease/Schedule/Outbox 并重装下一 `T_alarm`）                                            |
| 独立恢复登记（D1 + Sweeper） | `prepareTurn` / 委派在未覆盖或提前截止时以单调递增 `generation` + `'registering'` 态调用 `upsertCoverage`（已覆盖零 D1 I/O）；暴露 `reconcileFromRegistry` | 维护外部 D1 `v2_recovery_registry` 与每分钟有界 `RecoverySweeper`（处理 Alarm 6 次重试耗尽、DO 断电与过期标记清理）             |
| Durable Execution Worker     | 定义 `claimDurableWork` / `commitDurableResult` 租约与 `markAttemptSent` / 累计成本 Fencing 规则                                                           | 运行 Queue 消费者、`ExecutionWorker`（Notes/Python/Daytona/长 Turn 恢复）与指数退避重试                                         |

### 8.2 Agent A ↔ Agent B 最小接口边界（共同冻结待确认）

对照 [Agent B PR #171](https://github.com/basicv8vc/Ember/pull/171)（`f8994e3`）：A/B 共享一套 v2_schedules、v2_dispatch_outbox、v2_recovery_coverage Migration；A 的 Turn/Task/Run 为唯一 Lease/Epoch 业务权威，B 通过同一 transactionSync 内的同步协调/收敛端口访问，不复制可写 v2_execution_leases。budget_sync 复用同一 Outbox 内部处理（不将结算载荷发到普通 Queue）。下面的 pending 修复、实际回执及共享端口须 #171 同步确认后共同冻结；目前不是已完成的 A/B 联合批准。

```typescript
/** Agent B 提供的外部 D1 `v2_recovery_registry` CAS 端口 */
export interface RecoveryRegistryPort {
  /**
   * D1 条件 Upsert：
   * - 仅当不存在行，或 `v2_recovery_registry.generation < cmd.generation` 时写入；
   * - 重置 `status = 'armed'`, `recovery_attempts = 0`, `sweep_lease_owner = NULL`；
   * - 所有仍可能覆盖已接受义务的原行（含 quarantined/backoff），取 `MIN(existing, cmd.recoveryAtMs)`；
   * - 同代重放只能保持或提前时间，旧代不写；返回实际权威世代和时间，不能回显请求目标。
   */
  upsertCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly generation: number;
    readonly recoveryAtMs: number;
  }): Promise<{ readonly accepted: boolean; readonly currentGeneration: number; readonly actualRecoveryAtMs: number | null }>;

  /** 条件退休删除：`DELETE FROM v2_recovery_registry WHERE agent_key = ? AND generation <= cmd.retireUpToGen` */
  retireCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly retireUpToGen: number;
  }): Promise<{ readonly retired: boolean }>;

  /** 条件延后：`UPDATE ... SET generation = cmd.newGeneration, next_recovery_at_ms = cmd.nextRecoveryAtMs WHERE agent_key = ? AND generation = cmd.expectedPrevGen` */
  postponeCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly expectedPrevGen: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
  }): Promise<{ readonly updated: boolean; readonly currentGeneration: number; readonly actualRecoveryAtMs: number | null }>;
}

/** Agent Head DO 暴露给 Agent B Sweeper 与 Queue Worker 的收敛接口 */
export interface AgentHeadRecoveryPort {
  /**
   * Sweeper 调用的统一恢复与覆盖计划端点：
   * 1. 若本地无未决义务（earliestAlarm === null）：先在 DO `transactionSync` 置 `coverage_state = 'uncovered'`,
   *    `generation = max(cov.generation, cmd.expectedGen) + 1`, 返回 `retireUpToGen = nextGen - 1`；
   * 2. 若仅剩更晚的未来义务：先在 DO `transactionSync` 置 `coverage_state = 'registering'`,
   *    `generation = cov.generation + 1`, 返回 `postpone(expectedPrevGen, newGeneration, nextRecoveryAtMs)`；
   * 3. 若 DO 在刚才的收敛中仍需立即执行或已有更新标记覆盖，返回 `keep_armed`；仅在无 pending 修复且已有可验证覆盖时允许 `noop_stale`。
   */
  reconcileFromRegistry(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly expectedGen: number;
    readonly nowMs: number;
  }): Promise<
    | { readonly action: 'repair_ensure'; readonly generation: number; readonly recoveryAtMs: number }
    | { readonly action: 'noop_stale'; readonly currentGeneration: number }
    | { readonly action: 'retire'; readonly retireUpToGen: number }
    | {
        readonly action: 'postpone';
        readonly expectedPrevGen: number;
        readonly newGeneration: number;
        readonly nextRecoveryAtMs: number;
      }
    | { readonly action: 'keep_armed'; readonly currentGeneration: number }
  >;

  /** 只确认当前 pending 世代的权威回执，迟到回调不得复活覆盖。 */
  confirmRegistryPlan(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
  }): Promise<{ readonly confirmed: boolean }>;

  /** Durable Execution Worker 认领/续期/提交接口 */
  claimDurableWork(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly entityType: 'turn' | 'task';
    readonly entityId: Id;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<
    | {
        readonly kind: 'claimed';
        readonly leaseEpoch: number;
        readonly leaseExpiresAtMs: number;
        readonly contextJson: string;
      }
    | {
        readonly kind: 'not_claimed';
        readonly reason: 'terminal' | 'lease_active' | 'deadline_expired' | 'not_found';
      }
  >;

  commitDurableResult(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly entityType: 'turn' | 'task';
    readonly entityId: Id;
    readonly leaseEpoch: number;
    readonly workerId: string;
    readonly outcome: unknown; // 映射到 Turn 或 Task 终态 + task_results
  }): Promise<{ readonly accepted: boolean }>;
}
```

### 8.3 Generation/CAS 关键竞态与修复协议（Zero-D1-I/O on Covered Path）

**规范补充：独立修复优先于下面的正常场景。** ensure/postpone/retire 的本地事务必须先持久化 pending_kind、唯一新 Generation、旧 CAS 世代与目标时间，并使旧准入覆盖失效。目标不得晚于全部已接受义务（含 budget_sync）及尚可提交候选的最早 D(O)；退休排除尚可提交的旧候选。DO 更新后、D1 CAS 前崩溃时，旧到期标记触发 Sweeper；即使 observedGeneration 落后，也须读取当前 pending/义务并重放计划或以更高世代 repair_ensure（MIN），禁止无条件 noop_stale。D1 CAS 已完成但确认丢失时读回实际标记，重新确认当前计划；若已延后则下一到期 Sweep 或新准入修复；若退休已删除且无义务，保持 uncovered，下次准入使用更高世代重建。远程确认只能在当前计划及实际标记覆盖所有义务时生效。旧回调不确认新计划；迟到 UPSERT 复活空标记只能安全退役，不删除较新义务。所有未终态义务在 backoff/quarantine 中仍须有界可发现、可恢复并告警。首个未接受候选无标记且无既有义务时可等待重试，不存在已接受任务丢失。M1 必须以离线客户端复现 DO pending 后崩溃、D1 CAS 后 ACK 丢失、有未来日程的旧世代 Sweep 及同代重放；不得以重新打开 App 作为修复条件。

1. **已覆盖快速路径**: 在 `transactionSync` 内校验 `v2_recovery_coverage.coverage_state === 'covered'` 且 `covered_recovery_at_ms <= requiredDiscoveryMs`，满足则**零 D1 读写**直接进入后续阶段。
2. **DO 更新 `'registering'` 后、D1 更新前崩溃 / 不明确超时**:
   - Stage 1 `transactionSync` 先推进 `generation += 1` 并把 `coverage_state` 置为 `'registering'`（此时尚未写入任何 Turn/Task 业务行）；
   - 若随后 Worker/DO 崩溃或 `upsertCoverage` 超时/失败：`prepareTurn` 直接 Fail Closed 返回 `503 DB_UNAVAILABLE`，DO 中没有任何未覆盖业务行。`coverage_state` 停留在 `'registering'`（**绝不回退为旧的 `'covered'`**），下一请求会看到 `'registering'` 并再次推进 `generation + 1` 重新向 D1 登记。
   - 若 D1 实际已写成功但 DO 在 Stage 3 提交前崩溃：D1 仅留下一条无害陈旧标记，下轮 `RecoverySweeper` 调用 `reconcileFromRegistry` 发现 DO 空闲后安全退休删除。
3. **同 Generation 并发登记消除**:
   - 两个并发未覆盖请求在 DO `transactionSync` #1 中被严格串行化：请求 A 原子获得 `intendedGen = g + 1`，请求 B 原子获得 `intendedGen = g + 2`，**不可能产生同 Generation 的 D1 写请求**。
   - 若请求 A 在 Stage 2 返回较慢、落后于请求 B 完成：Stage 3 中请求 A 校验 `v2_recovery_coverage.generation === intendedGen && coverage_state === 'registering'` 失败；仅当 B 已完成且 `coverage_state === 'covered' && covered_recovery_at_ms <= D(A)` 时 A 才可借用 B 的覆盖继续，否则 A 触发第 5.2 节 `budget_sync` 补偿释放并返回可重试 `503 DB_UNAVAILABLE`。
4. **过期 / Quarantined / 世代超前标记修复**:
   - 若 D1 因历史故障残留了过期 `next_recovery_at_ms` 或 `status = 'quarantined'` / `'backoff'` 的行：下一次 `upsertCoverage` 以严格更大 `generation` 覆盖并强制重置 `status = 'armed'`、`recovery_attempts = 0`、`sweep_lease_owner = NULL`（包括 quarantined 仍取全部现存义务与新义务的最早时间，不能丢弃既有覆盖）。
   - 若因 DO 快照恢复或异常跳变导致 D1 的 `generation >= intendedGen`（`upsertCoverage` 返回 `accepted: false, currentGeneration: d1Gen`）：DO 在新短事务中将 `v2_recovery_coverage.generation` 快进同步为 `max(cov.generation, d1Gen) + 1`（保持 `'registering'`），随后执行**至多 1 次**重试写入 D1，自动自愈世代错位。
5. **Sweeper 退休/延后竞争防护与降级运行**:
   - Sweeper 执行 `reconcileFromRegistry` 时，DO 必须**先**在 `transactionSync` 内将本地 `v2_recovery_coverage` 推进 `generation` 并置 `'uncovered'`（退休）或 `'registering'`（延后），之后 Sweeper 才能向 D1 发送条件 `retireCoverage(retireUpToGen)` 或 `postponeCoverage(expectedPrevGen)`。
   - D1 恢复索引不可用期间：Direct Path 读操作与已覆盖（`covered` 且 `covered_recovery_at_ms <= D(O)`）的 Fast Path 对话继续服务；任何未覆盖请求（含 `'registering'` 态）必须 Fail Closed 返回 `503 DB_UNAVAILABLE`。

---

## 9. B1 API 与消息提交契约兼容性矩阵

| B1 接口 / 不变量                                                             | V2 处理方式与兼容保证                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/session`, `/refresh`, `DELETE /v1/auth/session`, `GET /v1/me` | 鉴权与身份目录（D1 或现有 Session Store）解析出不变的 `AuthContext` 及 `agent_id`、`conversation_id`、`transcript_epoch`。错误响应与令牌轮换复用检测（`reuse_detected -> revoke all`）不变。                                                                                               |
| `POST /v1/conversations/{id}/messages`                                       | 请求体严格校验 `B1SendMessageRequestSchema`，拒绝 `Idempotency-Key` 与客户端 `tenant_id`/`principal_id`/`policy_version`；`transcript_epoch` 校验在 DO `transactionSync` 内原子执行；`201` 新写入 / `200` 重放均返回严格校验的 `B1SendMessageReceiptSchema`（`turn.status = 'running'`）。 |
| `GET /v1/message-submissions/{client_submission_id}` (`N-1..N-12`)           | 返回原始提交收据（`turn.status` 保持为当初确认时的 `'running'`），未提交或 Transcript 清除后返回 `404 NOT_FOUND`，客户端严格依据 `200` 采纳 / `404`（仅同 Epoch 重试） / `409`（停发并保留草稿）对账。                                                                                     |
| `GET /v1/conversations/{id}/messages`                                        | 单次 DO SQLite 读快照同时返回 `transcript_epoch`、`messages`、`next_after`、`has_more`，满足 `RD-1..RD-6` 与 `O-1..O-5`。                                                                                                                                                                  |
| `GET .../turns/{turn_id}` & `POST .../turns/{turn_id}/cancel`                | 返回封闭 `B1AssistantTurnDtoSchema`；取消置位 `cancel_requested_at_ms` 并在非运行中时直接收敛为 `cancelled`，不暴露内部 `lease_epoch` 或 `execution_mode`。                                                                                                                                |
| `DELETE /v1/me/conversation/messages` (`TE-1..TE-6`)                         | 单个 `transactionSync` 内删除消息与 Turn、取消运行中 Turn、`transcript_epoch += 1`、撤销活跃 Turn 的 `dispatch_outbox`；**不删除** `tasks`、`runs`、`task_events`、`task_results`、`message_attachments` 所指向的 Task 产物指针。                                                          |
| `POST /v1/tasks`, `GET /v1/me/tasks*`, `POST /v1/me/tasks/{id}/cancel`       | 保持 `Idempotency-Key` 语义、`L-1..L-9` 原子 `task_reference` 关联校验、`X-1..X-9` `task_results` 不可变读取语义与 Closed `TaskEventPayload` 脱敏边界。                                                                                                                                    |

---

## 10. 失败场景与确定性故障矩阵

| 编号 | 故障场景                                                               | 触发点                                    | 预期确定性行为与不变量                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1  | 并发提交同一 `client_submission_id`（相同内容）                        | `prepareTurn` Stage 1/3                   | 首个事务提交并返回 `201`；后者（即使在 Stage 2 之后才重入 `transactionSync`）在 Stage 3 写入 `budget_sync(release)` Outbox 补偿释放自身冗余 `GlobalBudget` 预留，返回 `200` 同收据且零重复消息/模型调用。                                |
| F-2  | 并发提交同 `client_submission_id` 但不同文本/附件/会话                 | `prepareTurn`                             | 拒绝并返回 `409 IDEMPOTENCY_CONFLICT`，不写任何行、不扣减配额。                                                                                                                                                                          |
| F-3  | `clearTranscript` 与 `prepareTurn` 并发交错                            | Stage 2 `await` 期间执行删除              | Stage 3 `transactionSync` 检测到 `transcript_epoch` 已递增 → 原子写入 `budget_sync(release)` Outbox 并异步释放 `GlobalBudget` 预留，抛出 `409 IDEMPOTENCY_CONFLICT`；已删会话零复活消息。                                                |
| F-4  | 未覆盖 Turn 遇 D1 Recovery Registry 不可用                             | `prepareTurn` Stage 2                     | Fail Closed 返回 `503 DB_UNAVAILABLE`，DO 无写入（`v2_recovery_coverage` 保持 `'registering'`）；客户端保留 Protected Outbox 待恢复后用原 `client_submission_id` 重试或对账。                                                            |
| F-5  | 已覆盖 Turn 遇 D1 Recovery Registry 不可用                             | `prepareTurn` Stage 1                     | 跳过 D1（0 D1 I/O），只要 Auth 与 GlobalBudget 可用即正常完成 `prepareTurn` 与后续执行；现有 D1 标记仍保障离线可恢复。                                                                                                                   |
| F-6  | Global Budget Authority 不可用、超限或存在全局 Halt                    | `prepareTurn` Stage 2 / `markAttemptSent` | 超限或存在未解决 Incident（`day_ceiling_exceeded` / `reservation_exceeded` / `usage_missing`）返回 `429 BUDGET_EXCEEDED`；不可用返回 `503 DB_UNAVAILABLE`。无新增已接受业务义务或付费 Egress；既有工作、预留及账务按恢复规则保留。                                                    |
| F-7  | Edge Worker 在 `prepareTurn` 后、`markAttemptSent` 前崩溃              | `prepareTurn` 与 `markAttemptSent` 之间   | 租约到期后 DO Alarm 触发回收；因未发且无 send_authorizing 意图/未知授权，本地结算为 **`released`**（0 扣费）并原子写入 `budget_sync(release)` 归还全局额度。                                                                  |
| F-8  | Edge Worker 在 `markAttemptSent` 成功后、Provider 返回前静默崩溃       | `markAttemptSent` 与 `commitTurn` 之间    | 租约到期（SSE `45 s` / `waitUntil` `25 s`）后 `<= 15 s` 内 Alarm 触发对账；因 **`send_started_at_ms IS NOT NULL`**，按 **`unknown_billed`** 保留全额预留并原子写 `budget_sync`，严禁盲目重放非幂等调用。                                 |
| F-9  | `markAttemptSent` 遭遇取消、`STALE_LEASE` 或 `already_sent`            | 发起 Provider `fetch` 前                  | 返回 `{ authorized: false }`，执行器严禁出网；只在确定未授权未发送时 released；already_sent/不确定不得退款。                                                                                                           |
| F-10 | 流式途中客户端断连                                                     | `Interactive Executor` 活跃流             | 立即停止 15 s 续期，撤销本地 Provider 请求（或若已生成句柄则 `handoffTurnToDurable`）；客户端重连后仅通过 `GET /messages` 与 `GET /turns/{id}` 恢复，零重复文本。                                                                        |
| F-11 | B1 非流式 `waitUntil` 超出 22 s 或在 25 s 内被杀                       | `POST .../messages` 后台执行              | 正常于 22 s 软移交 Durable Queue，无 30 s 截断损失；若崩溃则 `25 s` 租约到期后由 Alarm 接力，在 `60 s` B1 Deadline 内交付 Queue 执行或收敛。                                                                                             |
| F-12 | 推理耗时超过 120 s 移交                                                | 达到 `105–115 s` 移交窗口                 | 调用 `handoffTurnToDurable`（`lease_epoch += 1`, `execution_mode = 'durable_queue'`），保持 `turn.deadline_at_ms = 600 s`（不被 120 s 误杀），由 Queue Worker 凭 `provider_job_handle` 接力；旧 Executor 迟到提交被 `STALE_LEASE` 拒绝。 |
| F-13 | DO 更新 `'registering'` 后 D1 写入前崩溃 / 同代并发登记 / 过期标记修复 | `prepareTurn` Stage 1→2                   | DO 未写入 Turn，下次请求见 `'registering'` 推进 `generation + 1`；并发请求在 `transactionSync` #1 获得严格不同 `generation`；过期/`quarantined` 行被 `upsertCoverage` 重置修复；D1 世代超前触发单次快进自愈。                            |
| F-14 | DO Alarm 连续 6 次重试全部失败（离线） + 未来 Schedule                 | 所有客户端均离线                          | Agent B 每分钟 `RecoverySweeper` 扫描 D1 `v2_recovery_registry` 到期行，唤醒 `AgentHeadDO.reconcileFromRegistry`，在 `<= 2 min` 检测、`<= 5 min` 内派发 Queue 并**向后重装**未来 `v2_schedules` Alarm。                                  |
| F-15 | 本地结算提交成功但 `settleGlobal` 失败 / Grant 已过期迟到结算          | `commitTurn` 后外部 RPC                   | `budget_sync` Outbox 已在本地事务原子写入，Alarm 保证重试；Grant 过期后转为 `expired_consumed`（拒绝退款）；若迟到回报 `observed > reserved`，强制补记 `overage` 并开启 Incident Halt。                                                  |
| F-16 | Provider 返回 2xx 但缺失 `usage` 字段                                  | `commitTurn` 结算                         | 严格按 `conservative_billed` 全额计入预留金额并开启 `usage_missing` 预算事故，阻断后续付费调用直至人工对账解除，同时合法发布本次已付费回复。                                                                                             |
| F-17 | Sweeper 退休/延后与新 `prepareTurn` 并发                               | `reconcileFromRegistry` 竞态              | DO 先推进 `generation` 并置本地为 `'uncovered'`/`'registering'` 再响应 Sweeper；D1 执行带 `WHERE generation <= retireUpToGen` / `= expectedPrevGen` 的 CAS，并发新请求绝对无法被误删。                                                   |
| F-18 | Task 跨 Run 重试触及 V1 模型尝试或累计成本上限                         | Durable `reserveAttempt`                  | 常规 Task 累计 `> 4` 次或 `> 20_000 micro_usd`、`python.agent` 累计 `> 6` 次或 `> 30_000 micro_usd` 时拒绝新预留并收敛 Task 终态，绝不产生无界重试账单。                                                                                 |

---

## 11. M1 实施计划与本地验收门禁（Work Package A）

依据 ADR-0006，M1 **仅在本地隔离环境使用 Fake Provider 运行**，在 M0 契约获 Architect/CTO 审核批准后按以下顺序推进（独立 Git worktree + Draft PR，不部署、不调付费 API）：

### 11.1 实施切片划分

1. **M1-A1: `@ember/runtime-v2` 契约与核心包骨架（纯类型与 SQLite Schema）**
   - 落地 `AgentHeadRpc`（含 `markAttemptSent`）、`GlobalBudgetAuthority`、`RecoveryRegistryPort`、`AgentHeadRecoveryPort` TypeScript 接口与 Zod 校验器；
   - 落地 Agent Head SQLite Schema 迁移器（版本号 1）及纯同步存储封装（共用 Agent B 的 `v2_dispatch_outbox` / `v2_schedules` / `v2_recovery_coverage` 表定义）。
2. **M1-A2: `AgentHeadDO` 核心状态机与 3-RPC 执行主路径实现**
   - 实现 `prepareTurn`（3 阶段 + `'registering'` 并发防护 + D1 世代快进 + TOCTOU `budget_sync` 补偿）、`markAttemptSent`（单次发送与租约/取消/Halt 门禁）、`renewTurnLease`、`handoffTurnToDurable`、`commitTurn`（本地结算与 `budget_sync` Outbox 原子同事务写入）、`cancelTurn`、`clearTranscript` 及 Direct Path 读接口；
   - 实现精确的单一 Alarm 重算重装器（支持前移、后移与 `deleteAlarm`）、交互 vs 总 Deadline 分离校验，以及 V1 Model Attempt 与累计成本上限校验。
3. **M1-A3: `GlobalBudgetDO` 权威预留服务与 `budget_sync` 补偿器**
   - 实现并发安全的 `reserveGlobal` / `renewGlobalGrant` / `settleGlobal`（含 Grant TTL 过期转 `expired_consumed` 不退款、迟到超支仍开 Incident Halt、跨租户全局 Halt）；
   - 实现 `v2_dispatch_outbox(entity_kind = 'budget_sync')` 补偿刷新器，并确保 M1 中 Fake Provider 经过 `simulated_full_protocol` 完整预算链路。
4. **M1-A4: Edge API Worker B1 兼容层与 Interactive Executor**
   - 挂载基于 `AgentHeadRpc` 的 B1 路由适配器，配置 B1 `waitUntil` `25 s` 租约 / `22 s` 软移交 / `60 s` B1 Deadline；
   - 在 `@ember/model-gateway` 增加 `FakeModelGateway` 流式与 `provider_job_handle` 模拟能力；
   - 实现 Interactive Executor（SSE `45 s` 租约 / `15 s` 续期 / `120 s` 交互移交至 `600 s` 总 Deadline / 断连处理 / Bounded SSE）。
5. **M1-A5: 本地确定性故障注入与 Benchmark 套件（联合 Agent B）**
   - 与 Agent B 的 `RecoveryRegistry` + `ExecutionWorker` 联调本地端到端测试与 F-1..F-18 全部负向测试。

### 11.2 M1 退出本地验收门禁（全部使用 Fake Provider）

- [ ] **B1 回归全绿**: 现有 B1 消息提交、幂等重放、Unknown-ACK 对账（`N-1..N-12`）、`transcript_epoch` 清除隔离、租户隔离（A↔B 404）与无内容日志审计在 V2 Agent Head 适配器下全部通过；验证 B1 `waitUntil` 22 s 软移交与 25 s 崩溃恢复均能在 `60 s` B1 Deadline 内收敛。
- [ ] **3-RPC 单次发送门禁 (`markAttemptSent`)**: 证明 `prepareTurn` 后 `markAttemptSent` 前崩溃可安全 `released`（0 扣费）；`markAttemptSent` 后崩溃必转 `unknown_billed`（不退款不盲重放）；取消或 `STALE_LEASE` 时 `markAttemptSent` 拒绝出网。
- [ ] **Fast/Durable/Handoff 与 Alarm 重装故障注入**: 覆盖连接中流式输出、客户端断连、Worker 静默崩溃（验证 `<= 60 s` 进入恢复对账）、`> 120 s` 推理通过 `provider_job_handle` 原子移交至 Durable Path 且不被错误总 Deadline 误杀、旧 Executor 迟到提交被 `STALE_LEASE` 拒绝、以及最早任务完成后 Alarm 正确**向后重装**至未来 Schedule。
- [ ] **覆盖路径、并发登记与降级证明**: 证明“已覆盖 Turn 零同步 D1 I/O”；测试 `'registering'` 崩溃恢复、多请求并发获取严格递增不同 `generation`、D1 过期/`quarantined`/超前世代修复、Sweeper 退休/延后 CAS 竞态、以及 D1 不可用时未覆盖 Fail Closed（503）且已覆盖/Direct Path 可用。
- [ ] **完整预算协议与上限门禁（Fake Provider 全链路）**: `FakeModelGateway` 走通 `GlobalBudgetDO` + `AgentHeadDO` + `budget_sync` Outbox 原子同提交链路；10+ 并发压测下绝不突破 `globalDailyMicroUsd` / `tenantDailyMicroUsd` / `principalDailyMicroUsd` 及 Task 累计 Attempt（4/6）/ 成本（20k/30k）上限；验证 Stage 3 交错失败补偿释放、过期 Grant 不退款、迟到超支补开 Incident Halt、`usage_missing` 触发跨租户全局 Halt，并报告 `GlobalBudget` P95、Runtime 耗时、SQLite 写放大与流式 CPU 指标。
- [ ] **追加竞态门禁**：同代登记重放不延后；DO pending 后 D1 CAS 前崩溃且客户端全离线，旧世代 Sweeper 修复并保留后续日程；远端 CAS 已成功但确认丢失；Global 授权超时/重复、过期/Halt 与发送竞争、不确定时禁止退款；候选补偿不误释放赢家、事务不因错误回滚、无覆盖时 TTL 保守结转；本地结算与同步意图同提交、Global ACK 丢失、迟到超额修正及跨 Agent Incident 传播。验证完整预算门禁关键路径延迟。
- [ ] **A/B 联合冻结**：#171 同步确认 pending 修复、唯一 Lease 权威、共享 DDL/端口与 budget_sync 后才启动依赖性编码。
