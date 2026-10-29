# Ember Architecture — 文档索引

本目录区分**已批准的规则**、**待评审的 V1 目标设计**和**历史研究资料**。架构文件不是功能实现证明；具体代码是否存在，应以 `main` 中的源码、Migration 和验收记录为准。

| 文档 | 当前状态 | 用途 |
| --- | --- | --- |
| [V1 Architecture Baseline](./v1-architecture-baseline.md) | **Proposed — CTO Review required** | V1 产品拓扑、数据权威、可替换基础设施、Artifact/Workspace/Checkpoint、恢复边界和 P0B-06 开工门槛。 |
| [V1 Execution Placement](./v1-execution-placement.md) | Proposed | 简单的 Mac/Cloud 位置调度策略；未来跨 **Run** 的 Checkpoint 恢复需要专题修订。 |
| [Architecture RFC v0.2](./Personal_Agent_Platform_Architecture_RFC_v0.2.md) | 历史 Draft | UX / 安全 / 成本假设与候选技术研究，不能当作已实现范围。 |
| [Architecture RFC v0.1](./Personal_Agent_Platform_Architecture_RFC_v0.1.md) | 历史 Draft | 早期 Always-on Agent、按需 Sandbox 架构探索。 |
| [P0-B Minimum Vertical Slice Task Spec](./Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md) | 历史任务书 | 原定本地验证目标；通过情况以对应 Acceptance 文档为准。 |

## 决策权威和阅读顺序

1. 对具体事项，优先遵守 `docs/adr/` 中明确标记 **Accepted** 的决策：
   - [ADR-0001：Cancellation and Retry](../adr/0001-cancellation-and-retry-coordination.md)
   - [ADR-0002：Pre-claim Deadline Failure](../adr/0002-preclaim-deadline-failure.md)
2. [V1 Architecture Baseline](./v1-architecture-baseline.md) **经 CTO 接受后**作为整体系统不变量。当前仍为 Proposed，不能把它当成已批准的开发指令。
3. [Execution Placement](./v1-execution-placement.md) 作为待评审专题设计；如与新 Baseline 冲突，记录差异并显式修订。
4. RFC、旧任务书保留作为决策背景，不覆盖已经合并的代码事实或已批准 ADR。

**注意：**RFC v0.2 中出现的内部标签 `ADR-001` 等，与 `docs/adr/0001-*`、`0002-*` 并非同一编号体系，不可仅按序号对号入座。

## P0B-06 开始实施前请阅读

1. Baseline `4–8`：Task/Run Fencing、数据所有权、可替换持久化、Workspace CAS 与 Checkpoint。
2. Baseline `12`：六项必须先决定的 B06-D1～B06-D6。
3. [Execution Placement](./v1-execution-placement.md) 中关于设备权限、离线和重试的规则，以及待修订的跨 Run 恢复区别。
4. ADR-0001/0002，`packages/domain`、`packages/contracts`、`packages/postgres`、`packages/execution` 当前实现。
5. [P0B-05 实现记录](../P0B-05-IMPLEMENTATION.md)与[验收证据](../P0B-05-ACCEPTANCE.md)。

P0B 各阶段的 Implementation/Acceptance 文件仍在 `docs/` 目录；Coding Agent 的工程 Prompt 在 [`docs/prompts/`](../prompts/)。

**实施规则：**在架构评审通过前不要下发 P0B-06 编码任务；文档草案不代表生产功能存在。