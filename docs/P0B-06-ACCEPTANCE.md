# P0B-06 — 验收记录（本地真实 PostgreSQL + 受控临时文件目录）

- **执行环境：**macOS（darwin 25.6.0, arm64）、Node 23.11.0 运行时、pnpm 12.15.0、PostgreSQL 17.11（本地实例，端口 55433）
- **数据库：**本机临时集群（`initdb` 于 `/tmp/ember-pgdata`，Round 2 复跑使用 `/tmp/ember-pg-test`，同样端口 55433），`ember` 与 `ember_test` 两个库；集成测试只创建/删除自己的 `ember_it_*` schema
- **文件系统：**每个测试用自己的 `mkdtemp('ember-blobs-')` 根目录，测试结束只删除该目录
- **代码 HEAD：**`69236a0`（PR #11 Round 2 修复提交；其后的文档提交只改本目录下的 `.md`）
- **说明：**本次使用本地安装的 PostgreSQL 17 而非 Docker Compose（开发机 Docker daemon 不可用、磁盘余量不足）；测试矩阵与 CI 中 `postgres:17-alpine` 服务等价，均为真实 PostgreSQL

## 1. 逐项验收表

| 场景                              | 覆盖测试                                                                                                             | 断言要点                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-T12 Workspace CAS**           | `tests/integration/workspace-cas.test.ts`（10）<br>`tests/unit/workspace-manifest.test.ts`（11）                     | 并发同版本不丢更新；版本单调 + 不可变历史（parent/digest）；共同基线的非交叉变更确定性合并；同路径冲突双方候选保留且不重复记录；删除/改名视为破坏性 → 冲突；跨租户引用 `POLICY_DENIED`；非法路径在写入前 `INVALID_ARGUMENT`                                                                                       |
| **B-T13 Artifact 完整性**         | `tests/integration/artifact-integrity.test.ts`（14，含 B-T14 的 4 例）<br>`tests/unit/local-blob-store.test.ts`（8） | SHA-256/大小/媒体类型校验；同租户读回；跨租户与不存在 ID 均为 `NOT_FOUND`；被篡改字节 `get()` 拒绝且 `verify()` 为 false；`../`、绝对路径、跨命名空间 key 拒绝；符号链接逃逸 `POLICY_DENIED`；流式写入超限中止                                                                                                    |
| **B-T14 Orphan staging**          | `tests/integration/artifact-integrity.test.ts`（14 中的 4 例）                                                       | 字节写入成功 + DB 失败 → 无 artifact 行、不可读；隔离期内不删除；隔离期后仅删无引用 staging；dry-run 只报告；已发布 artifact 的字节永不被 GC；无 `blobs` 行的安装文件可回收                                                                                                                                       |
| **B-T17 Checkpoint Crash/Resume** | `tests/integration/checkpoint-resume.test.ts`（7）<br>`tests/integration/durable-worker.test.ts`（4）                | 已提交 Step 崩溃后仍可读且不重复执行；旧 Run 提交 `STALE_LEASE` 零写入；新 Run/epoch 读 CP 继续并完成；`(stepId, inputDigest)` 幂等复用同一 checkpoint；显式 `stepSequence` 与已提交位置不符 → `IDEMPOTENCY_CONFLICT`；schema/executor 不兼容 → 拒绝恢复；混合「其它步骤可读 + 本步骤不可读」仍拒绝；跨租户不可见 |
| **B-T26 原子性注错**              | `tests/integration/result-commit.test.ts`（19）                                                                      | Event 插入 / Checkpoint 插入 / COMMIT 窗口注错 → Task 仍 `running`、无 artifact、无 workspace 版本、无 CP、无 receipt、Event 计数不变；COMMIT 后丢 ACK → 任务已终态且重放返回原 Receipt                                                                                                                           |
| 24 并发相同 Operation ID          | `result-commit.test.ts`                                                                                              | 24 次并发提交只有 1 次 `replayed=false`，共用同一 `committedAt` 与 `artifactId`，DB 中 1 条 artifact、1 条 receipt、1 个 `completed` 事件                                                                                                                                                                         |
| 锁等待后租约过期                  | `result-commit.test.ts`                                                                                              | 另一连接持有 Task 行锁期间租约到期 → 提交被 `STALE_LEASE` 拒绝（锁后 `clock_timestamp()`）                                                                                                                                                                                                                        |
| 取消优先 / Deadline               | `result-commit.test.ts`                                                                                              | 已请求取消 → `CANCELLED` 零写入；Deadline 已过 → `DEADLINE_EXCEEDED` 零写入                                                                                                                                                                                                                                       |
| CAS 失败整体回滚                  | `result-commit.test.ts`                                                                                              | `WORKSPACE_VERSION_CONFLICT` + Task 仍 `running` + 无 artifact，冲突候选单独持久化                                                                                                                                                                                                                                |
| 重复 Finish 无第二事件            | 既有 P0B-04 套件（未改动断言）                                                                                       | `lease-*-.test.ts` 全部通过；终态收敛共用同一函数                                                                                                                                                                                                                                                                 |
| P0B-01～05 回归                   | 既有 13 个集成文件 + 18 个单元文件                                                                                   | 全部通过（见下）                                                                                                                                                                                                                                                                                                  |

## 2. 命令与结果（全部实际执行）

| 命令                             | 结果                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 通过：`Lockfile is up to date`（7 个 workspace 项目）                                                                |
| `pnpm lint`                      | 通过：0 problems                                                                                                     |
| `pnpm format:check`              | 通过：`All matched files use Prettier code style!`                                                                   |
| `pnpm typecheck`                 | 通过：无输出（strict + noUncheckedIndexedAccess）                                                                    |
| `pnpm test:unit`                 | **20 files / 373 tests passed**                                                                                      |
| `pnpm build`                     | 通过（`tsc -b tsconfig.build.json`，含 6 个 project reference）                                                      |
| `pnpm db:migrate`（第 1 次）     | `5 applied, 0 already applied`（0001–0005）                                                                          |
| `pnpm db:migrate`（第 2 次）     | `0 applied, 5 already applied`（幂等）                                                                               |
| `pnpm test:integration`          | **14 files / 151 tests passed**（真实 PG 17 + 临时 blob 根目录）                                                     |
| ESM consumption smoke            | `import('./packages/postgres/dist/index.js')` → 64 exports，`PostgresRunResultCommitter` 为函数；`domain` 32 exports |
| `git diff --check`               | 通过（无空白错误）                                                                                                   |

> Round 2 / Round 3 复跑说明：本机 `pnpm` 的 corepack 缓存丢失（`Cannot find module .../bin/pnpm.cjs`），因此本地复跑直接调用
> 脚本等价的本地二进制（`./node_modules/.bin/vitest run --config vitest.unit.config.ts` 等）。上表脚本本体未变，
> CI 侧仍用 `pnpm`。Round 3 的本地集成测试跑在 Homebrew PostgreSQL 17（`127.0.0.1:5432`，本机 Docker daemon
> 当时无响应），CI 侧仍跑 `postgres:17-alpine` 容器；两侧都是真实 PostgreSQL 17，用例完全相同。

### CI 证据（GitHub Actions `CI`，Node 24 LTS + `postgres:17-alpine`）

| 项目             | 值                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR               | https://github.com/basicv8vc/Ember/pull/11（Draft，base `main`）                                                                                                                                                                            |
| 分支             | `feature/p0b-06-artifact-workspace-checkpoint`                                                                                                                                                                                              |
| 首次通过 run     | https://github.com/basicv8vc/Ember/actions/runs/40812981890（HEAD `6767372`，Round 1）                                                                                                                                                      |
| Round 2 run      | https://github.com/basicv8vc/Ember/actions/runs/40827483054（HEAD `5484a2c`，success）                                                                                                                                                      |
| CI 日志实测      | Unit `20 files / 373 tests passed`；Integration `13 files / 121 tests passed`；`5 applied` → `0 applied, 5 already applied`；`All matched files use Prettier code style!`                                                                   |
| Round 2 日志     | Unit `Test Files 20 passed` / `Tests 373 passed`；Integration `Test Files 14 passed` / `Tests 143 passed`；`5 applied, 0 already applied` → `0 applied, 5 already applied`；`All matched files use Prettier code style!`；`eslint .` 无输出 |
| Round 3 run      | https://github.com/basicv8vc/Ember/actions/runs/40831840106（HEAD `99589c6`，success）                                                                                                                                                      |
| Round 3 日志     | Unit `Test Files 20 passed` / `Tests 373 passed`；Integration `Test Files 14 passed` / `Tests 148 passed`；`5 applied, 0 already applied` → `0 applied, 5 already applied`；`All matched files use Prettier code style!`；`eslint .` 无输出 |
| Round 3 文档提交 | https://github.com/basicv8vc/Ember/actions/runs/40832153371（HEAD `8bad6c1`，success）：`git diff --stat 99589c6..8bad6c1 -- . ':!docs'` 为空，同一日志行全部复现                                                                           |
| Round 3 P2 run   | https://github.com/basicv8vc/Ember/actions/runs/40837789751（HEAD `30dca02`，success）：合并锁范围修复 + 守卫矩阵文档                                                                                                                       |
| Round 3 P2 日志  | Unit `Test Files 20 passed` / `Tests 373 passed`；Integration `Test Files 14 passed` / `Tests 151 passed`；`5 applied, 0 already applied` → `0 applied, 5 already applied`；`All matched files use Prettier code style!`；`eslint .` 无输出 |
| Round 3 P2 注记  | 同一提交序列的首轮 run `40837711568`（HEAD `f00181b`）被同组更高优先级请求取消（`ci-refs/pull/11/merge`），因此以 `30dca02` 的 run 为准                                                                                                     |

Round 1 / Round 2 / Round 3 的 CI 结论都来自实际读取的 job 日志，而不是绿色图标推断。Round 3 run 也证明 `0005` 在全新
数据库上从零应用成功（`0005_p0b06_artifacts_workspace_checkpoint.sql in 58ms`），因此迁移文件的改动不依赖
本地残留状态。

### 新增测试分布

| 文件                                           | 用例数 | 类型                        |
| ---------------------------------------------- | ------ | --------------------------- |
| `tests/unit/workspace-manifest.test.ts`        | 11     | 纯规则（无 DB/FS）          |
| `tests/unit/local-blob-store.test.ts`          | 8      | 真实临时目录，无 DB         |
| `tests/integration/workspace-cas.test.ts`      | 10     | 真实 PG                     |
| `tests/integration/artifact-integrity.test.ts` | 18     | 真实 PG + 真实文件          |
| `tests/integration/checkpoint-resume.test.ts`  | 7      | 真实 PG + 真实 lease/reaper |
| `tests/integration/result-commit.test.ts`      | 23     | 真实 PG + 事务注错          |
| `tests/integration/durable-worker.test.ts`     | 4      | 端到端闭环                  |
| `tests/integration/duplicate-upload.test.ts`   | 5      | 真实 PG + 真实文件          |
| 合计新增                                       | **86** |                             |

## 3. 故障注入的真实证据

| 注入点                         | 可观察结果                                                                                           | 证据来源                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `before_event`                 | 事务回滚；Task `running`，artifact/workspace/CP/receipt 计数为 0，事件仍为 `accepted/leased/started` | `result-commit.test.ts`                               |
| `before_checkpoint_insert`     | 同上                                                                                                 | 同上                                                  |
| `before_commit`（COMMIT 窗口） | 同上                                                                                                 | 同上                                                  |
| `after_commit`（ACK 丢失）     | 事务已提交：Task `completed`、恰 1 个 `completed` 事件；重放返回 `replayed: true` 且无新行           | 同上                                                  |
| 字节写入成功、DB 元数据失败    | staging 文件存在但 `staged_blobs` 计数为 0，Artifact API 不可见；隔离期后 GC 删除                    | `artifact-integrity.test.ts`                          |
| 安装成功、发布事务未提交       | 安装文件存在但无 `blobs` 行；隔离期后 GC 删除                                                        | 同上                                                  |
| 已发布字节被篡改               | `get()` → `DB_UNAVAILABLE`；`verify()` → false；字节不被静默修复                                     | 同上                                                  |
| 崩溃（租约过期 + Reaper 收敛） | Task → `retryable_failed`；已提交 CP 保留；新 Run 拿到更大 epoch                                     | `checkpoint-resume.test.ts`、`durable-worker.test.ts` |

## 4. 未完成 / 待 CTO Review 的问题

1. **用户侧删除与保留策略**：`ArtifactStore.delete()` 只删除可见性元数据；是否需要「用户保留」标记、历史版本保留期与物理回收的完整策略，需要产品决策。
2. **冲突裁决接口**：目前只有只读查询（`workspaces.conflicts()`）。裁决写入（选择一方/手动合并）会引入新的状态语义，需 ADR 级评审后再实现。
3. **自动合并的重命名识别**：当前把「删除 + 新增」一律视为破坏性冲突，宁可误报也不误合并。若 Cline/CTO 认为需要 rename detection，需要先定义确定性算法。
4. **`mock.file` 的 Claim 范围**：`DURABLE_TASK_KINDS` 比 P0B-05 的 `EXECUTABLE_TASK_KINDS` 多了 `mock.file`，仅在配置了 `EMBER_WORKER_BLOB_ROOT` 时生效；生产入口仍要求 `EMBER_WORKER_SIMULATED_EXECUTION=local-only` 且拒绝 `EMBER_ENV=production`。
5. **大文件**：写入侧支持流式与上限，读取侧仍返回有界 `Uint8Array`（沿用既有 `ArtifactStore.get` 契约）。真正的大对象下载需要新的流式 Port，属于后续阶段。
6. **本机执行环境偏差**：本次验收使用本地 PostgreSQL 17.11（非 Docker Compose）与 Node 23.11.0（仓库 `engines` 声明 Node 24）。`pnpm install --frozen-lockfile`、lint、typecheck、build、unit、integration 在本机均通过；CI 仍按 `.nvmrc`（Node 24）与 `postgres:17-alpine` 执行，结论以 CI run 为准。

## 5. 复现步骤

```bash
# 数据库（任选其一）
pnpm dev:db                     # Docker Compose（CI/常规开发）

# 迁移
pnpm db:migrate && pnpm db:migrate

# 单元 + 集成
pnpm test:unit
TEST_DATABASE_URL=postgres://ember:...@127.0.0.1:55432/ember_test pnpm test:integration
```

集成测试不会读取或删除任何开发者目录：schema 名称受正则保护，blob 根目录由 `mkdtemp` 创建并在结束时校验位于系统临时目录内才删除。

## 6. Round 1 Review 修复对照（Round 2 证据）

| 编号 | Round 1 发现                                                                                  | 修复（代码位置）                                                                                                                                                                                                                                                                                                                                                                                                                                          | 回归测试（本地真实 PG 17）                                                                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | 同一租户重复上传相同字节触发唯一约束 → 接口 500                                               | `staged_blobs` 不再对 `(tenant_id, storage_key)` 唯一，改为普通索引；每次上传保留独立 attempt 身份（`migrations/0005_p0b06_artifacts_workspace_checkpoint.sql:42-72`），物理 staging 文件仍内容寻址并共享                                                                                                                                                                                                                                                 | `duplicate-upload.test.ts`（5）：3 次顺序上传 / 8 次并发上传 / 同一内容键每次 attempt 独立 staging 身份 / 跨 Task 发布同字节 / 跨租户隔离                                                                                                                        |
| P1-2 | 混合 checkpoint 中「本 build 读不出的已提交 `produce` 步骤」被当作未完成 → 可能重复执行副作用 | `apps/worker/src/durable-run-handler.ts:271-294`：只要存在不可读的 `produce` checkpoint 立即 `POLICY_DENIED`，不再仅凭 `compatible.length === 0` 判断                                                                                                                                                                                                                                                                                                     | `durable-worker.test.ts`：`stops the Run when the committed step is unreadable but another step is not`（另两条 incompatible 用例覆盖单步不可读 / 输入不一致）                                                                                                   |
| P1-3 | `RunGrant` 未绑定 agent 与 worker                                                             | `packages/postgres/src/storage/result-committer.ts:1000-1010`：锁内校验 `task.agent_id === grant.agentId` 且 `run.worker_id === grant.workerId`                                                                                                                                                                                                                                                                                                           | `result-commit.test.ts > P0B06 grant binding (P1-3)`（3）：同租户另一 agent 的 grant、非持有 worker 的 grant 均零写入；从持久 Run 派生的 grant 通过                                                                                                              |
| P1-4 | 发布事务与 GC 收集器竞态：字节被回收后仍可能写入引用                                          | ① 新 Port 方法 `assertInstalled(tenantId, sha256, size)`（存在 + 普通文件 + 大小，不重算哈希）：`blob-store.ts:163`、`local-blob-store.ts:447`；② `result-committer.ts:562-578` 先取 `(tenant, sha256)` advisory lock（`lockBlobDigests`，`blob-store.ts:348`），再由 `assertInstalledBytes`（`:798-820`）复核，缺失 → `DB_UNAVAILABLE` 且零写入；③ 收集器在锁内复查引用后才删除（`collectStagingKey` `blob-store.ts:277`、`collectInstalledKey` `:315`） | `artifact-integrity.test.ts`：`retains bytes published while the collector is deciding`、`still collects an unreferenced file once no publisher holds the lock`；`result-commit.test.ts`：`writes nothing when the installed bytes are gone at publication time` |
| P1-5 | `(stepId, inputDigest)` 复用未比较步骤在历史中的位置                                          | `packages/contracts/src/persistence.ts` 新增可选 `stepSequence`（缺省 = 由事务分配、不做位置断言；显式 = 断言位置）；`result-committer.ts:906-915, 1061+` 的 `sameCheckpointSemantics` 比较该字段，不符 → `IDEMPOTENCY_CONFLICT`                                                                                                                                                                                                                          | `checkpoint-resume.test.ts`：`refuses to reuse a step identity at a different position in the history`                                                                                                                                                           |
| P2-1 | 幂等摘要未覆盖 checkpoint 依赖，不同命令可能被判为重放                                        | `result-committer.ts:356-383`：`requestDigest` 纳入 `stepId / stepSequence / inputDigest / executorVersion / cursor / workspaceVersion / artifacts / externalEffects`                                                                                                                                                                                                                                                                                     | `result-commit.test.ts`：`treats a different checkpoint dependency as a conflicting command`                                                                                                                                                                     |
| P2-2 | 删除仍被引用的 Artifact 会留下悬空引用                                                        | `artifact-store.ts:219-256`：删除前在同一事务内统计 workspace version / checkpoint / conflict 引用，有引用 → `POLICY_DENIED`                                                                                                                                                                                                                                                                                                                              | `artifact-integrity.test.ts`：`refuses to delete an artifact a workspace version still references`；`checkpoint-resume.test.ts`：`refuses to delete an artifact a committed checkpoint still references`                                                         |
| P2-3 | 候选写入失败却仍向调用方报告 `WORKSPACE_VERSION_CONFLICT`                                     | `result-committer.ts:670-690`：冲突候选由独立幂等事务持久化，持久化失败时上抛真实错误而不是伪装成冲突                                                                                                                                                                                                                                                                                                                                                     | `result-commit.test.ts > P0B06 P2-3 conflict candidate persistence in the committer`                                                                                                                                                                             |

**守卫的有效性验证（不是「测试是绿的」就算）：**

- P1-2、P1-4 的新增守卫都用临时禁用（就地 `perl` 改动 + 备份）验证过：禁用后对应用例**失败**，恢复后重新通过，
  说明用例确实约束该行为，而不是无论代码如何都通过。
- `stepSequence` 的语义是刻意选择：**省略 = 不声明位置**（序号由事务分配），**显式 = 断言位置**。既有调用方
  （不关心序号）无需变更，需要跨 Run 复用的调用方可以显式锁定位置。

**并发一致性结论：** 发布与 GC 使用同一把 `(tenant, sha256)` advisory lock，且收集器在锁内重新读取引用，
因此两者不可能交错：要么发布先提交（收集器随后必然看到引用而保留字节），要么收集器先删除（发布发现字节缺失，
零写入退出，由重试的 Step 重新产生内容）。隔离窗口只删除「无行 + 超过隔离期」的文件，已发布 Artifact 的字节
不会被回收。

## 7. Round 2 Review 修复对照（Round 3 证据）

Round 2 复审提出两个新的并发缺陷，都源于「同一个判定与写入之间存在窗口」。修复方式是让两条路径在同一批数据库行上
相遇，而不是靠时间窗猜测。

| 编号 | Round 2 发现                                                                                                        | 修复（代码位置）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 回归测试（本地真实 PG 17）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-A | `ArtifactStore.put()` 在 `install()` 与摘要 advisory lock 之间没有锁内字节复核，GC 可在此窗口删除文件               | `packages/postgres/src/storage/artifact-store.ts`：`put()` 取得 `lockBlobDigests` 后立刻 `blobs.assertInstalled(tenant, sha256, size)`，缺失 → `DB_UNAVAILABLE`（`installed bytes disappeared before publication`）且**零写入**（事务回滚，无 `blobs`/`artifacts` 行）                                                                                                                                                                                                                                                                                               | `artifact-integrity.test.ts > P1-A`（3）：① 真实 `sweepOrphans` 在阻塞器持锁期间排在上传之前，放开后先删文件，上传零写入退出；② 安装后文件立即消失（确定性形态）同样零写入；③ 反序调度（上传先到 lock、收集器后到）仍合法通过：上传先提交、收集器放弃删除（`removedBlobs = 0`） 。测试侧：阻断屏障在超时或异常时取消仍在等待的语句并归还连接，由 `advisory-lock-barrier.test.ts > P0B06-T1 lock fixture cleanup`（2）守护（撤掉该路径时该用例与 `db.close()` 都会报出「连接仍被占用」，而不是把整轮跑挂到超时） |
| P1-B | `ArtifactStore.delete()` 用普通 `SELECT` 判定 JSONB 引用，写方可在判定与 `DELETE` 之间写入新引用 → 悬挂 Artifact id | 新增 `packages/postgres/src/storage/artifact-references.ts`：引用写方在事务内对每个被引用 Artifact 行取 `FOR SHARE`（`lockArtifactRows` 去重升序）；`delete()` 先 `FOR UPDATE` 再判定。三条持久引用路径全部接入：`commitWorkspaceInTransaction`（`lockArtifactReferences`）、`writeCheckpoint`（`lockCheckpointArtifacts`）、`recordWorkspaceConflictIn`（`lockConflictCandidateArtifacts`）。`RunResultCommitter.lockReferences` 在写引用前一次性锁住预锁集合（范围见 §8：Round 3 复审后已从「workspace 清单 ∪ checkpoint」扩大到「当前版本 ∪ 清单 ∪ checkpoint」） | `artifact-integrity.test.ts > P1-B`（2）：未提交的 Workspace version / 未提交的 conflict candidate 都会让 `delete()` 先等待、提交后被 `POLICY_DENIED` 拒绝且 Artifact 仍可读；`result-commit.test.ts > P1-B`（1）：`before_event` 处事务未提交时 `delete()` 不得落地，提交后被拒绝                                                                                                                                                                                                                              |

**守卫的有效性验证（逐个临时禁用 → 对应用例失败 → 恢复后通过）：**

| 守卫                                                                                 | 禁用后的可观察结果                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `put()` 的锁内 `assertInstalled`                                                     | 两条 P1-A 用例都从 `rejects` 变成 `promise resolved`（上传成功写下指向已删除字节的行）    |
| `commitWorkspaceInTransaction` 的 `lockArtifactReferences`                           | P1-B 的 Workspace version 用例失败（`delete()` 不再等待，version 提交后 Artifact 已消失） |
| `recordWorkspaceConflictIn` 的 `lockConflictCandidateArtifacts`                      | P1-B 的 conflict candidate 用例失败（同上方向）                                           |
| `writeCheckpoint` 的 `lockCheckpointArtifacts` + `lockReferences` 的 checkpoint 分支 | P1-B 的 checkpoint 用例失败（`expected true to be false`：`delete()` 没有被阻塞）         |

**死锁风险评估（新增锁的实际顺序）：**

```text
Task → Run → blob 摘要 advisory lock（升序）→ workspace 行（FOR UPDATE/FOR SHARE）
     → Artifact 行 FOR SHARE（去重升序）→ 引用行（workspace_versions / step_checkpoints / workspace_conflicts）
```

- 所有多行获取都经过 `lockArtifactRows`，因此 Artifact 行的获取顺序在任意两个事务之间一致；
  `delete()` 只锁**单行**且锁内不做任何阻塞式等待（引用判定是普通快照读），因此不存在「删除方等写方、写方等删除方」的环。
- `RunResultCommitter` 先用 `lockWorkspaceRow` 拿 workspace 行锁，再锁并集，保证与 `commitWorkspaceInTransaction`
  和 `recordWorkspaceConflictIn`（都是 workspace 行 → Artifact 行）顺序一致；否则「workspace 提交持 X 求 Y」与
  「checkpoint-only 提交持 Y 求 X」会成环。
- `recordWorkspaceConflictIn` 显式先取 workspace 行 `FOR SHARE`：冲突表插入本身会通过外键取父行 `FOR KEY SHARE`，
  先取锁即可把这次隐式获取纳入同一顺序。
- 合并路径可能引用「另一方刚写入的 Artifact」：这些额外行现在**就在预锁通道内**（`lockWorkspaceArtifactScope`
  把当前版本清单并入预锁集合），细节与守卫见 §8；合并期间 workspace 行已被持有，没有事务能在持有这些行时反过来
  等待该 workspace 行。

**已知限制（刻意保留）：** conflict candidate 路径只加锁、**不要求 Artifact 行存在**。失败方（fenced commit）的候选
经常引用「自身已回滚事务从未发布」的 Artifact id；这类 id 没有任何行，也不可能有可被删除的对象，若强行要求存在会把
`WORKSPACE_VERSION_CONFLICT` 错报成 `POLICY_DENIED`（既有 P2-3 用例正是这种场景）。已存在的引用行仍被
`FOR SHARE` 保护。

## 8. Round 3 Review P2：自动合并把 Artifact 引入最终清单，预锁范围不完整

Round 3 复审指出：`lockReferences()` 预锁的是「请求清单 ∪ checkpoint」，但 `commitWorkspaceInTransaction` 的
自动合并会把**当前 Workspace 版本**里的 Artifact 带进最终清单，这些行由后续 `lockArtifactReferences` 再次加锁。
若它们的 id 小于已持有的 id，全局升序协议就被反转（持高位 id 等低位 id），协议声明与实现不一致。

| 编号 | 发现                                                                                               | 修复（代码位置）                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 回归测试（本地真实 PG 17）                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2   | 预锁只覆盖「请求清单 ∪ checkpoint」，自动合并引入的 Artifact 会在高位 id 之后才加锁 → 升序协议失效 | `workspace-store.ts` 新增 `lockWorkspaceArtifactScope`：先锁 workspace 行，再在同一事务内读取**当前版本**清单，与「请求清单 ∪ checkpoint」合并去重排序后**一次性**下发（合并结果 ⊆ 当前版本 ∪ 候选，所以这是超集）。`commitWorkspaceInTransaction` 新增 `prelockedArtifactIds`，合并后用 `assertInsideReferenceScope` 复核最终清单未越界（越界 → `DB_UNAVAILABLE`，把将来的合并规则改动变成硬失败而不是静默乱序）。`RunResultCommitter.lockReferences` 改用该入口并把锁集传给 CAS | `result-commit.test.ts > P2-A`（3）：① 阻塞器以 `FOR UPDATE` 持有被合并进来的低位 Artifact，提交方必须**先**等它、此时探测高位 Artifact 的 `FOR UPDATE NOWAIT` 仍被授予（修复前该探测失败，见下表）；② 两个 Workspace 共享同一 Artifact 且都做自动合并时，`delete()` 被拒绝、两边都提交到 v2；③ 镜像用例：两个 Workspace 各自引入对方 head 引用的 Artifact，两个合并都保留对方条目 |

**守卫的有效性验证（逐个就地禁用 → 对应用例失败 → 恢复后通过；三种组合都实际跑过）：**

| 禁用范围                                                              | 实测结果                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 只禁用 `lockWorkspaceArtifactScope` 中并入当前版本清单                | `P2-A` 三个用例全部失败，失败原因都是 canary：`DB_UNAVAILABLE: workspace manifest references an artifact outside the locked scope`      |
| 只禁用 `commitWorkspaceInTransaction` 的 `assertInsideReferenceScope` | `P2-A` 三个用例全部通过 —— 预锁集合本身已经覆盖合并结果，canary 只防「合并规则将来变化」                                                |
| 同时禁用上两项                                                        | 只有第 ① 个用例失败：`expected false to be true`（提交方在等低位 Artifact 时已经持有高位 Artifact，乱序被真实观测）；第 ②③ 个用例仍通过 |

**关于「死锁」的准确表述（复审问题的边界）：** 回归测试里能确定性复现的是**加锁顺序反转**，触发反转后必须有一个
**会等待的 `FOR UPDATE` 持锁者**才会真正成环。两个 committer 之间不会死锁：它们对同一批 Artifact 行都取 `FOR SHARE`，
而 `FOR SHARE` 之间互不冲突（`P2-A` 的第 ③ 个镜像用例在禁用守卫时同样通过，正好证明这一点）。因此：

- 现状可达的等待路径是「写方持高位 `FOR SHARE` 等低位行（被 `delete()` 的 `FOR UPDATE` 或任何持锁事务挡住）」——
  这一次序反转会让一个本可继续的写方卡在更高 id 上，并且在 `delete()` 变得更复杂（例如将来把删除并入更大的事务、
  或在持锁后再取第二行）时直接升级为 40P01。
- 修复后所有首次加锁仍在同一升序通道内完成，`delete()` 依旧只锁单行、锁内无阻塞等待，因此环依然不成立；
  `assertInsideReferenceScope` 让「预锁范围不完整」这件事无法再悄悄发生。
