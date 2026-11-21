# Ember Neon 退役就绪审计与 V1→V2 迁移方案（Neon Decommission Readiness Audit）

- **审计日期**：2026-11-21
- **代码基线**：`origin/main` @ `afb5946`
- **审计性质**：只读核查与退役规划（不升级 Neon 套餐、不新增 PostgreSQL 依赖、未删除数据库或用户数据、未修改任何生产/预发云资源）
- **核心结论**：
  1. **V2 架构零 Neon 运行时依赖**：已部署的 `ember-v2-staging` 及其构建产物中 **0 个 PostgreSQL / Neon / Hyperdrive 运行时依赖**，完全基于 Cloudflare Workers + Durable Objects SQLite + D1 + Queues。
  2. **计划中的 Production 存在 5 项前置代码/配置缺口**：V2 尚未提供 Production Wrangler 配置，[runtime-config.ts](../../apps/api/src/local-v2/runtime-config.ts) 拒绝 `EMBER_ENV=production`；同时 `@ember/api` 仍有编译期 `@ember/postgres` 类型耦合、D1 会话表依赖冷启动建表、缺少 R2 >1 MiB 附件支持，且 [apps/cloud-async-runtime/wrangler.jsonc](../../apps/cloud-async-runtime/wrangler.jsonc) 仍残留旧版 `production` Hyperdrive 模板。
  3. **现网运行资源可直接缩减**：Cloudflare 账号中存在 **2 个遗留实验 Worker + 2 个过期 Hyperdrive + 4 条实验 Queue（含对应的 Neon `production` PoC 分支与 `soft-hat-19698091` 项目）可立即安全停用**；而造成 `silent-boat-95177889` 月度 compute 逼近上限（已累计 `361,823s` ≈ `100.51 CU-hours`）的直接原因是 `ember-assistant-turn-runtime-staging` 的 `* * * * *` 分钟级 Cron 持续唤醒 Neon `staging` 分支。
  4. **V1 数据体量极小、无在途任务**：`ember_staging` 当前仅含 **1 个真实 Apple 账号、3 个对话 / 78 条消息、6 个已完成 Task、4 个 Artifact**，且**在途 Turn / Task / Outbox 全部为 0**，适合通过有界维护窗口进行「备份 → 停写 → 一次性导入校验 → 切流 → 14 天只读观察 → 退役 Neon」的最小安全路径。

---

## 1. V2 依赖审计：Staging 与计划中的 Production

### 1.1 已核查：V2 Staging 运行时与构建产物完全脱离 Neon

对已部署 Worker `ember-v2-staging`（`https://ember-v2-staging.slowfast.dev`）及 [wrangler.v2-staging.jsonc](../../apps/api/wrangler.v2-staging.jsonc) 进行只读核查：

- **线网与绑定（Cloudflare 只读核查）**：仅绑定 `AGENT_HEAD` (`AgentHeadDO`)、`GLOBAL_BUDGET` (`GlobalBudgetDO`)、D1 `D1_RECOVERY` (`ember-v2-staging-recovery`, `36f975f7-c79d-4559-9729-93091d811236`) 与 4 条 `ember-v2-staging-*` 队列；`hyperdrive` 绑定为空，`r2_buckets` 为空，Worker Secrets 为 `[]`（无 `DATABASE_URL`）。
- **构建产物扫描**：通过 `wrangler deploy --dry-run --outdir` 编译 [runtime-worker.ts](../../apps/api/src/local-v2/runtime-worker.ts) 得到 `runtime-worker.js`（3.9 MB），检索 `hyperdrive|@neondatabase|postgres|pg_advisory|DATABASE_URL|new Pool` **全部为 0 命中**。
- **线上探活**：`GET https://ember-v2-staging.slowfast.dev/readyz` 返回 HTTP `200`，仅探测 `d1_recovery: "up"`。

### 1.2 隐式依赖与计划中的 Production 阻塞项

虽然 V2 运行时已脱离 Neon，但在 **代码解耦、Production 配置与数据平滑迁移** 上仍存在以下必须显式关闭的耦合与缺口：

| 类别                                      | 影响范围                | 现状与具体位置                                                                                                                                                                                                                                                                                                                                                                                                 | 处理要求                                                                                                                                                                                                                 |
| :---------------------------------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **构建期 `@ember/postgres` 耦合**         | V2 Staging / Production | [apps/api/package.json](../../apps/api/package.json) 仍依赖 `@ember/postgres`；[runtime-session.ts](../../apps/api/src/local-v2/runtime-session.ts)、[staging-session-store.ts](../../apps/api/src/local-v2/staging-session-store.ts) 及共享路由（`auth/session-service.ts`、`conversation/`、`tasks/`、`turns/`、`uploads/`）存在 `import type` 依赖                                                          | 将共享 DTO 类型（如 `B1SessionRecord` 与 Repository 接口）下沉至 `@ember/contracts` 或 `@ember/domain`，切断 V2 构建链对 `packages/postgres` 的直接依赖                                                                  |
| **遗留 Production Hyperdrive 模板**       | 计划中 Production       | [apps/cloud-async-runtime/wrangler.jsonc](../../apps/cloud-async-runtime/wrangler.jsonc) 声明 `name: "ember-assistant-turn-runtime"` 与 `EMBER_ENV: "production"`，仍绑定 `HYPERDRIVE = REPLACE_WITH_RUNTIME_HYPERDRIVE_ID`（尚未在 CF 部署）                                                                                                                                                                  | 禁止沿用该模板部署生产；在退役 PR 中标记废弃或移除 V1 `wrangler.jsonc`                                                                                                                                                   |
| **V2 Runtime 尚未开放 `production` 环境** | 计划中 Production       | 尚无 V2 Production Wrangler 配置及独立 D1/Queues；[runtime-config.ts](../../apps/api/src/local-v2/runtime-config.ts) `resolveV2AllowedHosts` 仅支持 `local\|test\|ci\|v2-staging`；[runtime-worker.ts](../../apps/api/src/local-v2/runtime-worker.ts) 仅 `v2-staging` 启用 Apple Sign In + `DENY_DEV_PROVIDER`，其他值将回落本地 `dev` 会话或抛错                                                              | 上线 Production 前必须新增 `wrangler.v2-production.jsonc`、开放 `EMBER_ENV=production` 严格配置，并强制 Apple Auth + `DENY_DEV_PROVIDER`                                                                                 |
| **D1 会话/身份迁移缺失**                  | Production + 迁移       | [0001_v2_recovery_registry.sql](../../packages/runtime-v2/migrations/0001_v2_recovery_registry.sql) 仅建 `v2_recovery_registry`；`v2_staging_sessions` 与 `v2_staging_apple_nonce_replays` 依靠 [staging-session-store.ts](../../apps/api/src/local-v2/staging-session-store.ts) 冷启动 `CREATE TABLE IF NOT EXISTS`，且首次登录会基于 `deterministicEdgeUuid('v2-staging:tenant:' + sub)` 生成全新 `tenantId` | 为 Production 补齐正式 D1 SQL 迁移（含 `v2_identities` / `v2_sessions` / `v2_apple_nonce_replays`），并按 `provider_subject` 显式保留 V1 既有 `tenant_id/agent_id/conversation_id`（避免旧用户重新登录后找不到历史数据） |
| **R2 与大文件上传通道缺口**               | Production + 附件       | V2 Staging 未绑定 R2，[task-artifact-service.ts](../../packages/runtime-v2/src/agent-head/task-artifact-service.ts) 使用 DO SQLite 内联 base64（上限 `V2_MAX_INLINE_ARTIFACT_BYTES = 1 MiB`）；而 V1 已支持 `15 MiB` 上传并使用 R2 `ember-blobs-staging`                                                                                                                                                       | Production（以及迁移超过 1 MiB 的 V1 附件/产物）须为 V2 配置独立 R2 Bucket 与对象读写路由                                                                                                                                |
| **部署脚本与 CI 绑定 PG**                 | 发布与 CI               | [deploy.mjs](../../infra/cloudflare/deploy.mjs) 强依赖 `neon` CLI 迁移 Neon；[.github/workflows/ci.yml](../../.github/workflows/ci.yml) 的 `verify` Job 依赖 PostgreSQL 17 容器，iOS [AppCompositionRoot.swift](../../apps/ios/EmberApp/App/AppCompositionRoot.swift) 默认地址仍为 V1 `https://ember-api.slowfast.dev`                                                                                         | 新增独立 V2 Production 部署与预检脚本（继承 [v2-staging-preflight.mjs](../../infra/cloudflare/v2-staging-preflight.mjs)）；V1 完全下线后再归档旧 PG 验证脚本与 `packages/postgres`；private repo 不要求 GitHub Actions CI                                  |

---

## 2. 现网运行的 V1 Worker、Cron、Hyperdrive 与 Neon 资源排查

以下均通过 Cloudflare 与 Neon 只读 API 核实（账号内全部 14 个 Cloudflare Worker 中仅以下 6 个与 Ember 相关）：

### 2.1 Cloudflare Workers 与 Cron Triggers

| Worker 名称                                    | 当前域名 / 暴露面                                           | Cron Triggers                                  | 绑定 Neon / Hyperdrive / Queue                                                                                                           | 处理建议                                                                                                                       |
| :--------------------------------------------- | :---------------------------------------------------------- | :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| **`ember-cloud-api`**                          | 仅 `workers.dev`（2026-11-08 部署）                         | 无                                             | Hyperdrive `a331dbebe08c4f4e9ec7eac2d2baf5a3` (`ember-alpha-neon-worker`)                                                                | **候选退役：须核实无依赖、完成备份并单独授权**（早期 Alpha PoC，已被 `*-staging` 取代）                                                                  |
| **`ember-cloudflare-free-runtime-experiment`** | `workers_dev=false`（2026-11-10 部署）                      | 无                                             | Hyperdrive `1af8ca2e11434f6dbaa90f4e1f640aeb` (`ember-cloudflare-free-runtime`) + Queue `ember-assistant-turns`                          | **候选退役：须核实无依赖、完成备份并单独授权**（Free Runtime 历史实验）                                                                                  |
| **`ember-daytona-smoke-staging`**              | `workers.dev`（2026-11-15 部署）                            | 无                                             | Queue `ember-staging-daytona-smoke`；**无 Neon/Hyperdrive**                                                                              | 随时可下线（仅 Daytona 冒烟用）                                                                                                |
| **`ember-cloud-api-staging`**                  | `ember-api.slowfast.dev` + `workers.dev`（2026-11-18 部署） | 无                                             | Hyperdrive `f7da9cff26b843fda8187764f9b81b25` + R2 `ember-blobs-staging` + Queue `ember-staging-assistant-turns`                         | **切流前保留**（当前 V1 iOS 默认入口）；切流冻结写时转维护/下线                                                                |
| **`ember-assistant-turn-runtime-staging`**     | `workers_dev=false`（2026-11-18 部署）                      | **`* * * * *`、`*/30 * * * *`、`0 */6 * * *`** | Hyperdrive `f7da9cff26b843fda8187764f9b81b25` + R2 `ember-blobs-staging` + 2 条 V1 Queue/DLQ + `DAYTONA_API_KEY` / `EMBER_MODEL_API_KEY` | **主能耗元凶，切流完成并排空队列后立即移除 Cron/停用**；分钟级 `* * * * *` Cron 持续唤醒 `ember_staging`，阻止其 scale-to-zero |
| **`ember-v2-staging`**                         | `ember-v2-staging.slowfast.dev`（2026-11-21 部署）          | `* * * * *` (`RecoverySweeper`)                | D1 `ember-v2-staging-recovery` + DO `AgentHeadDO`/`GlobalBudgetDO` + 4 条 V2 Queue/DLQ（**无 Hyperdrive**）                              | **保留**（V2 目标架构预发环境）                                                                                                |

### 2.2 Hyperdrive 与 Neon 项目对应关系

| Hyperdrive 配置 ID / 名称                                            | 指向 Neon 项目 / 分支 / Endpoint                                                                                                                              | Neon 现状（2026-11-21T08:36Z 只读核查）                                                                                                                                  | 处理建议                                                                                                                                                                          |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a331dbebe08c4f4e9ec7eac2d2baf5a3` (`ember-alpha-neon-worker`)       | `soft-hat-19698091` (`ember-issue132-neon-free`) / `production` (`br-gentle-king-a1b9j4i2`) / `ep-floral-boat-a1y1mh11` / DB `ember_test`                     | 自 **2026-11-10T13:41:54Z** 起已休眠（`suspended`），`active_time = 13,568s`                                                                                             | 停用 `ember-cloud-api`、完成 `pg_dump` 恢复验证并获单独授权后，才可删除 Hyperdrive 与 Neon 项目                                                                                                |
| `1af8ca2e11434f6dbaa90f4e1f640aeb` (`ember-cloudflare-free-runtime`) | `silent-boat-95177889` (`ember-cloudflare-free-experiment`) / `production` (`br-fragrant-resonance-a1uao4wl`) / `ep-shy-resonance-a1k5npxg` / DB `ember_test` | 自 **2026-11-18T07:59:21Z** 起已 `idle/suspended`，历史累计 `compute_time = 175,623s`（**48.78 CU-h**）                                                                  | 停用实验 Worker、核实队列空闲及备份并获单独授权后，才可删除 Hyperdrive 与孤儿实验队列（`ember-assistant-turns*`、`ember-free-runtime-turns*`）；导出确认仅测试库后可先删除该 `production` 分支释放配额观察压力 |
| `f7da9cff26b843fda8187764f9b81b25` (`ember-staging-neon-hyperdrive`) | `silent-boat-95177889` / `staging` (`br-sparkling-bird-a1cfzgxs`) / `ep-old-shape-a1q7ik0j` / DB `ember_staging`                                              | **持续 `active`**（最近活跃 `2026-11-21T08:36:00Z`），累计 `compute_time = 186,200s`（**51.72 CU-h**）；与旧 `production` 分支合计已达 **100.51 CU-h**（`free_v3` 套餐） | V1 切流冻结期间**保留**；切流完成并关闭 V1 Cron 后立即使其休眠为只读冷备，满足退役门禁后删除                                                                                      |

---

## 3. V1 状态盘点与 V2 映射清单

对 V1 权威数据库 `ember_staging`（`migrations/0001`–`0023`，共 41 张表）执行非 PII 精确行数与状态分布核查，并对比 V2 目标存储（`D1_RECOVERY` + `AgentHeadDO` SQLite + `GlobalBudgetDO` SQLite + R2）：

| 状态域                           | V1 Neon 表及实测存量（`ember_staging`）                                                                                                                                                                                                              | 在途 / 特殊状态明细                                                                                                                                                  | V2 目标承载与迁移策略                                                                                                                                                                                                                                                                          |
| :------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **身份与认证 Session**           | `consumers`(3), `consumer_identities`(3), `consumer_sessions`(5), `tenants`(3), `principals`(3), `agents`(3), `apple_identity_nonce_replays`(1)                                                                                                      | `consumer_identities`: **1 条 `apple` + 2 条 `dev`**；`consumer_sessions`: **3 条有效 + 2 条已失效/吊销**                                                            | **仅迁移 `provider='apple'` 身份及其关联 Tenant/Agent/Conversation UUID** 到 D1 `v2_identities`/`v2_sessions`（过滤 `dev` 与已吊销 Session）；迁移有效 Session Token SHA-256 Digest 实现免重登，同步近期未过期的 Nonce 防重放记录                                                              |
| **历史对话与消息**               | `conversations`(3), `conversation_messages`(78), `conversation_message_attachments`(2)                                                                                                                                                               | 全量已落盘                                                                                                                                                           | 按 `(tenant_id, agent_id)` 迁移至对应 `AgentHeadDO` 的 `conversations`、`conversation_messages`、`message_attachments`；保留原 `id`、`sequence`、`last_sequence`、`client_submission_id` 与消息正文                                                                                            |
| **Memory**                       | **V1 无对应表**（`0001`–`0023` 未定义 `personal_memories`）                                                                                                                                                                                          | 0 行                                                                                                                                                                 | V2 `AgentHeadDO` SQLite `personal_memories`（migration v6）初始为空表，无需从 Neon 迁移                                                                                                                                                                                                        |
| **Tasks / Runs / 审批**          | `tasks`(6), `runs`(8), `task_events`(41), `task_results`(6), `step_checkpoints`(9), `approvals`(0)                                                                                                                                                   | `tasks`: **4 `completed` + 2 `failed`（0 `queued`/`running`/`waiting_approval`）**；`runs`: **4 `succeeded` + 3 `failed_retryable` + 1 `failed_terminal`（0 在途）** | 迁移已落盘 `tasks`、`runs`、`task_events`、`task_results` 到 `AgentHeadDO` 对应历史表（供历史详情查看）；`step_checkpoints` 随冷备归档即可                                                                                                                                                     |
| **Schedules / Commitments**      | `commitments`(0), `commitment_occurrences`(0), `commitment_outcomes`(0), `consent_grants`(0)                                                                                                                                                         | 全为 **0 行**                                                                                                                                                        | 当前无历史调度需迁移；V2 启用 `v2_schedules` / `proactive_schedules` / `proactive_schedule_runs` 即可                                                                                                                                                                                          |
| **Artifacts / Blobs / 上传文件** | `artifacts`(4), `blobs`(4), `staged_blobs`(3), `bytea_blobs`(4), `bytea_staged_blobs`(1), `user_staged_uploads`(2)；另 R2 `ember-blobs-staging` 实测 **2 个对象**（各约 `2.53 MB`）                                                                  | `bytea_blobs`: **3 条正文仍在 PG `bytea`** + 1 条在 R2；`user_staged_uploads`: 1 条 `bound:postgres` + 1 条 `bound:r2`；`blobs`/`staged_blobs` 均为 PG `bytea`       | **迁移前高风险项**：V1 文件同时分散在 **Neon PG `bytea`** 与 **R2 `ember-blobs-staging`**。必须通过迁移工具读取 `artifacts`/`blobs`/`bytea_blobs`/`user_staged_uploads`，把 PG `bytea` 与 R2 对象统一转存至 V2 目标 R2（或 ≤1 MiB 产物写入 `v2_task_artifacts`），核验 SHA-256 后方能摆脱 Neon |
| **未完成执行与 Outbox / 预算**   | `assistant_turns`(34), `b1_turn_dispatch_outbox`(34), `b3_task_dispatch_outbox`(4), `model_turn_attempts`(30), `task_model_attempts`(17), `budget_operations`(13), `model_spend_days`(12), `model_global_spend_days`(6), `model_budget_incidents`(0) | `assistant_turns`: **29 `completed` + 3 `failed` + 2 `cancelled`（0 `running`）**；两张 Outbox **0 条未完成 (`completed_at IS NULL`)**                               | 切流前在停写窗口排空所有在途 Turn/Task/Outbox（要求全为 0）；历史尝试与对账流水保留在冷备份中；仅当同一 UTC 日切流且存在已消耗预算时，将当天 `model_spend_days` / `model_global_spend_days` 写入 `AgentHeadDO` / `GlobalBudgetDO` 防当天超额                                                   |
| **其余未使用/元信息表**          | `workspaces`(0), `workspace_versions`(0), `workspace_conflicts`(0), `operation_receipts`(0), `platform_metadata`(1), `schema_migrations`(23)                                                                                                         | 全为空或元信息                                                                                                                                                       | 随冷备归档，不迁入 V2                                                                                                                                                                                                                                                                          |

另经核查，V2 隔离 Staging 库 `ember-v2-staging-recovery` 当前已记录 `v2_recovery_registry = 1` 行、`v2_staging_sessions = 2` 行、`v2_staging_apple_nonce_replays = 1` 行（为阶段验证数据）。若 V1 与 V2 Staging 共用同一 Apple 测试账号，合并导入前须先比对或清理重复测试记录。

---

## 4. V1→V2 最小安全迁移路径、切流、回滚与退役条件

由于当前真实存量极小且无在途异步任务，**无需构建跨 PG/DO 双向同步或 CDC**，采用「前置解耦 → 冷备份 → 短时停写迁移与校验 → 灰度切流 → 14 天冷备观察 → 最终退役」的 5 步最小安全路径：

### 步骤 0：历史实验资源退役准备与 V2 前置就绪（需单独授权）

1. **核对候选退役的 V1 实验资源（本步骤仅评估，不执行删除）**：完成备份与恢复验证、核实没有活跃业务依赖，并另获 Founder / CTO 明确授权后，才可删除遗留实验 Worker（`ember-cloud-api`、`ember-cloudflare-free-runtime-experiment`）、对应 Hyperdrive（`ember-alpha-neon-worker`、`ember-cloudflare-free-runtime`）、4 条实验队列及 Neon `soft-hat-19698091`。
2. **补齐 V2 Production 阻塞项**（见第 1.2 节）：
   - 解耦 `@ember/api` 中 V2 对 `@ember/postgres` 的类型依赖；
   - 新增 V2 Production Wrangler 配置与 `EMBER_ENV=production` 严格守卫；
   - 补齐 D1 正式身份映射迁移（支持按 Apple `provider_subject` 保留 V1 的 `tenant_id/agent_id/conversation_id`）及 R2 Bucket 绑定（承接 >1 MiB 上传与 Artifact）。

### 步骤 1：全量备份与可恢复性预演

1. 在 Neon `ember_staging` 上通过直连只读执行两次独立逻辑导出（停写前基线一次、停写窗口锁定后最终一次）：
   - `pg_dump --format=custom --no-owner` 全库导出（含 `public` 与 `ember_private` schema）；
   - 按 `tenants`/`consumer_identities`/`conversation_messages`/`tasks`/`artifacts` 另导出校验清单（记录每表行数、主键集合及内容 SHA-256 摘要）。
2. 全量拉取 R2 `ember-blobs-staging` 对象列表与字节并计算 SHA-256。
3. 在本地临时 PostgreSQL 17 容器中执行一次 `pg_restore` 恢复演练，确认备份可读、完整、校验和一致（备份加密归档到 Neon 之外的对象存储/安全介质）。

### 步骤 2：短时停写排空 → 确定性导入 → 双向校验

1. **V1 维护窗口**：暂停 `ember-cloud-api-staging` 写入口（或临时返回 `503 MAINTENANCE`），等待 Queues 排空并查询确认：
   - `assistant_turns WHERE status = 'running'` = `0`；
   - `tasks WHERE status IN ('queued', 'running', 'waiting_approval')` = `0`；
   - `b1_turn_dispatch_outbox WHERE completed_at IS NULL` = `0` 且 `b3_task_dispatch_outbox WHERE completed_at IS NULL` = `0`。
2. **最终冻结备份**：确认在途全 0 后执行步骤 1 的最终冻结 `pg_dump`。
3. **一次性幂等导入**：
   - 将 `provider = 'apple'` 的身份映射与未过期 `consumer_sessions` 写入 V2 D1；
   - 按 `(tenantId, agentId)` 写入对应 `AgentHeadDO` SQLite（`conversations`、`conversation_messages`、`message_attachments`、`tasks`、`runs`、`task_events`、`task_results`）及搬迁后的 R2/Artifact；
   - 若切流当日 V1 已有 `model_spend_days` 消耗，写入对应 UTC 日预算基线；向 `D1_RECOVERY`（无待恢复任务时可不插 `armed` 占位）及 DO `conversations.last_sequence` 同步最大值。
4. **导入校验（全量比对 100% 一致方可切流）**：
   - 逐 Tenant 核对：会话数、消息数、`MAX(sequence) == conversations.last_sequence`、每条消息文本与 `client_submission_id` SHA-256、Task/Result 行数、每个 Artifact / Attachment 的字节大小与 SHA-256；
   - 使用白名单 Apple 账号在 V2 执行只读回归：`GET /v1/me`、`GET /v1/me/conversation/messages`、`GET /v1/me/tasks`、`GET /v1/tasks/:id/artifacts/:aid/download`，确认历史内容完整可读。

### 步骤 3：切流策略与硬性回滚边界

- **切流顺序**：
  1. **内部灰度**：iOS Debug / 白名单测试包指向 V2 域名完成一轮全链路验证（登录态续期、多轮对话、附件下载、Task 执行）。
  2. **域名与正式客户端切流**：更新 iOS 默认配置并在确认无异常后将 `ember-api.slowfast.dev` 自定义域名绑定切换至 V2 Worker（同时立即禁用 `ember-assistant-turn-runtime-staging` 的 `* * * * *` 等 Cron Triggers 与 `ember-cloud-api-staging` 路由，避免 V1 后台再写入或继续唤醒 Neon）。
- **回滚边界（严格遵守 ADR-0005 / ADR-0006）**：
  - **切流前（V2 未接收真实用户写流量）**：随时通过保留 V1 域名与恢复 Cron 回退，零风险。
  - **切流后（一旦 V2 接受真实用户写入）**：**禁止通过简单切回域名/Route 回滚到 V1 Neon**（否则将静默丢失切流后的用户消息、记忆与调度）。若 V2 出现代码缺陷，优先使用 Cloudflare Worker `wrangler rollback <previous-version-id>` 在 V2 内部回退版本；仅当 V2 存储层发生不可恢复故障时，才进入全局停写故障恢复：导出 V2 DO 增量状态并与冷备对齐后方可切回。

### 步骤 4：Neon 最终退役门禁（全部满足方可执行永久删除）

切流后保持 **14 天只读冷备观察期**（期间已停用 V1 Cron 与 API，Neon 处于 0 计算消耗休眠状态），满足以下 **全部 6 项门禁** 并由 Founder / CTO 书面确认后，方可永久删除 Neon：

1. **稳定运行达标**：V2 已承接 100% 流量连续稳定运行 **≥ 14 天**，期间无 P0/P1 数据损坏、跨租户越权或恢复丢失事故。
2. **存量验证完成**：所有迁移的 Apple 账号均已在 V2 完成登录、历史消息/产物读取及新 Turn/Task 执行验证。
3. **V1 运行态彻底静默**：`ember-cloud-api-staging`、`ember-assistant-turn-runtime-staging`（含 3 条 Cron）已下线，V1 队列与 DLQ 均为空；`ember-v2-*` 生产及预发端到端零 Neon/Hyperdrive 访问。
4. **最终冷备份独立存档通过恢复校验**：已完成最终 `pg_dump` 与 R2 资产备份的独立离线保存，并在临时 PG 实例完成至少一次全量恢复核验。
5. **仓库与本地验证解耦收敛**：`apps/api` 与 V2 编译链不再依赖 `@ember/postgres`；private repo 不启用 GitHub Actions CI，以本地 V2 Cloudflare-native 定向验证作为验收证据。
6. **正式退役签字与按序销毁**：经授权确认后，按顺序移除：V1 Workers（`ember-cloud-api-staging`、`ember-assistant-turn-runtime-staging`、`ember-daytona-smoke-staging`）→ 3 个 Hyperdrive 配置 → V1 Queues → Neon `soft-hat-19698091` 与 `silent-boat-95177889`。
