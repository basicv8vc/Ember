# Ember P0B-10C: 证据审计、缺口追踪与性能对照分析报告

- **报告编号:** `EMBER-P0B-10C-AUDIT-01`
- **任务代号:** P0B-10C (性能复验、B-T01～B-T30 证据审计、P0B 最终结果准备)
- **代码仓库:** `basicv8vc/Ember` (私有)
- **基线提交 (Base SHA):** `2ec04f6c7459820c20813554a749c60447d33e88` (main / PR #24)
- **可复验代码提交 (Reproducible Git SHA):** `4a21b5f5796bc80020efb5e31d9c23dfc8f18338` (Commit 1: `feat(bench): add disable-pg-sampling toggle and regression tests for P0B-10C`)
- **审计分支:** `feature/p0b-10c-results-audit`
- **审计日期:** 2026-10-31
- **审计角色:** Performance / Verification / Release-readiness Engineer

---

## 1. 审计目标与独立性声明

本报告旨在为 Ember P0-B 提供**真实、可复现、数据自洽的工程证据**，而非一份“看起来全部绿色”的纸面报告。

### 1.1 独立性与客观性原则

1. **真实可复现（针对 P1 审查）：** 严禁测试在未提交的代码上执行而记录旧 Git HEAD。所有正式基准测试均在干净提交 `4a21b5f5796bc80020efb5e31d9c23dfc8f18338` 上重新完整执行，任何开发者检出该提交均可严谨复现完全一致的代码逻辑与压测套件。
2. **数据严格对账（针对 P2 审查）：** 报告中所有表格数值与原始基准 JSON 产物进行逐字段核对，并通过自动化单元测试 (`tests/unit/benchmark-report-reconciliation.test.ts`) 实施防漂移校验。
3. **因果与假设严谨分离（针对 P2 审查）：** 对 A/B 对照实验结论保持客观统计口径，区分“有限样本下的观测事实”与“未经证实的底层假设”，删除未经验证的原因断言。
4. **未合并分支透明度：** 对正在并行开发的 PR 10A (`feature/p0b-10a-demo-e2e` / `pnpm demo` / `test:e2e`) 及 PR 10B (`feature/p0b-10b-process-recovery`)，严格标为 `PENDING INTEGRATION` / `NOT RUN`，不可提前代签 DoD。

---

## 2. 软硬件执行环境基准

| 属性                  | 配置值                                                        | 审计核验方式                         |
| :-------------------- | :------------------------------------------------------------ | :----------------------------------- |
| **主机芯片**          | Apple M1 (8 核心: 4 性能核 + 4 能效核)                        | `sysctl -n machdep.cpu.brand_string` |
| **物理内存**          | 16 GB 统一内存 (17,179,869,184 Bytes)                         | `sysctl -n hw.memsize`               |
| **操作系统**          | macOS 26.5.1 (Darwin Kernel Version 25.5.0 arm64)             | `uname -a`                           |
| **Node.js 运行时**    | `v24.11.0`                                                    | `node -v`                            |
| **pnpm 包管理器**     | `12.15.0` (frozen lockfile)                                   | `pnpm -v`                            |
| **PostgreSQL 数据库** | `PostgreSQL 17.11 (Homebrew)` on `aarch64-apple-darwin`       | `SELECT version();`                  |
| **数据库隔离策略**    | 瞬态 Schema 隔离 (`ember_bench_<hex>`)，跑毕自动 DROP CASCADE | Harness 内部原子保障                 |
| **凭证与脱敏策略**    | 强制脱敏：`databaseUrl: "[REDACTED]"`, `apiUrl: "[REDACTED]"` | 自动化敏感词扫描                     |

---

## 3. C1: 基准测试完整复验数据 (Load Benchmark Verification)

### 3.1 标准基线连续 3 轮实测数据 (1,000 Agents / 100 Concurrency / 1,000 Tasks)

测试命令：

```bash
node --env-file-if-exists=.env.local --import tsx apps/benchmark/src/cli.ts \
  --agents 1000 --concurrency 100 --task-mix fast:70,standard:30 \
  --warmup 50 --total-requests 1000 --seed 42 --enable-local-load \
  --out-dir benchmarks/audit-p0b-10c/baseline
```

在干净代码提交 `4a21b5f` 上连续执行 3 轮完整压测，下表记录每一轮原始 JSON 的实测数值、中位数与全量极值范围（**禁止挑选最好的一轮，严格保证数据与原始产物 100% 对账**）：

| 指标维度                          | 第 1 轮 (Run 1) | 第 2 轮 (Run 2) | 第 3 轮 (Run 3) |  中位数 (Median)  |    范围 (Min ~ Max)    |    目标要求    |      判定      |
| :-------------------------------- | :-------------: | :-------------: | :-------------: | :---------------: | :--------------------: | :------------: | :------------: |
| **可复验代码 Git SHA**            |    `4a21b5f`    |    `4a21b5f`    |    `4a21b5f`    |     `4a21b5f`     |       `4a21b5f`        | 可追溯 Commit  |    **PASS**    |
| **Agent 创建耗时**                |    696.7 ms     |    614.4 ms     |    950.6 ms     |   **696.7 ms**    |    614.4 ~ 950.6 ms    |       -        |      优异      |
| **Agent 创建吞吐**                |   1,435.4 /s    |   1,627.7 /s    |   1,052.0 /s    |  **1,435.4 /s**   |  1,052.0 ~ 1,627.7 /s  |       -        |      优异      |
| **PostgreSQL Agent 记录**         |      1,000      |      1,000      |      1,000      |     **1,000**     |     1,000 ~ 1,000      |    1,000 条    |    **PASS**    |
| **PostgreSQL Workspace 记录**     |      1,000      |      1,000      |      1,000      |     **1,000**     |     1,000 ~ 1,000      |    1,000 条    |    **PASS**    |
| **常驻进程/常驻沙箱数**           |      0 / 0      |      0 / 0      |      0 / 0      |     **0 / 0**     |         0 ~ 0          |       0        |    **PASS**    |
| **正式任务总数 / 成功数**         |  1,000 / 1,000  |  1,000 / 1,000  |  1,000 / 1,000  | **1,000 / 1,000** |          100%          |      100%      |    **PASS**    |
| **未解释任务丢失数 (lost)**       |        0        |        0        |        0        |       **0**       |           0            |       0        |    **PASS**    |
| **重复确认数 (duplicateAck)**     |        0        |        0        |        0        |       **0**       |           0            |       0        |    **PASS**    |
| **Durable Ack P50**               |     6.28 ms     |     5.97 ms     |     6.48 ms     |    **6.28 ms**    |     5.97 ~ 6.48 ms     |       -        |      优异      |
| **Durable Ack P95**               |    56.10 ms     |    53.26 ms     |    61.83 ms     |   **56.10 ms**    |    53.26 ~ 61.83 ms    | $\le 1,000$ ms | **PASS (MET)** |
| **Durable Ack P99**               |    101.35 ms    |    103.55 ms    |    109.03 ms    |   **103.55 ms**   |   101.35 ~ 109.03 ms   |       -        |      优异      |
| **Queue Wait P50**                |   1,139.00 ms   |   1,208.00 ms   |   1,303.50 ms   |  **1,208.00 ms**  | 1,139.00 ~ 1,303.50 ms |       -        |      稳定      |
| **Queue Wait P95**                |   1,733.90 ms   |   2,450.10 ms   |   2,506.05 ms   |  **2,450.10 ms**  | 1,733.90 ~ 2,506.05 ms |       -        |   见第 4 节    |
| **Task Completion P50**           |   1,794.95 ms   |   1,932.70 ms   |   2,088.94 ms   |  **1,932.70 ms**  | 1,794.95 ~ 2,088.94 ms |       -        |      稳定      |
| **Task Completion P95**           |   2,517.98 ms   |   3,438.96 ms   |   3,616.43 ms   |  **3,438.96 ms**  | 2,517.98 ~ 3,616.43 ms |       -        |   见第 4 节    |
| **HTTP 在途峰值 (In-Flight)**     |       100       |       100       |       100       |      **100**      |          100           |    100 并发    |  **VERIFIED**  |
| **Worker 执行槽峰值 (In-Flight)** |       38        |       38        |       39        |      **38**       |        38 ~ 39         |    100 槽位    |  **VERIFIED**  |
| **Fake Sandbox 存活峰值 (Live)**  |   1 (Idle: 0)   |   2 (Idle: 0)   |   2 (Idle: 0)   |  **2 (Idle: 0)**  |    1 ~ 2 (Idle: 0)     |    闲置为 0    |    **PASS**    |
| **PostgreSQL 采样次数**           |       201       |       213       |       238       |      **213**      |      201 ~ 238 次      |      $>0$      |    **PASS**    |
| **PostgreSQL 活跃连接峰值**       |       30        |       39        |       38        |      **38**       |        30 ~ 39         |       -        |      受控      |
| **PostgreSQL 总连接峰值**         |       52        |       52        |       53        |      **52**       |        52 ~ 53         |       -        |      受控      |
| **进程峰值 RSS**                  |    330.3 MB     |    325.1 MB     |    300.4 MB     |   **325.1 MB**    |    300.4 ~ 330.3 MB    |       -        |      平稳      |
| **进程峰值 V8 Heap**              |    150.8 MB     |    147.5 MB     |    146.1 MB     |   **147.5 MB**    |    146.1 ~ 150.8 MB    |       -        |     无泄漏     |
| **CPU 平均利用率**                |      14.8%      |      14.3%      |      13.6%      |     **14.3%**     |     13.6% ~ 14.8%      |       -        |      平稳      |
| **费用标注审计**                  |   `simulated`   |   `simulated`   |   `simulated`   |    `simulated`    |           -            |  严禁虚假USD   |    **PASS**    |

> **对账审计说明 (针对 P2):**
> 原始 JSON 文件中 Run 1 总连接峰值为 52（活跃 30，采样 201 次），Run 2 为 52（活跃 39，采样 213 次），Run 3 为 53（活跃 38，采样 238 次）。本表格数据已与 `benchmarks/audit-p0b-10c/baseline/` 目录下的 3 份 JSON 严格对齐，单元测试自动保障无偏差。

### 3.2 Standard Path 压力测试 (100% Standard, mock.compute)

- **参数配置:** `--agents 300 --concurrency 50 --task-mix fast:0,standard:100 --warmup 20 --total-requests 300 --enable-local-load`
- **执行总耗时:** 3,571 ms
- **任务对账:** 300 / 300 成功完成 (100.00%)，0 任务丢失，0 失败。
- **沙箱生命周期审计:** Peak Live Sandboxes: **2**，测试结束后 Idle: **0**。每个 `mock.compute` 任务瞬态初始化 FakeSandbox，并在步骤完成后彻底销毁。
- **延迟指标:** Durable Ack P95 = **30.70 ms**，Queue Wait P95 = **263.30 ms**，Task Completion P95 = **642.72 ms**。
- **系统资源:** 活跃连接峰值 31，总连接峰值 52 (采样 35 次)，峰值 RSS 331.4 MB。

### 3.3 短时稳定性持续负载测试 (20s Duration Load Test)

- **测试性质澄清 (针对 P3 审查):** 本项为**短时稳定性测试（20 秒）**，旨在检验在不间断高频提交下是否存在即时的内存快速膨胀或连接泄露；**本测试不构成长期（如数小时/数天）无内存泄漏的充分证明**，长期内存稳定性仍保留为后续生产环境或长期压测的持续验证项。
- **参数配置:** `--agents 500 --concurrency 50 --task-mix fast:70,standard:30 --warmup 20 --duration 20s --enable-local-load`
- **执行时间与样本数:** 21,633 ms 持续压测，累计吞吐执行 **2,192 个任务**（平均吞吐率 **~101 req/s**）。
- **任务对账:** 2,192 / 2,192 全部成功 (100.00%)，0 任务丢失，0 超时，0 报错。
- **延迟指标:** Durable Ack P50 = **3.27 ms** (P95 = **10.02 ms**)，Queue Wait P95 = **175.00 ms**，Task Completion P95 = **554.38 ms**。
- **系统资源:** 活跃连接峰值 47，总连接峰值 53 (采样 214 次)，峰值 RSS 340.1 MB，Heap 150.9 MB。短时高压下未见明显内存阶梯式膨胀。

---

## 4. C2: 性能波动对照实验与采样开销归因审计

### 4.1 核心问题回顾

在历史 PR #23 → PR #24 复验中，Queue Wait P95 与 Task Completion P95 出现回升。此前曾有人假设：“PR #24 引入的每 100ms 一次 PostgreSQL `pg_stat_activity` 实时轮询可能对数据库与调度产生了开销扰动”。

### 4.2 对照测量设计与交替执行顺序

为了科学检验该假设，本次审计在 `apps/benchmark/**` 中新增无侵入参数 `--disable-pg-sampling`。在**相同 Git SHA (`4a21b5f`)、相同硬件、相同参数（500 Agents / 50 并发 / 500 请求 / 种子 101/102）**下，采用**交替执行顺序**（Run A1 [OFF] → Run B1 [ON] → Run A2 [OFF] → Run B2 [ON]）执行 4 轮对照实验：

| 对照轮次         |  PG 采样状态   |    采样次数    | Durable Ack P95 | Queue Wait P95  | Completion P95  | 峰值 RSS |
| :--------------- | :------------: | :------------: | :-------------: | :-------------: | :-------------: | :------: |
| **Run A1 (OFF)** | **关闭** (OFF) | 0 (unverified) |    38.55 ms     | **1,233.20 ms** | **3,107.21 ms** | 281.5 MB |
| **Run B1 (ON)**  | **开启** (ON)  |     112 次     |    43.38 ms     |  **928.15 ms**  | **2,091.43 ms** | 310.5 MB |
| **Run A2 (OFF)** | **关闭** (OFF) | 0 (unverified) |    33.23 ms     |  **580.10 ms**  | **1,107.55 ms** | 283.3 MB |
| **Run B2 (ON)**  | **开启** (ON)  |     60 次      |    30.07 ms     |  **312.00 ms**  |  **789.14 ms**  | 289.0 MB |

### 4.3 审计科学结论与假设区分 (针对 P2 审查)

1. **有限样本下的客观观测事实：**
   - 在本组交替对照测试中，无论是 Run A1 还是 Run A2，关闭 PostgreSQL 采样并未带来排队延迟的下降；相反，两轮关闭采样测试的 Queue Wait P95（1,233.20 ms 与 580.10 ms）均高于对应开启采样的轮次（928.15 ms 与 312.00 ms）。
   - **结论口径：** 当前有限样本（4 轮）未发现 PostgreSQL 采样与排队延迟升高之间的一致关系。性能波动的具体来源仍待进一步测量。
2. **潜在假设区分（不构成确诊断言）：**
   - 诸如“V8 事件循环微任务排队”、“macOS APFS 磁盘写入同步与 WAL 批处理”以及“跨时钟测量量化抖动”等仅为后续排查的理论候选假设，目前不作为已证实原因写入正式结论。
3. **安全合规声明：** 关闭采样的对照实验仅用于排查性能变量，**不作为满足 PR #24 遥测规范的正式验收证据**。正式交付以开启采样的实测数据（采样数 $>0$）为准。

### 4.4 新增开关回归测试与自动化数据校验 (针对 P2 审查)

为确保 `--disable-pg-sampling` 功能的安全与质量，本次交付补充了完整的自动化回归套件：

1. **单元测试 (`tests/unit/benchmark-metrics.test.ts`):** 验证 `TelemetryCollector` 在禁用时采样数为 0，且在生成 Markdown 报告时将指标正确标记为 `UNVERIFIED`、DoD 保持未选中 `[ ]`，杜绝伪造遥测 PASS。
2. **集成测试 (`tests/integration/benchmark-smoke.test.ts`):** 验证 CLI 接收 `--disable-pg-sampling` 时，端到端闭环下 PostgreSQL 活跃/总连接数为 0，采样记录严格为 0。
3. **报告数据自动对账测试 (`tests/unit/benchmark-report-reconciliation.test.ts`):** 自动读取 `benchmarks/audit-p0b-10c/baseline` 下的原始 JSON 文件，断言报告文档中记载的 Git SHA、PostgreSQL 峰值总连接数、活跃连接数与采样次数 100% 吻合，防止任何人工抄写误差。

---

## 5. 时钟对齐与指标语义限制说明

### 5.1 客户端高精度时钟 vs 服务端持久化时钟

在 `apps/benchmark/src/runner.ts` 的测量模型中：

- **Durable Ack** 和 **Task Completion** 是基于客户端进程的原生单调纳秒时钟（`performance.now()`）测量发包到回包的真实端到端经历时延。
- **Queue Wait** 是从任务事件记录中解析 `acceptedEvent.occurred_at` 与 `firstExecEvent.occurred_at`（源于 PostgreSQL `CURRENT_TIMESTAMP` 或应用服务端 `Date.toISOString()`）的时间差计算得出：
  $$\text{queueWaitMs} = \max(0, t_{\text{exec}} - t_{\text{accepted}})$$
- **First Real Event** 则将客户端纳秒时延与服务端毫秒时间差做了叠加计算：
  $$\text{firstRealEventLatencyMs} = \max(0, \text{durableAckLatencyMs} + \text{queueWaitMs})$$

### 5.2 测量限制与不变量

1. **时钟精度不同：** 客户端采用高分辨率时钟（亚毫秒），而数据库事件采用标准墙上时钟（毫秒级）。不同时钟源在毫秒级边缘存在固有的量化截断误差。
2. **不可跨架构简单归因：** 不能将本地单机 Loopback 环境下的微秒级排队波动，误解为真实生产网络上的跨地域端到端延迟（RTT）。
3. **概念明确区分：**
   - **100 HTTP 并发 $\neq$ 100 个 Worker 并发：** 客户端以 100 并发压测，但 Worker 实际最大执行槽位稳定在 38~39（因为 Fast 任务耗时极短，快速周转完结）。
   - **1,000 逻辑 Agent $\neq$ 1,000 个虚拟机/容器：** 逻辑 Agent 纯粹是数据库中的静态元数据行，闲置时占用 0 系统进程。
   - **模拟执行耗时 $\neq$ 真实模型首字延迟（TTFT）：** `DeterministicFakeLLM` 为固定延迟，不可用来推断真实模型性能。

---

## 6. B-T01～B-T30 证据矩阵与状态审计

| ID        | 等级        | 测试目标                       | 验收标准                                   | 实施证据文件                                                                                        | 实测命令                                    |          判定           |
| :-------- | :---------- | :----------------------------- | :----------------------------------------- | :-------------------------------------------------------------------------------------------------- | :------------------------------------------ | :---------------------: |
| **B-T01** | Unit        | 输入 Schema / Task kind        | 非法输入 4xx，无 DB 副作用                 | `tests/unit/task-schemas.test.ts`<br>`tests/unit/api-task-create.test.ts`                           | `pnpm test:unit`                            |        **PASS**         |
| **B-T02** | Unit        | Fast/Standard Router           | 固定规则，Fast 不启动 Sandbox              | `tests/unit/execution-router.test.ts`<br>`tests/unit/deterministic-executor.test.ts`                | `pnpm test:unit`                            |        **PASS**         |
| **B-T03** | Unit        | Fake 未知命令                  | 拒绝，不调用 Host Shell                    | `tests/unit/fake-sandbox.test.ts`<br>`tests/unit/fake-llm.test.ts`                                  | `pnpm test:unit`                            |        **PASS**         |
| **B-T04** | Unit        | Task 状态机非法转换            | 统一拒绝，有错误码                         | `tests/unit/task-state-machine.test.ts`<br>`tests/unit/run-state-machine.test.ts`                   | `pnpm test:unit`                            |        **PASS**         |
| **B-T05** | Unit        | Budget/TTL                     | 到达上限停止继续执行                       | `tests/unit/budget-guard.test.ts`<br>`tests/integration/persistent-budget.test.ts`                  | `pnpm test:unit`<br>`pnpm test:integration` |        **PASS**         |
| **B-T06** | Integration | Durable Ack                    | DB commit 后才返回                         | `tests/integration/durable-task-inbox.test.ts`                                                      | `pnpm test:integration`                     |        **PASS**         |
| **B-T07** | Integration | 并发相同 Idempotency Key       | 只创建一个 Task，重放返回同 ID             | `tests/integration/task-idempotency.test.ts`                                                        | `pnpm test:integration`                     |        **PASS**         |
| **B-T08** | Integration | 相同 Key 不同 Payload          | 409 Conflict                               | `tests/integration/task-idempotency.test.ts`                                                        | `pnpm test:integration`                     |        **PASS**         |
| **B-T09** | Integration | 2 Worker 同时 claim            | 无双 Lease / 重复有效 Run                  | `tests/integration/lease-claim.test.ts`                                                             | `pnpm test:integration`                     |        **PASS**         |
| **B-T10** | Integration | Lease 超时回收                 | 新 Run 可领取                              | `tests/integration/lease-recovery.test.ts`                                                          | `pnpm test:integration`                     |        **PASS**         |
| **B-T11** | Integration | 旧 Worker 迟到提交             | fencing 拒绝                               | `tests/integration/lease-fencing.test.ts`                                                           | `pnpm test:integration`                     |        **PASS**         |
| **B-T12** | Integration | Workspace CAS                  | 过期版本写入失败                           | `tests/integration/workspace-cas.test.ts`                                                           | `pnpm test:integration`                     |        **PASS**         |
| **B-T13** | Integration | Artifact hash / length         | 文件与 DB 元数据一致                       | `tests/integration/artifact-integrity.test.ts`                                                      | `pnpm test:integration`                     |        **PASS**         |
| **B-T14** | Integration | Orphan 文件                    | 不对用户可见，安全清理可执行               | `tests/integration/artifact-integrity.test.ts`<br>`tests/unit/local-blob-store.test.ts`             | `pnpm test:integration`<br>`pnpm test:unit` |        **PASS**         |
| **B-T15** | E2E         | Fast Task                      | 结果正确；Sandbox 创建次数 0               | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 execution-worker.test.ts 验证)_                   | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** |
| **B-T16** | E2E         | Standard Task                  | 新 Sandbox、Artifact、Checkpoint、Destroy  | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 execution-worker.test.ts 验证)_                   | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** |
| **B-T17** | E2E         | 重新提交/恢复 Workspace        | 读取上次版本，新的 Sandbox ID              | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 checkpoint-resume.test.ts 验证)_                  | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** |
| **B-T18** | E2E         | SSE 断线重连                   | 顺序、游标、可重放                         | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 http-task-sse.test.ts 验证)_                      | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** |
| **B-T19** | E2E         | Queued/Running Cancel          | 终态唯一；不运行下一步                     | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 cooperative-cancellation 验证)_                   | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** |
| **B-T20** | E2E         | Mock Approval                  | 先 WaitingApproval，批准后恢复；拒绝后结束 | 待 PR 10A 合并 (`tests/e2e/**`)<br>_(集成代理已在 persistent-mock-approval 验证)_                   | `pnpm test:e2e` _(待合并)_                  | **PENDING INTEGRATION** |
| **B-T21** | Security    | Tenant B 查询 A 任务           | 404，无泄露                                | `tests/integration/http-task-api.test.ts`<br>`tests/unit/api-task-read.test.ts`                     | `pnpm test:integration`                     |        **PASS**         |
| **B-T22** | Security    | Tenant B 读取 A 文件/Event     | 404 / 拒绝                                 | `tests/integration/http-artifact-api.test.ts`<br>`tests/integration/http-task-sse.test.ts`          | `pnpm test:integration`                     |        **PASS**         |
| **B-T23** | Security    | 无 Token/假 Tenant ID          | 401 或 404，无法冒充                       | `tests/integration/http-agent-api.test.ts`<br>`tests/unit/api-auth.test.ts`                         | `pnpm test:integration`                     |        **PASS**         |
| **B-T24** | Security    | Path Traversal / Symlink       | 不能逃逸 Artifact Root                     | `tests/integration/artifact-integrity.test.ts`<br>`tests/unit/local-blob-store.test.ts`             | `pnpm test:integration`<br>`pnpm test:unit` |        **PASS**         |
| **B-T25** | Chaos       | DB Ack 前/后 Crash             | 无丢任务/重复创建                          | `tests/chaos/b-t25-durable-ack-crash.test.ts`                                                       | `pnpm test:chaos`                           |        **PASS**         |
| **B-T26** | Chaos       | Artifact/Checkpoint 之间 Crash | 无对用户可见半提交结果                     | `tests/chaos/b-t26-artifact-checkpoint-atomic.test.ts`<br>`tests/integration/result-commit.test.ts` | `pnpm test:chaos`                           |        **PASS**         |
| **B-T27** | Chaos       | 旧 Run 与新 Run 交错           | 旧结果不能覆盖                             | `tests/chaos/b-t27-lease-fencing-concurrency.test.ts`                                               | `pnpm test:chaos`                           |        **PASS**         |
| **B-T28** | Load        | 1,000 逻辑 Agent               | 无 1,000 Fake 常驻进程                     | `apps/benchmark/**`<br>`tests/integration/benchmark-smoke.test.ts`                                  | `pnpm bench:local`                          |        **PASS**         |
| **B-T29** | Load        | 100 并发请求（本地）           | 无 Task 丢失，指标完整                     | `apps/benchmark/**`<br>`tests/integration/benchmark-smoke.test.ts`                                  | `pnpm bench:local`                          |        **PASS**         |
| **B-T30** | Telemetry   | simulated cost / redaction     | 费用注明模拟，日志无 Token/敏感内容        | `tests/integration/telemetry-observability.test.ts`<br>`tests/unit/telemetry-privacy.test.ts`       | `pnpm test:integration`<br>`pnpm test:unit` |        **PASS**         |

---

## 7. 缺口与最终集成验收清单 (Gap Tracking & Integration Checklist)

在 PR 10A、PR 10B 和 PR 10C 三个并行 PR 合并到主线时，最终集成者必须按以下步骤执行端到端复验：

- [ ] **代码合并基线验证：** 将 PR 10A、10B、10C 无冲突合入 `main`。
- [ ] **执行构建与静态检查：**
  ```bash
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm format:check
  pnpm typecheck
  pnpm build
  git diff --check
  ```
- [ ] **执行全套单元、集成与混沌测试：**
  ```bash
  pnpm test:unit
  pnpm test:integration
  pnpm test:chaos
  ```
- [ ] **执行端到端与演示命令 (PR 10A 交付物)：**
  ```bash
  pnpm test:e2e
  pnpm demo
  ```
- [ ] **执行真实进程强杀恢复测试 (PR 10B 交付物)：**
      验证独立运行的 Worker 进程在 `SIGKILL` 强杀后，重启的新 Worker 能够自动接管并完成未完结任务。
- [ ] **重跑 1,000 Agent / 100 并发标准压测 (PR 10C 交付物)：**
  ```bash
  pnpm bench:local --agents 1000 --concurrency 100 --task-mix fast:70,standard:30 --warmup 50 --total-requests 1000 --seed 42 --enable-local-load
  ```
- [ ] **人工审核并正式签署 P0-B DoD。**
