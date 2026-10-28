# Project Ember — Pi Agent 工程任务 Prompt

> **Task ID:** `P0B-03`  
> **Task:** PostgreSQL Business Schema, Tenant-Scoped Repositories & Idempotent Task Creation  
> **Repository:** https://github.com/basicv8vc/Ember  
> **Base:** 最新 `origin/main`；审查起点为 P0B-02 squash merge `a74d68d5096b2974fc225d32c1a1a27cf2dd78f6`  
> **Feature branch:** `feature/p0b-03-durable-task-inbox`  
> **Deliverable:** **仅 Draft PR → main；不得合并**  
> **Environment:** 本地 PostgreSQL 17；**禁止付费云、真实 LLM、生产数据**

你是 Project Ember 的 Senior Backend / Database Engineer。请实施 **P0B-03 — Durable Task Inbox**：首次将已审核的领域命令以原子事务持久化到 PostgreSQL，并实现 Tenant 隔离、并发幂等与真正的 Durable Ack。你必须实际编写代码、测试、文档并提交 Draft PR，等待 CTO 审核。

## 1. 背景与工程原则

Ember 是 Cloud Agent + 可选 Local Device Agent 的 Personal Agent Platform。逻辑上长期在线的 Agent **不意味着**为每个 Agent 分配常驻 Sandbox。任务控制面必须首先保证 **正确、可恢复、可追踪、低成本**。

已审核的上游文档：

- [Architecture RFC v0.2](https://chatgpt.com/library?file_id=libfile_8da6b47699548191bcdeac5e09db5353&account_id=personal)
- [P0-B Minimum Vertical Slice 工程任务书](https://chatgpt.com/library?file_id=libfile_9397a13d80f48191aacfa47a8416bd5b&account_id=personal)

现有事实：P0B-01 已提供 Node 24 LTS、pnpm、Hono、PostgreSQL 17、`pg`、幂等 Migration Runner、Vitest、CI。P0B-02 已提供 `@ember/domain`、`@ember/contracts`、Task/Run 状态机、Zod、固定安全错误消息和 Event Payload 白名单。

**本阶段的定义：Task 一旦返回创建回执，它及其 `accepted` Event 必须已在数据库中提交成功；重复请求绝不能产生第二个逻辑 Task。**

不启动 Worker、不调用 Sandbox、不实现任务执行或 HTTP `/v1/tasks`，也不把“能插入一条 SQL”冒充 Durable Ack。

## 2. Git 与工作区边界

1. 先检查当前仓库、`git status`、远端 main HEAD、已有分支及仓库指导文件。不得覆盖未提交的用户工作。
2. 以最新 `origin/main` 创建独立分支 `feature/p0b-03-durable-task-inbox`。若 main 已不同于上面的审查起点，应先比对新提交；若与任务冲突，暂停报告。
3. 保留 P0B-01 的 `0001` Migration 及既有验收文档、P0B-02 的类型/契约/状态机设计；未经必要性论证不要改变它们。
4. 允许在该 Feature Branch 实现、运行本地测试、提交、推送并创建 Draft PR；**严禁直接改 main、强推、自动合并、修改保护规则或部署云服务**。

## 3. 技术栈与模块范围

保持 Node.js 24 LTS、TypeScript strict + NodeNext/ESM、pnpm 12、Zod 4、`pg`、显式 SQL Migration、PostgreSQL 17、Vitest、现有 GitHub Actions。

在现有 `packages/postgres` 中新增适度模块，例如：

```text
migrations/
  0002_durable_task_inbox.sql
packages/postgres/src/
  repositories/
    agent-repository.ts
    task-repository.ts
  task-digest.ts
  ... existing migration / pool infrastructure
tests/integration/
  durable-task-inbox.test.ts
  task-idempotency.test.ts
docs/
  P0B-03-IMPLEMENTATION.md
  P0B-03-ACCEPTANCE.md
```

路径是建议，不要求建立无代码的包或空类。优先复用现有数据库连接、迁移、配置与错误体系，不引入 ORM、新队列、Redis 或其他数据库。

`@ember/domain` 和 `@ember/contracts` 是领域与校验的事实来源：不要在 PostgreSQL 包另造状态枚举、TaskKind 或 Error Code。必要的接口微调需保持向后兼容，并记录理由。

## 4. SQL Schema 与完整性

新增 **前向** Migration `0002_*.sql`，不得篡改、重命名已应用的 `0001`；沿用既有 checksum、filename guard、advisory lock 与每迁移独立事务。

本阶段完成 Durable Inbox 所需的最小业务关系，至少包括：

| 表            | 要求                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `tenants`     | UUID PK、名称、创建时间                                                                                       |
| `principals`  | tenant FK、principal ID、role；**不存储明文 Dev Token**                                                       |
| `agents`      | tenant-scoped Agent、名称、策略版本、Workspace 关联                                                           |
| `workspaces`  | 一 Agent 一 Workspace、版本初值 0、未来 manifest 引用；不实现文件存储                                         |
| `tasks`       | tenant / agent、kind、受校验的输入、稳定 digest、idempotency key、状态、deadline、重试/lease 预留字段、时间戳 |
| `runs`        | 对 P0B-04 保留 Run 基本结构、attempt、epoch、worker/status，**不实施 claim/lease**                            |
| `task_events` | task/tenant、单 Task sequence、phase、白名单 payload、trace ID、时间戳                                        |

`checkpoints`、`artifacts`、`approvals`、`usage_records`、`inbound_events` 等表可按依赖关系留给其后续工作包；不能因为上游列出完整 P0-B 最终表清单，就在本阶段制造未经使用和测试的大量空 Schema。若提前添加表，必须说明其必要性并提供约束测试。

数据库必须实现：

- `UNIQUE (tenant_id, idempotency_key)`；同一 Tenant 下唯一，而不同 Tenant 可重复使用相同 Key。
- 与 Tenant 关联的资源使用显式 `tenant_id`，并优先使用 **复合唯一键与复合外键**（例如 `(tenant_id, agent_id)`），数据库层拒绝跨 Tenant 资源引用。
- Task 状态、Run 状态、非负 attempt/epoch/Workspace version 等重要约束在 DB 层显式检查；业务逻辑仍复用 Domain 状态机。
- 为后续调度准备 `tasks(status, next_run_at, created_at)`、lease expiry、Run 与 Event 查询所需索引。
- Task Event 在单任务内严格按 sequence 递增；第一条 `accepted` 推荐为 sequence 1，创建事务内仅插入一次。
- 使用 `TIMESTAMPTZ` 保存时间，避免本地时区字符串与排序差异。
- Agent 与 Workspace 的初始关联须在一个事务里完成；若采用双向 FK，明确处理建表与插入时的循环依赖，不留下半创建关联。
- 不存储 Token、密钥、宿主路径，SQL 错误不泄露到公共 Domain Error Message。

注意：**仅建立 `runs` 表与 lease 预留字段，不代表 Worker、Fencing、Lease Safety 已完成。** 不得虚报 B-T09～11。

## 5. Repository 契约

实现真实 `pg` Repository，至少支持：

**AgentRepository**

- 在受验证 `AuthContext` 下创建 Tenant 自己的 Agent 与初始 Workspace（事务原子性）。
- Tenant-scoped 查找 Agent；跨 Tenant 查询返回 `null` / `NOT_FOUND`，不泄露存在性。
- 可使用显式本地 Fixture / Testkit 创建 Tenant、Principal，但不得让客户端通过 Task Command 自行指定 Tenant。

**TaskRepository**

- `create(ctx, cmd): Promise<TaskReceipt>`：验证 Domain/Contract 与 Agent Tenant 所属权，事务性创建 Task + 首条 Event。
- `get(ctx, taskId): Promise<TaskView | null>`：Tenant-scoped，跨 Tenant 与不存在对象均不可见。
- P0B-02 已声明的 `requestCancel(ctx, taskId)`：若要让实现满足完整接口，本阶段**仅持久记录取消意图**（`cancel_requested`），不得宣称已经处理合作式取消、Task 终态或 Cancel API。清楚标为 P0B-08 才完成的能力；不得让本阶段测试误以为取消已完成。也可以在不破坏既有接口的前提下将该方法留到后续实现，并说明类型与实现边界，禁止抛出伪装成功的空实现。

所有读写以 `ctx.tenantId` 限定；不能仅检查资源 ID 在全局存在。使用已审核的 `DomainError` 固定公开文本以及内部安全诊断。连接池错误、SQL 错误不得进入外部响应。

## 6. 幂等键与规范化 Digest（重点）

对有效的 `TaskCommand` 计算确定性 `SHA-256` 请求摘要，定义并测试规范化规则：

1. 摘要覆盖 `agentId`、`kind`、按 Kind 校验的 `input` 和 `deadlineAt`（包含与命令语义相关的全部字段）。
2. Digest 生成前先做 Zod 校验；采用**确定性规范序列化**，对象字段顺序不同但语义一致时摘要相同，数组顺序不变。
3. Idempotency Key 用作 `(tenant_id, idempotency_key)` 唯一查找键，不是请求正文的合法字段；是否纳入摘要必须明确且一致，推荐不纳入。
4. 不记录完整请求内容、Prompt 或敏感信息到日志；日志可记录 opaque task ID、digest、结果类别。
5. 若设置 64 KiB 输入限制，按 UTF-8 **字节数**核对，而不是只比较 JS 字符数量；未来 HTTP Gateway 仍须独立限流与校验。

同键处理必须是：

| 情形                            | 返回/行为                                                                   |
| ------------------------------- | --------------------------------------------------------------------------- |
| 同 Tenant，新 Key               | 插入 Task `queued` + Event `accepted`，Commit 后返回 `replayed: false`      |
| 同 Tenant、同 Key、同规范化请求 | 返回同一个 Task ID、**当前**状态、`replayed: true`，不能重复插入 Task/Event |
| 同 Tenant、同 Key、不同请求     | 稳定 `IDEMPOTENCY_CONFLICT`；未来 HTTP 映射 409，本阶段不实现路由           |
| 不同 Tenant、相同 Key           | 相互独立，各有自己的 Task                                                   |
| 同一 Key 高并发竞争             | DB 约束保证只创建一个 Task；失败的请求按 Digest 判定重放或冲突              |

不得使用仅依赖进程内 `Map`、Mutex、`SELECT` 后 `INSERT` 的非原子检查来实现幂等。可以使用 PostgreSQL `UNIQUE` 与明确事务/`ON CONFLICT` 策略；并发冲突后的重读必须在正确的事务隔离与可见性语义下完成。**不用全局串行锁牺牲所有 Tenant 的并发。**

当同一 Key 的第一次创建已完成而 Task 状态后来改变时，重放回执应反映最新持久状态，但 `taskId` 必须相同；首个 `acceptedAt` 保持不变。

## 7. 原子事务与 Durable Ack

一个新 Task 的创建流程必须在**同一个 DB 事务**中完成：

1. 校验 `AuthContext` / `TaskCommand`，确认 Agent 属于 Tenant。
2. 生成规范化摘要及 server-side Task ID、Event ID/Trace ID 等必要标识。
3. 创建 `queued` Task，初始化 attempts / lease 相关默认值。
4. 写入第一条符合 `TaskEventSchema` 白名单的 `accepted` Event；禁止将原始 Prompt、Token、工具输出写入 Event。
5. `COMMIT` 成功后，才可以返回 `TaskReceipt`。

失败时必须 `ROLLBACK`；**不得产生“客户端已得到 Task ID，但数据库中不存在 Task”的假回执**。

处理数据库 Commit 成功但客户端未收到 ACK 的场景：同 Idempotency Key 重试返回已创建 Task。不会新增第二条 accepted Event。

Event sequence、Task 状态与 Idempotency 唯一性由数据库约束共同保护；P0B-03 不需要实现 Event SSE/轮询 API，但持久 Event 必须能被以后按 Task 和 sequence 正确读取。

不得在持有数据库事务期间调用 LLM、Sandbox、HTTP 或任何长时间外部业务操作。

## 8. 必须实现的真实 PostgreSQL 测试

沿用 P0B-01 的临时 `ember_it_<随机>` Schema / 独立测试数据库约定，仅清理本次测试创建的资源；严禁 DROP/TRUNCATE 未验证归属的用户数据。不能用 SQLite 或 Fake DB 冒充集成测试。

至少覆盖：

**B-T06 — Durable Ack**

- 成功返回时，独立连接能读取 Task 与首条 Event。
- 在创建任务事务中故意引入 Event 写入失败，Task 必须回滚且不能 ACK。
- Commit 后、ACK 前模拟丢失响应，再用同 Key 重试，仍只保留一个 Task/首个 Event。
- DB 不可用或 Commit 失败时，不能返回成功回执。

**B-T07 — Concurrent Idempotency**

- 同 Tenant、同 Key、同 Payload，并发至少 20 次，使用真正独立的数据库连接/事务竞争。
- 所有成功响应 `taskId` 相同；恰好一条 Task、一条 accepted Event。
- 首次创建 `replayed: false`，其余返回 `replayed: true`（不依赖谁先赢得竞态）。
- 不同 Tenant 可独立使用相同 Key，不发生串租户。
- 属性顺序不同的等价 JSON 产生相同 Digest；不同语义输入不能假重放。

**B-T08 — Idempotency Conflict**

- 同 Tenant、同 Key、不同 `kind`、不同 `input`、不同 Agent 或 Deadline 产生稳定冲突。
- 冲突后原 Task、Digest 与 Event 不被修改；不插入第二条 Task/Event。

**Tenant / SQL Integrity**

- Tenant B 使用 Tenant A 的 Agent ID 创建 Task，失败且不泄露 A 的存在性。
- Tenant B `get(A 的 taskId)` 得到 `null`。
- 直接使用 SQL 尝试插入跨 Tenant FK，数据库本身拒绝。
- `idempotency_key` 唯一索引确实存在；不能只靠代码约束。
- Workspace 初始创建与 Agent 关联原子一致；版本初值为 0。
- Event sequence 与限制字段受到约束；Event Payload 不包含自由文本通道。

**Migration / Regression**

- 全新临时 Schema 依序应用 `0001` + `0002` 成功，重复迁移零变更。
- 修改或重命名已应用 Migration，原有完整性检查仍拒绝。
- P0B-01/02 的测试、ESM 构建、Health/Ready 行为无回归。
- 不要求本阶段实现 B-T09～11 的 Worker/Lease/Fencing 行为。

如需故障注入，请以可控测试钩子或事务内约束错误实现；不得破坏公共 Migration、篡改共享数据库或在仓库中硬编码生产连接串。

## 9. 后续能力的清晰边界

**本阶段不做**：

- Worker polling / `FOR UPDATE SKIP LOCKED` claim 的实际实现。
- Lease acquire / heartbeat / reaper / fencing / retry backoff。
- Run 的真实执行生命周期；仅有为 P0B-04 准备的 Schema。
- Execution Router、FakeLLM、FakeSandbox 或真实 Shell/Browser 执行。
- Artifact 文件系统、Workspace CAS、Checkpoint 或 Orphan GC。
- `/v1/tasks`、HTTP 4xx、Dev Token Gateway、SSE、审批/预算路由。
- 完整取消处理或 `retryable_failed → cancelled` 新状态边；记录已有 OQ-1，**在 P0B-04 调度开发前必须确定其与 `cancel_requested` 的交互规则**。
- Cloudflare/E2B/Daytona/Boat、外部 LLM、BYOK、OAuth、真实付款或云部署。

**不允许**用一个总是成功的 Mock Repository、预置假回执、内存 Map、独占单连接串行测试来伪装 Durable Persistence 或并发安全。

## 10. 验证命令与质量门槛

在真实环境执行并记录结果：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm build
pnpm dev:db
pnpm db:migrate
pnpm db:migrate
pnpm test:integration
git diff --check
```

本地未安装 Docker/PG 时必须标记 `NOT RUN/BLOCKED`，并以 GitHub Actions 临时 PostgreSQL service container 验证，**不得谎报本地通过**。保留 CI 最小权限及零付费密钥。

另需验证通过构建后的 ESM 入口可以导入和使用 PostgreSQL Repository；单元测试的 Vitest alias 成功不能替代构建产物实际可消费。

**验收门槛**：

- [ ] 真实 PostgreSQL 中 Task + `accepted` Event 事务原子落库。
- [ ] 新任务 Ack 严格在 Commit 之后。
- [ ] `UNIQUE (tenant_id, idempotency_key)` 在 DB 存在且有效。
- [ ] 并发同 Key 无重复 Task/Event。
- [ ] 相同请求重放与不同请求冲突均按定义处理。
- [ ] Tenant-safe FK、Tenant-scoped Repository 查询通过负向测试。
- [ ] 无 raw prompt、Token、SQL、数据库密码出现在 Event/公开错误/日志。
- [ ] Migration 0001 不变；0002 可复现、幂等。
- [ ] 全部 P0B-01/02 回归测试通过，CI Green。
- [ ] `B-T06`、`B-T07`、`B-T08` 均有实际数据库测试证据。
- [ ] 未宣称 B-T09～11、HTTP/API、Worker、Sandbox 已完成。
- [ ] 无付费云、生产数据、真实凭据或隐式外部副作用。
- [ ] PR 保持 Draft / Open / **未合并**。

## 11. 文档和 PR

新增：

- `docs/P0B-03-IMPLEMENTATION.md`：Schema、FK/索引、事务边界、规范化 Digest、幂等并发处理策略、Error/Cancel 边界、Migration 与后续 Worker 依赖。
- `docs/P0B-03-ACCEPTANCE.md`：实测 OS/Node/pnpm/PG 版本、真实命令、通过/失败/未运行项、并发样本数量、SQL 行数核对、CI URL 和风险。

更新 README 中 P0B 状态和本地使用说明；**不要覆盖 P0B-01/02 的历史验收记录**。

建议 Draft PR 标题：

```text
feat(p0b): implement durable task inbox and idempotent persistence (P0B-03)
```

PR 描述必须含 Scope、Architecture、Schema/Constraints、Transactions、Idempotency、Tenant Isolation、Verification、Security & Cost、Deviations、Follow-ups。

最终向 CTO 汇报：

1. 分支、Base/Main SHA、Head SHA、Draft PR URL、是否仍未合并。
2. 新增/修改文件列表、核心 SQL Schema 及关键索引/FK 说明。
3. 创建/重放/冲突三类事务路径与并发处理策略。
4. B-T06～08 的测试方法、并发数、实际数据库行数与结果。
5. 既有 Unit/Integration/CI 的**实际**通过/失败数和链接。
6. 与 RFC/任务书偏差、OQ-1 等尚未解决问题及风险。
7. 是否有实际费用、真实 API Key、对外部署、修改 main 或删除他人资源（期望全部为否）。

## 12. 执行与暂停条件

你可以在范围内自主编码、创建限定测试 Schema、运行测试、创建 Feature Branch、提交并推送 Draft PR。不得自动进入 P0B-04。

遇到以下情况必须暂停报告：需要付费服务/生产凭据；将改动范围扩至 Worker/Sandbox；必须覆盖用户工作或已应用 Migration；需要修改 main/仓库权限；或发现 Tenant/事务语义无法按上述方式安全实现。

**最终交付状态：独立 Draft PR Open，main 不变，P0B-03 的 Durable Inbox 与并发幂等具备可重复的真实 PostgreSQL 证据，等待 CTO Review。**

> **Engineering Principle:** _A Task ID is a promise of durable existence, not a guess made before commit._
