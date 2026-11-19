# ADR-0006 — 体验优先、设备驱动的 Runtime V2

- 状态：经产品负责人 / CTO 批准并合并到 main 后为 Accepted — 仅 M0 与本地 M1 PoC
- 日期：2026-11-19
- 负责人：V2 首席架构师
- 范围：V2 架构基线、有明确边界的 PoC 和部署预算；不授权生产环境切换
- 关联：[ADR-0005](0005-cloudflare-native-runtime-v2.md)、[ADR-0004](0004-beta-v1-live-platform-contract.md)、[V1 架构基线](../architecture/v1-architecture-baseline.md)、[V1 执行位置设计](../architecture/v1-execution-placement.md)
- 语言说明：本文为 [ADR-0006 英文原版](0006-experience-first-device-powered-runtime-v2.md) 的完整中文译本，不构成独立的架构决策；如有歧义，以英文原版为准，后续修订应同步更新两种语言版本。

## Architecture North Star — 长期架构原则

**Experience-first, Event-driven, Cost-efficient.**

**体验优先、事件驱动、成本高效。**

**Cloud-managed, Device-powered Personal Agent.**

**云端管理、设备驱动的个人智能体。**

这些是长期产品架构原则，而非对某个供应商技术栈的描述。

- 体验优先：尽可能缩短用户获得有效反馈及任务完成的时间；绝不为了节省基础设施成本而让用户无谓等待。安全、隐私、授权、数据完整性和可靠的持久化执行是强制约束，而不是可牺牲的权衡项。
- 事件驱动：Agent 在用户感知中始终存在，拥有持久的身份、记忆、任务与承诺；只有当用户、日程、外部事件或恢复义务需要时才进行计算。
- 成本高效：消除无意义的空闲计算和写入放大；只有在满足体验与正确性要求之后，才选择节省成本的方案。持久存在不等于持续计算。
- 云端管理：Cloud 是持续可访问的协调与持久化平面，即使所有设备都离线，仍能接收并调度工作。这是一项设计目标，而非保证 100% 可用的 SLA。
- 设备驱动：iPhone 与 Mac 是一级执行节点，Android 和其他平台是未来候选。用户自有的 CPU/GPU/NPU、本地数据与原生工具能够扩展 Agent 能力、降低延迟并避免不必要的云端 Sandbox 支出。不进行跨用户算力共享。执行受到设备可用性、电量、散热、内存、权限及操作系统与应用商店规则的约束。
- 云端执行仍不可或缺：用于设备离线、无人值守任务、不受设备支持的工作负载以及获得授权的回退。追求最佳执行位置，而不是不惜代价地本地优先。

## 决策与优先级

本 ADR 细化 ADR-0005：保留 Cloudflare-native 方向以及正确性和迁移门禁，增加延迟优先的交互路径、作为一级架构边界的设备驱动执行，以及可衡量的部署预算。经产品负责人/CTO 批准并合并后，本 ADR 仅针对 M0（契约/Benchmark 冻结）及本地隔离 M1（Agent Head、Fast/Durable Path、使用 Fake Provider 的独立恢复）取代 ADR-0005 的不授权 PoC 限制。依赖性编码开始前，M0 公共契约须经架构师/CTO 审核。本地 M1 门禁通过后，创建云资源、部署及 Smoke（即使在建议的 $10/月预算内）也需要产品负责人/CTO 单独明确批准 Cloud PoC 的环境、额度和凭据。真实外部 LLM/Daytona 调用需要产品负责人/CTO 单独批准 Provider Canary 的明确支出上限，并验证单 Agent/全局预算预留。M2 及之后的里程碑实施和集成须后续范围批准；独立设备研究不受影响。本 ADR 不改变 ADR-0004 冻结的 V1 Wire Contract，不允许迁移真实用户，不授权新的外部模型支出或付费 Sandbox 使用，也不证明任何 V2 组件已经实现。V1 产品交付独立推进。现有 V1 安全、Fencing、预算预留、幂等、删除 Epoch 以及消息与任务关联的原子性约束继续强制生效。

## 目标拓扑

```text
 iPhone / Mac / 未来 Android / Web
       |                         ^ 本地执行 / 进度
       v                         |
 Edge API Worker（认证、路由、流式传输、同步）
       |
 Agent Head DO <-----------------+ Fenced Commit / 事件
 （SQLite、状态、策略、Alarm、持久化恢复）
       |                    |
       | Fast Path          | Durable Path
       v                    v
 Interactive Executor     Queues -> Execution Worker
       |                    |
       +----------+---------+
                  v
       LLM / Tools / Daytona / 获授权的设备执行器

 D1（按需）：账户、会话、设备与路由目录
 R2：不可变或版本化的产物、文件、备份对象
 设备本地存储：缓存、离线 Outbox、私有输入
```

上述为逻辑边界；初期复用现有 Monorepo，尽量减少 Worker 部署单元。不建设通用多 Runtime 框架，也不强制依赖 Agents SDK 或 Workflows。

### 三条访问路径

1. **Direct Path（直接路径）**：本地缓存视图及限定权限范围的 API 读写；历史记录、任务状态和设置无需调用 LLM、Queue 或 Sandbox。使用权威版本或游标校正乐观 UI。
2. **Interactive Fast Path（实时快速路径）**：API Worker 认证后调用 Agent Head，在原子事务中接收消息、检查 Transcript Epoch、预留预算、准备上下文、领取 Run/Lease，并记录持久化恢复意图。提交成功后，Interactive Executor 直接流式返回模型输出，无需等待 Queue 消费。简单 Turn 的目标是两次核心 DO RPC（Prepare 与 Fenced Commit），但这不是不变量。中间工具、恢复、续租和同步可能需要更多调用。已提交的回复、Usage 和关联的 Task/Notes 副作用，在现有契约要求时仍必须原子提交。
3. **Durable Path（可靠执行路径）**：用户委托、日程、外部事件、审批、回调或恢复触发持久化任务的创建或领取；保存派发意图，经 Queue 交付，在 DO 外执行，再通过 Fencing 提交。长时间外部工作使用供应商 Job Handle/回调或有明确边界的持久化续执行；DO 不等待无界任务完成。

Fast Path 与 Durable Path 共享同一权威状态机、Run 身份、Lease/Epoch、取消、预算与安全规则。客户端断开不撤销已接受的工作。租约过期后，恢复必须核对尚在进行的供应商调用、隔离过期结果，并遵循明确的结果未知或幂等重试规则。不得盲目重放非幂等外部副作用，也不得推定供应商计费具有 Exactly-once 保证。仅依靠 HTTP `waitUntil` 不能实现可靠的持久化恢复。流式输出在最终提交前是暂时性的；客户端重连后读取持久状态，不得产生重复消息。在支持的情况下从持久化 Checkpoint 恢复，不承诺精确恢复中断时的每一个 Token。

### Interactive Executor 部署与恢复

初期 Interactive Executor 是 Edge API Worker 内的 HTTP Handler，不额外引入容器/服务，也不经 DO 转发流。增量 Streaming 使用有界缓冲。Workers Standard 在客户端保持连接时无墙钟 Duration 费用或 HTTP Duration 硬限制；CPU、内存及 Subrequest 限制仍生效。断连或 Runtime 重启可能取消执行；waitUntil 在响应结束/断连后最多延长 30 秒。参见 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 与 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)。不依靠该宽限时间保证任务活性。

M0 初始测试配置（非 Wire Contract 或 SLA）：交互执行总 Deadline 为 120 s，Lease 为 45 s，仅在活跃执行期间每 15 s 续租；供应商调用使用有界 Timeout 与 Abort Signal。发现断连后停止续租并尽快请求供应商取消/移交；执行器静默丢失时，正常恢复目标为最后一次成功续租后 60 s 内进入核对（45 s 到期 + 15 s 发现/派发余量）。合法的带 Fencing 移交或 Lease 到期前不得抢占活跃 Run。进入恢复不意味着可重复结果未知的供应商调用，也不承诺 60 s 内完成任务。Alarm 失败时使用下文独立恢复门禁。更长或不受支持的工作以持久化状态转入 Durable Path，而非启动第二份执行。M0 在验证现有 V1 Lease/Deadline 兼容性后冻结精确超时及续租规则；M1 使用 Fake Provider 测试连接期间 Streaming、断连、静默崩溃、慢供应商、重复/过期完成及长任务移交。显式模拟推理超过 120 s：在截止前保存 Checkpoint 或供应商 Job/Operation Handle，将同一逻辑 Task/Turn 通过带 Fencing 的移交转入 Durable Path，并展示用户可感知的继续执行状态；重连后验证只有一个最终提交结果。若供应商不支持流恢复或结果未知，则核对/取消或明确展示限制；不得承诺同一供应商计算一定无缝续跑、盲目重放或静默截断用户任务。报告恢复时间和实际 P50/P95/P99。不设置空闲心跳。

### Agent Head 与存储边界

- 初期每个由服务端解析的 Agent/Tenant 所有权域对应一个 canonical DO；保留 Tenant、Principal、Agent 的区别。不得根据不可信客户端 ID 路由。不建立全局业务状态 DO。仅在有热点证据后进一步分片。
- DO SQLite 持有 Conversation、Message、Turn、Task、Run、Schedule、Inbox/Outbox、Approval、Reservation、Notes 以及事务不变量要求共置的元数据。本地读取上下文并提交相关副作用；SQLite 事务内不得执行慢速 I/O，也不得使用跨外部调用的全局异步锁。DO 内异步交错执行仍需事务与 Fencing 保护。
- D1 是全局控制数据的首选可选存储，用于身份/目录、会话、权益、设备注册和范围受限的恢复索引。只引入必要的最小 Schema。DO SQLite 和 D1 公布的行读写价格相同，但存储价格、延迟与事务边界不同。使用相同 Benchmark 工作负载对比 D1-centric 与 DO-local；不得将需要原子提交的消息、任务和 Usage 变更拆分至不同存储。D1 中作为投影的索引必须可重建，不能成为第二权威数据源。
- 路由与身份缓存必须具备明确、有界的新鲜度与撤销语义。单 Agent 预算预留无法保证平台全局支出上限；付费外部请求前必须保留现有严格的全局预算门禁，独立验证其权威状态/预算预留机制并测量延迟。
- R2 保存大型不可变或版本化产物及备份；暂存上传、验证归属与 Hash、提交元数据、清理孤儿对象。R2 与 SQLite 无法共享事务。只有实测需求证明必要时才归档历史。
- 设备存储区分可重建的已确认历史缓存与受保护的待发送记录。首次尝试前持久化消息正文、原始 `client_submission_id`、`transcript_epoch` 及账号范围，跨重启、离线和缓存淘汰保留。遵循 [B1 Platform Contract §10](../product/B1_PLATFORM_CONTRACT.md)（N-1～N-12）：ACK 未知时按原 ID 查询；200 则采用确认记录，404 且 Epoch 有效才使用同一 ID 重试；按 ID/Sequence 对账而非文本。按 N-7 仅在收到含 Sequence 的 200/201 后移除已确认 Outbox 条目；遵守 B1 的冲突/删除例外（409 停止重试，按 §10.3 保留未发送草稿；Transcript 删除按 N-11/N-12 清理并隔离队列及在途提交）。缓存清理、重启或账号切换不得静默丢弃未确认记录，也不得重放其他账号的记录；遵守 B1 定义的清理及冲突处理规则，不引入新的静默丢弃行为。设备私有输入仍以本地为权威；禁止静默上传。
- Schema 演进：按 Object 实施有版本、事务性、幂等的 Migration；测试长期休眠 Object 的 Schema 升级、资产清单、导出/恢复、删除及 R2 清理，并演练向前修复和回滚。

### 事件调度与可靠性

每个 Agent Head 的单个 Alarm 指向有索引的持久化 Schedule/Outbox/Lease 表中最早到期的工作。只在最早截止时间变化或处理需要时重新设置 Alarm；按有界批次处理到期任务，保持顺序，遵守周期性日程的时区及夏令时（DST）规则，隔离失败。正常路径无需全局轮询或持续 Agent Loop。Alarm 与 Queue 采用至少一次（At-least-once）交付语义；处理重复、延迟、重试耗尽、发布前后失败以及终态/结果核对。通过平台 API 和故障注入测试验证存储与 Alarm 的原子性行为。即使存储与 Alarm 注册具备原子性，独立且有界的恢复机制也必须存在：6 次 Alarm 自动重试可能全部失败。在 Agent Head 的 Alarm 故障域之外维持持久化且有索引的唤醒/恢复登记表，仅包含权威 Agent ID、Generation 与下次可恢复时间（初始候选为 D1 + 一个定时 Worker；允许等效的独立持久化触发器）。接受执行义务前必须确保可被持久发现；不能保证时拒绝接受未覆盖的工作。登记与 DO 提交之间发生崩溃可以遗留无害的过期标记，但不得使已接受义务无法被发现。使用 Generation/CAS 保守核对；更早的义务仍可能提交时，不得移除或推迟唯一标记。未来日程的标记必须保留到安全退役。定期仅对到期标记作有界扫描，通过同一带 Fencing 的状态机重新设置 Alarm/派发；不全量轮询 DO、不引入全局业务状态 DO、不为每个 Agent 设置心跳。积压、延迟及重复失败必须可观测并告警。不得丢失已提交的工作；Dirty Flag 不是持久化保证。

**Fast Path 登记与降级。** 不为每个普通对话轮次同步读写 D1。当已有持久化标记的恢复时间不晚于新增义务所需发现时间、Generation 经证明有效，且准入/退役协议能防止并发移除或推迟时，可以复用该标记覆盖新增义务。特别是普通对话未提前最早恢复时间且已经建立此覆盖时，无需同步写入登记表。DO 本地持久化覆盖记录只能在经证明的 Generation/Fencing 协议下使用：Sweep 必须从权威 DO 获得安全退役/推迟授权，在远程退役前使旧准入覆盖失效，并按 Generation 条件更新；过期缓存、先前读取时无工作或无条件删除均不足以保证安全。首个未覆盖义务（含此前空闲的 Agent）或要求更早恢复时间的义务，必须在提交前建立覆盖。不为避免一次登记写入而定期唤醒空闲 Agent。若 D1 跨区域写入成为延迟瓶颈，评估区域化部署或等效独立持久化触发器；D1 读副本无法将写入移出主库（[D1 Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)）。

恢复登记表不可用时，继续不创建未覆盖义务的已授权 Direct Path 操作；已覆盖的 Fast Path 轮次仅在其他必需权威（含全局预算与认证）可用且有效时继续。不因 D1 恢复登记失败而阻塞全部聊天，但不得将新增未覆盖工作确认为已接受。保留客户端受保护 Outbox，展示可重试的不可用/ACK 未知状态，按 B1 原 Submission ID/Epoch 对账；提交结果未知不等于已拒绝。安全时继续既有带 Fencing 的执行，保留标记和持久化恢复，并在依赖恢复后核对。不得绕过预算门禁或承诺登记表故障期间一定能够自主恢复。M0 必须冻结准入/退役协议、故障行为及兼容客户端的错误映射；M1 测试登记表不可用时已覆盖/未覆盖轮次、并发 Sweep/退役与接受、提前截止时间、崩溃/重启、过期 Generation 和 ACK 丢失。跨区域 RTT 分别测量首个未覆盖轮次及复用标记轮次的 ACK/Runtime P95，报告实际每轮登记操作数与故障行为。经证明已覆盖的路径无需同步访问登记表，作为明确验收项。

M1 恢复门禁（本地故障注入，随后在单独批准的 Cloud PoC 上复验）：让初次 Alarm 调用和全部 6 次重试失败，同时所有客户端离线，存在待派发任务及后续日程；验证无需用户流量即可独立发现、正确派发及重新设置 Alarm。初始目标：在重试耗尽后（必要依赖不可用时，从恢复可用起算），于明确的 PoC 有界负载下 2 分钟内发现、5 分钟内恢复派发/设置 Alarm；报告实际最大值/P95 及失败情况，而非平台 SLA。测试登记表与 DO 提交前后崩溃、重复 Sweep/Alarm/Queue 交付、过期标记清理、并发日程变更和后续日程实际执行。不得丢失已接受任务或产生重复提交结果；供应商结果未知仍遵循现有核对规则。M0 在实施前冻结精确登记协议、恢复频率/批次与测量定义；Fast Path 延迟及成本 Benchmark 必须包含预登记调用；未满足门禁不得验收 M1 或继续发布。

### 设备驱动执行契约

复用已有 V1 Domain/Contracts、Placement、Run/Lease 与 Checkpoint 概念，不创造第二套执行系统。

- **设备注册表（Device Registry）**：权威所有权、经过认证的设备身份、受支持的工具/Runtime 版本及能力声明；设备就绪状态具有短时有效性，不得因设备已注册就假定可执行。执行时检查授权、范围、撤销、App 状态及本地策略。
- **执行请求/邀约（Execution Request/Offer）**：稳定的 Task/Run/Epoch 和操作 ID、能力、授权输入、Deadline、资源范围及受限凭据；通用 Queue Payload 和日志不得包含密钥。
- **设备状态/结果（Device Status/Result）**：accepted/running/waiting/failed/completed/cancelled，带版本的进度、经过验证的输出引用、Fencing 与幂等提交。凭据可撤销且只适用于一次被许可的执行；设备无权为自己授予新权限。
- **Placement 优先级**：首先满足隐私、权限、能力及 Deadline 的硬约束；其次考虑用户感知的预计完成延迟、可靠性和设备健康；最后考虑云端成本。初期使用简单确定性规则。只有获得授权且输入/数据权限允许时才能回退，否则等待设备或询问用户。绝不自动上传仅限本地的输入。跨 Run 转移前必须验证外部副作用与 Checkpoint 可移植性。
- **首个设备 Demo**：在前台 iPhone 上执行原生 PDF/文本提取或 OCR，并将获得许可的结果返回 Cloud。对照 Daytona 使用相同输入、输出标准和端到端延迟指标；测量设备电量、散热和内存。Mac Adapter、动态代码/WASM/Python 属于后续工作；不假设移动端可无限制执行代码、任意后台唤醒或逃逸操作系统 Sandbox。必须在支持的硬件与操作系统版本上验证移动端后台可用性。

### 全球延迟与 DO 效率

Edge API 尽量靠近客户端；适用时在创建 Agent 时使用 Agent Home Location Hint（它不保证具体部署位置，也不是多主复制）。分别测量亚太、欧洲、美洲的性能，包括用户旅行、冷启动和跨区域模型延迟。暂不实现实时跨区域迁移。根据真实 TTFT、生成速率、准确性、工具能力和成本选择模型供应商及执行位置。

DO 只执行短时协调 Handler；不在内部等待 LLM/Sandbox/Tool 完成。在有明确收益时使用支持 Hibernation 的 WebSocket；不使用 Keepalive Timer 或逐 Token 持久化。在保留必要恢复与审计数据的前提下合并进度写入。使用有界上下文、索引查询、增量同步和本地缓存。符合休眠条件时，目标为空闲计算成本接近零；持久化存储和到期工作仍会产生费用。

## 体验与可靠性门禁

初始工程目标不是实测 SLA。使用匹配的区域、模型、Prompt、数据、客户端及负载与优化后的 V1 对比；报告 P50/P95/P99、冷/热状态、失败情况及测量定义。

| 指标 | 初始目标 |
| --- | --- |
| 本地发送反馈 | ≤ 50 ms |
| 缓存历史首次渲染 | ≤ 100 ms |
| 消息持久化 ACK（近区域 P95） | ≤ 250 ms |
| Runtime 开销（不含模型/供应商，近区域 P95） | ≤ 200 ms |
| 简单任务使用低延迟模型的首个有效 Token（P50 / P95） | ≤ 1 s / 2.5 s |
| 后台任务开始派发（P95，不含供应商启动） | ≤ 3 s |
| 前台取消状态反馈 | ≤ 500 ms |
| 后台负载导致的前台 P95 延迟增幅 | ≤ 10% |

M1 退出门禁：在前后台并发负载下，独立测量完整同步全局预算预留/检查（包括争用、冷启动、跨区域 RPC），也计入端到端 Runtime/TTFT 测量。初始分配：近区域 P95 ≤ 50 ms，包含在 200 ms Runtime 开销内，不是额外预算。Fake Provider 测试必须覆盖实际预留语义、并发、额度耗尽及 Fail-closed 行为；在另行批准的 Cloud/Provider Canary 中复验。权威预留前不得调用付费供应商，不能以最终一致的缓存余额替代。如延迟未达标，优化权威状态/事务，或经明确审核、证明全局上限不变量后评估有界预分配额度；不得削弱上限。首 Token 数字在真实模型测试前仍是假设。

不得为了这些目标降低数据完整性。测试离线/Outbox 重启及缓存淘汰、账号隔离、未知 ACK 与 B1 冲突/删除对账、重复事件、并发预算/全局上限、Transcript 删除、跨租户隔离、断连、过期 Epoch、Outbox 发布间隙、Alarm 重试耗尽、供应商结果未知、凭据撤销、R2 不一致、设备休眠/离线及授权回退。保留所有 B1 Wire Contract 和 Domain Contract 行为；Streaming/Device Wire 扩展需要明确的版本化批准。

## 部署预算（美元/月）

规划日期：2026-11-19。产品负责人现有账户：Workers Paid $5/月、Neon Free、Supabase Free。V2 无需新的固定数据库订阅。账户包含额度由其他产品共享，并非 Ember 独享。V1 在切换前保留 Neon；V1 的任何超额费用均属于迁移期间的独立成本。V2 不需要 Supabase。除非单独列入预算，所有数字均不包含税费、现有开发者计划/域名费用、工程人力及第三方 Connector 费用。

### 官方计费参数

| 计费项 | 每月包含额度 | 超额单价 |
| --- | ---: | ---: |
| Workers 请求 | 1,000 万 | $0.30/百万 |
| Workers CPU | 3,000 万 ms | $0.02/百万 ms |
| DO 请求（含 Alarm 及计费 RPC/WS） | 100 万 | $0.15/百万 |
| DO Duration | 400,000 GB-s | $12.50/百万 GB-s |
| DO SQLite 读取/写入行数 | 250 亿 / 5,000 万 | $0.001/百万 / $1/百万 |
| DO SQLite 存储 | 5 GB-month | $0.20/GB-month |
| D1 读取/写入行数 | 250 亿 / 5,000 万 | $0.001/百万 / $1/百万 |
| D1 存储 | 5 GB-month | $0.75/GB-month |
| Queues 操作 | 100 万 | $0.40/百万 |
| R2 Standard 存储 | 10 GB-month | $0.015/GB-month |
| R2 Class A / B | 100 万 / 1,000 万 | $4.50/百万 / $0.36/百万 |
| Observability（2026-12-01 起） | 摄入 50 GB / 保留 10 GB-month | $0.25/GB / $0.10/GB-month |

Workers Paid 的 $5 基础费每个账户只计算一次。DO Duration 按每个活跃 Object 0.128 GB 内存计费；符合 Hibernation 条件的空闲时间不计 Duration。模型对 DO 计算请求数和 GB-s 超额向上取整至整百万；R2 Standard 操作向上取整至整百万，存储向上取整至整 GB-month；DO SQLite 行数/存储及其他计费项按比例估算，以账单验证为准。这并非单纯的保守余量：DO 官方定价页 [Compute billing](https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing) 明确规定超额用量（含 Duration）向上取整至下一计费单位。10k MAU 时，437,760 GB-s 减去包含的 400,000，超出 37,760 GB-s；ceil(37,760 / 1,000,000) × $12.50 = $12.50，而非假设按比例计费的 $0.472。修正后的取整总额为 $176.07（旧 $176.27 包含 $0.20 的额外存储取整）。小于 64 KB 的 Queue Message 通常需要三次操作，重试增加操作次数。D1 与 DO SQLite 分别计算包含额度。索引写入、删除及 `setAlarm` 写入计入用量；需要测量实际计费行数。D1 包含前 10 万个数据库，Queues 包含前 1 万个队列；V2 不需要为每位用户创建独立 Queue/D1 数据库。R2 公网出站流量免费，其他服务可能收费。12 月 1 日之前的 Workers Logs：每月包含 2,000 万个事件，超额 $0.60/百万；本模型采用面向未来的 Observability 价格。来源见文末。

### 工作负载与可复现估算

按每月 30 天计算；MAU 为月活 Agent（本模型每位用户一个）。假设 60% 轻度、30% 中度、10% 重度。额外保留的休眠用户、历史增长、备份及高用量 Connector，在数据明确后另行计入。

| 用户类型 | 每日对话轮数 | 每日后台任务 | 每月总事件 | DO 数据库平均 MB | R2 平均 MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 轻度 | 5 | 1 | 180 | 5 | 20 |
| 中度 | 20 | 4 | 720 | 20 | 100 |
| 重度 | 100 | 20 | 3600 | 100 | 500 |
| 加权平均 | 19 | 3.8 | 684 | 19 | 92 |

单次事件的假设（非实测）：6 次计费 Worker 请求、累计 40 ms Worker CPU、4 次计费 DO 请求、累计 0.5 s 计费 DO 活跃墙钟时间、200 行 DO 读取、20 行 DO 计费写入（已含索引/Alarm 开销）、10 行 D1 读取、平均 0.2 行 D1 计费写入、1.2 次 Queue 操作（平均 0.4 条小消息，包含恢复/后续执行）、0.1 次 R2 Class A 和 0.2 次 Class B。D1 存储 0.25 MB/Agent。假设采样后每事件合计 2 KB 计费 Observability 摄入，保留 7 天且负载稳定。存储 MB/GB 使用十进制单位。存储估算表示平均计费保留量，不是每月新增量。

设 N 为 Agent 数量，E = 684 × N（或采用上表单一用户画像的工作负载）。月度用量：

- Workers：6E 次请求、累计 40E ms 活跃 CPU。Workers Standard 对 Streaming 墙钟时间不单独收费，但需独立测量其延迟/并发及供应商工作。为便于复算，将示意 40 ms/事件拆为所有事件平均 30 ms 其他处理 + 10 ms 流处理（非实测）；CPU 总量 = E × (30 + 10) ms。若未计入单事件向量，额外 Streaming 重连、活跃 Lease 续租请求/写入、字节/日志及重试单独计量。100k MAU 时，包含 CPU 已用尽的情况下，每事件额外 10 ms CPU 增加 $13.68/月；单纯 30 s 网络等待增加 $0 Worker Duration 费用。不得为 Streaming 持续占用 DO。M1/M4 测量墙钟和活跃 CPU 后替换假设。
- DO：4E 次请求、0.128 × 0.5E GB-s、200E 行读取、20E 行写入、0.019N GB-month。
- D1：10E 行读取、0.2E 行写入、0.00025N GB-month。
- Queues：1.2E 次操作。R2：0.092N GB-month、0.1E 次 Class A、0.2E 次 Class B。
- Observability：0.000002E GB 摄入，存储近似为摄入量 × 7/30。
- 每个计费项 i 输入 A_i（账户包含额度）、B_i（其他产品预测用量）、U_i（Ember 用量）。剩余额度 R_i = max(A_i − B_i, 0)。按计价单位 Q_i 换算，成本估算 = $5 + 各项 p_i × f_i(max(U_i − R_i, 0)/Q_i) 之和；DO 计算请求/Duration 与 R2 Standard 操作/存储的 f_i 为向上取整（ceil），其余为原值。$5 是现有账户的分摊基础费，而非新增订阅。计费单位边界处的实际边际账单可能不同，需核对账户总账单。
- 下表暂不包含独立恢复机制新增开销，待 M0 协议测量。上线前必须将其作为额外用量向量显式估算：例如每分钟一次的定时 Worker 每 30 天增加 43,200 次调用，另加到期索引行读取、登记/清理写入、恢复 RPC/CPU、遥测和重试。将其加入 U_i（避免与已有单事件假设重复计数），实测后重估。若额度耗尽，仅每事件额外两行 D1 计费写入就可能在 1k MAU 增加 $1.37/月，100k MAU 增加 $136.80/月。不轮询全部 Agent。即使实际费用更高，恢复机制也必须保留。

| MAU | 剩余全部额度 | 剩余 50% 额度 | 剩余额度为零 | 建议规划预算 |
| ---: | ---: | ---: | ---: | ---: |
| 1–10（PoC，按 10 估算） | $5.00 | $5.00 | $22.73 | $10 |
| 100（Internal Alpha） | $5.00 | $5.08 | $24.70 | $15 |
| 1,000（Public Beta） | $9.33 | $10.43 | $44.62 | $30 目标 / $60 条件性预算 |
| 10,000（Growth） | $176.07 | $208.14 | $245.01 | $300 |
| 100,000（Scale） | $2,204.80 | $2,261.13 | $2,326.00 | $3,500 |

额度情景仅用于敏感性分析，对每项计费均使用给定的剩余比例；实际各项 B_i 必须来自共享账户基线。各情景均包含 $5 基础费，并如上排除独立恢复新增开销。共享额度耗尽时 Beta 的 $30 目标不可行，建议 $60 条件性预算（含余量），须根据真实用量由产品负责人/CTO 另行批准。额度为零时 PoC/Alpha 也可能超出 $10/$15；创建云资源或扩大负载前必须核实容量并取得修订预算批准。不得声称拥有专属免费额度或账户级硬上限。

同为 1,000 位用户，分别全部为轻度/中度/重度时，按相同假设估算为 $5.15/$9.65/$62.54。10 万混合用户下，仅 DO 行写入超额费用约 $1,318；每次事件额外增加 10 行写入，会增加约 $684/月。10 万 MAU 时，若每事件计费 DO Duration 从 0.5 s 增至 10 s，模型中的 Duration 费用将从 $50 增至 $1,100/月。这些是工作负载推演，不证明吞吐量已经达标，也不保证实际账单。保留必要的审计、预算和恢复写入。因成本调整架构前，应先使用真实计费数据。

M0 退出门禁：定义可重复的单事件计费 Trace，测量可取得的 V1 基线（逻辑数据库变更、保留字节、任务构成，而非 SQLite 计费行数的替代），并使用最小本地 SQLite/DO Probe 校准普通 Turn、Task、重试、活跃 Lease 续租及 Alarm/恢复操作；记录实测或明确估算的计费行数（含索引、删除及 Alarm）、存储字节与局限。M1 报告本地 V2 实测，M4 退出须通过另行批准的云端计量取得各路径/用户画像的实际单事件计费写入、P50/P95 与加权平均，并与供应商指标核对；上线前替换 20 行/事件假设并重估。不得为成本门禁删除必要的完整性/恢复写入。

存储是存量，不是每用户固定的终身上限。M0 定义活跃与休眠用户的初始字节、单事件净新增字节、保留/删除/备份假设。M4 使用代表性长历史负载实测数据库/索引/元数据与 R2 增长，并预测 1/6/12 个月平均 GB-month，含保留的非活跃用户及备份。敏感性分析：100k MAU 下，DO 平均存储从 19 增至 38 MB/Agent，按 $0.20/GB-month 每月额外 $380；实际使用真实保留及额度数据。归档/删除须遵守已有用户保留、导出及完整性契约；不为满足成本模型强制裁剪历史。

### 独立的可变执行预算

LLM 支出独立于基础设施。以下仅为示意价格，而非已选模型报价：Input Token $0.50/百万，Output Token $2/百万；每次事件 5,000 Input 和 1,000 Output Tokens，则每事件 $0.0045，每位混合活跃用户每月 $3.078（1,000 MAU 为 $3,078）。实际 Input/Output、缓存 Input、模型/工具步骤数及重试均需要计量；不设无条件的单事件 Token 额度。

Daytona 官方标价：CPU $0.0504/vCPU-hour，RAM $0.0162/GiB-hour，存储在价格规则所述前 5 GiB 免费之后为 $0.000108/GiB-hour；需确认实际账户权益、存储生命周期和具体计费。示例 Linux 1 vCPU/1 GiB RAM 的活跃计算费用为 $0.0666/小时，不含额外存储。假设每位用户每月执行 30 次可分流、每次 5 分钟的任务，1,000 位用户共消耗 2,500 活跃小时，即 $166.50 原始计算成本（未扣抵用额度、未计额外存储）。若其中 50% 的任务能够在设备上安全执行、质量等同且无需云端 Sandbox 回退，原始计算成本降至 $83.25。这是一种情景分析，而不是对分流率的预测。设备计算将能耗和发热负担转移至所有者设备，Cloud 协调与 LLM 费用仍存在。不假设长期运营能够使用促销额度。端侧收益需要同任务对照 Benchmark 和真实 Placement 分布验证。

1,000 混合 MAU 的示意预算：$30 Cloud Runtime + $3,078 LLM + $166.50 Sandbox = $3,274.50/月（不含其他费用）；50% 可分流任务在端侧执行时，Sandbox 部分节省 $83.25。采用 $60 条件性 Cloud Runtime 预算时，相同情景为 $3,304.50/月（不含其他费用）。这些数字不构成支出授权或产品定价。PoC 默认使用 Fake Model/Executor；真实供应商 Canary 支出需要单独批准的明确硬上限及单用户/全局预算预留。本 ADR 不授权 Supabase 或 Neon 付费升级。

在 1k MAU 的 $3,274.50 示意预算中，LLM 约占 94%，Cloud Runtime 约占 1%；这是情景估算而非实测成本构成。优先优化推理单位经济模型，再优化基础设施细节：复用现有 Model Gateway 与预算控制，设定获批准的单用户/套餐及全局上限，每次付费调用前预留最大估计支出，核对实际 Input/Output/缓存 Token 与重试，对未知 Usage 保守处理。M0 定义小型模型路由评估矩阵（延迟、正确性/任务成功率、每成功任务成本、工具能力、隐私）；从确定性路由及有界上下文/输出/工具步骤/调用预算开始。只在支持且保持质量、延迟和隐私时评估 Prompt Cache 或端侧推理；不单纯为省 Token 强制降级。额度耗尽时准确告知用户并保留已接受工作恢复能力；不得静默截断或超出批准上限自动支出。M1 Fake Provider 测试验证单用户/全局上限与计量；付费模型评估另行授权。M4 发布要求实测推理成本分布和修订的单用户预算，而非仅基础设施估算。本 ADR 不批准具体模型选型或真实供应商支出。

### 预算控制与部署

- 使用现有 Workers Paid 套餐；先做本地 Wrangler 测试。建立隔离的 V2 Staging Worker、DO Namespace、Queue、R2 Prefix/Bucket 及按需 D1，使用专用非生产身份，不使用真实用户数据；不修改 V1 路由。云端资源创建/部署/Smoke 须按前述规则单独批准；不引入新的固定费用订阅。
- 首次云端 PoC 预算：Cloud Runtime 合计 $10/月（已支付的 $5 基础费 + 至多 $5 规划余量），默认外部 LLM/Sandbox 支出 $0。对比账户基线记录实际增量用量，因为包含额度共享且费用归属并不完全精确。
- 达到阶段规划预算的 50%、80%、100% 时告警；PoC 期间每日复核支出、流量及延迟，上线后每周复核。普通成本偏差应告警而非全面停止生产；限制未经批准的模型/Sandbox 支出和滥用负载，保留已接受任务的恢复能力。账户级 Workers/DO 支出限制可能影响其他 App，已存储数据仍可能产生费用。未经产品负责人审核不启用大范围硬限制。实施开发环境隔离、单次调用 CPU 限制、供应商预算检查、产物保留与非敏感日志采样。
- 按事件及工作负载画像追踪 Workers CPU/请求、DO Duration/请求/行数、D1、Queue 重试/DLQ、R2 存储/操作、Observability 字节、模型 Token/成本、Sandbox 分配的活跃/存储时长。与供应商账单核对；不记录私有文本、文件或凭据。
- 首次及后续每次发布门禁复核官方价格（尤其 12 月 1 日 Observability 切换）、计费模式及剩余共享额度；根据实测 P95 延迟、每操作计费写入行数、存储增长、Streaming CPU 和单用户成本重估。支出超出规划时应调查；产品体验和可靠恢复优先。预算是暂定规划决策，不是自动硬性停止服务的限制。

## 实施与切换

M0：ADR、最小公共 Execution/Streaming/Recovery Contract 及匹配负载的 V1 Benchmark。M1：本地 Agent Head + Fast Path 与 Alarm/Queue Durable Path 并行，先用 Fake Executor；独立恢复与受保护 Outbox 验收为强制门禁。M2：获授权的 iPhone 原生工具与路由 Demo（独立移动 Sandbox 研究继续）。M3：复用 V1 LLM、Notes、Daytona，按需增加最小全局控制数据，版本化 API 扩展单独审核。M4：云端 Benchmark、故障注入、导出/导入、删除/恢复、区域与成本验证。M5：可逆的按 Agent 迁移；未经单独切换批准不得使用真实数据。

### M0/M1 验收清单（摘要；以上详细门禁仍为规范）

| 阶段 | 验收项 | 证据 |
| --- | --- | --- |
| M0 | 公共 Execution/Streaming/Recovery Contract；已有 B1 兼容 | 经审核的契约及所有权不变量 |
| M0 | 登记覆盖、退役/Fencing、D1 故障行为；Lease/Deadline 和长轮次移交 | 协议与确定性故障场景 |
| M0 | V1 基线、计费 Trace、存储增长假设及模型路由矩阵 | 可复现工作负载/测量定义及本地 Probe |
| M1 | Fast/Durable Path、受保护 Outbox、ACK 未知、租户隔离 | 本地 Fake Provider 端到端及负面测试 |
| M1 | 已覆盖轮次：零同步登记 I/O；未覆盖轮次与登记故障 | 竞态/故障测试；分别记录 ACK/Runtime 延迟；不丢失已接受工作 |
| M1 | 全部 6 次 Alarm 重试失败；独立恢复及后续日程 | 指定条件下离线恢复：≤ 2 min 发现 / ≤ 5 min 派发或重新设置 Alarm |
| M1 | Streaming/断连、执行器静默丢失及推理 > 120 s | 正常恢复 60 s 内进入核对的目标；带 Fencing 的移交，唯一最终结果或明确结果未知 |
| M1 | 全局/单 Agent 预算、延迟及计费 Trace | 原子预留、近区域 P95 ≤ 50 ms 预算检查目标（包含于 200 ms Runtime）；实测写入量与流处理 CPU |

本次批准级别下，M1 各项仅使用本地/Fake Provider。上线前在另行批准的 Cloud/Provider Canary 中复验相关门禁。失败或无法测量的证据必须如实报告，不得标为通过。

工程分工：A — Agent Core/Fast Path；B — Event Runtime/Recovery；C — Device Runtime；D — Performance/Migration 与 D1 对照。依赖性改动前先冻结共同契约；共享 Schema 与所有权由架构师协调；采用隔离 Worktree、Draft PR、本地测试（不要求 GitHub Actions）。

迁移必须保证每个 Agent 只有一个可写权威 Runtime，隔离旧执行，并暂停或核对未完成的外部副作用。Snapshot/Export，导入后验证 ID、数量、Checksum、顺序、约束和 Schema 版本；验证 API/iOS 兼容；按照服务端解析的 Agent 所有权路由；上线前测试灰度流程及切换后的新增数据反向迁移。仅切换路由不等于回滚。Neon 在范围受限的切换窗口内暂时保留，仅在运维验收通过后退役。不长期双写。

## 尚待验证的证据与非目标

尚未测量：Cloudflare 账户实际用量、V1 Neon 活跃 CU/无法空闲的原因、DO 冷/热延迟、Duration 与写入放大、全局预算权威状态访问延迟、真实设备可用率/分流率、保留休眠用户与导出数据的成本、供应商结果未知时的处理。预算及性能目标都是暂定值。本次文档 PR 未创建新资源、修改生产环境、访问凭据、执行付费任务或运行 Runtime 测试。

## 参考资料（价格核实日期：2026-11-19）

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/observability/pricing/
- https://neon.com/pricing
- https://www.daytona.io/pricing
