# P0B-01 — Repository Foundation 实现说明

> 状态：P0B-01 已实现；P0B-02 起的业务能力**未实现**。
> 关联验收证据：[P0B-ACCEPTANCE.md](./P0B-ACCEPTANCE.md)
> 上游：[P0-B Minimum Vertical Slice 任务书]，架构 RFC v0.2

## 1. 目标与非目标

P0B-01 只负责建立可复现、可审查的工程骨架，让后续工作包在同一套运行时、数据库、测试与
CI 契约上迭代。

本 PR 包含：

- Node.js LTS + TypeScript `strict` + pnpm Workspace 的 monorepo；
- 可启动的 Hono HTTP 服务，`GET /healthz`（liveness）与可选的 `GET /readyz`（readiness）；
- 本地 PostgreSQL（Docker Compose，仅 loopback）与最小 SQL migration runner；
- 环境变量 Zod 校验、默认 loopback、日志脱敏；
- Vitest 单元测试（含真实 HTTP socket）与真实 PostgreSQL 集成测试；
- GitHub Actions CI（PR 触发、PostgreSQL service container、最小权限）；
- README、本文件与验收报告。

本 PR 明确**不包含**（归属后续工作包）：Task/Run/Event/Artifact 业务 Schema、持久 Task Inbox、
幂等创建、Worker claim/lease/fencing、Execution Router、FakeSandbox、Workspace/Checkpoint、
SSE、Tenant AuthZ、Mock LLM、Approval/Budget、Telemetry、Chaos/Load 测试、CI 之外的部署。

## 2. 目录与职责

```text
apps/api/
  src/app.ts        createApp(deps)：Hono 路由与 JSON 错误处理，不绑定端口
  src/index.ts      HTTP listener + 优雅关闭（SIGINT/SIGTERM）
  src/env.ts        API 环境变量 Zod 校验、loopback 判定
  src/readiness.ts  readiness 探针契约与基于 SELECT 1 的实现
  src/logger.ts     结构化 JSON 日志（不记录 token/password/请求体）
  tsconfig.json     开发 / 类型检查用（paths 指向源码，不产出）
  tsconfig.build.json 构建用（composite，输出 dist）
packages/postgres/
  src/config.ts     DATABASE_URL 等校验、日志用连接元数据白名单
  src/pool.ts       pg.Pool 工厂（懒连接、statement_timeout、search_path）
  src/migrator.ts   迁移发现、校验、advisory lock、事务化执行
  src/cli/migrate.ts pnpm db:migrate 入口
migrations/
  0001_platform_metadata.sql 仅基础设施元数据，不是 P0B-03 业务表
tests/unit          无数据库；含真实 loopback socket 的 /healthz 断言
tests/integration   TEST_DATABASE_URL + 每次运行独立随机 schema
infra/local         PostgreSQL 17（127.0.0.1:55432）与 initdb 脚本
```

### 关于缺失的 `packages/domain` 与 `packages/contracts`

P0B-01 任务书把它们标记为“未来 P0B-02 的占位边界”，同时要求“不要生成大量空包、空接口或虚假
的测试”。两者冲突时优先后者：本 PR 不提交只含 `export {}` 的空包，而是把边界记录在此处，
在 P0B-02 引入领域类型、状态机与 Zod Schema 时一次性建立。这样 PR 中每个包都有真实职责与测试。

## 3. 关键架构取舍

| 决策           | 选择                                                                                              | 理由与影响                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时         | Node.js **24.22.1 LTS (Krypton)**，`.nvmrc` + `engines >=24 <25`                                  | 任务书要求“当前受支持 LTS”。查询 nodejs.org 时 `v26.12.1` 的 `lts` 为 `false`，因此不使用 Node 26；Node 24 是当时最新 LTS。CI 通过 `node-version-file` 使用同一固定版本 |
| 包管理         | pnpm **12.15.0**，`packageManager` 固定，提交 `pnpm-lock.yaml`，`save-exact`                      | 可复现安装；`allowBuilds` 显式允许 esbuild 构建脚本。pnpm 只是工程工具，不是生产运行时，性能结论不归因于 pnpm                                                           |
| 语言 / 模块    | TypeScript `strict`，`module: NodeNext`，ESM（`"type": "module"`）                                | 与 Node ESM 对齐；源码内相对导入显式带 `.js` 后缀，避免构建产物在 Node 下解析失败                                                                                       |
| 构建           | `tsc -b` 项目引用（`packages/postgres` → `apps/api`），不引入打包器                               | 产物是可直接 `node apps/api/dist/index.js` 运行的 ESM；不引入 bundler 复杂度                                                                                            |
| 测试时依赖解析 | Vitest alias 把 `@ember/postgres` 指向 `src/index.ts`                                             | `test:unit` / `test:integration` 不要求先 `build`，同时 `pnpm build` 仍验证真实产物                                                                                     |
| HTTP           | Hono + 官方 `@hono/node-server`；`createApp()` 与 `serve()` 分离                                  | 单测无需绑定公网端口；真实 socket 测试用 `port: 0` 隔离端口                                                                                                             |
| 健康检查       | `/healthz` 纯 liveness，不访问 DB；`/readyz` 执行 `SELECT 1`                                      | 明确区分两件事：数据库故障不应让进程被判定为死亡。readyz 未配置探针时返回 503 + `not_configured`                                                                        |
| 监听地址       | 默认 `127.0.0.1`；非 loopback 必须显式 `EMBER_ALLOW_NON_LOOPBACK_BIND=true`                       | 防止本地开发误暴露到局域网；校验在启动前完成并写测试                                                                                                                    |
| 配置校验       | Zod 校验 `EMBER_*`、`DATABASE_URL`、连接池参数                                                    | 失败即停止启动；错误消息只包含变量名与规则，不回显密码                                                                                                                  |
| 数据库访问     | `pg` + 显式 SQL，无 ORM                                                                           | 事务边界可审查；避免 P0 阶段引入 ORM 抽象成本                                                                                                                           |
| 连接池         | `createPool()` 懒连接，`statement_timeout` 由服务端强制                                           | 进程启动与 liveness 不依赖数据库可达性；单条语句不会无限挂起                                                                                                            |
| 迁移体系       | 自研 ~180 行 runner：`schema_migrations`、advisory lock、每迁移独立事务、SHA-256 校验、跳过已应用 | 无额外依赖、可审计；编辑已应用迁移会显式失败；P0 不实现 down migration（回滚策略待 P0B-03 设计）                                                                        |
| 迁移内容       | 仅 `0001_platform_metadata.sql`（基础设施元数据）                                                 | 任务书禁止提前设计 Task/Run/Event/Artifact Schema                                                                                                                       |
| 测试数据库隔离 | 每次运行创建 `ember_it_<12 hex>` schema，`search_path` 指向它，结束后只 DROP 该 schema            | 不清理任何无法证明属于本次测试的资源；可在共享测试库上安全并行运行                                                                                                      |
| 日志           | 自研最小 JSON logger；`DATABASE_URL` 仅以脱敏形式输出                                             | 不引入日志框架；避免凭据进入日志。真实请求体/Token 目前尚不存在                                                                                                         |
| CI             | 仅 PR + 手动触发，`permissions: contents: read`，PostgreSQL 17 service container                  | 无云账号、无付费 Key、无自动合并/发布/部署；迁移在 CI 中连续执行两次以验证幂等                                                                                          |

## 4. 测试策略

- **单元**：环境变量（默认值、端口范围、严格 loopback 判定与非法 IPv4/IPv6 负向用例、显式
  opt-in、无效 `DATABASE_URL` 不回显密码）、`describeDatabaseTarget` 白名单（含 `?password=` 等
  敏感 query 参数不出现）、迁移文件发现与命名/顺序/空文件校验、`/healthz` 与 `/readyz` 的
  `app.request` 断言，以及在 `127.0.0.1:0` IPv4 socket 与 `[::1]` IPv6 socket 上的真实 HTTP
  验证（含“数据库 down 时 `/healthz` 仍 200、`/readyz` 503”）。IPv6 测试在缺少 IPv6 loopback
  的环境中会显式 skip 并标注原因。
- **集成**：真实 PostgreSQL 上的连接、空 schema 首次迁移、重复迁移幂等、`schema_migrations`
  版本与 checksum 记录、`platform_metadata` 数据、readiness up、篡改已应用迁移的 checksum 被拒绝、
  重命名已应用迁移（内容不变）被拒绝。
- 缺少 `TEST_DATABASE_URL` 时集成测试**失败**而不是跳过，避免“未执行却显示通过”。
- 测试不会启动 Fixed Port、不会访问公网、不会调用任何外部 API。

## 5. 与上游文档的偏差 / 待评审点

| 项目                                               | 上游建议                                                                                     | 本 PR 实际                           | 原因                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| 包结构                                             | 建议 9 个包（domain/contracts/workspace-local/sandbox-fake/orchestrator/telemetry/testkit…） | 仅 `apps/api` + `packages/postgres`  | P0B-01 只做骨架，任务书同时要求不建空包；其余包随 P0B-02/05/06/09 建立 |
| `pnpm dev`                                         | P0-B 目标是 API + Worker                                                                     | 只启动 API                           | P0B-01 不含 Worker；README 明确说明，不伪装 Worker 已运行              |
| `pnpm test:e2e` / `pnpm demo` / `pnpm bench:local` | P0-B 目标 CLI 契约                                                                           | 未提供                               | 属于 P0B-07～P0B-10；未实现即不在 README 声称可用                      |
| `/readyz`                                          | 可选                                                                                         | 已实现（DB readiness）               | 任务书允许；与 liveness 严格区分                                       |
| down migration                                     | 未要求                                                                                       | 未实现                               | P0 只保证从空库可重放；回滚策略留待业务 Schema 落地后评审              |
| CI 触发                                            | “为 PR 配置 CI”                                                                              | `pull_request` + `workflow_dispatch` | 不向 `main` 推送触发，避免与受保护流程耦合                             |

## 6. 已知风险与后续边界

1. **迁移 runner 不处理并发 DDL 冲突之外的失败恢复**：每个迁移是单事务，失败会回滚，但需要人工
   修复迁移文件后重跑；P0 可接受。
2. **没有 down migration 与影子数据库校验**：业务 Schema（P0B-03）落地前需要补充迁移评审流程。
3. **`/readyz` 只覆盖数据库**：后续 Artifact Store 等依赖加入时应扩展为多 checks 结构（当前返回
   结构已预留 `checks` 映射）。
4. **CI 未覆盖 macOS / Windows**：与本地环境差异由 README 的版本表与故障排查说明弥补。
5. **P0B-02 起的领域模型**必须复用本 PR 的 `@ember/postgres` 配置/连接与迁移契约，避免另起一套
   DB 访问方式。
