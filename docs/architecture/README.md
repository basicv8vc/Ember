# Ember Architecture — 文档索引

本目录区分**已批准的规则**、**待评审的 V1 目标设计**和**历史研究资料**。架构文件不是功能实现证明；具体代码是否存在，应以 `main` 中的源码、Migration 和验收记录为准。

| 文档                                                                                                        | 当前状态                                                         | 用途                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [V1 Architecture Baseline](./v1-architecture-baseline.md)                                                   | **Accepted — CTO Architecture Review（PR #8，2026-10-29 合并）** | V1 产品拓扑、数据权威、可替换基础设施、Artifact/Workspace/Checkpoint、Mac Coding Harness Adapter、恢复边界和 P0B-06 开工门槛。 |
| [V1 Execution Placement](./v1-execution-placement.md)                                                       | Proposed（专项决策 D-01～D-07 未批准）                           | 简单的 Mac/Cloud 位置调度策略；区分当前固定执行目标与未来需要专项 ADR 的跨 **Run** 恢复。                                      |
| [Architecture RFC v0.2](./Personal_Agent_Platform_Architecture_RFC_v0.2.md)                                 | 历史 Draft                                                       | UX / 安全 / 成本假设与候选技术研究，不能当作已实现范围。                                                                       |
| [Architecture RFC v0.1](./Personal_Agent_Platform_Architecture_RFC_v0.1.md)                                 | 历史 Draft                                                       | 早期 Always-on Agent、按需 Sandbox 架构探索。                                                                                  |
| [P0-B Minimum Vertical Slice Task Spec](./Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md) | 历史任务书                                                       | 原定本地验证目标；通过情况以对应 Acceptance 文档为准。                                                                         |

## Cloud Runtime V2 方向

- [ADR-0005：Cloudflare-native Cloud Runtime V2](../adr/0005-cloudflare-native-runtime-v2.md)：已接受的长期技术方向与 V1 防腐纪律；原 ADR 本身不授权迁移或 PoC。ADR-0006 经批准合并后，仅就 M0/本地 M1 PoC 的授权细化并取代该限制；其余门禁及 V1 契约不变。

- [ADR-0006：Experience-first, Device-powered Runtime V2](../adr/0006-experience-first-device-powered-runtime-v2.md)（[中文版](../adr/0006-experience-first-device-powered-runtime-v2.zh-CN.md)，以英文原版为准）：经产品负责人/CTO 批准并合并后为 Accepted；定义两条长期架构原则、Fast/Durable Path、端侧执行、性能门禁及部署预算。仅授权 M0 契约/Benchmark 和本地隔离 M1 Fake Provider PoC；M0 公共契约经架构师/CTO 审核后方可实施依赖性改动。云资源创建/部署/Smoke、真实供应商 Canary 支出、M2 及后续实施与生产迁移均须分别取得明确批准。

- [V2-M0-B：Event Runtime & Recovery Contract](./v2-m0-event-recovery-contract.md)：M0 工程契约冻结（PR `#171`，共享 DO SQLite/D1 `v2_schedules` / `v2_dispatch_outbox` / `v2_recovery_coverage` / `v2_recovery_registry` 规范 DDL 与 `RecoveryAdmissionPort` / `EventRuntimeCoordinatorPort` / `RecoveryRegistryPort` / `V2DispatchEnvelope` 拥有者；仅授权后续本地 Fake Provider M1 编码，须先于 `#170` 合并）。

- [V2-M0-A：Agent Head & Interactive Runtime Contract](./v2-m0-runtime-contract.md)：M0 工程契约冻结（PR `#170`，`AgentHeadDO` 业务状态、`assistant_turns` / `tasks` / `runs` / `model_attempts` 租约与预算权威、3-RPC 门禁、`GlobalBudgetAuthority`、`AuthoritativeBusinessPort` 及 B1 交互执行边界；依赖 `#171` 联合冻结后合入，M0-D `#172` 为独立 Benchmark 门禁）。

## 决策权威和阅读顺序

1. 对具体事项，优先遵守 `docs/adr/` 中明确标记 **Accepted** 的决策：
   - [ADR-0001：Cancellation and Retry](../adr/0001-cancellation-and-retry-coordination.md)
   - [ADR-0002：Pre-claim Deadline Failure](../adr/0002-preclaim-deadline-failure.md)
   - [ADR-0003：P0B-06 Engineering Contract Freeze](../adr/0003-p0b-06-persistence-contract-freeze.md)（合并到 `main` 后生效）
   - ADR-0005 与 ADR-0006（见上；ADR-0006 经批准合并后，在其明确决策范围内优先，V1 契约不变）
2. [V1 Architecture Baseline](./v1-architecture-baseline.md) 已经 CTO Architecture Review 接受（PR #8，2026-10-29 合并到 `main`），作为整体系统不变量生效。
3. [Execution Placement](./v1-execution-placement.md) 仍为待评审专题设计（专项决策 D-01～D-07 未批准）；如与新 Baseline 冲突，记录差异并显式修订。
4. RFC、旧任务书保留作为决策背景，不覆盖已经合并的代码事实或已批准 ADR。

**注意：**RFC v0.2 中出现的内部标签 `ADR-001` 等，与 `docs/adr/0001-*`、`0002-*` 并非同一编号体系，不可仅按序号对号入座。

## P0B-06 开始实施前请阅读

1. Baseline `4–8`：Task/Run Fencing、数据所有权、可替换持久化、Workspace CAS 与 Checkpoint。
2. Baseline `12`：已批准的 B06-D1～D6 架构边界；[ADR-0003](../adr/0003-p0b-06-persistence-contract-freeze.md) 冻结具体工程行为契约。
3. [Execution Placement](./v1-execution-placement.md) 中关于设备权限、离线和重试的规则，以及待修订的跨 Run 恢复区别。
4. ADR-0001/0002，`packages/domain`、`packages/contracts`、`packages/postgres`、`packages/execution` 当前实现。
5. Mac Harness Discovery/Adapters 属于独立 V1 专项工程，**不纳入 P0B-06**；不可把本机第三方 Session 当作可移植 Checkpoint。
6. [P0B-05 实现记录](../P0B-05-IMPLEMENTATION.md)与[验收证据](../P0B-05-ACCEPTANCE.md)。

P0B 各阶段的 Implementation/Acceptance 文件仍在 `docs/` 目录；Coding Agent 的工程 Prompt 在 [`docs/prompts/`](../prompts/)；下一阶段的 [P0B-06 Cline CLI Prompt](../prompts/Ember_P0B-06_Cline_CLI_Implementation_Prompt.md) 所依赖的 Architecture Baseline 已接受并合并（PR #8），但**仍须先使 ADR-0003 经审查合并到 `main`，完成 B06-D1～D6 工程契约冻结**后才可执行。

**实施规则：**Architecture Baseline 已接受（PR #8），但在 ADR-0003 合并生效之前仍不要下发 P0B-06 编码任务；文档草案不代表生产功能存在。
