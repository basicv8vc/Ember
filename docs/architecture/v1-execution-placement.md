# Ember V1 — 执行调度设计（Execution Placement）

> 状态：**Proposed / 待 CTO 与产品负责人确认（专项决策 D-01～D-07 未批准；D-04 仅就 V1 云端 Daytona Sandbox 部分批准，见 §11）**  
> 版本：v0.2 · 2026-10-29（与已接受（Accepted，PR #8）的 V1 Architecture Baseline 对齐；本文自身仍为 Proposed）  
> 适用范围：Ember V1（iOS + macOS 同期发布）  
> 仓库路径：`docs/architecture/v1-execution-placement.md`  
> 本文定义目标架构与决策边界，**不表示相应代码已经实现**。

## 1. 产品定位与核心原则

Ember 是永久在线、跨设备访问、按需执行任务的 Personal Agent Platform。Agent 是拥有身份、配置、长期状态与任务历史的**逻辑实体**，不是永久占用的一台虚拟机或一个进程。

- **iOS App**：交互、提交/取消任务、查看进度和结果、接收通知；V1 不承担通用后台执行。
- **macOS App**：与 iOS 相同的交互能力，另外运行受控的本地 Executor，可访问用户明确授权的本机资源。
- **Cloud Control Plane**：永久在线，负责可信身份、Task/Run 状态、持久化、权限、调度、通知与执行协调。
- **Cloud Executor**：可按需启动的 Sandbox/VM，只负责执行，不是 Agent 状态的权威持久存储。

**交互来源 ≠ 执行位置。** 从 macOS 提交的任务可以由云端执行；从 iOS 提交的任务也可以由 Mac 执行。关闭客户端不会取消已持久化的任务；Mac 离线只影响依赖该设备的执行。

## 2. V1 目标与非目标

### 目标

1. 用确定、可解释、可审计的规则决定任务在云端还是指定 Mac 执行。
2. 不让客户端来源、设备名称或未经验证的请求字段隐式决定执行位置。
3. 不把本机私有资源自动上传云端；执行位置不得绕过数据权限。
4. 与现有 Task / Run / Event、Lease / Fencing / Retry / Cancellation 兼容。
5. 为未来其他设备类型和智能调度保留接口，不预先建设复杂调度系统。

### 非目标

- 动态比较 CPU、电量、网络、实时云服务价格或模型能力以优化路由。
- **单次 Run 内**的进程/VM/模型会话热迁移、实时抢占、跨多台 Mac 自动均衡。
- **当前 P0B-06 阶段**的跨 Run 自动重新放置；未来可在明确策略、权限和 Checkpoint 兼容性验证后支持新 Run 从另一 Executor 继续逻辑步骤，且不得视为热迁移。
- 多个 Executor 同时执行同一个 Run。
- 通过设备在线状态承诺任务立即执行；在线≠有权限≠资源充足。
- 本文不决定 Artifact/Workspace 的加密、共享范围和跨设备同步细节；另行设计。

## 3. 两项独立决策

### 3.1 Execution Placement：在哪里执行

V1 目标类型：

- `cloud`：受控云端执行节点。
- `mac`：已注册且经过授权的特定 macOS 设备（需要可信 `deviceId`）。

V1 用户执行偏好：

| 偏好           | 含义         | 规则                                                                |
| -------------- | ------------ | ------------------------------------------------------------------- |
| `auto`（默认） | 系统选择     | 云端可执行且不需要本机私有资源 → `cloud`；必须访问 Mac → 指定 `mac` |
| `cloud`        | 用户指定云端 | 只允许云端执行条件满足的任务；不允许时返回稳定的能力/策略拒绝       |
| `mac`          | 用户指定 Mac | 仅能选择自己的已注册、已授权设备；离线时等待，不静默改派云端        |

### 3.2 Execution Router：采用何种执行等级

沿用 P0B-05 的 `fast | standard | heavy`；它描述执行策略/资源等级，**不能**复用为 `mac | cloud` 的表达。Placement 与 Router 应拥有分离的契约、测试和决策日志。

## 4. 任务权限与位置规则

V1 将任务的**服务端可信要求**先分为：

- `cloud_capable`：所需数据与工具均获准在云端执行；也允许用户显式选择有相应能力的 Mac。
- `mac_required`：任务需要指定 Mac 的未同步私有文件、应用、凭据或系统权限；不得自动转移至云端。

分类不能只根据 `Task.kind` 字面值判断，更不能由客户端随意声明。例如，逻辑 Workspace 的 `mock.file` 不等于访问 Mac 私有文件。需从工具、数据来源、授权与能力声明推导。

| 任务示例                         | 默认 `auto`    | 解释                                            |
| -------------------------------- | -------------- | ----------------------------------------------- |
| AI 对话、云端网页研究、定时报告  | 云端           | 不依赖 Mac 私有资源，可保持永久在线             |
| 对已授权同步的文件进行分析       | 云端           | 文件可供云端按授权读取                          |
| 整理 Mac Downloads、操作本地应用 | 指定 Mac       | 需要本机权限，不自动上传私有数据                |
| 本地项目代码分析                 | 视数据授权而定 | 未同步项目 → Mac；可在云端访问的授权项目 → 云端 |

**简化决策顺序：**

1. 验证请求者、Tenant 和目标设备所有权；从可信元数据得到任务能力、数据范围与权限。
2. 如果任务 `mac_required`：拒绝 `cloud` 偏好；否则绑定获授权的 Mac。
3. 如果任务 `cloud_capable`：`mac` 偏好绑定指定 Mac；`cloud` 与 `auto` 选择云端。
4. 校验所选执行节点的资格和能力；节点暂不可用时排队，不自动降低安全要求。
5. 为后续 Claim 提供明确的目标约束，只有符合目标/能力的 Worker 可以领取。

V1 不以智能模型推断执行位置。所有拒绝都要有固定规则码，不泄露其他 Tenant 的设备信息。

## 5. 离线、重试和生命周期

- **Mac 离线**：指定 Mac 的任务保留为 `queued`，等待设备恢复上线；不创建虚构 Run，不增加 attempt。可向用户展示从设备状态推导的“等待设备”原因，但不擅自增加新 TaskStatus。
- **云端繁忙**：保持排队，按现有调度/预算/Deadline 处理。
- **重试**：单次 Run 不迁移设备；当前实现与最初 V1 简化规则中，后续 Run 默认保持目标。产品已确认**具备资格时允许未来新 Run 从已提交的逻辑 Checkpoint 在另一 Executor 恢复**；真正开启自动重新放置前，必须批准单独的设备权限、数据同步、Checkpoint 兼容和审计策略。显式 `mac` 偏好及未同步私有数据不得被自动改派云端。
- **Deadline / Cancellation**：沿用 ADR-0001/0002。已提交取消后不得创建新 Run；过期或耗尽预算的未领取任务按现有合法 FSM 边收敛。
- **Mac 断连、租约过期**：由云端控制面协调 Lease/Reaper；旧 Run 的数据库结果和 Workspace 提交必须被 Fencing 拒绝。断连不是任务已失败的直接证明。
- **结果**：只有经过权威持久化和合法 Run/Workspace 提交的结果，才可被 iOS/macOS 作为有效完成结果展示。

## 6. 信任与网络边界（必须明确）

现有 P0B-05 Worker 通过 PostgreSQL LeaseQueue 直接访问数据库，**这只是服务端开发阶段实现**。V1 的 macOS App 不应持有 PostgreSQL 连接凭据，也不应直接调用数据库。

建议增加经认证的 **Executor Gateway / Worker API**，由云端服务端持有数据库访问权，统一执行 Claim / Heartbeat / Finish / Fencing 验证。Mac 通过主动发起的安全出站连接或轮询与控制面通信，无须向互联网开放本机数据库或服务端口。

- `workerId` 字符串不是认证凭据；必须有独立的设备身份、授权、撤销机制。
- Mac/云端执行节点不得伪造最终用户的 `AuthContext`；内部 Run 权限由可信租约/服务身份限定。
- 分配时检查能力，提交结果时再次验证 Tenant + Task + Run + `lease_epoch`。
- 设备离线、超时和网络分区时遵循“可能重复执行，但不允许过期 Run 提交权威结果”的模型；对不可逆外部副作用后续另设幂等与审批机制。
- 任何把本地私有数据转移到云端的操作都需显式授权策略；Placement 本身不自动上传文件。

## 7. 与现有代码的衔接和实施顺序

| 现有组件                             | V1 处理方式                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task / Run / Event FSM               | 继续沿用，不在本设计中新增状态                                                                                                                   |
| P0B-04 LeaseQueue / Fencing / Reaper | 服务端继续作为调度和权威状态内核                                                                                                                 |
| P0B-05 `ExecutionRouter`             | 保留 `fast/standard/heavy`，不承担位置选择                                                                                                       |
| P0B-05 `claimableKinds`              | 继续作为能力限制；未来增加执行位置/设备过滤，不能只靠 task kind                                                                                  |
| P0B-06 Artifact/Workspace/Checkpoint | 必须存储逻辑引用，不能把本机绝对路径当成跨设备身份                                                                                               |
| P0B-07 HTTP/AuthZ                    | 为远程设备控制协议设计安全的身份、授权与访问边界                                                                                                 |
| 后续 macOS Executor                  | 引入设备身份、在线状态、受限 Executor API、受控本机资源访问                                                                                      |
| V1 Coding Harness Integration        | Mac 上只读发现已安装 Codex / Claude Code / Pi 等 Harness，经用户授权后通过 ACP/原生 Adapter 委托任务；保留 Ember Task/Run 权威。非 P0B-06 范围。 |
| 后续 Cloud Executor                  | 通过相同的权威任务语义按需执行，运行时可销毁                                                                                                     |

**当前无需修改 P0B-01～05 代码，也无需立即实现完整 Placement。** Baseline 边界已在 P0B-ARCH 评审中批准（PR #8）；P0B-06 只落实与持久化相关的不变量，设备通信及实际位置调度仍待本文专项批准后在后续实施。

## 8. 将来实施时的最低验收场景

1. iOS 创建 `cloud_capable` 任务，默认云端执行；Mac 离线不影响其执行。
2. macOS 创建 `cloud_capable` 任务，默认同样可以云端执行；不得因为请求来自 Mac 就自动本地执行。
3. 用户明确指定 Mac，任务仅由该 Mac 的获授权 Executor 领取。
4. `mac_required` + `cloud` 请求被拒绝；不会为便利而上传私有数据或回退云端。
5. Mac 离线时不产生伪造 Run/成功事件；上线后可领取，Deadline 到期则合法失败。
6. Worker 不符合所选设备、Tenant 或能力时不能 Claim；伪造 `workerId` 不足以获得权限。
7. 断连、重连、重复 Claim、旧 epoch Finish 和过期 Workspace 提交不能造成权威状态回退。
8. 用户从 iOS 与 macOS 看到相同的持久化 Task/Run 状态；事件可重复传递但不能重复生效。
9. 本机 Harness 的发现不会自动启动未知可执行文件或授予访问；只有显式用户授权的 Harness 和工作目录可参与运行，权限审批、超时与旧 Epoch 迟到结果均被拦截。
10. 未来跨 Run 恢复仅使用已经发布的逻辑 Checkpoint，并在新 Run/epoch 下完成权限、能力与 Workspace 版本重新校验；不依赖不同 Harness 私有会话互通。

## 9. 尚待单独批准的设计决策

- **D-01（存储）**：共享 Workspace、长期记忆与 Artifact 的权威存储、加密和跨设备同步方案——下一份设计文档讨论。
- **D-02（多 Mac）**：V1 仅支持一台已选定执行 Mac，还是允许多台已注册 Mac 但必须显式选定其中一台？不在 V1 自动负载均衡。
- **D-03（体验）**：Mac 离线任务的排队时限、用户通知与主动重新指定执行位置的流程。
- **D-04（收费）**：启用真实付费云端 Executor 前的额度、预算、并发和成本保护门槛。
  - **部分决定（2026-11-15，CTO 批准）**：仅针对 Beta V1 / Private Alpha 的 Daytona Python Agent Task，采用 §11 的有界执行参数。其他执行环境（Mac/本地 Harness、E2B、VM 类 Sandbox 等）、商业收费方案、用户配额定价与正式发布后的成本策略**仍未批准**。
- **D-05（协议）**：Mac 与 Executor Gateway 之间使用轮询、持续连接还是混合机制；实现需结合断线恢复与移动/桌面运行特性确定。
- **D-06（Harness）**：本地可执行程序发现/版本/能力探测、用户授权、ACP/原生适配、会话管理、审批与隔离策略；先独立验收，再宣称支持特定 Provider。
- **D-07（跨 Run 恢复）**：何时允许改变目标 Executor、Checkpoints/输入数据条件、用户偏好约束和失败时显示的原因；不属于 P0B-06 的自动调度行为。

## 10. 决策摘要

V1 采用 **简单、规则驱动、可解释的 Placement**：交互设备和执行位置解耦；`auto` 默认云端执行云端可用任务；涉及未经同步的本机资源必须使用获授权 Mac；用户可显式选择云端或 Mac，但不能突破能力和隐私边界。单次 Run 不热迁移，重试默认保持目标；未来在单独批准的策略和已提交逻辑 Checkpoint 上允许新的 Run 条件性跨设备恢复。永久在线来自云端控制面，而不是每个 Agent 或每台 Mac 永久运行。

下一步单独讨论：**长期记忆、Workspace、文件与 Checkpoint 在云端、Mac、iPhone 之间的持久化、所有权和同步模型。**

## 11. V1 云端 Agent Task 执行边界（D-04 部分决定）

> 状态：**APPROVED（CTO，2026-11-15）**，仅适用于 Beta V1 / Private Alpha 中的 **Daytona Python Agent Task**（产品范围见 [BETA_V1_ROADMAP.md B3](../product/BETA_V1_ROADMAP.md#b3--delegate-work-inside-conversation)）。  
> 本节**不**批准：其他执行环境（Mac/本地 Harness、E2B、VM 类 Sandbox）、商业收费与用户配额定价、D-01 的长期存储方案，或正式发布后的成本策略。  
> 下列数值均为上限，实现可以更严格；放宽需 CTO 批准。本节是直接用于实施的参数，不引入新的审批流程或设计阶段。

### 11.1 数据模型：复用，不新建

- 复用现有 Task / Run / Lease 状态机、`task_results`、`artifacts`（`artifacts.task_id`）、`task_events`、Conversation `task_reference` / `outcome_reference` 与 `commitments`。
- 不引入第二套 AgentTask 模型或状态机；不在 `tasks` 上复制 Conversation、Artifact、Commitment 关联。
- Schema 变更只能以**新增** Migration 提交（由 Agent A 统一负责），不修改历史 Migration。

### 11.2 Runtime 位置与 Smoke 优先

- 复用 `apps/cloud-async-runtime` 的 Cloudflare Queue Consumer，新增独立的 Agent Task Queue；不预先部署常驻 Node 服务。
- 依据：Queue Consumer 单次调用的 Wall Time 上限远大于 Sandbox 生命周期；现有 `limits.cpu_ms: 30000` 是 CPU 预算，等待模型与 Daytona 的网络时间基本不计入。
- **Cloudflare + Daytona Smoke 优先**：Agent B 首先验证 Daytona SDK 能在 Workers Runtime 中完成打包、Node 兼容 API 调用以及 `container-small` 的创建/执行/销毁。Smoke 不等待 PR A1。只有出现无法低成本解决的阻塞时，才改为独立 Node Task Worker，并在 PR 中附上证据。

### 11.3 Sandbox 与预算上限

| 项                  | V1 决定                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox 类型        | Daytona `container-small`（snapshot `daytona-small`）                                                                                              |
| 创建方式            | **Lazy Sandbox Provisioning**：首次 Python 工具调用时才创建，之前的模型调用不占用 Sandbox 生命周期                                                 |
| 每个 Run 的 Sandbox | 最多 1 个；Run 结束（成功、失败、取消、超时）后立即销毁；不跨 Run 复用                                                                             |
| Sandbox 生命周期    | 120 秒（`DAYTONA_SANDBOX_LIMITS.maxSandboxLifetimeSec`）                                                                                           |
| 单条命令            | ≤ 60 秒（`maxExecTimeoutMs`）                                                                                                                      |
| Python 执行次数     | 每个 Run 最多 **3 次**（含首次执行和基于 traceback 的修复）                                                                                        |
| 执行阶段 LLM 调用   | 每个 Run 最多 **4 次**（≤ 3 次生成或修复代码 + 1 次结果总结）                                                                                      |
| 文件大小            | 输入、输出单文件 ≤ 256 KiB                                                                                                                         |
| 网络                | 默认 `deny-all`                                                                                                                                    |
| 凭据                | 不向 Sandbox 注入任何 Ember Secret（数据库凭据、模型 Provider Key、会话 Token、Daytona Key 等）                                                    |
| 并发                | Agent Task Queue 初始 `max_concurrency: 2`、`max_batch_size: 1`。Adapter 的 `maxConcurrentSandboxes: 2` 只约束单个 Provider 实例，不能当作全局保证 |
| 孤儿回收            | 依赖 Adapter 的 vendor idle-stop + 停止即删除，Reaper 负责回收超时 Run                                                                             |

- 重试产生的新 Run 同样受上述上限约束；每个 Task 的 Run 总数受现有重试策略限制。
- Task 的 LLM 调用与普通聊天的 `model_turn_attempts` **分开计量**，但共享全局费用上限。外部测试前必须核实当前 OpenRouter Key 的累计额度限制。

### 11.4 重试与恢复：Queue 只负责投递，Run/Lease 负责执行重试

- Agent Task Queue 只负责**投递**：重试次数设为低值并配置 DLQ。每次投递都必须先通过 Lease/Fencing 领取一个 Run，才能调用模型或接触 Sandbox；没有可领取 Run 时直接确认消息并退出。
- 是否重试只由 Run/Lease 决定（`retryable_failed` → 新 Run），避免 Queue 重试和 Lease 恢复同时重跑同一个 Task。
- **Lease Heartbeat** 在等待模型和 Daytona 期间也要持续发送，不能只在步骤之间发送；Lease TTL 必须大于单次最长等待。
- **Fencing**：旧 epoch 的 Run 写入的事件、结果和 Artifact 一律拒绝。
- **Checkpoint 恢复**：LLM 循环不可重复，因此 Checkpoint 定义为“已完成的工具调用及其持久化结果”。新 Run 使用新的 Sandbox，从已持久化的输入 Artifact 重新上传，并带着已保存的历史重新提示模型；不假设模型会生成相同的计划。有副作用的操作通过现有 `operation_receipts` / `external_effects` 保证最多执行一次（V1 Python Task 本身在 `deny-all` 下没有外部副作用）。

### 11.5 不可信输入

- **模型生成的代码和用户文件都视为不可信输入**；文件内容可能包含提示注入，借此诱导模型生成恶意代码。
- Sandbox 只运行程序允许列表中的程序（`python3` 已在列表中），不开放 Shell、包管理器或网络客户端。
- stdout/stderr 按 Adapter 上限截断；回传给模型和在 iOS 渲染时都作为不可信数据处理（转义后以文本或 Markdown 展示，不执行脚本或 HTML）。
- PR B1 必须包含以下安全测试：网络隔离、路径限制、资源耗尽（CPU、内存、磁盘、进程数、时间）、Sandbox 环境中不存在 Secret、跨租户数据隔离。

### 11.6 Artifact 存储（V1 临时方案）

- 文件字节暂存在 **Neon PostgreSQL**：新增一个受大小约束的 `bytea` 实现，实现现有 `BlobStore` 接口，沿用 `blobs` / `artifacts` 的现有语义，不引入 R2。现有 `PostgresBlobStore` 通过 `LocalBlobStore` 存储字节，不能在 Cloudflare 与各 Worker 之间共享。
- 单文件 ≤ 256 KiB，在上传接口和数据库约束两层都要校验。
- 文件在发布为 Artifact 之前不可下载；每次读取都校验租户。
- 最终 Artifact 与 Task 完成状态、`task_results` 在同一个事务中提交，不会出现“显示已完成但文件不可读”。
- 未关联到任何委托的上传文件由现有 GC 隔离机制回收。
- 本方案**不**决定 D-01。

### 11.7 输入与体验边界

- 初始输入：普通文本，以及 ≤ 256 KiB 的 TXT/CSV/Markdown 附件，通过独立的认证上传接口提交（聊天消息保持现有字符上限）。上传后的 Artifact ID 必须校验所有权，并与该次委托绑定。
- **APNs 未实现**：关闭 App 后，只承诺任务在云端继续执行、重新打开 App 后恢复真实状态和结果；不承诺任何推送通知。
