# Ember P0B-06 — Artifact Store / Workspace CAS / Checkpoint / Fenced Result Commit

> **状态：Engineering Prompt · Ready only after Architecture PR #8 has been reviewed and merged into `main`**  
> **执行工具：Cline CLI（执行 Agent）；CTO 负责审核，不自动合并**  
> **范围：本地 P0-B 验证；不采购云服务，不使用真实 LLM/外部密钥**  
> **前置基线：**`docs/architecture/v1-architecture-baseline.md`（尤其 §4～8、§12.1）、`docs/architecture/v1-execution-placement.md`、ADR-0001/0002，已合并 P0B-01～05 源码与测试。

## 0. 强制 Preflight（未满足则停止并报告，不猜测）

1. 核对当前 `main` 是否包含 PR #8 的 Architecture Baseline、P0B-06 CTO 决策冻结和 Execution Placement 修订。若未合并，**停止编码**，报告当前 SHA、PR 状态，不在旧设计上抢跑。
2. 读取本仓库 `AGENTS.md`、代码/迁移/脚本与规范，核对已完成 P0B-05 的基线；先汇报代码事实、待复用端口、现有 `LeaseQueue.finish()` 和 `ArtifactStore` / `WorkspaceStore` 的语义差距。
3. 检查工作目录和 Git 状态；保留用户未提交/未跟踪的任何文件。创建独立 `feature/p0b-06-artifact-workspace-checkpoint` 分支（必要时新 worktree）；不得在 `main` 直接开发。不得重写或强推已有分支。
4. 列出你认为必须新增或变更的接口、Migration、表、事务和测试；遇到与 Accepted ADR/FSM 冲突时**先停下提问**。不要把架构草案误称为已实现代码。

## 1. 目标与交付结果

实现真正可验证的本地持久化纵向闭环：

- 受控目录内不可变 Blob 和 staging → 通过授权与校验的正式 Artifact，含安全下载/完整性校验；
- Tenant-safe、版本化 Workspace Manifest，CAS 与可审计的历史版本；同一已知共同基线上的**完全不交叉路径更新**可安全自动合并，其余保留冲突候选，不发生 last-write-wins；
- 可序列化、带格式版本和来源的逻辑 Step Checkpoint；进度发布受到当前 Run/epoch Fencing；
- 可信 `RunResultCommitter`（名称可按代码风格调整），在**一个 PostgreSQL 事务**中原子地验证 Run、授权与 CAS，并提交正式 Artifact 引用、Workspace 更新、Checkpoint、合法 Task/Run 状态与唯一终态 Event；ACK 丢失时幂等重放；
- P0B-05 确定性模拟 Executor 形成至少一条 Artifact → Checkpoint → 崩溃恢复/完成的实际闭环。真实 Shell、真实 LLM、网络 Sandbox 与设备分发均不在本阶段。

优先最小、可测试的正确实现；不为了未来可替换性同时实现第二套生产数据库或云 Blob Provider。

## 2. 关键契约，必须遵循

**身份/权限**：保留 `AuthContext`（经过 Gateway 验证的用户）与 scoped Run Grant（服务端验证的任务执行权）两个不同信任域。Worker 不能把猜测的 `principalId` 填入 `AuthContext`。所有实体引用按 Tenant 校验，跨 Tenant 与不存在对象对外均安全失败。

**Blob 生命周期**：字节不可变；先写隔离 staging，验证大小/Hash/媒体类型/路径后才有资格被数据库发布；staging 不可作为用户正式 Artifact 读取。数据库失败不得产生可见 Artifact。孤儿 staging 和正式保留数据的清理政策分开。Blob 物理路径/存储 key 不作为逻辑 Workspace 身份。考虑上限、流式/有界接口与原子文件落盘；不要将无限大内容锁死为一次性 `Uint8Array`。

**Workspace**：manifest 使用经规范化的逻辑相对路径，拒绝 `../`、绝对路径、分隔符欺骗、符号链接越界、重复条目和未授权引用；版本从既有 workspaces 行延伸，CAS 由真实 DB 条件更新保证。保存不可变旧版本以供冲突/恢复。第一版自动合并**仅限有共同基线、双方变更路径不交叉、且无高风险操作的确定性情形**。所有其他冲突需要保留双方候选和来源，不可覆盖或静默丢弃。

**Checkpoint**：有 `schemaVersion`、来源 tenant/task/run/epoch、stable Step/operation IDs、执行器/输入兼容性、逻辑游标、已发布 Artifact、Workspace 版本、外部副作用核验状态。仅提交完毕的 CP 可恢复；新 Run 获取新 epoch 写权，旧 CP 仅作只读恢复输入。不得存储宿主机路径、密钥或 Harness 私有会话作为可移植恢复事实。

**原子结果提交**：同一事务在取得必要的 Task/Run/Workspace 行锁后按权威时钟重新校验有效 lease、取消/Deadline、当前 Run 与 epoch、输入版本和 CAS。所有 DB metadata/Checkpoint/Event/FSM 更新要么整体提交，要么整体回滚。不可先独立 `WorkspaceStore.commit()` 后调用 `LeaseQueue.finish()` 造成部分成功。已有 `LeaseQueue.finish()` 的回归语义必须保留；如需改造共用事务逻辑，避免双终态 Event。重复 commit operation ID 且内容相同应稳定返回原结果，不同内容稳定冲突；旧 epoch 全部无写入副作用。

**状态/事件**：只走 Domain FSM，终态不可重写；`TaskEventPayload` 必须保持安全 allowlist（不可写入 Prompt、文件正文、绝对路径、令牌）。变更事件 schema 必须同时校对 Domain、Zod 和 SQL allowlist。冲突不能假装任务已经 completed，且不得擅自添加未批准的新状态机边。

**可替换组件**：领域与应用服务依赖 `BlobStore`、`WorkspaceStore`、`CheckpointStore`、`RunResultCommitter` 能力契约，不依赖 `pg.Pool`、具体文件夹或云供应商。PostgreSQL + 受控本地文件系统仅为此阶段 Adapter。保留真实数据库原子性，不把多个独立存储 API 的先后调用包装成“事务”。

## 3. 推荐分阶段实现（每阶段都能独立验证）

1. **模型与迁移**：先核实 `0001`～`0004`；只新增前向 `0005_*.sql`（如确需多步，递增编号）。设计 tenant-safe Artifact/Blob/Checkpoint/WorkspaceVersion/Conflict 元数据、唯一业务键、外键、状态与引用约束。不能编辑已合并 Migration。
2. **Blob Store 与 Artifact 应用服务**：安全本地路径、写入临时文件/验证/原子安装、拒绝符号链接逃逸、隔离 staging、按 Tenant 获取/校验、孤儿 GC 的可测试模拟。正式 Artifact 独立于最新 Workspace 版本，不因没有出现在最新 Manifest 就被删除。
3. **Workspace Manifest/CAS/历史/冲突**：真实独立 PG 连接并发；两写者一个 CAS 成功、另一个稳定冲突；有共同基线的完全独立修改允许确定性合并并再次 CAS；跨 Tenant 引用、相同路径并发修改、二进制/删除冲突保全候选。
4. **Checkpoint Store**：可信 Run Grant、Step 幂等键、schema/版本兼容检验、旧 Run Fencing、跨 Tenant 负例；先实现确定性逻辑恢复，后续再接执行器。
5. **RunResultCommitter**：真实 PG 事务 + Row Locks + DB 后锁时间，整笔提交与事务失败回滚；覆盖已过期 lease、cancel、deadline、旧 epoch、重复操作 ID、Event 失败、CAS 失败、ACK 丢失。
6. **P0B-05 执行器接线**：在不开放真实 Shell 的前提下，增加受限模拟文件/Artifact/Checkpoint 路径，或者以现有确定性 `mock.chat`/`mock.compute` 实现等效闭环；清楚记录支持的 task kinds 和不支持的路径，未支持者不 Claim。注入逻辑 crash 后新 Run 从已提交 CP 继续，不复用旧 Run 写权。

## 4. 强制验收场景（真实 PostgreSQL + 临时文件目录）

- **B-T12 Workspace CAS**：并发单赢家、版本单调、历史可读、已知共同基线的安全不交叉合并、同一路径冲突持久保全；无 last-write-wins。
- **B-T13 Artifact 完整性**：Hash/size/type 验证、下载按 Tenant 授权、无权与不存在 ID 安全失败、修改/损坏 Blob 检测、恶意路径/符号链接穿越拒绝。
- **B-T14 Orphan staging**：Blob 写成功 DB 失败 → 不可见；重启后可识别，GC 只能清理已证明无引用的 staging，不能删用户正式 Artifact、历史 Workspace 或 Checkpoint 引用。
- **B-T17 Checkpoint Crash/Resume**：已提交 Step 不重新执行；未提交 Step 允许重做；旧 Run 不能写新版本/新 CP；新 Run + 新 epoch 读取兼容 CP 后继续。
- **B-T26 原子性注错**：在 Event 插入、CAS、Checkpoint 插入和 DB COMMIT/ACK 窗口各注入失败；检查 Task/Run/Workspace/Checkpoint/Event 的一致快照、幂等重放和持久可见性。
- **其他 P0 高风险**：24 并发相同 Operation ID；跨 Tenant SQL FK 直接负例；有效/过期租约边界和锁等待竞争；重复 Finish 无第二个 Event；取消先提交后结果拒绝；Blob 引用缺失、旧 epoch / 非当前 Run 所有持久结果写入均零副作用。
- 测试必须证明旧有 P0B-01～05 所有 Contract/Lease/Fencing/Retry 行为没有回归；对关键测试可做受控 mutation 验证防止恒真断言。

至少运行并报告（不能运行就列明原因，不得写 PASS）：`pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm test:unit`、`pnpm build`、`pnpm db:migrate` 连续两次、`pnpm test:integration`、构建 ESM consumption smoke、`git diff --check`。所有集成测试使用独立 Schema/测试数据库和受控临时文件目录；清理前验证目标，严禁删除任何开发者目录或现存数据。CI 要真实读取日志和 Head SHA，不可仅凭绿色图标猜测用例数。

## 5. Git、交付与守则

- 只提交与 P0B-06 相关的代码、Migration、测试、文档和必要依赖更新；不推送含 API Key/敏感私人文件的样本。
- 输出 `docs/P0B-06-IMPLEMENTATION.md`、`docs/P0B-06-ACCEPTANCE.md`，包括正式架构映射、数据模型、状态/事务不变量、测试 ID、故障注入结果、已知偏差与未实现风险。
- 创建或更新同一 **Draft PR**，base 为合并 Architecture Baseline 后的最新 `main`；描述明确“本地持久化验证，不是生产云/设备能力”。推送后跑 CI，汇报实际 run URL 与结果；不得强推、修改 main、自行合并 PR、自动发布应用或云服务。
- 保持 iOS/macOS、Mac Coding Harness Discovery/Adapter、ACP、真实云 Sandbox、生产密钥与跨设备自动迁移**明确不在本 PR**。不要为了支持这些需求私自扩展 P0B-06。
- 交付结果格式：分支/Base/HEAD/PR/CI、关键设计决议、变更文件、逐项验收表（命令 + 测试计数）、真实 DB/文件故障证据、未完成/待 CTO Review 问题。

**STOP 条件：**Architecture PR #8 尚未合并；发现与 Accepted ADR 相冲突的新状态边；无法保证 Runner 原子提交与 Workspace CAS；需要生产云/费用/真实账号或访问未授权私人数据；关键数据库/文件权限无法验证。遇到这些条件及时报告并等待 CTO，不可靠放宽安全约束绕过。
