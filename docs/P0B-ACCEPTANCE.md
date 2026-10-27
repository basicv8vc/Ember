# P0B-01 — 验收报告（Repository Foundation）

> 本文件只记录**实际执行过**的命令与结果。未执行的项标记 `NOT RUN`，失败的项标记 `FAILED`。
> 本 PR **不**声称 P0B-02～P0B-10 已完成。

## 1. 执行环境

| 项目       | 值                                                                |
| ---------- | ----------------------------------------------------------------- |
| 日期       | 2026-10-27（本地时区 UTC+8；日志中的 UTC 时间为 07:4x）           |
| OS         | macOS (Darwin 25.3.0, arm64)                                      |
| Node.js    | v24.22.1（LTS "Krypton"）                                         |
| pnpm       | 12.15.0（`packageManager` 固定）                                  |
| TypeScript | 5.9.3，`strict: true`                                             |
| PostgreSQL | 17（Docker `postgres:17-alpine`，容器 `ember-local-postgres`）    |
| Docker     | 29.0.1（Docker Desktop / Compose v2）                             |
| 分支       | `feature/p0b-01-repository-foundation`（基于 `main` @ `f182c11`） |

Node 版本选择依据：执行时 nodejs.org 的版本索引中 `v26.12.1` 的 `lts` 字段为 `false`，
而 `v24.22.1` 为 `lts=Krypton`，因此使用 Node 24 LTS。

## 2. 交付前仓库状态核验

| 检查             | 命令                                                      | 结果                                                                          |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 远端 HEAD / 分支 | `git fetch --all --prune && git ls-remote --heads origin` | 仅 `refs/heads/main` @ `f182c11887052a4edf4378e3f4c004d9c155087a`，与本地一致 |
| 工作区           | `git status`                                              | 干净（仅 4 个未被跟踪的本地参考 Markdown，未提交、未修改）                    |
| 既有内容         | `cat README.md`                                           | 仅项目标语；标语已保留                                                        |
| 指导文件         | 查找 `AGENTS.md` / `CONTRIBUTING.md`                      | 仓库中不存在，无需遵循额外流程                                                |
| 分支创建         | `git checkout -b feature/p0b-01-repository-foundation`    | 成功；同名远端分支不存在，未覆盖他人工作                                      |
| `main` 修改      | —                                                         | 无。`main` 未被提交或推送                                                     |

## 3. 验收清单逐项结果

| #   | 验收项                                                         | 命令 / 证据                                                               | 实际结果                                                                                                                        | 状态     |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | 仓库状态核验，PR 来自独立 feature 分支                         | `git status`、`git ls-remote`、`git branch`                               | 分支为 `feature/p0b-01-repository-foundation`；`main` 保持 `f182c11`                                                            | **PASS** |
| 2   | `pnpm install --frozen-lockfile` 成功                          | 删除全部 `node_modules` 与 `dist` 后执行 `pnpm install --frozen-lockfile` | `Done in 562ms`（本机 pnpm store 已预热），0 错误                                                                               | **PASS** |
| 3   | `pnpm lint` 成功                                               | `pnpm lint`                                                               | `eslint .` 退出码 0，无 error/warning                                                                                           | **PASS** |
| 4   | `pnpm typecheck` 成功（strict）                                | `pnpm typecheck`                                                          | `tsc -p tsconfig.json` 退出码 0                                                                                                 | **PASS** |
| 5   | `pnpm test:unit` 成功，含真实 `/healthz` HTTP 断言             | `pnpm test:unit`                                                          | 3 个文件 / 23 个测试全部通过；包含 `app.request('/healthz')` 与 `127.0.0.1:0` 真实 socket 上的 200 断言                         | **PASS** |
| 6   | `pnpm build` 成功，生成可运行 Node 产物                        | `pnpm build`                                                              | `tsc -b tsconfig.build.json` 退出码 0；`apps/api/dist/index.js` + `packages/postgres/dist/*` 生成                               | **PASS** |
| 7   | `pnpm dev` 默认 loopback 启动，`GET /healthz` 200              | `pnpm dev`，然后 `curl -i 127.0.0.1:8787/healthz`                         | HTTP 200，`{"status":"ok","service":"ember-api",...}`；`lsof` 显示仅 `127.0.0.1:8787 (LISTEN)`；`/readyz` 200，DB `up`          | **PASS** |
| 8   | `pnpm dev:db` 可启动本地 PostgreSQL                            | `pnpm dev:db`                                                             | Compose 创建卷/网络/容器，`Up (healthy)`，端口 `127.0.0.1:55432->5432`；同时创建 `ember` 与 `ember_test`                        | **PASS** |
| 9   | `pnpm db:migrate` 空库首次成功，重复执行成功                   | 新建空数据库 `ember_p0b01_verify` 后连续执行两次（`DATABASE_URL` 覆盖）   | 第一次 `1 applied, 0 already applied`；第二次 `0 applied, 1 already applied`；`schema_migrations` 仅 1 行；验证后删除临时数据库 | **PASS** |
| 10  | `pnpm test:integration` 至少完成真实 PG 连接与 Migration 验证  | `pnpm test:integration`                                                   | 1 个文件 / 5 个测试通过（真实 PostgreSQL 17）：连接、首次迁移、重复迁移、版本记录、readiness、checksum 篡改拒绝                 | **PASS** |
| 11  | GitHub Actions 工作流实际执行                                  | `.github/workflows/ci.yml` + Draft PR 的 Actions 运行                     | CI run [40469868681](https://github.com/basicv8vc/Ember/actions/runs/40469868681)：**success**，48s，全部步骤通过               | **PASS** |
| 12  | `.env.example` 无真实密钥；默认不公开监听；无付费依赖          | 人工检查 `.env.example`、`env.ts`、`package.json`、`pnpm-lock.yaml`       | 仅本地占位口令；非 loopback 绑定需显式 opt-in；依赖全部为开源 npm 包，无付费服务                                                | **PASS** |
| 13  | `git diff --check` 通过；README/验收报告准确区分已实现与未实现 | `git add`（排除本地参考文档）后 `git diff --cached --check`               | 见第 6 节                                                                                                                       | **PASS** |
| 14  | Draft PR 已创建、描述完整、未合并 `main`                       | `gh pr create --draft`                                                    | [PR #1](https://github.com/basicv8vc/Ember/pull/1)，`isDraft: true`，`state: OPEN`，base `main`；未合并                         | **PASS** |

## 4. 实测命令与关键输出

### 4.1 单元测试

```text
$ pnpm test:unit
 RUN  v5.0.5 /Users/a1-6/Downloads/Ember
 Test Files  3 passed (3)
      Tests  23 passed (23)
   Duration  255ms
```

覆盖内容：

- `tests/unit/healthz.test.ts`：`/healthz` 固定响应；真实 loopback socket 上数据库 down 时
  `/healthz` 仍 200 而 `/readyz` 503；未配置探针时 `/readyz` 503 + `not_configured`；未知路由
  JSON 404。
- `tests/unit/env.test.ts`：默认 `local` / `127.0.0.1` / `8787`；端口范围；拒绝 `0.0.0.0` 与
  `192.168.x.x`；显式 opt-in 放行；`DATABASE_URL` 校验错误不包含密码；日志脱敏。
- `tests/unit/migrator.test.ts`：真实 `migrations/` 目录解析、命名/顺序/空文件/缺失目录校验。

### 4.2 集成测试（真实 PostgreSQL）

```text
$ pnpm test:integration
 RUN  v5.0.5 /Users/a1-6/Downloads/Ember
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  231ms

$ docker exec ember-local-postgres psql -U ember -d ember_test -tAc \
    "select count(*) from pg_namespace where nspname like 'ember_it_%'"
0
```

隔离方式：每次运行创建 `ember_it_<12 hex>` schema，迁移与断言只在该 schema 内进行，结束后仅
DROP 该 schema。没有 TRUNCATE / DROP 其他 schema，也没有清理开发者的其他数据。

### 4.3 数据库迁移（空库首次 + 幂等）

```text
### 1st run on empty database
running migrations from /Users/a1-6/Downloads/Ember/migrations
database: postgres://ember:***@127.0.0.1:55432/ember_p0b01_verify
applied migration 0001_platform_metadata.sql in 3ms
migrations complete: 1 applied, 0 already applied

### 2nd run
migrations complete: 0 applied, 1 already applied

### recorded version
  id   |            name            |          applied_at
-------+----------------------------+-------------------------------
 0001  | 0001_platform_metadata.sql | 2026-10-27 07:46:44.722055+00
```

日志中的连接串密码显示为 `***`，未输出真实口令。

### 4.4 API 行为

```text
$ curl -i http://127.0.0.1:8787/healthz
HTTP/1.1 200 OK
{"status":"ok","service":"ember-api","version":"0.0.0","checkedAt":"2026-10-27T07:46:57.114Z"}

$ curl -i http://127.0.0.1:8787/readyz
HTTP/1.1 200 OK
{"status":"ready","checks":{"database":{"status":"up","latencyMs":23}},...}

$ lsof -nP -iTCP:8787 -sTCP:LISTEN
node ... TCP 127.0.0.1:8787 (LISTEN)

### 构建产物 + 不可达数据库（liveness 不受影响）
$ DATABASE_URL=postgres://ember:whatever@127.0.0.1:55999/nope node apps/api/dist/index.js
healthz_http=200
readyz_http=503
{"status":"unavailable","checks":{"database":{"status":"down","latencyMs":5}},...}

### 拒绝非 loopback 绑定
$ EMBER_HOST=0.0.0.0 node apps/api/dist/index.js
api failed to start: Refusing to bind non-loopback host "0.0.0.0" without EMBER_ALLOW_NON_LOOPBACK_BIND=true
exit=1

### 缺少 DATABASE_URL
$ node apps/api/dist/index.js
api failed to start: Invalid database environment: DATABASE_URL: Invalid input: expected string, received undefined
exit=1
```

## 5. GitHub Actions / Draft PR

| 项目            | 值                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支            | `feature/p0b-01-repository-foundation`                                                                                                                                 |
| 已验证代码 HEAD | `4ea68e4b021ecb597b659127bbcff85050f446c2`                                                                                                                             |
| Draft PR        | <https://github.com/basicv8vc/Ember/pull/1>（`isDraft: true`，`state: OPEN`，base `main`）                                                                             |
| CI 运行 #1      | [40469650009](https://github.com/basicv8vc/Ember/actions/runs/40469650009) — **success**，51s（首版 workflow，Actions 仍为 v4 major）                                  |
| CI 运行 #2      | [40469868681](https://github.com/basicv8vc/Ember/actions/runs/40469868681) — **success**，48s（当前 workflow：`checkout@v7`、`pnpm/action-setup@v6`、`setup-node@v7`） |
| CI 步骤         | frozen install → lint → format check → typecheck → unit tests → build → `db:migrate` ×2 → integration tests，全部 ✓                                                    |
| CI 环境         | 临时 `postgres:17-alpine` service container，`permissions: contents: read`，无 secrets，无部署                                                                         |
| `main` 状态     | 未修改（`f182c11`）、未合并                                                                                                                                            |

CI 中仅剩一条信息性提示（`ubuntu-latest` 将于 2026-10-19 后迁移到 Ubuntu 26 镜像），不是失败项。

## 6. 代码质量与仓库卫生

| 检查                        | 结果                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `git diff --cached --check` | 通过（无空白错误）                                                                                                  |
| 提交内容                    | 仅 P0B-01 相关文件；4 个本地参考 Markdown（任务书/RFC/本 Prompt）未提交                                             |
| 敏感文件                    | `.env.local` 被 `.gitignore` 忽略；`node_modules/`、`dist/`、`*.tsbuildinfo` 均忽略                                 |
| 依赖许可/成本               | 全部为开源 npm 包（Hono、pg、Zod、Vitest、ESLint、Prettier、TypeScript、tsx）；无付费云、无 AI Key、无外部 API 调用 |

## 7. 未执行 / 未完成项

以下项目**不属于** P0B-01，均未实现，也**不**计入通过：

- P0B-02 领域类型/状态机/Zod Schema；
- P0B-03 Task/Run/Event/Artifact Schema、幂等创建；
- P0B-04 Worker lease/fencing/retry；
- P0B-05 Execution Router / Fake LLM / Fake Sandbox；
- P0B-06 Artifact / Workspace CAS / Checkpoint；
- P0B-07 Task API / Tenant AuthZ / SSE；
- P0B-08 Cancel / Mock Approval / Budget；
- P0B-09 Telemetry / Chaos / 1,000 Agent 负载；
- P0B-10 `pnpm demo` / `pnpm bench:local` / `P0B-RESULTS.md`。

因此本 PR 不能作为 P0-B 完成、Sandbox 安全或 1,000 Agent 生产性能的证据。
