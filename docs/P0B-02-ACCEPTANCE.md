# P0B-02 — 验收报告（Domain Models & Task State Machine）

> 本文件只记录**实际执行过**的命令与结果。未执行或未实施的项目明确标记为
> `NOT RUN` / `DEFERRED`，不计入通过。
> 本 PR **不**声称 P0B-03～P0B-10 已完成，也不声称 HTTP API、Worker、Sandbox 或数据库业务表已实现。

## 1. 执行环境

| 项目       | 值                                                             |
| ---------- | -------------------------------------------------------------- |
| 日期       | 2026-10-27（本地时区 UTC+8）                                   |
| OS         | macOS (Darwin 25.3.0, arm64)                                   |
| Node.js    | v24.22.1（LTS "Krypton"，与 `.nvmrc` 一致）                    |
| pnpm       | 12.15.0（`packageManager` 固定）                               |
| TypeScript | 5.9.3，`strict: true`                                          |
| Zod        | 4.6.7                                                          |
| Vitest     | 5.0.5                                                          |
| PostgreSQL | 17（Docker `postgres:17-alpine`，容器 `ember-local-postgres`） |
| Docker     | Docker Desktop / Compose v2（本地 PostgreSQL 仅 loopback）     |
| Base       | `main` @ `a169d802c6a46ffd64d22aa0af81a902b52c679c`            |
| 分支       | `feature/p0b-02-domain-state-machine`                          |

`package.json` 的 `engines` 仍为 `>=24 <25`；本机执行命令时使用 Node 24.22.1，
没有升级或替换既有工具链。

## 2. 交付前仓库状态核验

| 检查            | 命令                                                       | 结果                                                                              |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 当前分支 / HEAD | `git status`、`git rev-parse HEAD`                         | 从 `main` @ `a169d80` 创建 feature 分支；`main` 未修改                            |
| 远端            | `git fetch origin --prune && git ls-remote --heads origin` | `main` @ `a169d80`；未覆盖其他分支                                                |
| 指导文件        | 查找 `AGENTS.md` / `CONTRIBUTING.md`                       | 仓库中不存在，无额外流程                                                          |
| P0B-01 合并状态 | `git log --oneline -5 origin/main`                         | `a169d80 chore(p0b): establish Ember repository foundation` 已在 `main`           |
| 工作区          | `git status --short`                                       | 仅有预期的 P0B-02 变更；4 个本地参考 Markdown 未提交（被 `.prettierignore` 忽略） |

## 3. 验收命令与结果

所有命令均在仓库根目录执行；`P` 代表
`node ~/.cache/node/corepack/v1/pnpm/12.15.0/bin/pnpm.mjs`（本机 pnpm 12.15.0）。

| #   | 命令                             | 实际结果                                                                                                             | 状态     |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `pnpm install --frozen-lockfile` | `Lockfile is up to date`，0 错误；新增两个 workspace importer 已写入 lockfile                                        | **PASS** |
| 2   | `pnpm lint`                      | `eslint .` 退出码 0，无 error/warning                                                                                | **PASS** |
| 3   | `pnpm format:check`              | `All matched files use Prettier code style!`                                                                         | **PASS** |
| 4   | `pnpm typecheck`                 | `tsc -p tsconfig.json` 退出码 0（strict，包含新包与测试）                                                            | **PASS** |
| 5   | `pnpm test:unit`                 | 7 个文件 / **239** 个测试全部通过（P0B-01 的 37 个 + P0B-02 新增 202 个）                                            | **PASS** |
| 6   | `pnpm build`                     | `tsc -b tsconfig.build.json` 退出码 0；生成 domain/contracts/postgres/api dist                                       | **PASS** |
| 7   | `pnpm test:integration`          | 1 个文件 / **6** 个测试通过（真实 PostgreSQL 17）                                                                    | **PASS** |
| 8   | `git diff --check`               | 无空白错误                                                                                                           | **PASS** |
| 9   | `pnpm db:migrate`（连续两次）    | 现有 `0001_platform_metadata.sql` 均成功；第二次 `0 applied, 1 already applied`                                      | **PASS** |
| 10  | 构建后 ESM 消费                  | `node` 直接 `import('./packages/domain/dist/index.js')` 与 `contracts/dist/index.js`，状态转换、Schema、DTO 正常工作 | **PASS** |
| 11  | 现有 API 行为回归                | 构建产物启动于 `127.0.0.1:8799`：`/healthz` 200、`/readyz` 200（DB up）                                              | **PASS** |
| 12  | GitHub Actions                   | run [40507205145](https://github.com/basicv8vc/Ember/actions/runs/40507205145) — success（代码 HEAD `3191aa3`）      | **PASS** |

### 3.1 单元测试实际输出

```text
$ pnpm test:unit
 RUN  v5.0.5 /Users/a1-6/Downloads/Ember

 Test Files  7 passed (7)
      Tests  239 passed (239)
   Duration  302ms
```

P0B-02 新增 4 个测试文件：

- `tests/unit/task-state-machine.test.ts`
  - 独立编码的 11 条合法边；
  - 7×7 完整矩阵中的 38 条非法边；
  - 三个终态分类、终态无出边、`queued → completed` / `waiting_approval → completed` /
    `retryable_failed → completed` 跳跃拒绝；
  - 同状态赋值显式拒绝；
  - `INVALID_STATE_TRANSITION` 稳定错误码与 `entity/from/to`；
  - 转换表 frozen、重复调用确定性。
- `tests/unit/run-state-machine.test.ts`
  - 6 条合法边、7×7 矩阵中的 43 条非法边；
  - 五个 Run 终态、终态不可重跑；
  - `lease_expired → succeeded` 显式拒绝；
  - `created` 不能直接到终态；同状态拒绝；表 frozen。
- `tests/unit/task-schemas.test.ts`
  - 4 种合法 TaskKind/Input、未知 kind；
  - 缺少/多余字段、跨 kind 错误 input、非法 UUID、超长字段、非法 Deadline；
  - `mock.file` 绝对路径、反斜杠、`..`、空段、媒体类型参数；
  - 客户端伪造 tenant/principal/status/lease/idempotency 字段被 strict Schema 拒绝；
  - Header Key 长度/字符、wire snake_case → 内部 camelCase 映射；
  - TaskReceipt 内部/DTO、校验错误不泄露原始值、issue 数量上限。
- `tests/unit/domain-contracts.test.ts`
  - 15 个领域错误码（含扩展 `INVALID_STATE_TRANSITION`）完整性与唯一性；
  - 每个 code 的 retryability、固定 public message、`toJSON`；
  - `publicMessage` / `diagnostic` 分离：DB 密码、API Token、SQL 错误和宿主路径只存在于内部诊断，
    不出现在 `message`、`toJSON()`、`toErrorResponse()` 或 `JSON.stringify(error)`；
  - `isDomainError` 不依赖消息文本；
  - `ErrorResponse` 严格 Schema 与 `toErrorResponse`；
  - TaskEvent 固定 payload allowlist、敏感键/伪装秘密/嵌套/null 负向用例、DTO 映射与运行时篡改 fail closed；
  - `TaskRepository` / `LeaseQueue` / `ExecutionRouter` / `ArtifactStore` /
    `WorkspaceStore` / `SandboxProvider` 签名的编译期断言。

### 3.2 集成测试实际输出

```text
$ pnpm test:integration
 RUN  v5.0.5 /Users/a1-6/Downloads/Ember

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  205ms
```

集成测试仍使用 P0B-01 的隔离方式：每次运行创建 `ember_it_<12 hex>` schema，只迁移和断言该
schema，结束后只 DROP 本次创建的 schema。没有 TRUNCATE/DROP 开发者其他数据。

### 3.3 迁移与 API 回归

```text
$ pnpm db:migrate
running migrations from /Users/a1-6/Downloads/Ember/migrations
database: 127.0.0.1:55432/ember
migrations complete: 0 applied, 1 already applied   # 本地卷已有 P0B-01 迁移

$ pnpm db:migrate
migrations complete: 0 applied, 1 already applied

# 构建产物 + 本地 PostgreSQL
$ EMBER_PORT=8799 node --env-file-if-exists=.env.local apps/api/dist/index.js
GET /healthz -> 200 {"status":"ok","service":"ember-api",...}
GET /readyz  -> 200 {"status":"ready","checks":{"database":{"status":"up",...}}}
```

启动日志仍只包含白名单数据库元数据：

```json
{
  "level": "info",
  "message": "api listening",
  "service": "ember-api",
  "env": "local",
  "host": "127.0.0.1",
  "port": 8799,
  "database": { "host": "127.0.0.1", "port": 55432, "database": "ember" }
}
```

### 3.4 构建产物 ESM 消费

```text
$ node --input-type=module -e "
    const domain = await import('./packages/domain/dist/index.js');
    console.log('domain:', domain.transitionTask('queued', 'running'),
                domain.isTerminalTaskStatus('completed'));
    const contracts = await import('./packages/contracts/dist/index.js');
    ...
  "
domain: running true
contracts: mock.compute sha256 22222222-2222-4222-8222-222222222222
```

这验证了 `tsc -b` 产物在 Node ESM/NodeNext 下可直接消费，且不依赖 Vitest alias。

## 4. B-T01～B-T04 实施状态

| ID        | 本阶段范围                                       | 状态                 | 证据 / 说明                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-T01** | 任务输入 Schema 与 TaskKind 校验的**纯逻辑部分** | **PASS（限定范围）** | `tests/unit/task-schemas.test.ts`：合法/非法 kind、每种 mock input、缺失/多余字段、UUID、Deadline、超长、伪造 Tenant/Principal。未启动 HTTP/DB，符合纯逻辑范围。完整“非法输入返回 4xx”属于 P0B-07，**DEFERRED**，不在本 PR 声称完成。 |
| **B-T02** | Fast/Standard Router                             | **DEFERRED**         | 仅提供 `ExecutionRouter`、`RouteDecision`、`ExecutionPath` 契约；没有 Router 实现，因此没有伪造测试通过。实际执行 P0B-05。                                                                                                            |
| **B-T03** | FakeSandbox 未知命令拒绝                         | **DEFERRED**         | 仅提供 `SandboxProvider`、`SandboxCapabilities`、`SandboxSpec` 契约；没有 FakeSandbox，也没有 host shell。实际执行 P0B-05。                                                                                                           |
| **B-T04** | Task 状态机非法转换统一拒绝并返回错误码          | **PASS**             | 完整 7×7 矩阵测试；非法转换统一抛 `InvalidStateTransitionError`，`code = INVALID_STATE_TRANSITION`；终态不可恢复；同状态显式拒绝。                                                                                                    |

`B-T02`/`B-T03` 的契约准备不等于测试通过。本报告没有把接口存在当作行为证据。

## 5. 验收清单逐项结果

| #   | 验收项                                     | 结果                                                                 |
| --- | ------------------------------------------ | -------------------------------------------------------------------- |
| 1   | 新增 `@ember/domain` 与 `@ember/contracts` | **PASS**                                                             |
| 2   | 两个包不存在循环依赖                       | **PASS**（domain 无外部依赖；contracts 只依赖 domain + zod）         |
| 3   | TaskStatus / RunStatus 与 RFC、任务书一致  | **PASS**                                                             |
| 4   | 合法 Task/Run 转换全部实现                 | **PASS**（独立编码的边表 + 全矩阵测试）                              |
| 5   | 非法转换全部被拒绝                         | **PASS**                                                             |
| 6   | Terminal State 不变量成立                  | **PASS**                                                             |
| 7   | 状态机无数据库/网络/时间/隐式副作用        | **PASS**（无 I/O import；表 frozen；重复调用确定性测试）             |
| 8   | 领域错误码统一且稳定                       | **PASS**（15 个 code；`toJSON` 安全字段）                            |
| 9   | TaskKind 与输入 Schema 完整                | **PASS**                                                             |
| 10  | 非法输入无法通过边界校验                   | **PASS**（strict object；负向用例）                                  |
| 11  | AuthContext 与客户端输入边界明确           | **PASS**（Body 无 tenant/principal；Header Key 独立）                |
| 12  | TypeScript strict typecheck                | **PASS**                                                             |
| 13  | 根目录 Build 成功                          | **PASS**                                                             |
| 14  | 新旧单元测试全部通过                       | **PASS**（239/239，包含 P0B-01 的 37 个）                            |
| 15  | PostgreSQL 集成测试无回归                  | **PASS**（6/6）                                                      |
| 16  | CI 全部通过                                | **PASS**（代码 HEAD run 40507205145）                                |
| 17  | 文档完整准确                               | **PASS**（本文件 + `P0B-02-IMPLEMENTATION.md`）                      |
| 18  | 未扩大到 P0B-03～P0B-05 实现范围           | **PASS**（无业务表、无 Repo、无 Worker、无 Router/FakeSandbox 实现） |
| 19  | 无真实凭据、外部模型调用或付费云开销       | **PASS**（仅本地 Docker PostgreSQL 与开源 npm 依赖）                 |
| 20  | PR 为 Draft、未合并 `main`                 | **PASS**（PR #2，`isDraft: true`，`state: OPEN`）                    |

## 6. 未实现范围（不计入通过）

- PostgreSQL Task/Run/Event/Artifact 业务表与 Migration；
- `TaskRepository`、`LeaseQueue` 的真实数据库实现；
- Idempotent Task Creation、摘要与并发冲突处理；
- Worker、Task Queue、Lease、Fencing、Retry 调度；
- Execution Router 决策引擎、FakeLLM、FakeSandbox；
- ArtifactStore / WorkspaceStore / Checkpoint；
- `/v1/tasks`、`/v1/agents`、SSE、Tenant AuthZ、Approval、Budget；
- HTTP 4xx 状态码映射与 `request_id` 注入；
- 真实 LLM、OAuth、BYOK、云 Sandbox、Kubernetes/Redis/Kafka；
- 1,000 Agent 负载、Chaos、端到端性能与成本验证。

这些项目在状态表中均为 `DEFERRED` / `NOT RUN`，不用 TODO 或空实现冒充通过。

## 7. GitHub Actions / Draft PR

| 项目                 | 值                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 分支                 | `feature/p0b-02-domain-state-machine`                                                                                              |
| 已验证代码 HEAD      | `3191aa30ae580ff9528d6bbad2ffcb13ef160e8a`                                                                                         |
| Draft PR             | <https://github.com/basicv8vc/Ember/pull/2>（`isDraft: true`，`state: OPEN`，base `main`；未合并）                                 |
| CI 运行（代码 HEAD） | [40507205145](https://github.com/basicv8vc/Ember/actions/runs/40507205145) — **success**（`3191aa3`，Node 24 LTS + PostgreSQL 17） |
| CI 步骤              | frozen install → lint → format check → typecheck → unit tests → build → `db:migrate` ×2 → integration tests，全部 ✓                |
| CI 环境              | 临时 `postgres:17-alpine` service container，`permissions: contents: read`，无 secrets、无部署                                     |
| `main` 状态          | 未修改（`a169d80`）、未合并                                                                                                        |

历史运行：[40506386450](https://github.com/basicv8vc/Ember/actions/runs/40506386450)（`1601a87`）与
[40506715013](https://github.com/basicv8vc/Ember/actions/runs/40506715013)（`cc6062e`）均为 success。
CI 中唯一提示是 `ubuntu-latest` 将于 2026-10-19 后迁移到 Ubuntu 26 镜像，不是失败项。
本报告更新提交为 docs-only；其最新 CI 结果见 PR Checks 页面。

## 8. 已知风险与后续建议

1. **纯状态机不等于分布式保证**：`transitionTask`/`transitionRun` 通过只代表内存中的纯规则通过；
   DB 事务、Lease Epoch、Fencing、Deadline、审批超时仍由 P0B-04/P0B-08 实现并测试。
2. **OQ-1（重试等待期间取消）**：`retryable_failed → cancelled` 未加入；需在 P0B-08 前由 CTO 决定。
   本 PR 不擅自扩展已审核状态图。
3. **OQ-2（`waiting_external`）**：按任务书排除在 P0-B 之外；若未来加入，需要新的状态、事件和回调
   去重模型，不能简单复用 `waiting_approval`。
4. **`mock.file` 只是逻辑 Key**：真正的路径隔离、符号链接防护、跨 Tenant 文件访问仍待 P0B-06；
   当前 Schema 只能阻止明显的绝对路径与 `..` 输入。
5. **错误码到 HTTP 的映射未实现**：`ErrorResponse` 只有形状；P0B-07 需要定义 400/401/404/409/429/500
   等映射，并保持 `request_id` 服务端生成。
6. **CI 仅覆盖 Linux**：本地 macOS 上的 Node 24 与 Docker PostgreSQL 17 已实测；其他平台未验证。
7. **Idempotency Key 格式**：采用 8–128 字符的保守可见 ASCII token 规则；若未来客户端需要更长或
   二进制 Key，需要重新评审，而不是放宽到任意字符串。

## 9. 安全与成本

- 没有使用真实 API Key、OAuth Token、生产数据或付费云服务。
- 没有调用 LLM、Sandbox Provider 或外部收费 API。
- 没有实现宿主机 Shell/Python/Playwright 执行；`mock.compute` 只接受白名单 `sha256`。
- 本地 PostgreSQL 仅绑定 `127.0.0.1:55432`；`.env.local` 被 `.gitignore` 忽略。
- 新依赖只有 workspace 包与既有 `zod@4.6.7`，没有引入网络/云 SDK。
- 本阶段产生的唯一成本为本地机器资源。

## 10. Review Round 1 修复记录

| 编号 | 问题                                                                                                                           | 修复                                                                                                                                                                                                                                               | 证据                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | `DomainError` 接受任意自定义文本，`toJSON()` / `toErrorResponse()` 直接输出该文本，可能泄露 DB 密码、API Token、SQL 或宿主路径 | `DomainError.message` 改为按 `code` 固定的安全 `publicMessage`；内部诊断改存 `WeakMap`，仅通过显式 `error.diagnostic` 读取，不参与枚举/序列化。`toJSON()` 和 `toErrorResponse()` 只使用 `publicMessage`；公开消息上限独立为 512，内部诊断上限 2048 | 新增负向测试：同一 `DomainError` 的 `diagnostic` 含 DB 密码、Bearer Token、SQL 与 `/Users/...` 宿主路径时，`message`、`publicMessage`、`JSON.stringify(error)`、`toJSON()`、`toErrorResponse()` 均不包含这些值；`Object.keys(error)` 不含 `diagnostic`                                                                          |
| P1-2 | `TaskEventPayloadSchema` 只限制形状/长度，无法阻止任意 Prompt、Token、API Key 或工具输出通过字符串值进入 Event Payload         | 改为**封闭 allowlist**：只有 16 个字段，全部是枚举、UUID、非负整数或布尔值，没有自由文本字段；`z.strictObject` 拒绝所有其他键。`toTaskEventDto()` 在映射前重新解析完整事件，运行时篡改对象 fail closed                                             | 新增负向测试：`prompt`/`messages`/`token`/`apiKey`/`authorization`/`toolOutput`/`stdout`/`stderr`/`content`/`text`/`sql`/`password`/`path`/`stack`/`input`/`output` 等键被拒绝；秘密塞入 `taskKind`/`runId`/`errorCode` 等允许字段也被拒绝；嵌套/数组/null 和 100,000 字符未知键被拒绝；`TASK_EVENT_PAYLOAD_KEYS` 固定并 frozen |

修复后单元测试从 235 增至 **239**，全部通过；没有降低类型检查或删除原有测试。

## 11. 最终结论

P0B-02 的领域层与契约层实现、单元测试、构建、真实 PostgreSQL 集成测试与 CI 均通过。
Draft PR 已创建且未合并；B-T01（纯逻辑范围）与 B-T04 为 **PASS**，B-T02/B-T03 明确为
**DEFERRED**，没有用接口或假实现冒充通过。P0B-03～P0B-10 仍未实现。

本 PR 可以提交 CTO Code Review；在 Review 完成前不进入 P0B-03，也不合并 `main`。
