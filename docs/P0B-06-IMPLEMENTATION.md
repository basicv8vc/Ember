# P0B-06 — Artifact Store / Workspace CAS / Checkpoint / Fenced Result Commit

- **状态：**本地 P0B 纵向闭环实现（P0B-06），待 CTO Review
- **基线：**`main` 含 Architecture PR #8/#9 与冻结的 ADR-0003；P0B-01～05 已合并
- **范围：**本地 PostgreSQL 17 + 受控本地文件系统；**不是**生产云存储、真实 Shell/LLM、Mac Harness 或设备分发能力
- **契约来源：**`docs/adr/0003-p0b-06-persistence-contract-freeze.md`（B06-D1～D6）、V1 Baseline §12.1

## 1. 架构映射

| ADR 契约                               | 实现位置                                                                                                                         | 说明                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| D1 Blob/Staging/Artifact 生命周期      | `packages/postgres/src/storage/local-blob-store.ts`、`blob-store.ts`、`artifact-store.ts`、`migrations/0005_*.sql`               | staging → 校验 → 安装（内容寻址）→ 可信事务发布元数据             |
| D2 Workspace Manifest / CAS / 有限合并 | `packages/domain/src/workspace-manifest.ts`、`packages/postgres/src/storage/workspace-store.ts`                                  | 纯规则（路径/合并）+ 真实 PG 条件更新与不可变历史                 |
| D3 Run 权限与原子提交                  | `packages/contracts/src/persistence.ts`（`RunGrant`、`RunResultCommitter`）、`packages/postgres/src/storage/result-committer.ts` | 单事务：行锁 → 锁后时钟 → fencing → 引用/CAS/CP/FSM/Event/Receipt |
| D4 可恢复 Step Checkpoint              | `packages/postgres/src/storage/checkpoint-store.ts`、`result-committer.ts`                                                       | 只读恢复输入；仅已提交行可见；schema/executor 兼容过滤            |
| D5 Provider-neutral Ports              | `packages/contracts/src/persistence.ts`                                                                                          | 领域/应用只依赖 Port；PostgreSQL + 本地目录只是本阶段 Adapter     |
| D6 执行放置边界                        | 未改动                                                                                                                           | 无 Placement 决策、设备注册、Harness 或跨设备搬迁                 |

P0B-05 的执行器通过 `apps/worker/src/durable-run-handler.ts` 接入：`mock.chat` / `mock.compute` / `mock.file`
形成 `Artifact → Checkpoint → (崩溃) → 新 Run/epoch → 恢复 → Workspace 版本 + 终态` 的真实闭环。
`mock.approval` 仍不可 Claim（P0B-08）。

## 2. 数据模型（`0005_p0b06_artifacts_workspace_checkpoint.sql`）

| 表                    | 作用                                       | 关键约束                                                                   |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `blobs`               | 不可变字节对象（tenant 内按 SHA-256 唯一） | `storage_key ~ '^blobs/<uuid>/<sha256>$'`、tenant 复合唯一                 |
| `staged_blobs`        | 私有 staging 记录（**不是** Artifact）     | `state ∈ pending/published/abandoned`，`storage_key` 只允许 `staging/...`  |
| `artifacts`           | 已发布 Artifact 元数据                     | FK → `blobs(tenant_id, sha256)`、FK → `tasks`/`runs`（tenant-safe 复合键） |
| `workspace_versions`  | 不可变版本历史（含 parent）                | 主键 `(tenant, workspace, version)`，`manifest_digest`                     |
| `workspace_conflicts` | 待决冲突候选（非终态）                     | `(tenant, workspace, dedupe_key)` 唯一，双方候选均保留                     |
| `step_checkpoints`    | 已提交逻辑 Step                            | `(tenant, task, step_id, input_digest)` 唯一 + 单调 `step_sequence`        |
| `operation_receipts`  | 幂等收据                                   | `(tenant, task, operation_id)` 唯一，含规范化请求摘要                      |

`0001`～`0004` 未改动；`0005` 为唯一新增前向迁移，已连续两次在真实 PG 17 上验证幂等。

## 3. 关键不变量

1. **字节不可变**：`blobs` 行一旦写入不再变化；安装使用 hard link + `EEXIST` 语义，绝不覆盖已存在的
   内容地址文件；发现已存在但 digest 不符时直接报错（视为损坏，不静默修复）。
2. **可见性由数据库决定**：只有 `artifacts` 行存在时字节才可读；staging 与安装后未提交的文件对用户不可见。
3. **事务原子性**：`RunResultCommitter.commitStep` 在一个 PostgreSQL 事务内完成 artifact 引用、Workspace CAS、
   Checkpoint、Task/Run 收敛、唯一终态 Event 与 `operation_receipts`。任一步失败整笔回滚（见 B-T26）。
4. **锁后权威时钟**：所有租约/取消/Deadline 判定使用 `SELECT clock_timestamp()`（锁获取之后），
   不使用事务开始时的 `now()`；锁等待期间过期的租约必定被拒（B-T26 锁等待用例）。
5. **Fencing**：`RunGrant` 由服务端从持久 Run 派生；提交校验 tenant/task/current_run/attempt/epoch 与租约到期。
   旧 Run/epoch 无任何写入副作用。
6. **幂等**：相同 `operationId` + 规范化摘要 → 只读取回原 Receipt（`replayed: true`），无新版本/新 Event；
   内容不同 → `IDEMPOTENCY_CONFLICT`。24 并发相同 ID 只产生一次写入。
7. **CAS 与有限合并**：只有存在可验证共同基线、双方变更路径完全不交叉、且无删除/改名等破坏性操作时才自动合并；
   其余保留双方候选并返回 `WORKSPACE_VERSION_CONFLICT`，不发生 last-write-wins。
8. **终态不可重写**：所有状态迁移仍经 `transitionTask` / `transitionRun`；`finish()` 与提交器共用
   `planFinishConvergence` / `applyFinishConvergence`，保证每个 Run 恰好一条终态 Event，没有双终态路径。
9. **事件白名单不变**：未新增 `TaskEventPayload` 字段，Domain / Zod / SQL allowlist 三者一致；
   Prompt、文件正文、绝对路径、令牌不会进入事件。
10. **发布与 GC 互斥**：发布事务在写任何元数据前先取 `(tenant, sha256)` 的 advisory lock，并在锁内用
    `assertInstalled` 复核字节仍在位；GC 在删除同一摘要的文件前取同一把锁并重新读取 `blobs`/`artifacts`。
    两者因此不可能交错：要么发布提交（GC 之后必然看到引用而保留），要么字节已消失而发布零写入
    （`DB_UNAVAILABLE`，Step 重做）。隔离窗口只删除「无行 + 超过隔离期」的文件。
    **该复核对两条发布路径都成立**：`RunResultCommitter`（`assertInstalledBytes`）与用户上传
    `ArtifactStore.put`（`artifact-store.ts`，锁内 `assertInstalled`）。用户上传尤其需要：`put` 先
    `stage`+`install` 再开事务，安装完成的文件此时既无 `blobs` 行也无 `artifacts` 行，收集器可以合法地在
    这个窗口里持有同一把锁并删除它。
11. **Artifact 引用行锁协议**：Workspace Version / Step Checkpoint / Conflict Candidate 的 Artifact 引用
    存放在 JSONB manifest 内，没有任何外键替它们加锁。因此写引用的一方必须在**写引用行的事务内**对每个被引用
    Artifact 行取 `FOR SHARE`（`artifact-references.ts` 的 `lockArtifactRows`，id 去重升序）；
    `ArtifactStore.delete` 在评估引用之前对同一行取 `FOR UPDATE`。`FOR SHARE` 与 `FOR UPDATE` 冲突，于是
    只有两种结果：写方先提交 → 删除方看到引用并拒绝（`POLICY_DENIED`）；删除方先提交 → 写方的锁内读取找不到
    行而拒绝，绝不产生悬挂 Artifact id。
    锁顺序固定为 `Task → Run → blob 摘要 advisory lock → workspace 行 → Artifact 行（升序）→ 引用行`；
    多行获取统一走 `lockArtifactRows`，因此不会出现反向顺序。`RunResultCommitter` 在写任何引用前用
    `lockWorkspaceArtifactScope` 一次性锁住**最终清单可能出现的全部 Artifact**：当前 workspace 版本的清单 ∪
    请求清单 ∪ checkpoint 引用（合并结果 ⊆ 当前版本 ∪ 候选，因此这是超集），再按同一升序通道下发。
    只预锁「请求清单 ∪ checkpoint」是不够的：`commitWorkspaceInTransaction` 的自动合并会把当前版本里的
    Artifact 合并进最终清单，那些行会在更高的 id 已被持有之后才被加锁，正好把升序协议反转。
    合并完成后 `commitWorkspaceInTransaction` 再用 `assertInsideReferenceScope` 复核最终清单没有落在预锁集合之外，
    任何一次合并规则的改动都会立刻失败，而不是悄悄退化成乱序加锁（`DB_UNAVAILABLE`）。

## 4. 生命周期与故障次序

```text
stage(bytes)           私有 staging 文件（O_EXCL + fsync + 增量 SHA-256，大小受限）
  │                     DB 记录失败 ⇒ 文件成为孤儿 staging（不可见，GC 才可回收）
install()              重新校验 digest/size → hard link 到 blobs/<tenant>/<sha256>
  │                     DB 失败 ⇒ 安装文件无 blobs 行（不可见，GC 才可回收）
commitStep() 事务       Task 锁 → Run 锁 → clock_timestamp →
  │                     幂等收据复查 → fencing/取消/Deadline →
  │                     blob 摘要 advisory lock → 安装字节在位复核（否则零写入）→
  │                     artifact 行（savepoint 保护唯一冲突）→
  │                     workspace 行锁 + Artifact 行 FOR SHARE（当前版本 ∪ 清单 ∪ checkpoint，升序）→
  │                     Workspace CAS（自动合并后复核清单未越出预锁集合）→ Checkpoint（锁内复核同一批引用）→
  │                     progress 或终态 Event → Receipt → COMMIT
  └── COMMIT 后失败     模拟 ACK 丢失：重放只读返回原 Receipt

ArtifactStore.put()    stage → install → 事务：摘要 advisory lock → 锁内 assertInstalled
  │                     （缺失 ⇒ DB_UNAVAILABLE 且零写入）→ blobs 行 → artifacts 行 → COMMIT
ArtifactStore.delete() 事务：artifacts 行 FOR UPDATE → 引用判定 → DELETE
  └── 与引用写方互斥      写方持 FOR SHARE 至提交，因此判定结果不会在窗口内失效
```

`progress` 提交不会终结 Run（不调用 `finish()`），`result` 提交同时收敛 Task/Run 并写唯一终态 Event。
`LeaseQueue.finish()` 的回归语义保持不变：同一个 `applyFinishConvergence` 负责状态、Run 与 Event。

## 5. 安全边界

- 路径：manifest 只接受规范 POSIX 相对路径；拒绝绝对路径、`..`、空段、反斜杠、盘符、控制字符、
  非 NFC 以及大小写/宽度折叠冲突。
- 文件系统：根目录 0700；`storage_key` 由 UUID + digest 派生；每次访问都做词法包含检查 + 父目录
  `realpath` 复核 + `lstat` 符号链接拒绝。
- 租户隔离：所有查询以 `AuthContext.tenantId` 或服务端 `RunGrant.tenantId` 为前缀；子表使用复合外键，
  直接 SQL 也无法跨租户挂接。不存在与无权对象对外表现一致（`NOT_FOUND`）。
- Worker 不构造 `AuthContext`：`RunGrant` 不含 principal，只有 tenant/task/run/agent/attempt/epoch。

## 6. 已知偏差与未实现项

| 项目                             | 现状                                                            | 原因                                                                       |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 用户删除/保留策略 API            | 仅 `ArtifactStore.delete` 改变可见性；物理保留策略未提供 UI/API | ADR 将用户删除与 GC 策略分离；P0B-06 只实现 staging 与无引用安装文件的回收 |
| 冲突裁决 API/UI                  | 未实现，只有 `workspaces.conflicts()` 只读查询                  | ADR-0003 明确延后                                                          |
| Workspace 自动合并的重命名识别   | 视为破坏性变更 → 冲突                                           | 保守优先，避免误合并                                                       |
| Checkpoint 的跨进程 harness 会话 | 明确不实现                                                      | D4/D6：harness 私有状态不是可移植恢复事实                                  |
| `mock.approval`                  | 仍不可 Claim                                                    | P0B-08                                                                     |
| 真实云/对象存储 Adapter          | 未实现                                                          | P0B-06 明确不采购云服务；Port 已就绪                                       |
| 大文件流式下载                   | `get()` 返回有界 `Uint8Array`（上限 32 MiB）                    | 与现有 `ArtifactStore.get` 契约保持一致；写入侧已支持流式                  |
| 已安装但无 `blobs` 行的文件      | 仅在隔离期后由 GC 回收                                          | 与「正式保留数据」策略分开，避免误删                                       |

## 7. 变更文件（高层）

```text
migrations/0005_p0b06_artifacts_workspace_checkpoint.sql        新增
packages/domain/src/workspace-manifest.ts                       新增（纯规则）
packages/contracts/src/persistence.ts                           新增（Ports/Types）
packages/contracts/src/interfaces.ts                            WorkspaceStore 扩展
packages/postgres/src/storage/*.ts                              新增 6 个 Adapter/服务
packages/postgres/src/storage/artifact-references.ts            新增（引用行锁协议）
packages/postgres/src/lease-queue/task-convergence.ts           新增（finish 共用逻辑）
packages/postgres/src/lease-queue/postgres-lease-queue.ts       改为复用共用收敛逻辑
apps/worker/src/durable-run-handler.ts                          新增
apps/worker/src/{run-handler,poll-loop,config,index}.ts         handler 结果类型 / 接线
tests/unit/{workspace-manifest,local-blob-store}.test.ts        新增
tests/integration/{workspace-cas,artifact-integrity,checkpoint-resume,
                   result-commit,durable-worker,duplicate-upload}.test.ts  新增
tests/integration/support/p0b06.ts                              新增测试夹具
docs/P0B-06-IMPLEMENTATION.md, docs/P0B-06-ACCEPTANCE.md        新增
```

## 8. 演示：如何本地复现

```bash
# 1. 真实 PostgreSQL（本地 Docker Compose 或任意本地实例）
pnpm dev:db
pnpm db:migrate

# 2. 启动持久化 worker（受控临时目录作为 blob root）
EMBER_WORKER_MODE=poll \
EMBER_WORKER_SIMULATED_EXECUTION=local-only \
EMBER_WORKER_BLOB_ROOT=/tmp/ember-blobs \
pnpm dev:worker

# 3. 提交一个 mock.chat Task（通过 API 或测试夹具），观察事件与 artifact/checkpoint 行
```
