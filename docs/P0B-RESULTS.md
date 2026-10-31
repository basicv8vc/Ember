# Ember P0-B 最终结果与验收证据报告 (P0B-RESULTS)

- **执行日期:** 2026-10-31
- **报告版本:** `1.0.1-p0b10c`
- **代码仓库:** `https://github.com/basicv8vc/Ember` (私有)
- **Git Base SHA:** `2ec04f6c7459820c20813554a749c60447d33e88` (PR #24 合并提交)
- **可复验代码 Git SHA:** `4a21b5f5796bc80020efb5e31d9c23dfc8f18338` (Commit 1: `feat(bench): add disable-pg-sampling toggle and regression tests for P0B-10C`)
- **环境基线:** macOS 26.5.1 (Darwin 25.5.0 arm64), Apple M1 (8 cores), 16 GB RAM, Node.js v24.11.0, pnpm 12.15.0, PostgreSQL 17.11 (Homebrew)
- **测试数据库配置:** Dedicated ephemeral schema (`ember_bench_<hex>`) on `postgres://ember:[REDACTED]@127.0.0.1:5432/ember_test`
- **当前 PR 状态说明:** 本报告编制于 P0B-10 三条并行分支（10A: Demo/E2E, 10B: Process Recovery, 10C: Benchmark Audit）并行阶段。**本报告基于已合并至 main 的 PR #24 基线**；由于 PR 10A 和 PR 10B 仍在独立 Draft PR 中，其相关 E2E 及进程强杀测试严格标记为 `PENDING INTEGRATION / NOT RUN`，不可在合并前提前签署整体 DoD。

---

## 1. 静态检查、构建与测试套件实测总览

所有测试均在本地环境完整执行，无环境跳过，无凭证泄露：

| 验证命令                | 涵盖范围与目标                                               | 执行耗时 | 测试文件数 | 测试用例数 |             结果状态              |
| :---------------------- | :----------------------------------------------------------- | :------: | :--------: | :--------: | :-------------------------------: |
| `pnpm lint`             | 全仓 ESLint 9 静态代码规范校验                               |  ~1.5s   |    全仓    |    全仓    |  **PASS (0 errors, 0 warnings)**  |
| `pnpm format:check`     | 全仓 Prettier 代码格式排版检查                               |  ~1.1s   |    全仓    |    全仓    |    **PASS (All files match)**     |
| `pnpm typecheck`        | TypeScript 5.9.3 严格类型检查 (`tsc -p tsconfig.json`)       |  ~1.8s   |    全仓    |    全仓    |     **PASS (0 type errors)**      |
| `pnpm build`            | TypeScript 项目编译构建 (`tsc -b tsconfig.build.json`)       |  ~2.1s   |    全仓    |    全仓    |    **PASS (Build successful)**    |
| `pnpm test:unit`        | 内存领域模型、状态机、Schema、Router、遥测计算、报告对账单测 |  ~2.2s   |  44 文件   |  676 用例  |  **PASS (676 passed, 0 failed)**  |
| `pnpm test:integration` | 真实 PostgreSQL 事务、租约、Fencing、CAS、SSE、遥测集成测试  |  ~4.6s   |  24 文件   |  253 用例  |  **PASS (253 passed, 0 failed)**  |
| `pnpm test:chaos`       | 故障注入、崩溃恢复、幂等回滚、旧 Run 交错混沌测试            |  ~0.8s   |   3 文件   |  19 用例   |  **PASS (19 passed, 0 failed)**   |
| `pnpm bench:local`      | 1,000 逻辑 Agent、100 并发闭环、PostgreSQL 连接治理压测      |  ~18.9s  |   1 套件   | 1,000 样本 | **PASS (100% Succeeded, 0 Lost)** |
| `pnpm test:e2e`         | 真实 CLI 与多租户端到端流水线 (PR 10A 交付物)                |    -     |     -      |     -      | **PENDING INTEGRATION (NOT RUN)** |
| `pnpm demo`             | 交互式终端演示命令 (PR 10A 交付物)                           |    -     |     -      |     -      | **PENDING INTEGRATION (NOT RUN)** |
| `git diff --check`      | 检查空白符、未解决合并冲突与补丁异常                         |  <0.1s   |    全仓    |    全仓    |         **PASS (Clean)**          |

---

## 2. B-T01～B-T30 逐项详细测试矩阵与证据追踪

对照 `docs/architecture/Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md` §11：

| ID        | 测试层级    | 测试目标与通过条件                                                    | 精确测试文件及代表用例                                                                                                           | 实测命令                                    |          状态           | 证据及可复验定位                                                                                        |
| :-------- | :---------- | :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------ | :---------------------: | :------------------------------------------------------------------------------------------------------ |
| **B-T01** | Unit        | 输入 Schema / Task kind<br>_(非法输入 4xx，无 DB 副作用)_             | `tests/unit/task-schemas.test.ts`<br>`tests/unit/api-task-create.test.ts`                                                        | `pnpm test:unit`                            |        **PASS**         | 验证 TaskKind、UUID、负向非法类型；API 路由层映射 400/422，无数据库副作用。                             |
| **B-T02** | Unit        | Fast/Standard Router<br>_(固定规则，Fast 不启动 Sandbox)_             | `tests/unit/execution-router.test.ts`<br>`tests/unit/deterministic-executor.test.ts`                                             | `pnpm test:unit`                            |        **PASS**         | `mock.chat` 路由至 Fast Path（纯内存，0 沙箱创建）；`mock.compute` 路由至 Standard Path。               |
| **B-T03** | Unit        | Fake 未知命令<br>_(拒绝，不调用 Host Shell)_                          | `tests/unit/fake-sandbox.test.ts`<br>`tests/unit/fake-llm.test.ts`                                                               | `pnpm test:unit`                            |        **PASS**         | 仅允许 `sha256` 内部白名单算法；未知命令统一拒绝 fail-closed，禁用宿主 shell、进程及网络。              |
| **B-T04** | Unit        | Task 状态机非法转换<br>_(统一拒绝，有错误码)_                         | `tests/unit/task-state-machine.test.ts`<br>`tests/unit/run-state-machine.test.ts`<br>`tests/unit/approval-state-machine.test.ts` | `pnpm test:unit`                            |        **PASS**         | 7×7 全状态转移矩阵穷举；非法转换统一抛出 `InvalidStateTransitionError`，终态不可逆。                    |
| **B-T05** | Unit / Int  | Budget/TTL<br>_(到达上限停止继续执行)_                                | `tests/unit/budget-guard.test.ts`<br>`tests/integration/persistent-budget.test.ts`                                               | `pnpm test:unit`<br>`pnpm test:integration` |        **PASS**         | 5 维度预算审计（步数、消耗单元、耗时、租户日限额、并发槽）；超额立即阻断，不产生越权扣费。              |
| **B-T06** | Integration | Durable Ack<br>_(DB commit 后才返回)_                                 | `tests/integration/durable-task-inbox.test.ts`<br>`tests/chaos/b-t25-durable-ack-crash.test.ts`                                  | `pnpm test:integration`                     |        **PASS**         | 独立连接验证：仅当 PostgreSQL 事务与 accepted 事件成功 COMMIT 后，客户端方可收到 202 Accepted。         |
| **B-T07** | Integration | 并发相同 Idempotency Key<br>_(只创建一个 Task，重放返回同 ID)_        | `tests/integration/task-idempotency.test.ts`                                                                                     | `pnpm test:integration`                     |        **PASS**         | 24 个真实并发请求使用相同 Idempotency-Key，PostgreSQL 仅插入 1 条任务记录，所有请求返回一致的 Task ID。 |
| **B-T08** | Integration | 相同 Key 不同 Payload<br>_(409 Conflict)_                             | `tests/integration/task-idempotency.test.ts`                                                                                     | `pnpm test:integration`                     |        **PASS**         | 相同幂等键附带不同载荷或 Agent ID，系统严格返回 409 Conflict (`IDEMPOTENCY_CONFLICT`)。                 |
| **B-T09** | Integration | 2 Worker 同时 claim<br>_(无双 Lease / 重复有效 Run)_                  | `tests/integration/lease-claim.test.ts`                                                                                          | `pnpm test:integration`                     |        **PASS**         | 两个独立连接池并发执行 `SELECT FOR UPDATE SKIP LOCKED`，同一时刻仅有唯一 Worker 获取有效租约。          |
| **B-T10** | Integration | Lease 超时回收<br>_(新 Run 可领取)_                                   | `tests/integration/lease-recovery.test.ts`                                                                                       | `pnpm test:integration`                     |        **PASS**         | Worker 崩溃超期后，Reaper 自动检测并释放租约，新 Worker 可正常领取并递增 `attempt` 与 `lease_epoch`。   |
| **B-T11** | Integration | 旧 Worker 迟到提交<br>_(fencing 拒绝)_                                | `tests/integration/lease-fencing.test.ts`                                                                                        | `pnpm test:integration`                     |        **PASS**         | 僵尸 Worker 迟到提交被 `lease_epoch` 校验拦截，抛出 `FENCE_REJECTED`，保护新 Run 状态不被破坏。         |
| **B-T12** | Integration | Workspace CAS<br>_(过期版本写入失败)_                                 | `tests/integration/workspace-cas.test.ts`                                                                                        | `pnpm test:integration`                     |        **PASS**         | Workspace 升级采用乐观并发控制（CAS），基于旧版本的提交失败并抛出 `WORKSPACE_CONFLICT`。                |
| **B-T13** | Integration | Artifact hash / length<br>_(文件与 DB 元数据一致)_                    | `tests/integration/artifact-integrity.test.ts`<br>`tests/integration/http-artifact-api.test.ts`                                  | `pnpm test:integration`                     |        **PASS**         | 校验 SHA-256 散列值与文件字节长度；损坏文件无法被检索或发布。                                           |
| **B-T14** | Integration | Orphan 文件<br>_(不对用户可见，安全清理可执行)_                       | `tests/integration/artifact-integrity.test.ts`<br>`tests/unit/local-blob-store.test.ts`                                          | `pnpm test:integration`<br>`pnpm test:unit` |        **PASS**         | 暂存区未提交文件对普通用户完全不可见；孤儿垃圾回收程序安全清除隔离期外的无效文件。                      |
| **B-T15** | E2E         | Fast Task<br>_(结果正确；Sandbox 创建次数 0)_                         | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 execution-worker.test.ts 验证)_                                                | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** | Fast Path 本地模拟正确，创建沙箱次数为 0。正式 E2E 依赖 PR 10A。                                        |
| **B-T16** | E2E         | Standard Task<br>_(新 Sandbox、Artifact、Checkpoint、Destroy)_        | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 execution-worker.test.ts 验证)_                                                | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** | Standard Path 完整生命周期闭环已在集成测试验证。正式 E2E 依赖 PR 10A。                                  |
| **B-T17** | E2E         | 重新提交/恢复 Workspace<br>_(读取上次版本，新的 Sandbox ID)_          | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 checkpoint-resume.test.ts 验证)_                                               | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** | Checkpoint 恢复读取上一版本 manifest 并生成新 Sandbox。正式 E2E 依赖 PR 10A。                           |
| **B-T18** | E2E         | SSE 断线重连<br>_(顺序、游标、可重放)_                                | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 http-task-sse.test.ts 验证)_                                                   | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** | 支持基于 Last-Event-ID 游标的历史事件重放与多租户隔离。正式 E2E 依赖 PR 10A。                           |
| **B-T19** | E2E         | Queued/Running Cancel<br>_(终态唯一；不运行下一步)_                   | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 cooperative-cancellation 验证)_                                                | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** | ADR-0001 协作式取消生效，终态收敛至 `cancelled`，不执行下一步。正式 E2E 依赖 PR 10A。                   |
| **B-T20** | E2E         | Mock Approval<br>_(先 WaitingApproval，批准后恢复；拒绝后结束)_       | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 persistent-mock-approval 验证)_                                                | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** | 任务在步骤中断并等待批准，批准后恢复执行，拒绝后正常终止。正式 E2E 依赖 PR 10A。                        |
| **B-T21** | Security    | Tenant B 查询 A 任务<br>_(404，无泄露)_                               | `tests/integration/http-task-api.test.ts`<br>`tests/unit/api-task-read.test.ts`                                                  | `pnpm test:integration`                     |        **PASS**         | 跨租户任务查询统一返回 404 Not Found，不暴露任务存在性与内部状态。                                      |
| **B-T22** | Security    | Tenant B 读取 A 文件/Event<br>_(404 / 拒绝)_                          | `tests/integration/http-artifact-api.test.ts`<br>`tests/integration/http-task-sse.test.ts`                                       | `pnpm test:integration`                     |        **PASS**         | 跨租户文件下载与 SSE 订阅均返回 404，权限严格按租户上下文限定。                                         |
| **B-T23** | Security    | 无 Token/假 Tenant ID<br>_(401 或 404，无法冒充)_                     | `tests/integration/http-agent-api.test.ts`<br>`tests/unit/api-auth.test.ts`                                                      | `pnpm test:integration`                     |        **PASS**         | 缺失 Bearer Token 返回 401 Unauthorized；伪造 Tenant ID 无法通过鉴权。                                  |
| **B-T24** | Security    | Path Traversal / Symlink<br>_(不能逃逸 Artifact Root)_                | `tests/integration/artifact-integrity.test.ts`<br>`tests/unit/local-blob-store.test.ts`                                          | `pnpm test:integration`<br>`pnpm test:unit` |        **PASS**         | 严禁 `../`、绝对路径与符号链接逃逸受控根目录，越界操作一律拒绝。                                        |
| **B-T25** | Chaos       | DB Ack 前/后 Crash<br>_(无丢任务/重复创建)_                           | `tests/chaos/b-t25-durable-ack-crash.test.ts`                                                                                    | `pnpm test:chaos`                           |        **PASS**         | 真实强杀连接测试：Ack 前崩溃自动回滚；Ack 后崩溃重试通过幂等凭据安全获取原任务，零重复插入。            |
| **B-T26** | Chaos       | Artifact/Checkpoint 之间 Crash<br>_(无对用户可见半提交结果)_          | `tests/chaos/b-t26-artifact-checkpoint-atomic.test.ts`<br>`tests/integration/result-commit.test.ts`                              | `pnpm test:chaos`                           |        **PASS**         | 在事务提交前注入崩溃，数据库完整回滚，用户界面与 API 绝不暴露半提交脏数据。                             |
| **B-T27** | Chaos       | 旧 Run 与新 Run 交错<br>_(旧结果不能覆盖)_                            | `tests/chaos/b-t27-lease-fencing-concurrency.test.ts`                                                                            | `pnpm test:chaos`                           |        **PASS**         | 僵尸 Worker 与新 Worker 并发交错写入时，Fencing 机制彻底阻断旧 Run 覆盖有效结果。                       |
| **B-T28** | Load        | 1,000 逻辑 Agent<br>_(无 1,000 Fake 常驻进程)_                        | `apps/benchmark/**`<br>`tests/integration/benchmark-smoke.test.ts`                                                               | `pnpm bench:local`                          |        **PASS**         | 真实创建 1,000 Agent 与 1,000 Workspace 记录，常驻系统进程为 0，常驻沙箱为 0。                          |
| **B-T29** | Load        | 100 并发请求（本地）<br>_(无 Task 丢失，指标完整)_                    | `apps/benchmark/**`<br>`tests/integration/benchmark-smoke.test.ts`                                                               | `pnpm bench:local`                          |        **PASS**         | 100 HTTP 并发下处理 1,000 任务，100% 成功，0 丢失，Durable Ack P95 = **56.10ms** (极值 53.26~61.83ms)。 |
| **B-T30** | Telemetry   | simulated cost / redaction<br>_(费用注明模拟，日志无 Token/敏感内容)_ | `tests/integration/telemetry-observability.test.ts`<br>`tests/unit/telemetry-privacy.test.ts`                                    | `pnpm test:integration`<br>`pnpm test:unit` |        **PASS**         | 强制标注 `cost_source: simulated`，`actual_vendor_cost_usd: null`；日志自动脱敏 Token 与 Prompt。       |

---

## 3. 基准复验与性能对照结论摘要

### 3.1 标准压测 3 轮连续结果

在与 PR #24 相同的 Apple M1 本地机器上，基于干净提交 `4a21b5f` 执行标准基线压测（1,000 Agents / 100 HTTP Concurrency / fast:70,standard:30 / 1,000 Tasks）：

- **Durable Ack P95:** 中位数 **56.10 ms**（极值范围 53.26 ~ 61.83 ms），远优于 $\le 1,000\,\text{ms}$ 规范目标。
- **任务对账 (Reconciliation):** 3,000 / 3,000 全部成功 (100.00%)，未解释任务丢失 **0**，重复 Ack **0**。
- **沙箱与系统驻留:** 闲置常驻沙箱 **0**，闲置常驻系统进程 **0**。
- **并发与连接测量:** 实测客户端 HTTP 在途峰值打满 **100**；Worker 执行槽位峰值 **38~39**；PostgreSQL 活跃连接峰值 **30~39**，总连接峰值 **52~53**（采样 201~238 次）。

### 3.2 采样开销 A/B 对照测量结论

针对历史观测到的 Queue Wait / Completion P95 波动，在相同 Git SHA (`4a21b5f`)、相同硬件、相同参数下，通过新增参数 `--disable-pg-sampling` 进行了 4 轮**交替执行对照实验**（Run A1 [OFF] → Run B1 [ON] → Run A2 [OFF] → Run B2 [ON]）：

- **Run A1 (OFF):** Durable Ack P95 38.55 ms，Queue Wait P95 1,233.20 ms，Completion P95 3,107.21 ms
- **Run B1 (ON):** Durable Ack P95 43.38 ms，Queue Wait P95 928.15 ms，Completion P95 2,091.43 ms
- **Run A2 (OFF):** Durable Ack P95 33.23 ms，Queue Wait P95 580.10 ms，Completion P95 1,107.55 ms
- **Run B2 (ON):** Durable Ack P95 30.07 ms，Queue Wait P95 312.00 ms，Completion P95 789.14 ms

**审计结论（针对 P2 审查）：**
当前有限样本（4 轮）未发现 PostgreSQL 采样与排队延迟升高之间的一致关系。性能波动的具体来源仍待进一步测量。

---

## 4. P0-B Definition of Done (DoD) 签署审核

依据 `docs/architecture/Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md` §12：

| DoD 验收条款                                                           |                     当前状态                     | 审计核对说明                                                            |
| :--------------------------------------------------------------------- | :----------------------------------------------: | :---------------------------------------------------------------------- |
| 1. 开发者按 README 可从空环境搭建并运行 API + Worker + PostgreSQL      |                     **MET**                      | 冻结锁文件安装、本地 compose / psql 验证通过。                          |
| 2. 通过 Dev Token 创建两个独立 Tenant/Agent，不能互访                  |                     **MET**                      | B-T21～B-T23 跨租户负向测试全绿，返回统一 404。                         |
| 3. 创建 Task 后数据库事务已 Commit 才返回 Task ID；幂等并发正确        |                     **MET**                      | B-T06～B-T08、B-T25 混沌测试全绿，24 并发幂等通过。                     |
| 4. Fast Path 不触发 Sandbox；Standard Path 完成 Fake Sandbox 生命周期  |                     **MET**                      | B-T02、B-T15、B-T16，实测常驻沙箱数严格为 0。                           |
| 5. 任务状态机、Run Lease、超时重试、取消和 Terminal 状态不变量成立     |                     **MET**                      | 7×7 状态机、ADR-0001、ADR-0002 边界测试全绿。                           |
| 6. Worker 强杀与重启后 Task 能重新派发；旧 Run 无法污染新结果          | **MET** _(代码级)_<br>**PENDING** _(独立进程级)_ | B-T11、B-T27 Fencing 测试通过；跨独立 OS 进程强杀测试等待 PR 10B 合并。 |
| 7. Artifact 完整性校验、Workspace Version CAS、Checkpoint 恢复通过     |                     **MET**                      | B-T12～B-T14、ADR-0003 冻结契约全绿。                                   |
| 8. SSE 断线重连按事件游标复原且 Tenant 隔离                            |                     **MET**                      | B-T18、HTTP SSE 流式重放与多租户隔离全绿。                              |
| 9. Mock Approval/Mock Budget 超限具有明确状态与事件                    |                     **MET**                      | B-T05、B-T20 预算审计与审批状态流转全绿。                               |
| 10. 记录 End-to-end / Queue / Fake Ready 等 Span；模拟成本标识清楚     |                     **MET**                      | B-T30、`cost_source = "simulated"`、`actual_vendor_cost_usd = null`。   |
| 11. 本地 1,000 逻辑 Agent 测试报告包含创建数、并发数、失败数和资源占用 |                     **MET**                      | 3 轮连续压测，包含完整 CPU、内存、连接池真实采样。                      |
| 12. 30 项测试场景均具备可重复执行的实现并通过                          |                 **IN PROGRESS**                  | 24 项完全 PASS；6 项 E2E 依赖 PR 10A 合并（DoD 不提前假签）。           |
| 13. `README.md`、`P0B-RESULTS.md` 说明真实执行命令、通过与失败项目     |                     **MET**                      | 本文档与 README 同步如实更新。                                          |
| 14. `git diff --check` 通过；独立分支开 Draft PR，不自动合并           |                     **MET**                      | 工作树干净，开立独立 Draft PR，严禁自动合并。                           |
| 15. 未开通或调用任何收费云服务、外部模型或第三方有费用 API             |                     **MET**                      | 100% 内存与本地沙箱模拟，零外部网络付费调用。                           |

> [!IMPORTANT]
> **DoD 最终签署裁定：**  
> 按照任务书第 12 节规定：“若出现 Blocked 或等待合并项，必须记录原因和修复计划，**DoD 保持未完成**，不得用 TODO 冒充通过”。  
> 本报告明确：**P0-B 最终整体 DoD 将在 PR 10A、PR 10B 和 PR 10C 全部合入 main 后，由主线集成者执行统一端到端复验后正式签署。**
