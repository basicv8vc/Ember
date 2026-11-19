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
2. **Interactive Fast Path**: 常规对话 Turn 与可快速响应的交互请求。Edge API Worker 鉴权后调用 `AgentHeadDO.prepareTurn`，在一个本地 SQLite 事务内原子接受消息并完成租约/预算预留；随后由 Edge API Worker 内的 **Interactive Executor** 直接流式或异步调用 Model Gateway，最后调用 `AgentHeadDO.commitTurn` 落盘结果并结算费用。简单 Turn 目标为 **2 次核心 DO RPC（`prepareTurn` + `commitTurn`）**。
3. **Durable Path**: 委派任务（`notes.action_items`、`python.agent`、`POST /v1/tasks`）、超过 120 秒交互上限的移交任务、定时调度（Schedule）、审批恢复及独立异常恢复。通过 `dispatch_outbox` + DO Alarm + Cloudflare Queues 投递到无状态 `Execution Worker`（或授权设备执行器），受同一套 `Run / Lease / Epoch` Fencing 保护。

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
2. **B1 120s 交互截止时间 vs 60s B1 轮询截止时间**:
   - **现状**: `packages/postgres/src/repositories/b1-conversation-write.ts` 定义 `B1_TURN_DEADLINE_SECONDS = 60`；`packages/model-gateway/src/limits.ts` 定义 `attemptTimeoutMs = 20_000`、`turnDeadlineMs = 60_000`。
   - **M0 契约**: 保留 B1 `60 s` 作为 `B1` 非流式默认 Turn 截止时间兼容性基准，同时在 V2 Interactive Fast Path 中支持将 `interactiveDeadlineMs = 120_000` 设为交互阶段截止阈值（若未触发移交则受 120s 上限约束，触发 >120s 推理移交后转入 Durable Path）。详见第 6.1 节。
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

每次对 Turn 或 Task 的任何受保护写操作（`renewLease`、`handoffTurn`、`commitTurn`、`commitDurableResult`），Agent Head DO 必须验证全部四项条件同时成立：

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
CREATE TABLE IF NOT EXISTS assistant_turns (
  id                     TEXT    PRIMARY KEY,
  conversation_id        TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id      TEXT    NOT NULL UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  response_message_id    TEXT    UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  status                 TEXT    NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  failure_reason         TEXT    CHECK (failure_reason IS NULL OR failure_reason IN ('timeout', 'internal_error')),
  execution_mode         TEXT    NOT NULL DEFAULT 'fast_interactive'
    CHECK (execution_mode IN ('fast_interactive', 'durable_queue', 'device')),
  deadline_at_ms         INTEGER NOT NULL,
  interactive_deadline_ms INTEGER,
  lease_epoch            INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner            TEXT,
  lease_expires_at_ms    INTEGER,
  claim_count            INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  cancel_requested_at_ms INTEGER,
  provider_job_handle    TEXT,
  handoff_reason         TEXT,
  linked_task_id         TEXT,
  created_at_ms          INTEGER NOT NULL,
  updated_at_ms          INTEGER NOT NULL,
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
  provider_id             TEXT    NOT NULL CHECK (provider_id IN ('fake', 'openai', 'openrouter')),
  model_label             TEXT    NOT NULL,
  rate_version            TEXT    NOT NULL,
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
  global_synced_at_ms     INTEGER,
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

-- 6. Outbox、定时调度与独立恢复覆盖记录（与 Agent B 边界）
CREATE TABLE IF NOT EXISTS dispatch_outbox (
  id                    TEXT    PRIMARY KEY, -- e.g. 'turn:<id>' or 'task:<id>'
  entity_type           TEXT    NOT NULL CHECK (entity_type IN ('turn', 'task', 'budget_sync')),
  entity_id             TEXT    NOT NULL,
  reason                TEXT    NOT NULL,
  next_attempt_at_ms    INTEGER NOT NULL,
  last_enqueued_at_ms   INTEGER,
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner           TEXT,
  lease_expires_at_ms   INTEGER,
  completed_at_ms       INTEGER,
  last_error_code       TEXT,
  created_at_ms         INTEGER NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON dispatch_outbox (next_attempt_at_ms, id) WHERE completed_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS scheduled_events (
  id              TEXT    PRIMARY KEY,
  kind            TEXT    NOT NULL,
  target_id       TEXT    NOT NULL,
  due_at_ms       INTEGER NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed', 'cancelled')),
  recurrence_rule TEXT,
  updated_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON scheduled_events (due_at_ms) WHERE status = 'pending';

-- 单行恢复覆盖记录：证明当前 Agent Head 是否已被外部 D1 恢复登记表覆盖
CREATE TABLE IF NOT EXISTS recovery_coverage (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  generation       INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  covered_until_ms INTEGER,
  state            TEXT    NOT NULL DEFAULT 'uncovered'
    CHECK (state IN ('uncovered', 'covered', 'retiring')),
  updated_at_ms    INTEGER NOT NULL
);
```

### 4.2 事务边界与并发交错纪律（DO Interleaving Discipline）

1. **禁止事务内阻塞 I/O**: 所有 `ctx.storage.transactionSync(() => { ... })` 内部只允许执行 SQLite 读写与 `setAlarm`（平台持久化操作），严禁包含 `fetch`、Queue 发送、R2 读写、D1 查询或 `GlobalBudgetAuthority` RPC。
2. **Await 后的二次校验（TOCTOU 防护）**: Durable Object 在单个事件循环中一旦执行 `await`（如等待 Global Budget 预留或 D1 覆盖登记），其他 RPC（如 `clearTranscript`、`cancelTurn` 或 Sweeper 退休询问）可以交错进入并修改 SQLite。因此所有跨 `await` 的状态变更必须在最后的 `transactionSync` 中**重新校验**前提条件（`transcript_epoch`、`client_submission_id`、`recovery_coverage.generation`、取消标记），校验失败则回滚本地意图并对已获取的外部资源（Global Budget 预留）执行补偿释放。
3. **单一 Alarm 计算规则**: 每次 `transactionSync` 结束前计算 `earliestDueMs = MIN(...)` 覆盖：
   - 未完成的 `dispatch_outbox.next_attempt_at_ms`
   - 活跃 `assistant_turns` 的 `MIN(lease_expires_at_ms, deadline_at_ms)`
   - 活跃 `tasks` 的 `MIN(lease_expires_at_ms, next_run_at_ms, deadline_at_ms)`
   - `approvals` 的 `expires_at_ms`（`status = 'pending'`）
   - `scheduled_events` 的 `due_at_ms`（`status = 'pending'`）
     仅当 `earliestDueMs` 变化且早于当前已注册 Alarm（或当前无 Alarm）时调用 `ctx.storage.setAlarm(earliestDueMs)`，避免冗余写入放大。

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
  readonly leaseMs: number; // M0 default: 45_000
  readonly turnDeadlineMs: number; // 60_000 (B1 poll) or 120_000 (V2 interactive phase)
  readonly executionMode: TurnExecutionMode;
  readonly modelReservation?: {
    readonly mode: 'fake' | 'real';
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
      readonly utcDay: string;
      readonly reservedMicroUsd: number;
      readonly context: readonly B2TurnContextRow[];
      readonly attachments: readonly B2MessageAttachmentMeta[];
    }
  | {
      readonly kind: 'replay';
      readonly replayed: true;
      readonly receipt: B1SendMessageReceipt;
      readonly currentTurnStatus: 'running' | 'completed' | 'failed' | 'cancelled';
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
  readonly reason: 'interactive_deadline_120s' | 'client_disconnect_handoff' | 'tool_delegation';
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

### 5.2 `prepareTurn` 三阶段执行语义

1. **Stage 1 — 本地只读预检 (`transactionSync` #1)**:
   - 校验 `agent_head_meta` 与 `conversations`（不匹配抛出 `NOT_FOUND`）。
   - 校验 `request.transcript_epoch === conversations.transcript_epoch`；不等则抛出 `IDEMPOTENCY_CONFLICT` (409)。
   - 查询 `conversation_messages` 中 `client_submission_id`：
     - 若存在且 `conversation_id`、`text`、`attachment_ids` 完全一致 → 直接返回 `{ kind: 'replay', replayed: true, receipt, currentTurnStatus }`（**零外部预算调用、零 D1 I/O、零新计费**）。
     - 若存在但内容不一致 → 抛出 `IDEMPOTENCY_CONFLICT` (409)。
   - 校验 24 小时滚动消息配额（`200` 条，`BUDGET_EXCEEDED` 429）、本地日预算（`principalDailyTurns <= 60`、`principalDailyMicroUsd`、`tenantDailyMicroUsd`）及未解决的 `agent_budget_incidents`。
   - 校验附件指针有效性，读取最近 `maxContextMessages = 8` 条上下文。
   - 计算所需发现截止时间 `requiredDiscoveryMs = nowMs + leaseMs + 15_000`（Fast Path），读取 `recovery_coverage` 判断是否已覆盖（`covered`）。
2. **Stage 2 — 外部权威预注册（仅按需，位于任何 SQLite 事务之外）**:
   - **恢复覆盖登记**: 仅当 Stage 1 判定**未覆盖**时，调用 `RecoveryRegistry.ensureCoverage(...)`；若服务不可用则 **Fail Closed (`DB_UNAVAILABLE` 503)**。**已覆盖路径零同步 D1 I/O**。
   - **全局预算预留**: 仅当 `mode === 'real'` 且预留金额 `> 0` 时，调用 `GlobalBudgetAuthority.reserveGlobal(...)`；若超限或存在全局未解决事故，返回 `BUDGET_EXCEEDED` (429)；若不可用，返回 `DB_UNAVAILABLE` (503)。
3. **Stage 3 — 原子本地提交 (`transactionSync` #2)**:
   - 重新校验 Stage 1 所有前置条件与 `recovery_coverage.generation`（防止 Stage 2 `await` 期间发生 `clearTranscript`、并发重放或 Sweeper 退休）。若被并发打断：触发幂等 `releaseGlobal(operationId)`（通过 `await` 或异步补偿 outbox）并返回对应结果（如 `replay` 或 `409`）。
   - 分配 `sequence = last_sequence + 1`；插入 `user` 消息 + `message_attachments`；创建 `assistant_turns`（`status = 'running'`，`lease_epoch = 1`，`lease_owner = workerId`，`lease_expires_at_ms = nowMs + leaseMs`，`interactive_deadline_ms = nowMs + turnDeadlineMs`）；写入 `model_attempts`（`state = 'reserved'`，`send_started_at_ms = nowMs` 当 `executionMode === 'fast_interactive'` 时直接标记已授意发送，若尚未出网在 Worker 异常中止前由 `commitTurn(not_sent)` 释放；若崩溃则按 `unknown_billed` 保守处理，从而**省去第 3 次 `markAttemptSent` DO RPC**！）；更新 `agent_spend_days`；写入 `dispatch_outbox`（`next_attempt_at_ms = lease_expires_at_ms + 5_000`，确保正常 Fast Path 不会被 Queue 抢占，但失联后立即可恢复）；必要时更新 `recovery_coverage` 并调用 `setAlarm`。

### 5.3 `commitTurn` 原子结算与发布语义

- 若 `lease_epoch` / `lease_owner` 不匹配或 `status !== 'running'`：
  - 先按 `operationId` 对 `model_attempts` 执行一次幂等账务结算（若仍为 `reserved` 且 `settlement.state` 合法），确保实际已发生的 Provider 调用费用不丢失；
  - **绝对禁止**写入 `conversation_messages` 或触发 `delegation`，返回 `{ outcome: 'fenced', turn }`。
- 若 Fencing 全部通过：
  - 在单个 `transactionSync` 内结算 `model_attempts` 与 `agent_spend_days`（超支或缺失 Usage 时写入 `agent_budget_incidents` 并触发 Halt）；
  - 若 `result.status === 'completed'`：写入 `ember` 消息（`sequence += 1`, `model_label`, `simulated`）；若有 `delegation`，同时创建 `tasks` + `task_events(accepted)` + `task_reference` 消息（`sequence += 1`）+ `dispatch_outbox(task)`；将 `assistant_turns` 置为 `completed` 并完成 Turn 的 `dispatch_outbox`；重算并更新 Alarm。
  - 若 `delegation` 产生新的未覆盖到期时间，在进入 `transactionSync` 前或按第 8.2 节协议先行确保 `RecoveryRegistry` 覆盖（若登记失败，不允许提交未覆盖的后台 Task，可降级只发布文本或返回可重试错误）。
  - 事务提交后，在 DO 外部调用 `GlobalBudgetAuthority.settleGlobal(...)`（或 `releaseGlobal`）；若外部 RPC 失败，写入/保留 `dispatch_outbox(entity_type='budget_sync')` 由 Alarm 可靠重试，绝不泄露全局已预留额度。

---

## 6. Edge API Worker Streaming、断连恢复与 >120s 移交

### 6.1 M0 冻结时间参数表（与 V1 租约/截止时间对齐）

| 参数                     | V1 现状                               | V2 M0-A 冻结规范                                                               | 说明                                                                    |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `leaseDurationMs`        | `30_000` (Tasks/Turns)                | **Interactive Fast Path: `45_000` ms**；Durable Path 保留 `30_000`–`45_000` ms | 兼容 V1 `LeaseQueueConfig` 上限（`max 300_000`）。                      |
| `leaseRenewalIntervalMs` | `10_000` (Tasks)                      | **Interactive Fast Path: `15_000` ms**（仅在活跃执行期间续期）                 | 严格小于 `leaseDurationMs / 2`，零空闲心跳。                            |
| 静默丢失恢复窗口         | Cron `* * * * *`                      | **正常路径 `<= 60_000` ms**（`45 s` 租约到期 + `<= 15 s` Alarm 检测/派发余量） | 非平台 SLA，为 M1 确定性故障测试目标。                                  |
| `attemptTimeoutMs`       | `20_000`                              | 单次非流式 HTTP 请求 `20_000` ms；流式首 Token / 空闲分片超时 `30_000` ms      | 绑定 `AbortSignal`，防止无限悬挂。                                      |
| `interactiveDeadlineMs`  | `60_000` (`B1_TURN_DEADLINE_SECONDS`) | **B1 兼容轮询 Turn: `60_000` ms**；**V2 交互流式/长推理上限: `120_000` ms**    | 超过 `120_000` ms 必须通过 `handoffTurnToDurable` 移交至 Durable Path。 |

### 6.2 Streaming 托管与防重复规则

- **托管位置**: Interactive Executor 运行于 Edge API Worker 请求处理生命周期内，**绝不在 Agent Head DO 内持有流式连接或 `await` 模型输出**，避免 DO 产生高额 Duration 计费并阻塞同一用户的其他并发请求。
- **零 Per-Token 持久化**: 流式输出使用有界内存缓冲（仅聚合最终完整文本用于 `commitTurn`），严禁每个 Token 写入 DO SQLite。
- **B1 兼容路径 (`POST /v1/conversations/{id}/messages`)**: 保持同步返回 `201/200 B1SendMessageReceipt`（在 `prepareTurn` 提交后立即返回）。随后在 `ctx.waitUntil(...)` 中启动 Fast Path 执行并 `commitTurn`；`waitUntil` 仅作低延迟加速通道，**不**作为恢复保证（已由 `prepareTurn` 中的 `dispatch_outbox` + Alarm + RecoveryRegistry 兜底）。
- **V2 流式路径（M1/M3 需经版本化 Wire 审批后启用，如 `POST /v2/conversations/{id}/messages/stream`）**:
  - 在 `prepareTurn` 成功后立即下发首个 SSE 事件 `event: turn.accepted`（包含完整 `B1SendMessageReceipt` 与 `transcript_epoch`）；
  - 持续推送 `event: turn.delta`（临时未提交文本，不入库）；
  - 完成时先调用 `commitTurn` 成功后，再下发 `event: turn.committed`（包含权威 `message_id`、`sequence`、`turn`）；
  - 触发 >120s 移交时，在 `handoffTurnToDurable` 成功后下发 `event: turn.handed_off`（指示客户端保持 `running` 态并转入轮询/同步监听）。
- **断连恢复**: 客户端重连后通过 `GET /v1/conversations/{id}/messages?after=<last_confirmed_seq>` 与 `GET /v1/conversations/{id}/turns/{turn_id}` 获取权威状态，按 `message_id`/`sequence` 对账；本地 UI 丢弃未提交的临时 Stream Buffer，绝不产生重复消息。

### 6.3 断连、静默崩溃与 >120s 推理移交流程

```text
Edge API Worker (Interactive Executor)            Agent Head DO                Queue / Execution Worker
  |                                                     |                                |
  |--- prepareTurn (lease=45s, deadline=120s) --------->| [commit msg+turn+outbox+alarm] |
  |<-- prepared (epoch=1, opId) ------------------------|                                |
  |                                                     |                                |
  |=== Scenario A: Observed Client Disconnect =========>|                                |
  |  1. Stop 15s lease renewal timer immediately        |                                |
  |  2. If provider_job_handle exists -> handoffTurnToDurable -------------------------->|
  |     Else -> abort provider AbortSignal; commitTurn(status='aborted' or 'failed')     |
  |                                                     |                                |
  |=== Scenario B: Silent Worker Loss =================>|                                |
  |  (Worker killed; no renewal)                        |                                |
  |                                  [At T+45s: lease expires; DO Alarm <= T+60s fires]  |
  |                                                     |--- reconcileExpiredLease()     |
  |                                                     |    - mark attempt unknown_billed|
  |                                                     |    - if handle: enqueue Queue ->|
  |                                                     |    - else: terminalize/retry   |
  |                                                     |                                |
  |=== Scenario C: Reasoning > 120s ===================>|                                |
  |  [At T+105s..115s before 120s deadline]             |                                |
  |  1. Capture provider_job_handle / checkpointRef     |                                |
  |--- handoffTurnToDurable(epoch=1, handle) ---------->| [epoch=2, mode=durable_queue,  |
  |<-- handed_off (nextLeaseEpoch=2) -------------------|  outbox due=now, alarm/queue] ->|
  |  2. Emit SSE `turn.handed_off` & close stream       |                                |
  |                                                     |<-- claimDurableRun(epoch=2) ---|
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
   - 维护全局跨租户每日桶 `global_spend_days (utc_day, reserved_micro_usd, consumed_micro_usd, overage_micro_usd)`、全局预算操作表 `global_budget_reservations (operation_id PRIMARY KEY, tenant_id, utc_day, amount_micro_usd, state, expires_at_ms)` 与全局未解决事故表 `global_budget_incidents`。
   - **禁止使用最终一致缓存替代**: 任何 `mode === 'real'` 的付费 Egress 前，必须持有来自 `GlobalBudgetAuthority` 的权威预留收据 `globalGrantId`（M1 目标：近区 P95 <= 50 ms，计入 200 ms Runtime 预算内）。

```typescript
export interface GlobalBudgetAuthority {
  reserveGlobal(req: {
    readonly tenantId: Id;
    readonly principalId: Id;
    readonly operationId: Id;
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

  settleGlobal(req: {
    readonly tenantId: Id;
    readonly operationId: Id;
    readonly state: 'settled' | 'conservative_billed' | 'unknown_billed' | 'released';
    readonly chargeMicroUsd: number; // 0 when released; reserved when conservative_billed/unknown_billed
    readonly reservedMicroUsd: number;
    readonly openIncidentReason?: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
  }): Promise<{ readonly applied: boolean; readonly alreadySettled: boolean }>;
}
```

### 7.2 并发安全与崩溃防漏规则

- **预留先于 Egress**: `GlobalBudgetAuthority.reserveGlobal` -> `AgentHeadDO` 本地提交 -> 检查 `isModelExecutionAuthorized` -> 发起 Provider 请求。任何环节失败立即中止，**绝不先发请求后补账**。
- **TTL 过期的保守处理**: 若 Worker 崩溃导致全局预留超过 `expiresAtMs` 仍未收到 `settleGlobal`，`GlobalBudgetAuthority` 后台清理**绝对不会释放（Refund）该额度**，而是将其从 `reserved_micro_usd` 结转为 `consumed_micro_usd`（等价于 `unknown_billed`），保证并发崩溃永远不会造成全局额度超支。
- **跨区延迟超 50 ms 的合规演进路径（仅作 M0/M4 预留方案，M1 默认直连权威预留）**: 若实测跨洲 RTT 导致 `GlobalBudgetAuthority` 突破 50 ms P95，可引入**有界预分配拨款（Bounded Preallocated Grants）**——`GlobalBudgetDO` 向区域协调节点或高频 Agent 预先拨付带过期时间 `lease_expires_at_ms` 的有界额度包，同时在 `GlobalBudgetDO` 立即计入 `reserved_micro_usd`，确保 `SUM(active_grants) + consumed <= globalDailyMicroUsd` 数学恒成立。

---

## 8. 与 Agent B（调度、恢复登记与 Outbox）的接口边界

Agent A（Agent Head / Fast Path）与 Agent B（Event Runtime / Recovery）通过以下明确接口解耦，各自独立开发、测试：

### 8.1 职责划分

| 能力域                       | Agent A 所有权（本契约主责）                                                                                                             | Agent B 所有权（协作消费/保障）                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| DO 内状态与 Outbox           | `dispatch_outbox`、`recovery_coverage`、`scheduled_events` 表结构；`prepareTurn`/`commitTurn`/`handoffTurn` 写入与完成标记               | Outbox 投递执行（向 Cloudflare Queue 发送关闭脱敏的最小唤醒信封）、DLQ 回放、定时调度触发器                          |
| DO Alarm                     | 在 `transactionSync` 结束时精确维护单一 `setAlarm(earliestDueMs)`                                                                        | 实现 `alarm()` 处理循环：批量扫描到期 Outbox/租约/调度，驱动重试与状态收敛                                           |
| 独立恢复登记（D1 + Sweeper） | `prepareTurn` / `enqueueTask` 在**未覆盖路径**前调用 `ensureCoverage`，**已覆盖路径零 D1 I/O**；提供 `reconcileAndPlanCoverage` 协议端点 | 维护外部 D1 `agent_recovery_registry` 与每分钟有界 `RecoverySweeper`（应对 DO Alarm 6 次自动重试全部失败的极端情况） |
| Durable Execution Worker     | 定义 `claimDurableRun` / `commitDurableResult` DO Fencing 规则                                                                           | 运行 Queue 消费者、`ExecutionWorker`（Notes/Python/Daytona/长 Turn 恢复）与指数退避策略                              |

### 8.2 Agent A ↔ Agent B 最小接口边界

```typescript
/** Agent B 提供的外部恢复登记端口（如 D1 实现） */
export interface RecoveryRegistryPort {
  ensureCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly generation: number;
    readonly recoveryAtMs: number;
  }): Promise<{ readonly accepted: boolean; readonly currentGeneration: number }>;

  retireCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly expectedGeneration: number;
  }): Promise<{ readonly retired: boolean }>;

  postponeCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly expectedGeneration: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
  }): Promise<{ readonly updated: boolean }>;
}

/** Agent Head DO 暴露给 Agent B Sweeper 与 Queue Worker 的收敛接口 */
export interface AgentHeadRecoveryPort {
  /** Sweeper 调用：先在 DO 内处理到期项，再由 DO 安全失效本地覆盖并发放退休/延后授权 */
  reconcileAndPlanCoverage(cmd: {
    readonly tenantId: Id;
    readonly agentId: Id;
    readonly observedGeneration: number;
    readonly nowMs: number;
  }): Promise<
    | { readonly action: 'noop_stale_generation'; readonly currentGeneration: number }
    | { readonly action: 'retire'; readonly expectedGeneration: number }
    | {
        readonly action: 'postpone';
        readonly newGeneration: number;
        readonly nextRecoveryAtMs: number;
      }
  >;

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

### 8.3 登记覆盖与降级运行协议（Zero-D1-I/O on Covered Path）

1. **已覆盖快速路径**: 若 `recovery_coverage.state === 'covered'` 且 `covered_until_ms <= requiredDiscoveryMs`，`prepareTurn` **不访问 D1**（0 ms 额外延迟、0 D1 写入计费）。
2. **未覆盖 / 提前截止路径**: 若 `state !== 'covered'` 或新义务要求更早的恢复窗口，必须在提交本地 SQLite 前以 `nextGen = generation + 1` 调用 `RecoveryRegistryPort.ensureCoverage`。若 D1 不可用，**Fail Closed (`DB_UNAVAILABLE` 503)**，不接受未覆盖义务，客户端保留 Protected Outbox 并按 B1 `N-1..N-12` 重试。
3. **Sweeper 退休竞争防护**: Sweeper 调用 `reconcileAndPlanCoverage` 时，DO 在 `transactionSync` 内**先行**更新 `recovery_coverage`（若无后续义务则设为 `state = 'uncovered'`，若有则提升 `generation` 并设置新的 `covered_until_ms`），然后返回指令；Sweeper 随后以条件 CAS（`WHERE generation = expectedGeneration`）更新 D1。任何在 `ensureCoverage` 之后才执行 `transactionSync` Step 3 的并发 `prepareTurn` 都会看到本地覆盖状态已变更并被安全拒绝或重新登记，绝不会留下“本地已提交但 D1 已被删”的孤儿义务。
4. **局部故障降级（D1 恢复索引不可用期间）**: 已获覆盖的 Turn（只要 Auth 与 GlobalBudget 可用）及全部 Direct Path 读操作可继续正常服务；未覆盖的新义务拒绝接收。

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

| 编号 | 故障场景                                               | 触发点                        | 预期确定性行为与不变量                                                                                                                                                                           |
| ---- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1  | 并发提交同一 `client_submission_id`（相同内容）        | `prepareTurn` Stage 1/3       | 首个事务提交并返回 `201`；后者（即使在 Stage 2 之后才重入 `transactionSync`）检测到已存在并释放自身冗余的 `GlobalBudget` 预留，返回 `200` 同收据且零重复消息/模型调用。                          |
| F-2  | 并发提交同 `client_submission_id` 但不同文本/附件/会话 | `prepareTurn`                 | 拒绝并返回 `409 IDEMPOTENCY_CONFLICT`，不写任何行、不扣减配额。                                                                                                                                  |
| F-3  | `clearTranscript` 与 `prepareTurn` 并发交错            | Stage 2 `await` 期间执行删除  | Stage 3 `transactionSync` 检测到 `transcript_epoch` 已递增 → 补偿释放 `GlobalBudget` 预留，抛出 `409 IDEMPOTENCY_CONFLICT`；已删会话零复活消息。                                                 |
| F-4  | 未覆盖 Turn 遇 D1 Recovery Registry 不可用             | `prepareTurn` Stage 2         | Fail Closed 返回 `503 DB_UNAVAILABLE`，DO 无写入；客户端保留 Protected Outbox 待恢复后用原 `client_submission_id` 重试或对账。                                                                   |
| F-5  | 已覆盖 Turn 遇 D1 Recovery Registry 不可用             | `prepareTurn` Stage 1         | 跳过 D1，只要 Auth 与 GlobalBudget 可用即正常完成 `prepareTurn` 与流式响应；现有 D1 标记仍保障离线可恢复。                                                                                       |
| F-6  | Global Budget Authority 不可用或超限                   | `prepareTurn` Stage 2         | 超限返回 `429 BUDGET_EXCEEDED`；不可用返回 `503 DB_UNAVAILABLE`。DO 零落盘、零付费 Egress。                                                                                                      |
| F-7  | Edge Worker 在 `prepareTurn` 后、调用 Provider 前崩溃  | `prepareTurn` 与 `fetch` 之间 | 租约在 `45 s` 后过期，DO Alarm（<= `60 s`）触发恢复；因 `send_started_at_ms` 已保守标记（或未证明 `not_sent`），按 `unknown_billed` 记账，确保全局预算绝不低估，Turn 按策略失败或进入可控对账。  |
| F-8  | 流式途中客户端断连                                     | `Interactive Executor` 活跃流 | 立即停止 15 s 续期，撤销本地 Provider 请求（或若已生成句柄则 `handoffTurnToDurable`）；客户端重连后仅通过 `GET /messages` 与 `GET /turns/{id}` 恢复，零重复文本。                                |
| F-9  | 静默丢失 Executor（如 Worker Isolate OOM/被杀）        | 执行期间无通知中断            | `45 s` 后租约到期，Alarm 于 `<= 60 s` 内触发 `reconcileExpiredLease`；旧 Executor 若奇迹复活提交 `commitTurn`，被 `STALE_LEASE` Fence 拒收并丢弃文本。                                           |
| F-10 | 推理耗时超过 120 s                                     | 达到 `105–115 s` 移交窗口     | 调用 `handoffTurnToDurable`（`lease_epoch += 1`, `execution_mode = 'durable_queue'`），发送 `turn.handed_off` 事件并由 Queue Worker 凭 `provider_job_handle` 接力；最终只产出一条 `ember` 回复。 |
| F-11 | DO Alarm 连续 6 次重试全部失败（离线）                 | 所有客户端均离线              | Agent B 每分钟 `RecoverySweeper` 扫描 D1 `agent_recovery_registry` 到期行，唤醒 `AgentHeadDO.reconcileAndPlanCoverage`，在 `<= 2 min` 检测、`<= 5 min` 内重武装或派发 Queue。                    |
| F-12 | Provider 返回 2xx 但缺失 `usage` 字段                  | `commitTurn` 结算             | 严格按 `conservative_billed` 全额计入预留金额并开启 `usage_missing` 预算事故，阻断后续付费调用直至人工对账解除，同时合法发布本次已付费回复。                                                     |
| F-13 | Sweeper 退休标记与新 `prepareTurn` 并发                | Sweeper `retireCoverage` 竞态 | DO 先本地失效 `recovery_coverage` 再响应 Sweeper；`prepareTurn` 在 Stage 3 察觉版本变化失败或重登记，且 D1 `DELETE ... WHERE generation = ?` CAS 安全防误删。                                    |

---

## 11. M1 实施计划与本地验收门禁（Work Package A）

依据 ADR-0006，M1 **仅在本地隔离环境使用 Fake Provider 运行**，在 M0 契约获 Architect/CTO 审核批准后按以下顺序推进（独立 Git worktree + Draft PR，不部署、不调付费 API）：

### 11.1 实施切片划分

1. **M1-A1: `@ember/runtime-v2` 契约与核心包骨架（纯类型与 SQLite Schema）**
   - 落地 `AgentHeadRpc`、`GlobalBudgetAuthority`、`RecoveryRegistryPort` TypeScript 接口与 Zod 校验器；
   - 落地 Agent Head SQLite Schema 迁移器（版本号 1）及纯同步存储封装。
2. **M1-A2: `AgentHeadDO` 核心状态机与 `prepareTurn` / `commitTurn` 实现**
   - 实现 `prepareTurn`（3 阶段 + TOCTOU 重验 + 幂等回放）、`renewTurnLease`、`handoffTurnToDurable`、`commitTurn`、`cancelTurn`、`clearTranscript` 及 Direct Path 读接口；
   - 实现单 Alarm 计算器与本地预算账本（复用 `@ember/execution/budget-guard` 与 `@ember/model-gateway/limits`）。
3. **M1-A3: `GlobalBudgetDO` 权威预留服务与补偿器**
   - 实现并发安全的 `reserveGlobal` / `settleGlobal`（含 TTL 过期自动转 `consumed` 与 Incident Halt）；
   - 实现 Agent Head 对 `budget_sync` Outbox 的失败重试同步。
4. **M1-A4: Edge API Worker B1 兼容层与 Interactive Executor**
   - 挂载基于 `AgentHeadRpc` 的 B1 路由适配器（保持 B1 集成/E2E 测试行为全兼容）；
   - 在 `@ember/model-gateway` 增加 `FakeModelGateway` 流式与 `provider_job_handle` 模拟能力；
   - 实现 Interactive Executor（45s 租约 / 15s 续期 / 120s 移交 / 断连处理 / Bounded SSE）。
5. **M1-A5: 本地确定性故障注入与 Benchmark 套件（联合 Agent B）**
   - 与 Agent B 的 `RecoveryRegistry` + `ExecutionWorker` 联调本地端到端测试与负向测试。

### 11.2 M1 退出本地验收门禁（全部使用 Fake Provider）

- [ ] **B1 回归全绿**: 现有 B1 消息提交、幂等重放、Unknown-ACK 对账（`N-1..N-12`）、`transcript_epoch` 清除隔离、租户隔离（A↔B 404）与无内容日志审计在 V2 Agent Head 适配器下全部通过。
- [ ] **Fast/Durable/Handoff 故障注入**: 覆盖连接中流式输出、客户端断连、Worker 静默崩溃（验证 `<= 60 s` 进入恢复对账）、`> 120 s` 推理通过 `provider_job_handle` 原子移交至 Durable Path 且重连后仅有一条最终结果、旧 Executor 迟到提交被 `STALE_LEASE` 拒绝。
- [ ] **覆盖路径与降级证明**: 证明“已覆盖 Turn 零同步 D1 I/O”；测试未覆盖 Turn 在 D1 不可用时 Fail Closed（503），且已覆盖 Turn 与 Direct Path 继续可用；验证 Sweeper 退休与 `prepareTurn` 并发竞态零丢单。
- [ ] **并发预算与停机门禁**: 10+ 并发压测下 `GlobalBudgetDO` + `AgentHeadDO` 绝不突破 `globalDailyMicroUsd` / `tenantDailyMicroUsd` / `principalDailyMicroUsd`；验证 `usage_missing` 触发 Halt、预留过期不退款、以及测得 `GlobalBudget` 校验 P95、Runtime 耗时、SQLite 行写放大与流式 CPU 指标。
