# Ember V1 — Architecture Baseline（正式架构基线草案）

> **状态：Proposed / 待 CTO Architecture Review；尚未批准，不代表代码已实现**  
> **版本：v0.2 · 2026-10-29（新增 Mac Harness 集成目标，仍为 Proposed）**  
> **Owner：Ember Product / CTO / Architecture**  
> **基线：`main` @ `b5b400fe35edc3dc34bacb19269cfa043d21878d`（P0B-01～05 已合并）**  
> **适用范围：V1 iOS + macOS App、云端 Control Plane、Mac/Cloud Execution、数据持久化与同步**  
> **下一门槛：在 P0B-06 工程 Prompt 下发前完成本文件和关键 ADR 的审查**

## 0. 本文件解决什么问题

Ember 是 Personal Agent Platform，不是一人一台长期运行的 VM。一个 Agent 拥有长期稳定的逻辑身份、授权、任务历史、Workspace 与记忆；具体执行环境可以创建、失效、替换。

本文件定义 V1 的**系统边界与不变量**，避免因为 PostgreSQL、云厂商、Sandbox、iPhone/Mac 文件路径或某一种 Agent 框架而锁死核心产品。它同时严格区分四种事实：

- **已实现（Implemented）**：已经在 `main` 的 P0B-01～05 代码中存在，并由对应验收记录支持。
- **产品决策（Product decision）**：产品负责人在架构讨论中确定的 V1 目标；可能尚无代码。
- **拟议工程契约（Proposed implementation）**：为达成目标推荐的设计，仍需 CTO 审查和专项 ADR。
- **未实现 / 延后（Deferred）**：不允许 Coding Agent 把设计文档当作功能测试通过的证据。

**文档权威规则：**适用范围内已经 Accepted 的 `docs/adr/` 决策优先约束其具体事项；本 Baseline **被 Accepted 后**约束跨模块的整体架构；已合并代码和测试决定“现在实现了什么”；已审查专题设计细化 Baseline；历史 RFC/任务书仅记录设计背景。冲突必须显式报告，不得静默选择较方便的版本。旧 RFC v0.2 中的 `ADR-001` 等内部编号不是 `docs/adr/0001-*` 的同一编号体系。

## 1. 产品边界与参与者

| 参与者 | V1 应负责 | 禁止默认承担 |
| --- | --- | --- |
| **iOS App** | 与 Agent 交互、下发/取消任务、追踪进度与文件、审批、通知、授权同步。 | 任意常驻后台执行、直接访问权威数据库。 |
| **macOS App** | 与 iOS 相同的交互能力，加上经过授权的本地 Executor；发现用户安装的 Coding Harness（如 Codex、Claude Code、Pi）并在用户授权后委托其执行编程任务。 | 成为云端共享状态唯一来源；持有云端数据库管理员凭据；安装即默认执行或自动获得全盘权限。 |
| **Cloud Control Plane** | 永久在线可访问的任务入口、认证授权、Agent/Task/Run/Event 权威状态、调度、持久化、设备管理、结果提交、通知。 | 每个 Agent 必须永久占用一台 VM、一个进程或一个模型会话。 |
| **Cloud Executor / Sandbox** | 按需获得受限能力、执行获授权任务、上传受检验输出。 | 长期 Agent 身份、永久 Workspace 根目录、无限制数据与密钥访问。 |
| **共享持久化层** | 加密保存长期记忆、共享 Workspace、已授权同步文件、Artifact、Checkpoint、任务历史。 | 默默同步 Mac 私人文件，或把 Sandbox 临时磁盘当权威副本。 |

**交互入口与执行位置互相独立。** iPhone 下发的任务可以交给已授权 Mac；Mac 上发起的任务同样可以在云端执行。客户端关闭不取消已持久化接受的任务。Mac 关机后 Control Plane 仍可接收消息，但依赖其私人能力的任务必须等待、显式失败或请求用户操作。

本设计不承诺具体生产 SLA、云成本、冷启动指标或生产部署已经完成。

## 2. 逻辑身份、信任边界与依赖方向

核心概念：

- **Tenant / Principal**：可信认证与数据授权边界；未经验证的请求字段不能自行设定 Tenant、Principal。
- **Personal Agent**：与设备、Sandbox ID、数据库行物理位置相独立的稳定逻辑身份。
- **Task**：一次用户业务意图；持久化、可观察、具备清晰授权。
- **Run**：Task 的一次执行尝试；一个 Task 可对应多个 Run，每个 Run 受 Lease/Epoch Fencing 保护。
- **Workspace**：逻辑的版本化 Manifest/树，不是宿主机绝对目录。
- **Artifact / Blob**：Artifact 是具有 Tenant 权属、权限和元数据的逻辑对象；Blob 是内容校验后的不可变字节。
- **Checkpoint**：已提交的逻辑执行进度，不等于 VM、浏览器或 OS 进程内存。
- **Long-term Memory**：可审计、可校正、有来源的长期 Agent 知识；不同于临时模型上下文。

依赖方向：

```text
iOS / macOS UI
    ↓ authenticated API
Cloud Control Plane ── Domain / Contracts / Application Services
    ↓ trusted scoped Executor Gateway
Mac Executor / Cloud Executor
    ↓ permitted data + artifacts (via APIs)
Persistence Ports (Task / Lease / Workspace / Artifact / Checkpoint / Memory)
    ↓
Infrastructure Adapters (PostgreSQL, local Blob, later object store / other DB)
```

这个图是目标逻辑依赖关系：**远端 Mac/Cloud Executor 不应直接连接 PostgreSQL**。目前 P0B-05 Worker 直接使用 `@ember/postgres` 是服务端本地实施阶段，不代表远端 Executor 的网络协议已经实现。

- 不能把用户 `AuthContext` 伪造给 Worker；Worker 拥有的是从持久状态校验过的 Run 身份和受限执行授权。
- `workerId`、`deviceId`、`sandboxId`、`artifactId`、SHA-256 都**不是认证凭据**。
- 执行位置、工具能力和数据权限需在领取、读写与最终提交时再次校验。
- 密钥、敏感 Prompt、私人文件内容不得进入通用 JSON 日志和开放的 Task Event payload。

## 3. 执行位置与执行等级分离

沿用 [`v1-execution-placement.md`](./v1-execution-placement.md) 中的两个独立概念：

| 决策 | 取值 | 作用 |
| --- | --- | --- |
| **Execution Placement** | 用户偏好 `auto \| cloud \| mac`，解析为云端或指定 Mac | **在哪里**执行 |
| **Execution Router** | `fast \| standard \| heavy` | **以什么执行等级/资源路径**执行 |

V1 位置决策采用可解释、可审计的简单规则，而非运行时 AI 自由猜测：

1. 从可信 Task、工具、数据来源、用户授权与注册设备能力推导执行条件；不能只看 Task kind。
2. `auto`：无需本机私人能力且具有云端权限则首选云端；需要私人 Mac 能力则选择授权的指定 Mac。
3. `cloud`：只有全部所需数据和工具都经授权可在云端使用才允许；不满足则拒绝，不能自动上传私人文件。
4. `mac`：只能指定用户拥有并认证授权的设备；离线则保留排队原因，不能伪造 Run，也不能默默改派云端。
5. 能力检查和安全策略优先于延迟、成本和便利；未来成本/电量/多设备负载均衡可作为可替换策略实现。

**变更提示：**当前 Placement v0.1 将“跨设备迁移”整体列为非目标，且重试默认保持执行位置。后续产品讨论批准了**具备资格的 Task 在新的 Run 中从逻辑 Checkpoint 恢复到另一设备**这一目标。两者并不等于“运行中的进程热迁移”，但文档措辞必须在正式实现前修订；**P0B-06 不准擅自加入自动改派逻辑**，该能力需要后续 Placement/权限/设备协议 ADR。

### 3.1 macOS 本地 Coding Harness 集成（V1 产品决策，工程待实现）

**目标：**用户可从 iOS 或 macOS 与同一个 Ember Personal Agent 交互，在需要访问 Mac 本地授权代码仓库时，由 Mac Local Executor 委托用户已安装且**单独授权**的 Codex、Claude Code、Pi 等 Coding Harness 执行；提交任务的设备不决定执行设备。Coding Harness 是可替换的**受托执行能力**，不是 Task/Run/Lease、租户身份、长期 Workspace 或 Checkpoint 的权威来源。

- **发现：**Mac App 以只读、元数据优先、受限目录扫描列出受支持的 Harness 候选、版本/可用性和能力。优先参考 AgentTower 的安装发现、安全路径检查与显式数据目录授权。发现成功 **≠** 已授权运行；不存在的、不可信或不可安全定位的可执行文件不可自动启动。发现阶段不得悄然运行候选二进制、安装插件、改写各 Harness 配置或读取凭据。
- **授权：**用户须显式启用某 Harness，并为每个任务限定项目根目录、读写、命令、网络、持续时间、成本及高风险行为的审批规则；允许撤销和审计。Mac 私人文件默认留本机，除非用户明确授权同步，否则不得随会话、日志、Artifact 或 Checkpoint 上传。已有 CLI 登录态不构成无限授权；不复制、提取或转发 Harness 凭据。
- **统一业务适配器：**在 Mac Execution Plane 内定义 provider-neutral `CodingHarnessRegistry` / `CodingHarnessAdapter`（拟议接口），覆盖 `discover/probe/capabilities/start/observe/approve-or-deny/cancel/dispose`，把不同协议转为 Ember 的执行进度、权限待决、完成、错误与取消语义。优先支持经实际能力协商的 **ACP**，并为 Codex App Server、Claude Code Agent SDK/程序化 CLI、Pi RPC 保留独立 Native Adapter。**ACP、MCP、Ember 内部 Task 契约不是一回事**；协议选择须由真实版本与能力探测决定，不因 Provider 名称直接推断。
- **任务与会话分离：**一个 Ember Task 可有多个受 Fencing 约束的 Run；每个 Run 可创建一个或多个 Harness Session，但 Session ID 仅是适配器内部引用。只有可信且仍有效的 Run/epoch 能向权威提交结果；日志、Stream、Harness 的“完成”回执不等于 Workspace/Artifact/Task 已提交。断线、取消、Deadline 和租约失效必须终止或隔离旧会话；迟到输出不得写入权威数据。
- **结果发布：**Harness 在获授权的隔离工作目录或可控 worktree 内产生变更；差异与产物须经过范围、内容及授权验证，按 Workspace `expectedVersion` 进行 CAS，冲突时保留双方内容并让用户决策。Mac 私人仓库不因需要云端 Task 状态而自动上传源代码或敏感 Prompt。
- **恢复边界：**不同 Harness 的内部推理上下文/私有会话格式不保证互通。Mac 断电后，只有**已提交的 Ember 逻辑 Checkpoint**和授权可访问的输入、产物可用于新 Run 的条件恢复；不能承诺跨供应商、跨设备恢复内部进程。外部副作用需幂等凭据、核验或再次审批。
- **安全隔离：**安装在用户 Mac 的 Coding Harness 可能拥有普通用户级 Shell、文件及网络能力，不能把它当成安全 Sandbox。适配器不得将模型生成文本直接插入 Shell 命令行；子进程以确定的二进制路径、argv、受控环境和工作目录启动，限制权限/资源并清理进程组。ACP 权限回调必须按 Ember 政策逐项审批，**不得沿用 AgentChat 早期实现中的自动批准行为**。
- **V1 验收：**先实现安全安装发现与用户启用；随后以至少一个经验证的 Harness 完成端到端编程任务，包括进度流、审批拒绝、取消、超时、旧 Epoch 迟到输出拒绝、私有路径越权拒绝与 CAS 冲突；最终形成 Codex/Claude/Pi 的独立 Adapter 兼容矩阵和版本化测试。未经验证的集成只能展示“检测到但不可委托”，不能宣称支持。

**工程阶段边界：**本决策纳入 V1 目标，但 Harness Discovery/Adapters、设备身份、Executor Gateway、真实 Mac App 均**不属于 P0B-06**。P0B-06 只提供支撑 Harness 产物的可替换 Artifact/Workspace/Checkpoint/原子提交契约；后续独立工作包实施本机集成。云端 Executor 不依赖 Mac 本机安装的 Harness，且不得由云端绕开本机授权直接调用。

## 4. Task / Run / Lease / 事务不变量

现有 P0B-01～05 已提供关键内核：纯领域状态机、Zod 契约、持久任务 Inbox、幂等创建、Tenant-safe FK、Lease/Heartbeat/Reaper/Fencing/Retry/Cancel、确定性 Fake execution。继续遵守已批准的：

- [ADR-0001 — Cancellation and Retry Coordination](../adr/0001-cancellation-and-retry-coordination.md)：`retryable_failed → cancelled` 合法；取消提交后不再创建新 Run；取消优先于未提交的重试。
- [ADR-0002 — Pre-claim Deadline Failure](../adr/0002-preclaim-deadline-failure.md)：`queued → failed` 仅限未领取且 Deadline/attempt budget 已耗尽，在锁下复核，无虚构 Run。
- 终态不可改写；同状态赋值不是隐式 no-op；`accepted` 是 Event 而非 Task status。
- Task 成功接收的 ACK 必须发生在 DB Commit 之后；Lease 成功领取不是任务已执行，更不是结果已持久化。
- 新尝试产生**新的 Run 和新的 lease epoch**；旧 Run、过期心跳、过期 Finish 和旧 Workspace/Checkpoint 提交必须被权威事务拒绝且零持久化副作用。
- 多 Worker 并发正确性不能靠进程内 Map/Mutex 替代数据库约束、锁与条件写。
- 外部工具通常是至少一次尝试的现实；不可逆副作用须有幂等操作标识、查询/补偿或用户审批，不能宣称端到端 exactly-once。

目前 `LeaseQueue.finish(run, outcome)` 只提交终态，**不能原子提交 Artifact、Workspace、Checkpoint 和终态 Event**。这是 P0B-06 必须解决的应用层边界，不能靠“先 commit Workspace，再调用 finish”拼凑。

## 5. 持久数据所有权、加密、同步

| 数据类别 | 权威持有与生命周期 | V1 默认权限 |
| --- | --- | --- |
| **Agent 长期记忆** | 加密云端权威存储；带来源和变更历史，检索索引是可重建派生物。 | 只授予有权用户与具体执行所需的受限读取。 |
| **共享 Workspace** | 云端权威、带版本的逻辑 Manifest；历史版本供合并、Checkpoint 引用与审计。 | 已认证设备和 Executor 通过受限 API 访问。 |
| **用户主动保存的 Artifact** | Tenant 拥有的持久逻辑对象；即便未挂到 Workspace 也可以单独存在。 | 依用户文件库权限与保留策略授权读取/删除。 |
| **Task 执行期间生成的暂存 Blob** | 私有、不可直接被当成已发布 Artifact；只有验证和提交后才可见。 | 运行时受限，失败后需可审计清理。 |
| **Mac 私人文件 / App 状态 / 凭据** | 默认仅保留在 Mac，**不自动上传、索引、备份到云端**。 | 用户明确同步授权前，云端无权读取。 |
| **iOS / macOS 缓存与离线编辑** | 本地可重建投影，编辑携带共同基线；不得覆盖云端权威版本。 | 同步时通过服务端验证与 CAS。 |
| **Sandbox 临时盘** | 可随 Runtime 销毁。 | 不能成为唯一持久恢复来源。 |

共享云端数据需加密存储与加密传输。V1 采用**服务端受控密钥**的授权访问模型：Cloud Executor 可在用户明确授权和任务允许的数据范围内解密处理；这不是零知识或端到端加密承诺。生产版本上线前需另行审查密钥托管/轮换/撤销、数据保留与删除、审计、设备丢失恢复和备份。

**永久身份必须使用逻辑 ID：**Workspace ID 和 Artifact ID 不绑定 `/Users/...`、Bucket 名、对象 Key、某家云平台、Sandbox 或 VM 实例。物理定位仅属于存储 Adapter 的内部元数据。Hash 用于完整性而非权限；禁止通过跨 Tenant 去重泄露其他租户文件是否存在。

## 6. 可替换基础设施：Ports & Adapters

产品核心通过**能力接口**而不是 SQL 客户端接口访问数据库；`@ember/domain` 不依赖 PG、对象存储、文件系统或云服务商。V1 不为了“可替换”提前维护多套生产级数据库：

| 能力端口 | 当前 / V1 方向 | 必须保留的正确性 |
| --- | --- | --- |
| `TaskRepository`、`LeaseQueue`、可信 Run Context Reader | 已有 PostgreSQL Adapter | 幂等、Tenant 隔离、单赢家 Claim、Lease/Fencing、事务提交。 |
| `WorkspaceStore` | P0B-06 PG 元数据 + 版本化 Manifest | CAS、历史版本、跨 Tenant 引用校验。 |
| `BlobStore` / `ArtifactService`（拟拆分） | 本地文件 Adapter；未来可接对象存储 | 授权、大小/Hash 校验、不可变内容、暂存/发布隔离。 |
| `CheckpointStore` | 持久元数据和已提交 Artifact 引用 | Tenant/Run 归属、版本兼容、Fencing。 |
| `RunResultCommitter`（拟议） | 一次权威 PG 事务 | 校验当前 Run/epoch/Deadline + Workspace CAS；原子发布 Artifact 引用、Workspace、Checkpoint、Event、Run 终态。 |
| `MemoryRepository` / `MemorySearch`（未来） | 云端事务存储；可替换检索索引 | 来源与授权不可丢，检索索引可重建。 |
| Mac 本地缓存 | SQLite / 本地文件（未来） | 不是云端调度数据库的等价替代。 |
| `CodingHarnessRegistry` / `CodingHarnessAdapter`（未来） | Mac 本地独立适配器，ACP / Codex App Server / Claude Agent SDK / Pi RPC | 探测与授权分离、会话独立于 Run、权限请求、取消、Fencing 和输出 CAS。 |

当前 `ArtifactStore` 的签名需要已验证用户 `AuthContext`，而远端 Executor 应使用经过验证的**受限 Run 授权**。P0B-06 需要设计相应的独立端口或应用服务；**禁止**伪造用户 `principalId`。

若将来新增第二种权威数据库 Adapter，必须通过同一组真实并发/故障契约测试：幂等创建、单赢家 Claim、旧 Epoch 零副作用、CAS 冲突、原子结果提交、跨 Tenant 负向、事务失败与提交 ACK 丢失。SQLite 本地缓存并不能凭 SQL 接口代替 PostgreSQL 的服务端并发调度职责。

### 6.1 Blob 上传与数据库 Commit 的边界

对象存储写入和关系数据库事务**不是同一个 ACID 事务**。拟议协议：

1. 授权输出范围；上传 Blob 到隔离的 staging 命名空间；检查 size、MIME/媒体类型政策、SHA-256 与存储完整性。
2. 服务端在**同一数据库事务**中重新验证 Tenant、Task、有效 Run/lease epoch、取消/Deadline、Artifact 引用和 Workspace `expectedVersion`，并原子提交已发布 Artifact 元数据、Workspace 新版本、Checkpoint、Event 和合法 Run/Task 状态。
3. **仅在 Commit 成功后**让结果成为用户可见的持久输出并返回成功。
4. 若 DB 失败，暂存 Blob 不得冒充 Artifact，待安全 GC/补偿；若 DB 已提交但 ACK 丢失，使用稳定提交操作 ID 幂等重放。
5. GC 需要追踪历史 Workspace、Checkpoint 和独立保存的用户 Artifact；“不在最新 Manifest”不等于“可以删用户文件”。

首版可为测试使用有界小文件，但设计不得永久绑定无上限 `Uint8Array` 或宿主机路径。加密方案、大小阈值、引用模型和 GC 时间窗口应在专项 ADR 批准。

## 7. Workspace CAS、自动合并与冲突处理

**已确认的产品方向：云端权威版本 + CAS + 尽可能安全的三方合并 + 用户决定不可合并的冲突。**

共同基线是安全合并的前提。任何共享编辑应包含经授权的 `workspaceId`、`baseVersion`、变更集合、actor/Run 来源和稳定 operation ID。提交时在服务端以实际云端版本验证；CAS 成功后版本单调递增。遇到并发提交时只允许有界的重新读取/合并/再次 CAS；不能降级为 last-write-wins。

| 竞争编辑 | 处理 |
| --- | --- |
| 云端版本没有变化 | 直接 CAS 提交。 |
| 两端修改不同的独立逻辑路径 | 允许确定性、安全的自动合并后再 CAS。 |
| 同一小型文本文件的非重叠修改 | 仅在该格式明确允许、三方文本合并和语法/权限校验通过后才可自动应用；语法通过不保证业务语义正确。 |
| 同一区域修改、删除 vs 修改、重命名冲突、二进制、敏感配置或权限变更 | **不覆盖**；保留两侧不可变版本、生成持久冲突记录，由用户决定。 |

用户可在 iPhone 简单选择“保留 Mac / 保留云端 / 两个都保留 / 稍后处理”，在 Mac 查看差异和手动合并。未来 Agent 可以提出合并建议，但有争议的内容未经用户批准不得自动应用。冲突必须保留两侧内容和来源，不能因为一次错误合并导致数据消失。

**不能无限期占用 Run Lease 等待用户。** 冲突结果要先持久保存，再通过符合现有 Task/Run FSM 的合法结束或未来经批准的审批工作流处理。P0B-06 不得自行添加新的 Task 状态、伪造 Run，或绕过现有状态机。首版实现门槛为 CAS、冲突拒绝和双方数据保全；细粒度文本合并可在确定性测试和政策批准后逐步开放，CRDT / 任意 AI 自动重写暂不实施。

## 8. 可移植 Checkpoint 与故障恢复

**产品目标：**当 Mac 中断时，已提交的逻辑步骤不必从头执行；在任务能力、同步数据、权限、用户策略和目标 Executor 兼容的前提下，未来允许**新的 Run**从已确认的 Checkpoint 在云端继续。

可恢复的是**逻辑状态**，不是正在运行的 shell、浏览器 Session、Coding Harness 内部 Session、VM 内存、模型 Token 流或任意进程指令地址。Codex/Claude Code/Pi 的内部上下文不可假定能彼此重载；未提交的当前步骤可能需要重做，必须防止外部副作用重复执行。

Checkpoint 应版本化地记录：

- Tenant / Agent / Task / 来源 Run、来源 Epoch、创建时间与格式版本；仅受信服务生成的标识。
- 已完成的 Step IDs、下一步游标、稳定 Step/Tool operation IDs、必要的可序列化最小状态。
- 已持久发布的 Artifact 引用、Workspace 版本/共同基线、必要输入版本。
- 所需工具能力、执行环境/流程版本、数据可访问性级别；敏感授权用受限引用，不保存明文长期凭据。
- 外部副作用 receipt 或需要再次核实的标志；不能依靠 Checkpoint 自行保证 exactly-once。

**Checkpoint 的发布必须与其宣称的步骤进度和权威数据库引用一致**，并在提交时经过 Run Fencing。新 Run 的有效 Epoch 才能继续写；旧 Run 的 Checkpoint 可以作为只读恢复输入，但不能把旧写权限“传递”给新 Run。恢复前检查 Manifest 版本/冲突、Blob 可达性、权限和执行器能力。

建议恢复路径：

1. Mac 执行过程中成功提交某一逻辑 Step 的 Checkpoint。
2. Mac 断开后 Lease 过期；Reaper 关闭旧 Run，并按已批准 retry/取消规则收敛 Task。
3. 将来具备真实 Placement/Gateway 时，重新检查用户选项、数据范围和云端能力；不满足则等待 Mac 或用户处理。
4. 新 Executor Claim **新 Run + 新 Epoch**，读取兼容 Checkpoint，恢复已完成步骤之后的工作。
5. 外部副作用依赖幂等键和核实；禁止重发未经核实的邮件、支付或危险操作。

**P0B-06 范围：**Checkpoint 逻辑模型、持久 Store、可信发布、Fencing、确定性模拟场景的同环境 Crash/Resume 证据。**不包含：**Mac↔Cloud 真正网络协议、任意进程热迁移、真实 Browser/VM 迁移、付费 Sandbox、多设备自动改派和生产级迁移承诺。后者需要独立审查和端到端真机/云环境验证。

## 9. 四种长期数据不能混为一谈

| 数据类别 | 核心生命周期 | 未来扩展 |
| --- | --- | --- |
| **Long-term Memory** | 有来源、有权限、可修正/删除的长期知识；云端权威。 | 向量/全文检索属于可重建派生索引，具体记忆写入与合并政策另行审查。 |
| **Workspace** | 可变逻辑文件清单，以 Manifest 版本和 CAS 管理；保留共同基线。 | 更细粒度自动合并、协作与冲突 UI。 |
| **Artifact** | 已验证不可变内容和授权元数据；可以单独保存或被多版本 Workspace 引用。 | File/Object Storage Adapter、保留期、GC、加密。 |
| **Checkpoint** | Task/Run/Step 已确认的逻辑执行快照与依赖引用。 | 跨 Executor 恢复、兼容性升级、工作流重放。 |

LLM 的上下文窗口不等于长期记忆；Sandbox snapshot 不等于可移植 Checkpoint。Agent 私人记忆的提取、自动写入、来源可信度、遗忘和用户控制，属于下一轮专题决策，P0B-06 不应该假装已实现 MemoryOS。

## 10. 安全、可靠性与可观测性硬规则

1. **Tenant-safe：**任何对象、读写、引用和事件必须经过 Tenant 归属检查；无权访问的外国 ID 与不存在的 ID 对外不可区分。
2. **Fenced：**Run/epoch/取消/Deadline 检查与权威写入在同一事务内；旧 Worker 不得提交 Task、Artifact 发布、Workspace、Checkpoint 或 Event。
3. **Least privilege：**云端执行器只获得本次 Task 需要、有效期受限、可撤销的数据和解密权限；Mac 本机私有数据默认不上传。
4. **No fake success：**只有持久事务成功才 ACK；Blob 上传成功、FakeSandbox 输出、/healthz 200 均不能充当用户结果已持久化的证据。
5. **No secret leakage：**事件仅承载 allowlist 的安全元数据；用户内容、凭据、Prompts、原始栈/路径不得混入日志。
6. **Recoverable：**损坏 Blob、悬空引用、CAS 失败、断网、丢 ACK、重复重试、GC 与权限撤销都需可检测、可审计、能安全回退。
7. **Cost/safety bounds：**资源、文件大小、Lease/Deadline、重试和计费上限必须有硬限制；真实 LLM 与付费云接入前另设安全及成本 Go/No-Go。
8. **Evidence over claims：**FakeLLM/FakeSandbox、模拟 1,000 Agent 和本地 CI 不证明真实隔离、多地区性能、云稳定性或商业可行性。
9. **Harness is not a sandbox：**本机第三方 Coding Agent 运行时可拥有较广的 OS 权限；仅发现/启动成功不等于已获得用户授权或具有强隔离。授权请求不得自动全允，工具输出/外部代码视为不可信输入。
10. **Provider independence：**不得把 Codex/Claude/Pi 的可执行路径、私有 Session 格式、配置文件或账户令牌作为 Ember Task、Workspace、Checkpoint 的持久身份。

## 11. 实现进度和 Roadmap（截至本草案）

| 工作包 | 现有实现 | 尚未实现 / 不能声称通过 |
| --- | --- | --- |
| **P0B-01** | Node 24 / strict TypeScript、Hono、PG17 本地、Migration、CI、基础日志和探针。 | 生产控制面 HA。 |
| **P0B-02** | 纯领域 FSM、领域错误、Zod 合同、抽象的 Repository/Provider 接口。 | 完整 HTTP AuthZ 与长期记忆服务。 |
| **P0B-03** | Tenant-safe Agent/Task/Run 基础表、幂等创建与事件原子性。 | Artifact/Checkpoint 实际持久化。 |
| **P0B-04** | Lease/Heartbeat/Reaper/Fencing/Retry/Cancel；ADR-0001/0002。 | 远端 Executor Gateway、跨设备恢复。 |
| **P0B-05** | 确定性 Execution Router、FakeLLM、FakeSandbox、受限 Worker Poll。 | 真实模型、持久输出、云 Sandbox、Mac Executor。 |
| **P0B-06** | **尚未开始**。 | Artifact Store、Workspace CAS/历史、Checkpoint、原子结果提交。 |
| **P0B-07** | 尚未开始。 | Task HTTP API、Tenant AuthZ、SSE/reconnect。 |
| **P0B-08** | 尚未开始。 | 完整协作式取消、审批、预算与副作用策略。 |
| **P0B-09** | 尚未开始。 | Telemetry、Chaos、Load 与真实恢复证据。 |
| **P0B-10** | 尚未开始。 | 本地垂直闭环 Demo、最终验收。 |
| **V1 App/Cloud 扩展阶段** | 架构目标已讨论。 | iOS/macOS App、设备身份、Gateway、真实云 Executor、授权同步与跨 Run 恢复。 |
| **V1 Mac Harness Integration（独立阶段）** | 已形成产品决策，尚无实现。 | 安全安装发现、用户授权、ACP/Native Adapter、Run-Session 生命周期、审计、CAS 产物接入和版本兼容矩阵。 |

本表是“已合并能力与未来目标”的区分，而非商业发布进度。P0B-05 的 `poll` 为显式开启的非生产本地模拟（`EMBER_WORKER_SIMULATED_EXECUTION=local-only`）；当前没有真实持久化 Artifact。根目录 README 中关于 P0B-04/P0B-05 的历史状态有过时表述，后续文档维护应同步修正。

## 12. P0B-ARCH → P0B-06 开工条件

**在 Cline CLI 工程 Prompt 下发之前，CTO 至少需明确以下 B06 决策：**

| 编号 | 需要冻结的契约 | 验收或阻断条件 |
| --- | --- | --- |
| **B06-D1** | 用户保存 Artifact 与任务 staging Blob 的生命周期、权限、数据保留、Hash、GC。 | 上传成功但数据库失败不可伪造用户文件；GC 不删仍被历史/用户保留引用的 Blob。 |
| **B06-D2** | Manifest 的逻辑 ID、版本历史、CAS、共同祖先、自动合并范围和冲突记录。 | 两个独立写者不会覆盖；冲突数据完整保留，不能静默 last-write-wins。 |
| **B06-D3** | `RunResultCommitter` 或等价原子服务；Run 授权与用户 `AuthContext` 的分离。 | 结果提交、Workspace CAS、Checkpoint、Event 和终态必须在事务边界内保持一致；旧 Epoch 全拒绝。 |
| **B06-D4** | Checkpoint Schema、兼容版本、最小状态、发布时机、同环境恢复和副作用幂等。 | Crash 后从最近已提交逻辑 Step 恢复；不宣称 VM 内存迁移。 |
| **B06-D5** | 存储 Ports/Adapter 的能力测试、路径及跨 Tenant 访问防护。 | 真实 PG 并发、故障注入、丢 ACK、CAS、Fencing、staging 清理正反例。 |
| **B06-D6** | Execution Placement 中关于未来**跨 Run**恢复和“运行中迁移”的表述一致性。 | 不允许与已发布 Placement 策略形成隐性冲突；P0B-06 不自动实现改派。 |

### 12.1 CTO Architecture Review — P0B-06 契约冻结建议（2026-10-29）

以下是审查现有 `@ember/contracts`、领域 FSM、0002/0003 Migration 和 P0-B Task Spec 后的**保守实施决议**。在本 PR 合并前仍属 Proposed；实现 Agent 不得自行更改这些边界：

| Gate | P0B-06 采用的最小可验证设计 | 明确延后 |
| --- | --- | --- |
| **B06-D1** | 分离不可变 `Blob`、仅任务可见的 `StagedBlob` 与正式授权 `Artifact`；上传的 bytes/size/SHA 校验完成也**不自动发布**。用户主动保存或被历史 Workspace/Checkpoint 引用的内容不得随意 GC。孤儿 staging 仅在可证明无引用且过可配置隔离窗口后清理。 | 真实云对象存储、生产 KMS/轮换、复杂存储配额与商业计费。 |
| **B06-D2** | `Workspace` 按 `tenantId + workspaceId` 隔离；Manifest 条目采用经规范化且唯一的逻辑相对路径，禁止穿越/符号链接逃逸；版本历史不可变；提交以 `expectedVersion` CAS。V1 最小自动合并仅在双方使用**已知共同基线**、修改路径完全不交叉且操作不含删除/重命名/权限/敏感元数据时尝试；其余保留两份候选产物和冲突元数据供用户决策，不修改权威版本。 | 通用文本三方合并、CRDT、AI 自动修改冲突、交互式冲突 UI（可在后续阶段接入）。 |
| **B06-D3** | 拆分用户 `AuthContext` 与由服务端验证的 scoped Run 执行授权；既有 `ArtifactStore.put(AuthContext)` / `WorkspaceStore.commit(AuthContext)` 不得由 Worker 伪造 principal 调用。单一可信 `RunResultCommitter` 在**一个 PG 事务**中锁定并核验 tenant/task/currentRun/epoch/attempt/有效 lease/Deadline/cancel，执行 Artifact 元数据发布、Workspace CAS、Checkpoint 引用、唯一终态 Event、合法 FSM 与 Run 终态。此前 staging 的 Blob 写不属于 PG ACID；必须有失败回收与重复 Commit 幂等键。不得先写 Workspace 后单独调用旧 `LeaseQueue.finish()`。 | 分布式 2PC、跨云对象存储 ACID、直接对外暴露 Executor DB 凭据。 |
| **B06-D4** | 版本化、最小、可序列化的**逻辑 Step Checkpoint**：来源 Tenant/Task/Run/epoch、step/cursor、输入与执行器兼容版本、Workspace 版本、已提交 Artifact、外部操作标识及副作用核验状态。Step 发布和引用一致性必须在有权 Run 的单次事务中核验；每次恢复只读最近已提交且兼容的 Checkpoint，新 Run/epoch 获得自己的写权。ACK 丢失需幂等重放；未确认的外部副作用不得自动重复。 | 任意 Harness 私有 Session、OS/VM/Browser 内存热迁移及跨 Mac/Cloud 真正远程恢复。 |
| **B06-D5** | V1 真实权威 Adapter 保持 PostgreSQL + 本地受控 Blob 文件存储，但领域和应用层只依赖能力 Port，禁止 SQL/宿主机路径泄入持久身份。必须在真实 PG 独立连接/故障注入下证实 CAS 单赢家、跨 Tenant/越界路径拒绝、坏 Hash/缺 Blob、旧 Epoch 零写、Event 失败整笔回滚、DB Commit 后丢 ACK 幂等重放及孤儿 staging 不可读。 | 第二个生产数据库 Adapter、云存储性能/SLA 推断。 |
| **B06-D6** | 本 PR 同步修订 `v1-execution-placement.md`：**单次 Run 不能热迁移**；未来仅允许新 Run 在授权和兼容性复核后从已提交逻辑 Checkpoint 条件恢复。P0B-06 不实现自动改派。 | 设备身份/Gateway、跨设备能力探测和自动位置切换策略。 |

**实现细节保护线：**

1. 当前 `TaskEventPayload` 只有安全 allowlist 元数据；新 Artifact/Checkpoint 流程不把自由文本、私人路径、Prompt 或 secrets 加入 Event。需要扩展 event 类型时须先审查 Domain、Zod、SQL 三方一致性。
2. `RunResultCommitter` 必须明确处理“同提交操作 ID + 同内容重放”“同 ID + 不同内容冲突”“旧 Run 重放”的可观察结果；数据库提交后才返回用户可见的成功 ACK。**已成功提交但 ACK 丢失**的同一操作可在受限身份校验后只读查询既有 receipt；这不授予过期 epoch 任何新的写入权。
3. 用户冲突裁决属于后续 API/UI；CAS 失败的**结果提交事务**必须整体回滚、不得产出终态成功。保留冲突候选与记录应通过独立、幂等、受限的非终态事务完成，固定引用双方不可变 Blob，并确保 GC 不清除未解决的候选；不能把用户待决冲突伪装成 `completed` 或自行增加不在 FSM 中的状态。
4. 已合并的 `0001`–`0004` 只读不修改；新增前向 Migration 负责 P0B-06 元数据、唯一键、复合 Tenant-safe FK、约束/索引与复测。
5. 有效 lease/Deadline 的时间判断须在取得必要锁后采样真实权威时间（如 PG `clock_timestamp()`；不能把事务开始时的 `now()` 当成等待锁后的时刻），避免锁等待穿越租约过期边界。
6. 目标是有测试可证明的**最小纵向闭环**，不是让 P0B-06 提前实现 Mac Harness、iOS/macOS、OAuth/设备网关、生产加密、完整审批或智能冲突合并。

未定设计可以先拆为小 ADR，别为了凑齐“通用架构”一次性添加不存在的 Repository/Provider 实现。技术组件未来可替换，但**数据库正确性与产品隐私不变量不可降级**。

**V1 Harness 专项决策不阻塞 P0B-06：**后续 Mac 集成开始前，须另行评审 Harness 身份/授权、ACP 与 Native Adapter 兼容矩阵、工作目录隔离、审批/取消、SDK/CLI 凭据边界、执行审计和结果提交协议。不得将“支持第三方 Harness”转嫁为 P0B-06 的编码任务。

### 后续实施顺序

1. **P0B-ARCH（当前）：**评审此 Baseline、既有 Placement 与关键 B06 ADR；批准后才发布 P0B-06 Prompt。
2. **P0B-06：**真实本地 Blob + PG 元数据、Workspace CAS、逻辑 Checkpoint、Fenced Commit、恢复及安全负向测试。
3. **P0B-07～10：**按原 P0-B 任务书完成 API/AuthZ/SSE、审批/预算、故障与负载、Demo/证据。
4. **V1 专项工程：**iOS/macOS、设备身份和 Executor Gateway、真实云执行与授权数据同步、符合策略的跨 Run Checkpoint 恢复；Mac Harness Discovery/Adapters 作为独立里程碑，需独立设计和真机/云端验收。

## 13. 文档索引与变更管理

- [V1 Execution Placement](./v1-execution-placement.md)：当前 Proposed 位置调度专题设计；跨 Run 恢复需明确后续修订。
- [Architecture RFC v0.2](./Personal_Agent_Platform_Architecture_RFC_v0.2.md) / [RFC v0.1](./Personal_Agent_Platform_Architecture_RFC_v0.1.md)：历史方案、背景及候选技术。
- [P0-B Minimum Vertical Slice Task Spec](./Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md)：工程目标，不等于已通过验收。
- [ADR-0001](../adr/0001-cancellation-and-retry-coordination.md)、[ADR-0002](../adr/0002-preclaim-deadline-failure.md)：已有正式决策。
- [Domain types](../../packages/domain/src/types.ts)、[Task FSM](../../packages/domain/src/task-state-machine.ts)、[Contracts](../../packages/contracts/src/interfaces.ts)：当前真实代码的语义接口。
- [P0B-05 Implementation](../P0B-05-IMPLEMENTATION.md) / [Acceptance](../P0B-05-ACCEPTANCE.md)：最新已合并阶段实现与证据。

**接受流程：**先在 Draft PR 中以 Proposed 状态审查，明确冲突、风险与开放问题；经 CTO 同意后才标记 Accepted。后续改动必须记录原因、替代方案及受影响模块；新 ADR 应指明修订或覆盖哪一节。**不得直接改 main、不得把架构文本当作已经完成的功能，也不得在架构评审之前开始 P0B-06。**
