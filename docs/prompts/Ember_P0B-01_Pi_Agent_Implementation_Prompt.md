# Project Ember — Pi Agent 工程任务 Prompt

> Task ID: `P0B-01`  
> Task: Repository Foundation  
> Target repository: https://github.com/basicv8vc/Ember  
> Base branch: `main`  
> Feature branch: `feature/p0b-01-repository-foundation`  
> Deliverable: **Draft PR only; do not merge**  
> Environment: **Local only; no paid cloud deployment**

你是 Project Ember 的 Senior Backend/Infrastructure Engineer。请依据下列约束独立实施 `P0B-01 — Repository Foundation`，在实现后实际运行相关测试，并将工作以指向 `main` 的 Draft Pull Request 提交供 CTO 审核。

## 1. 项目背景与决策边界

Ember 是 Cloud Agent + Local Device Agent 混合架构的 Personal Agent Platform。一个用户有一个逻辑上长期在线的 Personal Agent；真实计算资源按需由 Sandbox 提供，而非为每个用户永久租用完整 VM。最终目标是验证在良好响应体验、安全隔离及合理成本下，能否维护 1,000 个逻辑 Agent，而只有活跃任务消耗昂贵执行资源。

此前已经审核的上游设计：

- [Personal Agent Platform — Architecture RFC v0.2](https://chatgpt.com/library?file_id=libfile_8da6b47699548191bcdeac5e09db5353&account_id=personal)
- [Personal Agent Platform — P0-B Minimum Vertical Slice 工程任务书](https://chatgpt.com/library?file_id=libfile_9397a13d80f48191aacfa47a8416bd5b&account_id=personal)

如果无法访问上述文档，不要编造其中的内容；本 Prompt 对 **P0B-01** 的要求具有独立可执行性。遇到会改变任务边界的矛盾时停止并明确列出问题。

**本次只做 P0B-01 工程骨架**，不是一次性完成整个 P0-B。后续 `P0B-02` 起才逐步交付领域状态机、持久 Task Inbox、Worker Lease、Execution Router、FakeSandbox、SSE、Workspace/Checkpoint 等完整业务能力。

## 2. 仓库和 Git 操作规范

已核验的仓库初始状态：私有仓库 `basicv8vc/Ember`，默认分支 `main`；检查时仅有包含项目宣言的 `README.md`，没有其他功能代码。**开始前必须重新读取远端 HEAD、分支、文件和 `git status`**，因为实际仓库可能已经被更新。

1. 阅读仓库里的 `AGENTS.md`、`CONTRIBUTING.md` 等适用指导（如果存在），检查已有配置；保留原有工作和 README 宣言。
2. 以最新的 `main` 为基线，创建 `feature/p0b-01-repository-foundation`。如果同名分支存在，先检查归属与变更，不能覆盖其他人的工作。
3. **严禁直接推送或提交到 `main`**；未经明确授权，不允许删除分支、强推、重写历史、关闭或合并 PR。
4. 修改范围只包含此任务；保持变更可审查。提交信息规范、相互关联的改动可分多个 commit。
5. 远端目标是 **Draft PR → `main`**。如果仓库权限、CI 权限或认证阻止操作，停下报告阻碍；不能绕过受保护流程。

## 3. 技术栈（P0B-01）

| 层              | 选择                                                                  |
| --------------- | --------------------------------------------------------------------- |
| Runtime         | 当前受支持的 Node.js LTS，README 记录实测版本；不要无依据使用实验版本 |
| Language        | TypeScript `strict: true`；ESM 配置一致                               |
| Package manager | pnpm Workspace，明确 packageManager 版本并提交锁文件                  |
| API             | Hono + 官方 Node.js Adapter                                           |
| Database        | 本地 PostgreSQL；通过 `pg` 访问，不引入 ORM                           |
| Validation      | Zod，用于环境变量、必要的配置校验                                     |
| Tests           | Vitest，包含可运行的单测和 PostgreSQL 集成测试                        |
| Quality         | ESLint + Formatter + `tsc --noEmit`                                   |
| Local DB        | `infra/local/compose.yaml`，只提供本地 PostgreSQL                     |
| CI              | GitHub Actions；仅开源依赖和 PostgreSQL Service，无付费密钥           |

注意：`pnpm` 是包管理工具，不是生产运行时；不要把性能目标误写成 pnpm 的运行时性能。

## 4. 实施模块与最小目录

建议采用下面的最小结构，可因实际项目需求做小幅收敛；**不要生成大量空包、空接口或虚假的测试**：

```text
Ember/
  apps/
    api/                   # 可启动的 Hono HTTP 服务
  packages/
    domain/                # 纯领域包占位边界（未来 P0B-02）
    contracts/             # 跨模块契约边界（未来 P0B-02+）
    postgres/              # 最小 DB 连接、migration runner
  infra/
    local/
      compose.yaml         # 本地 PostgreSQL
  migrations/              # 最小迁移体系，不提前设计业务 Schema
  tests/
    unit/
    integration/
  docs/
    P0B-IMPLEMENTATION.md
    P0B-ACCEPTANCE.md
  .env.example
  .gitignore
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig*.json
  README.md
```

具体交付要求：

**A. Workspace / Build**

- 根工作区可以通过 `pnpm install --frozen-lockfile` 完成可复现安装。
- 具备并实际验证：`pnpm lint`、`pnpm typecheck`、`pnpm test:unit`、`pnpm build`。
- 提供 `pnpm dev` 启动 API。不要假称尚未实现的 Worker 已运行；完整 API + Worker 启动归属后续任务。
- 锁定依赖版本、提供合理 `.gitignore`；不要提交 `.env`、用户数据、密钥或本地数据库文件。

**B. API**

- 使用 Hono + Node Adapter，确保 `GET /healthz` 返回 HTTP 200 和最小健康响应。
- `/healthz` 是 **liveness**，不要求数据库在线；可选择额外实现数据库 readiness，但必须明确区分且不可把其结果伪装成 liveness。
- 默认监听 `127.0.0.1`，端口通过已校验的环境变量配置；默认环境模式为 `local`，未经明确配置不得监听 `0.0.0.0`。
- 将 Hono App 的创建逻辑与实际 HTTP Listen 入口分开，保证可以不绑定公网端口进行单测。
- 不需要任务创建 API、SSE、用户认证逻辑（它们属于后续工作包）。

**C. PostgreSQL / Migration**

- 提供本地 PostgreSQL 启动方式：`pnpm dev:db` 可以启动 Docker Compose 的本地 DB，或者 README 同时说明使用已安装的本机 PostgreSQL。
- 提供 `pnpm db:migrate`，从空数据库可执行、重复执行安全（无重复 DDL 错误）。
- 实现最小 migration runner 和 migration 版本表即可；**不要提前设计 P0B-03 的 Task/Run/Event/Artifact Schema**。
- 数据库连接参数从本地环境变量读取，经过必要校验，密码不输出到日志。
- 测试使用独立测试数据库/Schema，严禁清理任何无法明确证明属于测试的资源。

**D. 实际测试**

- 一项有效的 Hono `/healthz` 单元/HTTP 测试（断言状态码和响应）。
- 一项真实 PostgreSQL 集成测试（例如连接、迁移首次执行、重复迁移、检查版本记录），不能用纯 mock 冒充数据库测试。
- 测试应隔离端口、数据库与临时资源；任何环境依赖必须在 README 中说明。
- 若本地缺少 Docker/PostgreSQL，明确报告集成测试未执行，不得将其标记 PASS；可以通过 GitHub Actions PostgreSQL Service 验证。

**E. GitHub Actions**

- 为 PR 配置 CI，执行可复现依赖安装、Lint、Typecheck、Unit Tests、Build 和 PostgreSQL 集成测试。
- PostgreSQL 使用 GitHub Actions 的临时服务容器，不使用生产数据库，不需要云账号或任何商业 API Key。
- CI 使用最小权限；避免记录数据库凭据或敏感环境信息。
- 不设置自动合并、自动发布、生产部署。

**F. Documentation**

- 保留 README 中既有标语：`1000 Agents. 1000 Embers. Only active agents need a flame.`
- README 加入 P0-B 背景、P0B-01 已实现边界、本地 prerequisites、所有已验证命令、所需环境变量示例和故障排查。
- `docs/P0B-IMPLEMENTATION.md` 记录本 PR 的架构取舍与未来模块边界。
- `docs/P0B-ACCEPTANCE.md` 逐条列出本 PR 的验收项、命令和实际通过/失败结果。未完成的 P0B-02～10 不得写成已完成。

## 5. 不允许实施的内容（Non-goals）

- 不实现真实 Sandbox、Firecracker、Playwright、Shell/Python 执行或宿主机任意代码执行。
- 不申请、部署或调用任何付费云资源；不连接 Cloudflare/E2B/Daytona/Boat 付费 Sandbox。
- 不使用真实 LLM、BYOK API Key、OAuth、支付、用户生产数据。
- 不开发 iOS、APNs、Telegram/WhatsApp/飞书等客户端或渠道。
- 不在本 PR 实现 Task/Run 业务 Schema、PG Queue、Worker lease/fencing、Event/SSE、Execution Router、Workspace CAS、Approval/Budget、Crash Recovery。
- 不建设 Kubernetes、Redis/Kafka、生产可观测性平台、多区域架构。
- 不声称 P0B-01 的健康检查或 Mock 测试证明完整 P0-B、Sandbox 安全性、1,000 Agent 生产性能。

## 6. 验收清单 — 全部必须有实际证据

- [ ] 当前仓库状态经核验，没有覆盖其他人的工作；PR 来自独立 feature 分支。
- [ ] `pnpm install --frozen-lockfile` 成功（新项目第一次可先生成锁文件，再执行 frozen 检查）。
- [ ] `pnpm lint` 成功。
- [ ] `pnpm typecheck` 成功（TypeScript strict）。
- [ ] `pnpm test:unit` 成功，包含真实 `/healthz` HTTP 断言。
- [ ] `pnpm build` 成功，生成 Node.js 可运行产物。
- [ ] `pnpm dev` 可在默认 loopback 地址启动，`GET /healthz` 返回 200。
- [ ] `pnpm dev:db` 可启动本地 PostgreSQL（或文档列明等效本机方式）。
- [ ] `pnpm db:migrate` 从空库首次运行成功，第二次重复执行仍成功。
- [ ] `pnpm test:integration` 至少完成真实 PostgreSQL 连接和 Migration 验证。
- [ ] GitHub Actions 工作流实际执行；如 CI 仍在运行或失败，准确记录状态。
- [ ] `.env.example` 不含真实密钥；默认不公开监听；没有新增付费依赖。
- [ ] `git diff --check` 通过；README 与验收报告准确区分已实现和未实现。
- [ ] Draft PR 已创建、描述完整、未合并 `main`。

如有无法通过的条目，标记 **BLOCKED/FAILED**，记录命令、错误、影响与下一步；不得删除失败测试、伪造日志或降低质量门槛。

## 7. 交付方式 / PR 格式

完成后创建 Draft PR，建议标题：

`chore(p0b): establish Ember repository foundation (P0B-01)`

PR 描述必须包含：

1. **Scope**：本 PR 实际实现了什么，以及明确不包含什么。
2. **Architecture**：目录/包边界、Node LTS、PostgreSQL、Migration 的取舍。
3. **Verification**：执行环境（OS/Node/pnpm/PostgreSQL 版本）、实际命令、通过与失败项、GitHub Actions 链接或状态。
4. **Security & Cost**：默认 loopback、本地测试库隔离、无真实密钥、无付费云部署。
5. **Review notes**：与任务书的偏差、已知风险、阻塞与后续 P0B-02 工作。

完成后向我回报：

- 仓库、分支名称、HEAD SHA、Draft PR URL。
- 修改文件概览与关键设计取舍。
- 测试/构建/CI 的**实际结果**（通过数/失败数/未执行项及原因）。
- 与 RFC v0.2 / P0-B Task Spec 的偏差。
- 是否有费用、外部 API、生产数据或意外权限操作（期望均为否）。

## 8. 自主执行与暂停条件

你被授权在上述范围内完成项目初始化、代码修改、必要的本地验证、feature branch 提交和 Draft PR 创建；无需为每个常规文件反复请求确认。**不得**自行扩大到下一工作包。

如遇以下任何情况，请暂停并明确向用户提问：

- 需要付费云、生产凭据、真实 LLM/API Key 或外部服务部署。
- 需要删除/覆盖已有项目内容、强推、修改 `main` 或改变仓库权限/保护设置。
- CI/仓库权限拒绝操作，无法在现有授权内安全推进。
- 上游 RFC 与实际实现出现涉及安全、持久化或架构边界的实质冲突。

**最终交付状态必须是：代码在功能分支，Draft PR Open，`main` 保持未修改且 PR 未合并。**
