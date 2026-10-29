# P0B-06 — 验收记录（本地真实 PostgreSQL + 受控临时文件目录）

- **执行环境：**macOS（darwin 25.6.0, arm64）、Node 23.11.0 运行时、pnpm 12.15.0、PostgreSQL 17.11（本地实例，端口 55433）
- **数据库：**本机临时集群（`initdb` 于 `/tmp/ember-pgdata`），`ember` 与 `ember_test` 两个库；集成测试只创建/删除自己的 `ember_it_*` schema
- **文件系统：**每个测试用自己的 `mkdtemp('ember-blobs-')` 根目录，测试结束只删除该目录
- **HEAD：**见 PR 描述（提交后补 URL 与 SHA）
- **说明：**本次使用本地安装的 PostgreSQL 17 而非 Docker Compose（开发机 Docker daemon 不可用、磁盘余量不足）；测试矩阵与 CI 中 `postgres:17-alpine` 服务等价，均为真实 PostgreSQL

## 1. 逐项验收表

| 场景                              | 覆盖测试                                                                                              | 断言要点                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-T12 Workspace CAS**           | `tests/integration/workspace-cas.test.ts`（9）<br>`tests/unit/workspace-manifest.test.ts`（11）       | 并发同版本不丢更新；版本单调 + 不可变历史（parent/digest）；共同基线的非交叉变更确定性合并；同路径冲突双方候选保留且不重复记录；删除/改名视为破坏性 → 冲突；跨租户引用 `POLICY_DENIED`；非法路径在写入前 `INVALID_ARGUMENT` |
| **B-T13 Artifact 完整性**         | `tests/integration/artifact-integrity.test.ts`（6 + 4）<br>`tests/unit/local-blob-store.test.ts`（8） | SHA-256/大小/媒体类型校验；同租户读回；跨租户与不存在 ID 均为 `NOT_FOUND`；被篡改字节 `get()` 拒绝且 `verify()` 为 false；`../`、绝对路径、跨命名空间 key 拒绝；符号链接逃逸 `POLICY_DENIED`；流式写入超限中止              |
| **B-T14 Orphan staging**          | `tests/integration/artifact-integrity.test.ts`（4）                                                   | 字节写入成功 + DB 失败 → 无 artifact 行、不可读；隔离期内不删除；隔离期后仅删无引用 staging；dry-run 只报告；已发布 artifact 的字节永不被 GC；无 `blobs` 行的安装文件可回收                                                 |
| **B-T17 Checkpoint Crash/Resume** | `tests/integration/checkpoint-resume.test.ts`（4）<br>`tests/integration/durable-worker.test.ts`（1） | 已提交 Step 崩溃后仍可读且不重复执行；旧 Run 提交 `STALE_LEASE` 零写入；新 Run/epoch 读 CP 继续并完成；`(stepId, inputDigest)` 幂等复用同一 checkpoint；schema/executor 不兼容 → `null`；跨租户不可见                       |
| **B-T26 原子性注错**              | `tests/integration/result-commit.test.ts`（7）                                                        | Event 插入 / Checkpoint 插入 / COMMIT 窗口注错 → Task 仍 `running`、无 artifact、无 workspace 版本、无 CP、无 receipt、Event 计数不变；COMMIT 后丢 ACK → 任务已终态且重放返回原 Receipt                                     |
| 24 并发相同 Operation ID          | `result-commit.test.ts`                                                                               | 24 次并发提交只有 1 次 `replayed=false`，共用同一 `committedAt` 与 `artifactId`，DB 中 1 条 artifact、1 条 receipt、1 个 `completed` 事件                                                                                   |
| 锁等待后租约过期                  | `result-commit.test.ts`                                                                               | 另一连接持有 Task 行锁期间租约到期 → 提交被 `STALE_LEASE` 拒绝（锁后 `clock_timestamp()`）                                                                                                                                  |
| 取消优先 / Deadline               | `result-commit.test.ts`                                                                               | 已请求取消 → `CANCELLED` 零写入；Deadline 已过 → `DEADLINE_EXCEEDED` 零写入                                                                                                                                                 |
| CAS 失败整体回滚                  | `result-commit.test.ts`                                                                               | `WORKSPACE_VERSION_CONFLICT` + Task 仍 `running` + 无 artifact，冲突候选单独持久化                                                                                                                                          |
| 重复 Finish 无第二事件            | 既有 P0B-04 套件（未改动断言）                                                                        | `lease-*-.test.ts` 全部通过；终态收敛共用同一函数                                                                                                                                                                           |
| P0B-01～05 回归                   | 既有 13 个集成文件 + 18 个单元文件                                                                    | 全部通过（见下）                                                                                                                                                                                                            |

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
| `pnpm test:integration`          | **13 files / 121 tests passed**（真实 PG 17 + 临时 blob 根目录）                                                     |
| ESM consumption smoke            | `import('./packages/postgres/dist/index.js')` → 54 exports，`PostgresRunResultCommitter` 为函数；`domain` 32 exports |
| `git diff --check`               | 通过（无空白错误）                                                                                                   |

### 新增测试分布

| 文件                                           | 用例数 | 类型                        |
| ---------------------------------------------- | ------ | --------------------------- |
| `tests/unit/workspace-manifest.test.ts`        | 11     | 纯规则（无 DB/FS）          |
| `tests/unit/local-blob-store.test.ts`          | 8      | 真实临时目录，无 DB         |
| `tests/integration/workspace-cas.test.ts`      | 9      | 真实 PG                     |
| `tests/integration/artifact-integrity.test.ts` | 10     | 真实 PG + 真实文件          |
| `tests/integration/checkpoint-resume.test.ts`  | 4      | 真实 PG + 真实 lease/reaper |
| `tests/integration/result-commit.test.ts`      | 13     | 真实 PG + 事务注错          |
| `tests/integration/durable-worker.test.ts`     | 1      | 端到端闭环                  |
| 合计新增                                       | **56** |                             |

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
