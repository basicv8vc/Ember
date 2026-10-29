# ADR-0003 — P0B-06 持久结果与恢复工程契约冻结

- **状态：CTO 已批准的工程契约；仅当本文件位于 main 时正式 Frozen（合并前不生效）**
- **决策日期：2026-10-29**
- **Owner：Ember Architecture / CTO**
- **决策范围：B06-D1～D6；P0B-06 本地纵向闭环**
- **架构依据：**已接受的 V1 Architecture Baseline v1.0（PR #8/#9）、ADR-0001、ADR-0002
- **代码核对基线：**main @ 69872989df0d0dc02b519d8fd6aa2c612e13fc47（P0B-01～05；尚无 P0B-06 代码）

## 目的、权威与冻结边界

V1 Architecture Baseline §12.1 在 PR #8 已经批准 B06-D1～D6 的系统不变量。本 ADR 把这些原则冻结为 **P0B-06 编码和验收必须遵守的行为契约**，消除「Baseline 已 Accepted」与「工程契约尚待冻结」的歧义。

- 本 ADR **合并到 main 后**，B06-D1～D6 的工程行为契约视为 Frozen，可以下发 P0B-06 工程 Prompt；合并前不可把 Draft 当成开工许可。
- 冻结的是**可观察语义、持久身份、原子性、授权、负向行为和测试门槛**。TypeScript 方法名称、辅助函数、私有 SQL 表名、索引命名及目录布局允许执行者提出等价实现，但不得降低这些不变量。
- 需要改变本文规定的行为、安全边界或已批准的 Domain FSM/ADR 时，必须停止实现，另提 ADR 或 CTO Review；不能以「实现细节」为由绕过。
- 本 ADR **不批准** Execution Placement 专题 D-01～D-07。Mac Coding Harness、真实云 Sandbox、跨设备自动改派、生产 KMS、付费基础设施均在 P0B-06 之外。
- 文档是待实现契约，不是通过了代码、性能、生产安全或真实跨设备恢复测试的证明。

## 现有事实与兼容约束

核对仓库现有代码：

- **Workspace** 在 migrations/0002_durable_task_inbox.sql 中按 (tenant_id, agent_id) 为主键，一 Agent 一 Workspace，同时有稳定 workspace.id、version（初值 0）和可空 manifest_ref。现有 WorkspaceStore 使用 (AuthContext, agentId)；实现不得平行引入不兼容的第二套 Workspace 身份。
- **Task/Run** 的 tenant/task 复合外键、current_run_id、lease_epoch、lease_expires_at、runs.leased_until、attempt、worker_id 和状态机已存在；0003/0004 已补 Tenant FK、唯一活跃 Run 和 safe-integer Fencing。
- **TaskStatus、RunStatus、TaskEventPayload** 是有限枚举及安全字段白名单。终态 Event、取消优先级及 queued → failed 的前置条件受 ADR-0001/0002 约束。
- **ArtifactStore / WorkspaceStore** 现有接口使用 AuthContext；Worker 不能伪造用户 principal。P0B-06 可以增补受限执行服务/Port，但必须保留既有授权 API 语义并同步调整契约测试。
- **PostgresLeaseQueue.finish()** 已承担历史 Finish 语义。原子结果提交必须复用或提取同一事务内的状态收敛逻辑，不能先改 Workspace、再调用独立 Finish。
- migrations/0001～0004 已合并，校验和受 migrator 保护；只能新增从 0005 开始的前向 Migration。

## B06-D1 — Blob、Staging、Artifact 的身份与生命周期

冻结以下逻辑实体；具体 SQL 表名不属于公有协议：

- **Blob：**不可变的字节对象；内容摘要 SHA-256、字节数、媒体类型和受控内部存储定位可验证。物理路径或存储供应商 Key 不是可公开引用的 Artifact/Workspace/Checkpoint 身份。
- **StagedBlob：**以可信 tenant/task/run/epoch 或用户上传会话为归属，私有、不可通过普通 Artifact 下载路径访问；字节验证通过不等于已发布。
- **Artifact：**具有稳定逻辑 artifactId、tenant 归属、Blob 摘要/大小/类型、创建来源与保留属性的已授权元数据；用户主动保存的 Artifact 可以独立于 Workspace 存在。已发布 Artifact 的字节不可就地修改。
- **引用与保留：**当前及历史 Workspace Manifest、已提交 Checkpoint、待决冲突候选、用户保留 Artifact 的引用必须防止物理 GC 删除；用户删除仅改变其授权/保留可见性，不能越过其他仍有效引用。
- **写入次序：**将有界数据写到受控私有 staging，验证真实字节、大小、SHA-256 和允许的类型，确保落盘提交点明确；然后由可信事务发布元数据。事务失败不得出现普通用户可见的 Artifact。
- **路径与故障：**防绝对路径、穿越、符号链接逃逸、TOCTOU 和非原子覆盖；内容不可信。测试需覆盖 crash 后文件残留、数据库回滚后不可见、损坏 Hash、缺失文件、重复上传、未知/跨 Tenant ID。
- **GC：**隔离期可配置且非零；只清理经过可靠引用重查确认无引用的孤儿 staging。扫描、标记和删除面对并发发布必须安全；任何不确定性保守保留并记录审计，不得删正式引用的 Blob。

## B06-D2 — Workspace Manifest、CAS、有限自动合并

- **身份：**V1 Workspace 的稳定逻辑身份是 tenantId + agentId 对应的现有 workspace.id。Manifest 文件条目仅保存规范化相对逻辑路径及 tenant-safe Artifact 引用和预期摘要/大小，不允许嵌入本机绝对路径。
- **路径：**采用确定的 POSIX 风格逻辑相对路径和唯一键；拒绝空路径、绝对路径、父级穿越、重复规范化键、控制字符、反斜杠/驱动器欺骗以及可能越过授权目录的符号链接。跨平台大小写或 Unicode 规范化不能可靠消歧时安全拒绝，不静默覆盖。
- **历史：**版本 0 表示空初始 Workspace；后续每一版本拥有不可变 Manifest 和明确父版本，历史可用于共同基线及恢复。更新必须以 expectedVersion 条件 CAS 原子成功并使版本单调递增。
- **并发：**相同 expectedVersion 的真正竞争只有一个直接 CAS 获胜。失利者不可修改权威 Manifest，也不可产生假的成功终态。
- **有限自动合并：**仅当双方具有可验证的共同基线，且基线→当前与基线→候选的变更路径集合完全不交叉、操作仅为安全的增加/内容更新，不含删除、重命名、权限或敏感元数据变化，才可确定性合并；合并结果须在最新版本上重新 CAS，竞争则重查并有界重试，不能 last-write-wins。
- **冲突：**其余情形返回稳定的 WORKSPACE_VERSION_CONFLICT；保护两份候选 Manifest/Artifact/来源和共同基线，持久化待决冲突引用并避免 GC。冲突记录采用独立、受限、幂等的**非终态事务**；结果提交事务本身必须整体回滚，不得把冲突伪装成 Task completed。用户裁决 API/UI 延后。

## B06-D3 — Run 权限、原子提交与幂等收据

- **身份隔离：**AuthContext 仅表示通过 Gateway 验证的用户；LeasedRun、workerId 或 Worker 提供的字段均非用户身份证明。服务端从权威数据验证出只作用于特定 tenant/task/run/attempt/epoch、具体操作及有效时间窗的 scoped Run 执行权限；不能接受 Worker 自造的 principal。
- **可信写入边界：**用单一 RunResultCommitter（或行为等价的应用 Port）聚合结果提交；必要时另提供共享同一 fencing/事务规则的 Step 发布操作。Domain/Application 只知道能力 Port，不接触 pg.Pool、SQL、内部文件路径。
- **锁与时间：**在同一 PostgreSQL 事务中按稳定顺序取得必要的 Task、Run、Workspace 锁；取得锁后采样权威当前时间（PG 可用 clock_timestamp()），检查 tenant、Task 当前 Run、attempt、epoch、Worker 归属、Task/Run 有效 lease、deadline、取消、允许 FSM 边及 Workspace CAS。不可用事务开始时的 now() 证明锁等待后的 lease 有效。
- **最终提交：**正式 Artifact 元数据与引用、Workspace CAS/历史、需要发布的 Checkpoint 引用、合法 Task/Run 终态、唯一且有序的终态 TaskEvent、幂等 Receipt 必须处于**同一个数据库事务**；任何一步失败整笔回滚。Blob 物理 staging 不属于数据库 ACID，需依 D1 可回收且始终不可见。
- **Step 发布：**中间 Step Checkpoint/Artifact/Workspace 版本和进度 Event（如有）同样要求事务性引用发布和有效 Run fencing；它不是终态完成，不得调用会终结 Run 的独立 Finish。
- **幂等键：**由可信 tenant/task/run 和本次操作的稳定 operationId 定位，持久记录规范化请求摘要与不可变 Receipt。相同 ID + 相同内容重复提交读取同一个结果，无新版本/新 Event；相同 ID + 不同内容返回 IDEMPOTENCY_CONFLICT；旧 Run/epoch 不得执行新写入。
- **丢 ACK：**如果事务已成功而响应丢失，经过严格租户、Run 来源及操作身份验证的调用者可以**只读**取回既有 Receipt；即便原 lease 过期，也不授予再次写入权。先检查已提交收据的只读幂等路径与新写入路径必须显式区分。
- **失败语义：**陈旧/过期 lease、取消/Deadline 或非法状态拒绝写入；CAS 冲突整体回滚；数据库不可达暴露固定安全错误且可按既有策略有界重试。遵守 ADR-0001 的取消优先级；Domain/Zod/SQL Event 白名单必须一致，禁止写入 Prompt、文件正文、私有路径或凭据。

## B06-D4 — 可恢复的逻辑 Step Checkpoint

- **逻辑模型：**版本化且可序列化，至少包含 schemaVersion、tenantId、taskId、来源 runId/epoch、stepId/单调游标、确定性输入摘要、执行器/步骤兼容版本、依赖 Workspace 版本、已提交 Artifact 引用、外部操作标识及已验证/未知副作用状态。
- **提交点：**仅在 Step 结果、引用和 Checkpoint 的可信事务提交后才视为已完成；未提交的 Step 允许重算，已提交的同一 Step 必须通过稳定 operationId 幂等识别，禁止重复作用。
- **恢复：**新 Run/新 epoch 读取同 Tenant/Task 下最新已提交、兼容、引用完整的 Checkpoint 作为**只读输入**，用自己的执行授权继续；旧 Run/epoch 不得新增 CP/Artifact/Workspace/Event。缺失依赖、版本不兼容、引用损坏必须停止并安全报告。
- **副作用：**外部动作完成状态不明时不得盲目重放；需要可验证的外部幂等 Key/回执才能自动继续，否则等待人工判断或安全失败。
- **V1 证据：**只验收相同受控模拟环境内从逻辑 Step 继续。Harness 私有 Session、浏览器/进程内存、VM 热迁移不是 Checkpoint，也不承诺真正 Mac→Cloud 接力。

## B06-D5 — Provider-neutral Ports 与验证矩阵

- **依赖方向：**Domain/Application → BlobStore、ArtifactStore、WorkspaceStore、CheckpointStore、RunResultCommitter/StepCommitter 的能力 Port → Infrastructure Adapter。PostgreSQL + 受控本地文件系统是 P0B-06 默认实现，而非领域语义或持久逻辑 ID。
- **事务完整性：**跨多实体原子写操作由具备事务能力的**同一 Adapter**实现，不得把多个异步 Port 调用按顺序排列就声称原子；不要求第二个生产数据库 Adapter，也不承诺不同数据库具有相同并发原语。
- **Schema/迁移：**在新的前向 0005+ Migration 中保存 tenant-safe Artifact/Blob 归属、WorkspaceVersion、Conflict、Checkpoint、Operation Receipt 等必要元数据；必要的复合 Tenant-safe FK、非空/唯一约束、CAS 条件和索引须由数据库强制，不可只靠应用层检查。已有 0001～0004 只读。
- **适配能力契约：**测试必须验证原子版本竞争、租户隔离、引用完整、幂等、事务回滚、锁等待后的 lease 截止时间、损坏文件、孤儿回收和读写授权；支持何种能力由明确契约/配置决定，不能由 Provider 名称推断。
- **既有 API 兼容：**对现有 ArtifactStore.put/get/verify/delete 与 WorkspaceStore.load/commit 进行显式演进；用户 AuthContext 路径与内部 Run 权限路径须分开，旧 LeaseQueue 行为与 P0B-01～05 回归不得退化。
- **安全结果码：**优先使用已有 INVALID_ARGUMENT、NOT_FOUND、POLICY_DENIED、WORKSPACE_VERSION_CONFLICT、IDEMPOTENCY_CONFLICT、STALE_LEASE、DB_UNAVAILABLE 等 DomainError 语义；增加枚举必须同步 Domain、Zod、SQL Event/错误允许集并先经 CTO Review。

## B06-D6 — Execution Placement 与恢复边界

- P0B-06 不引入 Placement 自动决策、设备注册、Gateway、Mac Harness 执行或跨设备搬迁。
- **Run 是固定执行尝试**：运行中不能热迁移；后续新 Run 可以在重新授权、能力/版本/数据可达性复核后以已提交 Checkpoint 为输入继续，但本阶段不实现自动 Mac→Cloud 改派。
- Execution Placement 文档的 D-01～D-07 仍是 Proposed，绝不能因本文 Frozen 被隐式批准。

## 验收、禁止项与执行授权

P0B-06 实施必须提供真实 PostgreSQL（独立连接和隔离测试 Schema）与受控临时 Blob 根目录的可重复证据：

- **B-T12：**CAS 单赢家、版本历史、共同基线的安全不交叉合并、交叉冲突双方候选保留、并发回滚。
- **B-T13：**Blob SHA/size/type、跨 Tenant 和不存在引用拒绝、符号链接与路径穿越、损坏 Blob 检出。
- **B-T14：**字节成功而 DB 失败、重启后孤儿 staging 不可读、GC 不误删历史/用户/Checkpoint/Conflict 引用。
- **B-T17：**崩溃后已提交 Step 不重复、未提交 Step 重做、新 Run/epoch 可读旧 CP 但旧 Run 零写、版本不兼容拒绝。
- **B-T26：**Event/Checkpoint/CAS/数据库 Commit 和丢 ACK 故障注入；Task/Run/Workspace/Artifact/Checkpoint/Event/Receipt 一致性与稳定重放。
- **额外安全门槛：**24 个并发相同 operationId、锁等待过期、跨 Tenant 复合 FK、取消与 Finish 竞争、重复 Finish 不增事件、缺失 Blob/越权路径、重新 Claim 后旧 Worker 全部零写。
- **完整回归：**Lint、Prettier、Typecheck、Unit、Build、Migrator 首次及二次、真实 PG Integration、ESM smoke、git diff --check；真实运行日志及 HEAD/CI URL 一并交付，不能用“CI 全绿”代替断言证据。

**STOP/升级条件：**需要修改 Accepted ADR/FSM、无法证明同事务 Fenced Commit + Workspace CAS、需伪造 AuthContext、需放宽租户/路径/Hash 防护、无法验证 DB/文件系统故障、出现不明确的外部副作用自动重放，均应暂停并交 CTO 评审。

**生效门槛：**本 ADR 经独立审查且合并到 main 后，B06-D1～D6 工程契约才正式 Frozen，随后可按 docs/prompts/Ember_P0B-06_Cline_CLI_Implementation_Prompt.md 启动 P0B-06 **代码**工作。合并前一律不得把此草案当作许可。
