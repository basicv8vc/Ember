# P0B-02 — Domain Models & Task State Machine 实现说明

> 状态：P0B-02 已实现领域类型、状态机、Zod 契约与单元测试。
> 本文件描述**实际代码**；未实现的能力在 [P0B-02-ACCEPTANCE.md](./P0B-02-ACCEPTANCE.md)
> 与第 9 节明确列出。
> 上游：P0-B Minimum Vertical Slice 任务书第 3、4、6、11、13 节；Architecture RFC v0.2。
> 基线：`main` @ `a169d802c6a46ffd64d22aa0af81a902b52c679c`（P0B-01 已合并）。

## 1. 目标与边界

P0B-02 建立后续持久化、Worker 调度与 Sandbox 执行共用的**唯一业务语义来源**：

- `@ember/domain`：纯 TypeScript 领域类型、Task/Run 状态机、稳定领域错误。
- `@ember/contracts`：Zod 输入/输出契约、跨模块接口、内部类型与 HTTP DTO 的显式转换。
- `tests/unit/`：完整状态矩阵、Schema 负向用例、错误契约与类型一致性测试。

本阶段**不包含**：Task/Run/Event 业务表、TaskRepository 实现、幂等创建、Worker/Lease/Fencing、
Execution Router 决策、FakeLLM/FakeSandbox、Artifact/Workspace/Checkpoint、`/v1/tasks`、
SSE、Tenant AuthZ、Approval/Budget 执行、真实 LLM/云 Sandbox、任意宿主机代码执行。
这些边界与 P0B-03～P0B-10 的归属见第 9 节。

## 2. 包职责与依赖方向

```text
packages/domain/                     packages/contracts/
  src/types.ts                         src/task-schemas.ts
  src/task-state-machine.ts            src/event-schemas.ts
  src/run-state-machine.ts             src/error-schemas.ts
  src/errors.ts                        src/interfaces.ts
  src/index.ts                         src/validation.ts
                                       src/index.ts
        ▲                                      ▲
        └────────── @ember/contracts ──────────┘
                     (zod only)

apps/api              packages/postgres
（本 PR 未改动）        （本 PR 未改动业务能力）
```

- `@ember/domain` **没有**任何外部运行时依赖；不引用 Hono、`pg`、Zod、文件系统、网络或时钟。
- `@ember/contracts` 只依赖 `@ember/domain` 与 Zod 4；不依赖 API 或 PostgreSQL。
- 没有循环依赖：domain 不反向引用 contracts，contracts 不引用 API/postgres。
- 构建沿用 `tsc -b` Project References；根 `tsconfig.build.json` 依次构建
  domain → contracts → postgres → api。Vitest alias 只用于免构建测试，构建产物不依赖 alias。

## 3. 领域模型

### 3.1 身份与基础类型

| 类型            | 语义                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `Id`            | 服务端生成的 UUID 字符串；客户端不能选择 ID                                                            |
| `AuthContext`   | `{ tenantId, principalId, policyVersion }`，由 Gateway 从 Dev Token 构造，**不来自请求体**             |
| `ExecutionPath` | `fast \| standard \| heavy`，由 Execution Router 决定                                                  |
| `TaskKind`      | 仅 `mock.chat`、`mock.compute`、`mock.file`、`mock.approval`                                           |
| `TaskCommand`   | 已校验的内部命令；`kind` 与 `input` 通过判别联合保持关联，并包含 Header 派生的 `idempotencyKey`        |
| `TaskReceipt`   | 持久化成功后的回执：`taskId`、`status`、`acceptedAt`、`replayed`                                       |
| `TaskView`      | Tenant-scoped 读取模型：状态、当前 Run、尝试次数、时间戳                                               |
| `LeasedRun`     | 一次被 Worker 租约持有的 Run：`taskId`、`runId`、`tenantId`、`attempt`、`leaseEpoch`、`leaseExpiresAt` |
| `RunRecord`     | Run 的持久化视图：`runId`、`taskId`、`attempt`、`leaseEpoch`、`status`、起止时间                       |
| `TaskEvent`     | 已发生事实：`taskId`、`sequence`、`phase`、`occurredAt`、`traceId`、净化后的 `payload`                 |

Task / Run / Event 的边界：

- **Task**：用户意图的整体生命周期，可关联多个 Run。
- **Run**：某一次执行尝试。一个 Run 结束不代表创建了新 Task。
- **Event**：已经发生的事实/进度，用于事件日志、轮询与 SSE 重放，不作为唯一事实来源。

### 3.2 `AuthContext` 与客户端输入边界

- `CreateTaskBody`/`CreateTaskRequest` 中没有 `tenantId`、`tenant_id`、`principalId`、
  `policyVersion`、`status`、`leaseEpoch` 等字段。
- 所有对象 Schema 使用 `z.strictObject`；客户端尝试夹带这些字段会被拒绝，而不是被静默忽略。
- `Idempotency-Key` 只从 Header 读取，由 `IdempotencyKeySchema` 单独校验，再与 Body 组合成
  `TaskCommand`。Body 中的 `idempotencyKey` 同样被拒绝。

### 3.3 Mock 输入语义

| Kind            | 字段               | 约束                                 | 说明                                      |
| --------------- | ------------------ | ------------------------------------ | ----------------------------------------- |
| `mock.chat`     | `prompt`           | 1–8,000 字符                         | 未来 FakeLLM 的确定性输入                 |
|                 | `maxOutputTokens?` | 1–2,048 整数                         | P0-B 不产生真实 token 计费                |
| `mock.compute`  | `operation`        | 仅 `sha256`                          | 白名单操作；未知操作在边界被拒绝          |
|                 | `text`             | 0–64,000 字符                        | 计算输入                                  |
| `mock.file`     | `fileKey`          | 1–256 字符，工作区相对逻辑 Key       | 不允许绝对路径、反斜杠、空段、`.`/`..` 段 |
|                 | `content`          | 0–64,000 字符                        | UTF-8 文本                                |
|                 | `mediaType?`       | 1–128，`type/subtype`                | 不接受 `; charset=...` 等参数             |
| `mock.approval` | `action`           | 1–128，`[A-Za-z0-9][A-Za-z0-9._:-]*` | 逻辑动作标签，不是可执行命令              |
|                 | `reason?`          | 0–1,000 字符                         | 人类可读原因                              |

`fileKey` 的正则（`LOGICAL_FILE_KEY_PATTERN`）阻止 `/etc/passwd`、`C:\...`、`../`、`a/./b`、
`a//b`、末尾斜杠与空段。真正的路径隔离、符号链接防护与 Sandbox 根目录映射属于 P0B-06；
本阶段只固定语义和边界。

`deadlineAt`/`deadline_at` 使用带显式时区的 ISO 8601/RFC 3339 时间戳。Schema **不读取当前时间**，
因此不会在纯校验层引入时钟依赖；Deadline 是否已过由后续应用层判断。

### 3.4 内部类型与 HTTP DTO

同一业务对象只有一个内部 canonical 形状，HTTP 字段通过显式转换表达：

| 内部（camelCase） | HTTP（snake_case）              | 转换                                                  |
| ----------------- | ------------------------------- | ----------------------------------------------------- |
| `CreateTaskBody`  | `CreateTaskRequest`             | `CreateTaskRequestSchema` 校验后 `toCreateTaskBody()` |
| `TaskCommand`     | Body + `Idempotency-Key` Header | `toTaskCommand(body, headerKey)`                      |
| `TaskReceipt`     | `TaskReceiptDto`                | `toTaskReceiptDto()`                                  |
| `TaskEvent`       | `TaskEventDto`                  | `toTaskEventDto()`                                    |
| `DomainError`     | `ErrorResponse`                 | `toErrorResponse(error, requestId?)`                  |

`TaskReceiptSchema`、`TaskEventSchema` 与 DTO Schema 都独立存在；DTO 不是内部对象的别名，
避免出现两套互相矛盾的字段定义。HTTP 状态码映射（例如 `INVALID_ARGUMENT` → 400）属于 P0B-07，
本阶段没有建立 `/v1/tasks`，也没有声称已实现 HTTP 4xx。

### 3.5 Event payload 脱敏契约

`TaskEventPayload` 不是任意 JSON 对象，而是一个**封闭的安全元数据 allowlist**。允许的字段仅有：

- 枚举：`taskKind`、`route`、`fromStatus`、`toStatus`、`runStatus`、`errorCode`；
- UUID：`runId`、`artifactId`、`sandboxId`；
- 非负整数：`attempt`、`workspaceVersion`、`durationMs`、`policyVersion`；
- 布尔：`replayed`、`cancelRequested`、`simulated`。

没有自由文本字段。`TaskEventPayloadSchema` 使用 `z.strictObject`，因此 `prompt`、`messages`、
`token`、`apiKey`、`authorization`、`toolOutput`、`stdout`、`stderr`、`content`、`text`、
`sql`、`password`、`path`、`stack`、`input`、`output` 等键一律被拒绝；把秘密塞进已允许字段
也必须满足该字段的枚举/UUID/整数/布尔类型，不能作为字符串携带。

`toTaskEventDto()` 在映射前重新解析完整 `TaskEvent`，运行时被篡改并附带额外字段的对象会 fail closed
并返回安全的 `INVALID_ARGUMENT`。`TASK_EVENT_PAYLOAD_KEYS` 与测试固定了当前 allowlist；未来新增
自由文本或工具输出字段必须先修改 Contract Test 并完成脱敏评审，不能仅靠长度限制放行。

## 4. Task 状态机

实现位置：`packages/domain/src/task-state-machine.ts`。

| From               | 允许的 To                                                                  |
| ------------------ | -------------------------------------------------------------------------- |
| `queued`           | `running`、`cancelled`                                                     |
| `running`          | `completed`、`waiting_approval`、`retryable_failed`、`failed`、`cancelled` |
| `waiting_approval` | `queued`、`failed`、`cancelled`                                            |
| `retryable_failed` | `queued`、`failed`                                                         |
| `completed`        | —（终态）                                                                  |
| `failed`           | —（终态）                                                                  |
| `cancelled`        | —（终态）                                                                  |

API：

```ts
canTransitionTask(from: TaskStatus, to: TaskStatus): boolean;
transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus; // 非法时抛 InvalidStateTransitionError
isTerminalTaskStatus(status: TaskStatus): status is TaskTerminalStatus;
```

规则：

1. 只允许表中声明的边；未声明的边一律拒绝。
2. `completed`、`failed`、`cancelled` 是终态，没有任何出边；迟到 Worker 不能改写。
3. **同状态赋值不是 no-op**：`transitionTask('running', 'running')` 返回
   `INVALID_STATE_TRANSITION`。调用者不能把“重复设置”当作隐式合法转换。
4. 非法转换抛结构化 `InvalidStateTransitionError`，稳定错误码
   `INVALID_STATE_TRANSITION`，并保留 `entity`、`from`、`to`。
5. 状态机不访问数据库、系统时间、网络、随机数或全局可变状态；转换表被 `Object.freeze`。
6. `accepted` 是事件/回执事实，不是 `TaskStatus`；`waiting_external` 属于 RFC 预留能力，
   本阶段**不在** `TaskStatus` 中，也没有真实外部回调。

### 4.1 特殊语义

| 边                           | 语义（仅定义，不执行副作用） |
| ---------------------------- | ---------------------------- |
| `waiting_approval → queued`  | Mock 审批通过，重新排队      |
| `waiting_approval → failed`  | 审批拒绝或过期               |
| `retryable_failed → queued`  | 满足重试调度条件             |
| `running → retryable_failed` | 可重试执行失败               |
| `running → cancelled`        | 合作式取消成功               |

重试次数、退避、Deadline、审批超时、租约有效期、取消与提交竞争，必须由 P0B-04/P0B-08 在
持久化层与 Worker 中结合事务和 fencing 验证。纯状态机**不**假装已经完成这些分布式保证。

### 4.2 有意未加入的边

- `retryable_failed → cancelled`：原任务书状态图没有覆盖“重试等待期间取消”。本阶段不悄悄加入，
  记录为 **OQ-1**，需在 P0B-08 前确定（见第 9 节）。
- `waiting_approval → running`：审批通过必须先回到 `queued`，由调度重新领取。
- `queued → completed`、`waiting_approval → completed`、`retryable_failed → completed`：
  不允许跳过执行或重试状态。

## 5. Run 状态机

实现位置：`packages/domain/src/run-state-machine.ts`。

| From               | 允许的 To                                                                        |
| ------------------ | -------------------------------------------------------------------------------- |
| `created`          | `running`                                                                        |
| `running`          | `succeeded`、`failed_retryable`、`failed_terminal`、`lease_expired`、`cancelled` |
| `succeeded`        | —（终态）                                                                        |
| `failed_retryable` | —（终态）                                                                        |
| `failed_terminal`  | —（终态）                                                                        |
| `lease_expired`    | —（终态）                                                                        |
| `cancelled`        | —（终态）                                                                        |

API：

```ts
canTransitionRun(from: RunStatus, to: RunStatus): boolean;
transitionRun(from: RunStatus, to: RunStatus): RunStatus;
isTerminalRunStatus(status: RunStatus): status is RunTerminalStatus;
```

规则：

1. 必须先从 `created` 进入 `running`，不能直接从 `created` 到任何终态。
2. 所有终态 Run 不能重新运行，包括 `failed_retryable`。
3. `lease_expired → succeeded` 被拒绝：过期 Run 的迟到结果不能覆盖新 Run。
4. 同状态赋值同样被拒绝，并返回 `INVALID_STATE_TRANSITION`。
5. **Run 失效 ≠ Task 最终失败**：Task 可以在旧 Run `lease_expired` 后重新排队，由新的 Run 继续执行。
6. Lease Epoch / Fencing Token 的数据库原子校验属于 P0B-04；本阶段只声明类型与纯规则。

## 6. 领域错误

实现位置：`packages/domain/src/errors.ts`、`packages/contracts/src/error-schemas.ts`。

`DomainError` 包含：

- 稳定的 `code`（联合类型，不是任意字符串）；
- `message` / `publicMessage`：由 `code` 选择的固定安全文本，是唯一允许进入 `toJSON()` 或
  HTTP DTO 的文本；
- `diagnostic`：内部诊断文本（例如驱动消息、SQL 片段），**从不序列化**，只供内部日志/调试；
- `retryable` 建议分类：`not_retryable` / `bounded_retry` / `conditional`。

内部诊断存放在 `WeakMap` 中，只能通过显式 `error.diagnostic` 读取；它不会出现在 `Object.keys()`、
`JSON.stringify(error)`、`toJSON()` 或 `toErrorResponse()` 中。`toErrorResponse()` 只使用
`error.publicMessage`，因此任意自定义诊断——包括数据库密码、API Token、SQL 错误和宿主文件路径——
都不会进入公开 DTO。

| Code                         | Retryability                   |
| ---------------------------- | ------------------------------ |
| `INVALID_ARGUMENT`           | `not_retryable`                |
| `UNAUTHENTICATED`            | `not_retryable`                |
| `NOT_FOUND`                  | `not_retryable`                |
| `POLICY_DENIED`              | `not_retryable`                |
| `BUDGET_EXCEEDED`            | `not_retryable`                |
| `IDEMPOTENCY_CONFLICT`       | `not_retryable`                |
| `WORKSPACE_VERSION_CONFLICT` | `conditional`                  |
| `STALE_LEASE`                | `conditional`                  |
| `DB_UNAVAILABLE`             | `bounded_retry`                |
| `SANDBOX_NOT_READY`          | `bounded_retry`                |
| `EXECUTION_TIMEOUT`          | `bounded_retry`                |
| `MOCK_TOOL_FAILED`           | `conditional`                  |
| `DEADLINE_EXCEEDED`          | `conditional`                  |
| `CANCELLED`                  | `not_retryable`                |
| `INVALID_STATE_TRANSITION`   | `not_retryable`（P0B-02 扩展） |

说明：

- `INVALID_STATE_TRANSITION` 是 P0B-02 增加的扩展码：原任务书错误表只列 API 面向的错误，
  非法状态转换需要独立、稳定、可测试的领域码。已在测试和本文件中记录。
- `conditional` 明确表示“是否可重试取决于执行阶段、Deadline、Lease 或工具定义”，由后续应用层判断；
  不在纯领域层假装给出全局答案。
- 调用者必须用 `code`/`instanceof`/`isDomainError()` 判断错误，禁止依赖 `message` 字符串匹配。
- `InvalidArgumentError` 只保留字段路径与规则码，不保留被拒绝的值；其 `diagnostic` 用于内部排查，
  公开文本仍是固定安全消息。
- `toErrorResponse()` 只输出 `{ error: { code, message, request_id? } }`，不输出 `stack`、`cause`、
  `diagnostic`、SQL 或原始输入。
- 公开消息上限为 `MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 512`；内部诊断上限为
  `MAX_DIAGNOSTIC_MESSAGE_LENGTH = 2048`，两者独立。

## 7. 跨模块接口契约

实现位置：`packages/contracts/src/interfaces.ts`。本阶段只有类型，没有实现。

| 接口              | 最小职责                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TaskRepository`  | `create` / `get` / `requestCancel`，全部接收 `AuthContext`                                                                          |
| `LeaseQueue`      | `claimNext` / `heartbeat` / `reapExpired` / `finish`；`finish` 返回是否仍持有租约                                                   |
| `ExecutionRouter` | `decide(ctx, cmd) → { path, reason, policyVersion }`                                                                                |
| `ArtifactStore`   | `put` / `get` / `verify` / `delete`，内容寻址与 Tenant scope                                                                        |
| `WorkspaceStore`  | `load` / `commit(expectedVersion, manifest)`，版本冲突显式失败                                                                      |
| `SandboxProvider` | `capabilities` / `create` / `waitReady` / `exec` / `putFile` / `getFile` / `stop` / `destroy` / `usage`，可选 `snapshot` / `resume` |

`SandboxCapabilities`、`SandboxSpec`、`SandboxExecResult`、`SandboxUsageRecord`、
`WorkspaceSnapshot`、`WorkspaceManifest` 等类型沿用 RFC v0.2 第 5 节的 provider-neutral 语义。
`create` 返回不代表 Ready，`snapshot`/`resume` 是显式可选能力。

**没有**创建 FakeSandbox、FakeLLM、内存 Repository 或空服务来让未实施测试显示 PASS。

## 8. 验证策略

- Task 状态机：独立编码的 11 条合法边 + 完整 7×7 矩阵中的 38 条非法边；终态、同状态、
  跳跃转换、稳定错误码与表不可变性。
- Run 状态机：6 条合法边 + 完整 7×7 矩阵中的 43 条非法边；五个终态、`lease_expired → succeeded`、
  同状态与不可变性。
- Zod：所有合法 kind/input、未知 kind、缺失/多余字段、非法 UUID、超长、非法 Deadline、
  Tenant/Principal 伪造字段、Header Key 边界、wire/internal 映射。
- 错误契约：全部错误码、retryability、`DomainError` 的 public/diagnostic 分离、非法转换统一抛错；
  使用含数据库密码、API Token、SQL 错误和宿主路径的诊断做负向序列化测试，确认公开 DTO 不泄露。
- Event 脱敏：固定 allowlist 的键/类型、敏感键负向用例、把秘密塞入允许字段的负向用例、嵌套/数组/null
  拒绝，以及 `toTaskEventDto()` 对运行时篡改对象 fail closed。
- 因本阶段没有数据库和 Router/FakeSandbox 实现，B-T01/B-T04 只覆盖纯逻辑部分；
  B-T02/B-T03 仅准备接口，状态为 `DEFERRED`，不计入 PASS。详见验收报告。

## 9. 已知设计问题与后续归属

| 编号  | 问题                                                        | 当前处理                                | 归属                  |
| ----- | ----------------------------------------------------------- | --------------------------------------- | --------------------- |
| OQ-1  | `retryable_failed` 等待重试期间是否允许取消？原状态图未覆盖 | 不加入边；记录为待定                    | P0B-08 前决策         |
| OQ-2  | `waiting_external` / 外部回调                               | 不进入 `TaskStatus`，不实现             | P0-B 范围外，后续 RFC |
| OQ-3  | 审批自动超时                                                | 只定义 `waiting_approval → failed` 语义 | P0B-08                |
| OQ-4  | 重试次数、退避、最大尝试                                    | 纯状态机不计算                          | P0B-04                |
| OQ-5  | Deadline 是否已过                                           | Schema 只校验格式                       | P0B-04/07             |
| OQ-6  | Lease Epoch / Fencing 原子性                                | 只声明 `LeaseQueue` 与 `LeasedRun`      | P0B-04                |
| OQ-7  | `mock.file` 的宿主路径隔离、符号链接逃逸                    | 只约束逻辑 Key                          | P0B-06                |
| OQ-8  | HTTP 状态码、request_id、SSE 错误映射                       | 只定义 `ErrorResponse` 形状             | P0B-07                |
| OQ-9  | Idempotency 摘要与并发创建                                  | 只校验 Header Key 格式                  | P0B-03                |
| OQ-10 | Budget 暂停/恢复语义                                        | 只有错误码                              | P0B-08                |

后续工作包不得把上述纯领域契约当作已经完成的分布式保证。例如：`transitionTask` 通过不代表
数据库事务已提交、Lease 未过期或迟到 Worker 已被 fencing 拒绝。

## 10. 与上游文档的偏差

| 项目                | 上游                           | 本 PR                | 原因                                   |
| ------------------- | ------------------------------ | -------------------- | -------------------------------------- |
| 状态机位置          | 任务书草案                     | 纯函数模块，无副作用 | 明确可测试、可复用                     |
| `TaskCommand.input` | 草案为 `unknown`               | 按 kind 的判别联合   | 让非法 kind/input 组合在类型层不可表达 |
| `TaskStatus`        | 草案含 `waiting_external` 预留 | 仅 7 个 P0-B 状态    | Prompt 明确本阶段不得实现外部等待      |
| 同状态转换          | 未规定                         | 显式拒绝             | 避免隐式 no-op 绕过状态校验；已记录    |
| `ArtifactStore`     | 草案只列 put/get               | 增加 verify/delete   | 对齐任务书模块职责表；仍为纯接口       |
| `LeaseQueue`        | 草案只列 claim/heartbeat/reap  | 增加 finish          | 对齐模块职责表；fencing 由 P0B-04 实现 |
| HTTP 错误映射       | 任务书第 4 节                  | 只定义 DTO 形状      | `/v1` 路由属于 P0B-07                  |

没有改变已审核的核心状态语义；`retryable_failed → cancelled` 等未覆盖边保持未实现并记录。
