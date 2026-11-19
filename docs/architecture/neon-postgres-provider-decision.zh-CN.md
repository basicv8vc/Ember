# Ember 数据库选型回顾：Why Neon over Supabase

[English](neon-postgres-provider-decision.md) | 简体中文

- 日期：2026-11-19
- 状态：历史决策记录与当前架构说明；不授权新的迁移、资源或付费操作。
- 范围：Ember Cloud / Private Alpha 的托管 PostgreSQL 选型，以及与 Cloud Runtime V2 的关系。
- 原始证据：[Issue #132](https://github.com/basicv8vc/Ember/issues/132)、[PR #135](https://github.com/basicv8vc/Ember/pull/135)（实测报告，Draft）、[PR #139](https://github.com/basicv8vc/Ember/pull/139)（后续兼容性与并发诊断，Draft）。

## TL;DR

Ember 选择 Neon 并不是因为 Supabase 不支持所需的 PostgreSQL 能力，也不是因为 Neon 在所有测试中更快。两个服务都通过了核心业务契约的兼容性验证。

选择 Neon 作为 Alpha 数据库的主要原因：

1. 实测 Neon 在 Cloudflare Hyperdrive 空闲连接存在的情况下仍可进入 Idle，并在下一次请求自动恢复。这比需要人工恢复的 Supabase Free 项目级暂停更符合按需执行的 Personal Agent。
2. Ember 已拥有认证、业务 API、任务执行和文件存储方案，主要需要的是托管 PostgreSQL，而非完整 BaaS。
3. 当时 Neon Free 的数据库容量与按量扩容路径更适合低流量起步。但节省计算成本取决于真实工作负载能够让数据库休眠。

**V1 保留 Neon PostgreSQL；Supabase 是经过验证的备选服务，不是当前运行依赖。V2 的 Cloudflare-native Runtime 方向由 ADR-0005 独立约束。**

## 1. 决策背景与时间线

| 日期            | 事件                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-07      | Issue #132 启动 Neon/Supabase 对照验证；授权各创建一个 Free 测试项目，仅使用合成数据。要求保留现有 PostgreSQL 业务和事务契约，不迁移 D1。            |
| 2026-11-08      | PR #135 汇总 P0–P4 实测，推荐 Neon 作为 Alpha PostgreSQL。PR #139 记录 Neon 作为 CTO-approved provider，并保留后续诊断任务。                         |
| 2026-11（后续） | Neon 进入 Ember Cloud 共享环境，通过 Hyperdrive 服务 API 与 Async Runtime；具体部署路径见 [Ember Cloud](../cloud-staging.md)。                       |
| 2026-11-18      | [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md) 记录 Neon compute 预警及 Cloudflare-native V2 方向；要求先测量和缓解 V1 的非必要数据库唤醒。 |
| 2026-11-19      | 用户提供 Supabase Free 实验项目低活动即将暂停的邮件；这不是 Ember Cloud 的数据库故障通知。                                                           |

原始对照报告仍为 Draft，不应将其全部未解决事项视为已完成。实际选型与当前部署由 main 上的部署说明及 ADR-0005 佐证。

## 2. 为什么 Ember 不需要完整的 Supabase BaaS

当时已经确定 Cloudflare-first、按实际需求逐步付费（pay-as-you-grow）的路线。托管 PostgreSQL 需要保持 Ember 已实现的持久化、租户隔离、事务、幂等以及 worker lease 语义。

| Supabase 能力  | Ember 的现行方案                                      |
| -------------- | ----------------------------------------------------- |
| Auth           | Apple Sign-in + Ember 自有认证与租户身份              |
| Data API       | Hono API + PostgreSQL repositories                    |
| Edge Functions | Cloudflare Workers                                    |
| 异步任务       | Cloudflare Queues + Async Runtime                     |
| Storage        | Cloudflare R2（对象）+ PostgreSQL（业务状态及元数据） |
| Realtime       | Ember 自有 API/客户端状态同步；不是当前 Supabase 依赖 |
| PostgreSQL     | Neon + Hyperdrive                                     |

因此数据库服务首先按照 PostgreSQL 兼容性、连接语义、可用性、成本和恢复能力选择，不为尚无需求的 BaaS 功能支付固定平台成本，也不引入 iOS 对数据库 API 的直接依赖。

## 3. 2026-11-08 对照实测摘要

两家实验数据库均位于 Singapore，仅用于相同区域对比，并不构成生产区域选择或全球延迟基准。以下是 PR #135 的历史证据（非本次重新运行）。

| 项目                                 | Neon Free                                                       | Supabase Free                                                  |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------- |
| PostgreSQL 版本                      | 17.11                                                           | 17.11                                                          |
| Migrations 0001–0017（PR #138 基线） | 全部应用，二次运行全部已应用；checksum/规范化 schema 与本地一致 | 同左                                                           |
| 核心持久化、租户隔离、幂等、回滚     | 针对性验证通过                                                  | 针对性验证通过                                                 |
| Advisory lock                        | 直接连接的迁移锁通过；Hyperdrive 事务锁通过                     | 直接连接的迁移锁通过；Hyperdrive 事务锁通过                    |
| Hyperdrive Worker                    | 真实调用通过                                                    | 真实调用通过                                                   |
| 连接故障恢复                         | 终止后端连接后恢复，约 2.2–2.7 s                                | 直接连接约 2.567 s；Hyperdrive 下一请求约 409 ms               |
| 空闲/恢复                            | 两次受控空闲观察进入 Idle，下一请求自动唤醒                     | 11m18s 后仍观察到 5 个闲置 origin session，未验证项目暂停/恢复 |
| 合成数据逻辑导出/恢复                | 通过                                                            | 通过                                                           |
| Hosted 压测                          | 部分并发场景未解决                                              | 针对性场景通过；未完成生产级负载测试                           |

### 关键胜出证据：Scale-to-zero

Neon 在受控测试中：

- 一次在约 7.5 分钟无请求后观察到 Idle；下一次 Worker 查询内部耗时 640 ms，HTTP 总耗时 1.96 s。
- 独立复测在 6m19s 后观察到 Idle；下一次查询内部耗时 611 ms，HTTP 总耗时 1.34 s。

两次观察均早于当时记录的 Hyperdrive 10 分钟 idle-connection timeout。它说明在该实验配置下，空闲的 Hyperdrive 连接并未阻止 Neon 休眠。但这些是有限样本，不是生产 SLO，也不能保证存在后台 SQL 调用时仍会休眠。

Supabase 的七天低活动项目级暂停与 Neon 的短时 compute suspension 不等价。前者可能需要人工恢复；后者在实验中可由下一请求自动唤醒。

### 未解决项与证据限制

- Neon 16 路并发 claim 通过；32 路测试 18 成功、14 超时。原始 SQL 诊断未保留；不能认定连接池、数据库延迟或 provider 限制是根因。PR #139 的诊断工具已完成静态验证，但原始报告未记录后续 hosted 诊断执行。
- 双方均存在固定时间窗口的 lock observer 测试敏感性；核心 advisory lock 的独立探针通过。
- 当时 Neon role script 的 `ALTER ROLE ... NOSUPERUSER` 被拒绝（SQLSTATE 42501），单独授权与角色属性检查通过，但该次实验未验证 password-authenticated runtime login；Supabase 使用兼容的角色创建方法完成了最小权限登录测试。
- 当时 Neon direct TLS 已由客户端验证，但 `pg_stat_ssl` 与代理端 TLS 的关系仍存在未解释的观察。
- 本地完整集成测试的 4 项失败来自旧的 16-migration 数量断言，与新增 0017 不一致；不将这些结果表述为全部测试通过。
- 两家测试使用不同的 Hyperdrive origin connection cap（Neon 20，Supabase 5），延迟与并发结果不能直接当成供应商性能排名。未验证持续负载、万人容量、完整网络分区或生产级灾难恢复。

细节以 [PR #135](https://github.com/basicv8vc/Ember/pull/135) 和 [PR #139](https://github.com/basicv8vc/Ember/pull/139) 为准；新测试需要独立授权及记录。

## 4. 经济性：按历史套餐评估，而非当前报价

以下配额和价格来自 2026-11-08 原始报告；不是本次实时核价，也不是未来套餐承诺。

| 项目            | Neon                                                 | Supabase                           |
| --------------- | ---------------------------------------------------- | ---------------------------------- |
| Free 数据库容量 | 1 GB                                                 | 500 MB                             |
| Free compute    | 100 CU-hours/月                                      | 实例模式，低活跃可能暂停           |
| Free transfer   | 5 GB public transfer                                 | 5 GB uncached + 5 GB cached egress |
| Free 恢复       | 6 小时/1 GB history；一个手动 snapshot               | 无自动项目备份                     |
| Paid 起步       | Launch 按使用量：当时 $0.106/CU-hour、$0.35/GB-month | Pro 当时 $25/月起                  |

当时 Neon Launch 的示例：若 0.25 CU 每天运行 8 小时，每月约 60 CU-hours，计算费用约 $6.36（另计存储、历史恢复与超额流量）。如果持续 24 小时运行，则为约 180 CU-hours、$19.08，仅计算费用就明显增加。以上均为模型估算，而非账单。

对照报告的万人场景假设 DAU 为注册用户的 10%，每 DAU 每天 10 条消息，每条 10 条 SQL，推算约 100,000 statements/day、1.2 GB/月数据增长、6 GB/月数据库 egress。在该假设下，两家 Free 都不适合继续承担全部负载；应提前规划容量。具体成本需要以实际 SQL、CU-hours、存储、网络、恢复目标与届时定价核算。

Free 只是实验和低流量起步的手段，不是架构硬约束。两家 Free 都不提供足够的生产级恢复承诺；应在引入真实用户数据前验证加密逻辑备份及可恢复性。

## 5. 当前 Ember Cloud 架构

根据 [cloud-staging.md](../cloud-staging.md)、[Cloudflare README](../../infra/cloudflare/README.md) 与 [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md)，现行共享环境为：

```text
iOS App
   |
API Worker ---- Cloudflare Queues ---- Async Runtime Worker ---- LLM / Daytona
   |                                         |
   +------------ Cloudflare Hyperdrive -----+
                         |
                  Neon PostgreSQL
                         |
              Business state / metadata

R2: file payloads and artifacts
Migration runner -> separate direct PostgreSQL connection
```

Neon PostgreSQL 是业务状态权威。API 和执行 Worker 通过 Hyperdrive 共享数据库；迁移必须走独立直连，因为 session-level advisory lock 不能经过 Hyperdrive transaction pooling。

Supabase 项目 `ember-issue132-supabase-free` 是 Issue #132 授权的合成数据对照环境。Ember Cloud 不使用它的 Auth、Storage 或 Data API，也没有将其选为当前主数据库。

以上是仓库配置与部署文档的核实结果，未重新查询 Cloudflare 线上 Hyperdrive origin、数据库内容或平台用量。

## 6. 近期服务商通知的实际影响

### Neon compute 预警

收到 Neon compute 额度预警，说明早期 Free 预算存在现实压力。若 API 状态读取、Worker recovery/relay、lease 检查或定时清理等操作频繁触发 SQL，可能妨碍 scale-to-zero。

这是待测量的运行时问题，而不是 PostgreSQL 不适用的结论。需要查看真实唤醒来源、SQL 次数、CU-hours、任务恢复延迟和首请求延迟，不能仅根据邮件断定根因或量化节省额度。

### Supabase Free 暂停预警（2026-11-19）

用户转发的邮件称：`ember-issue132-supabase-free` 因超过 7 天活动不足而即将暂停；邮件发送时尚未暂停；暂停后 90 天内可恢复，之后可下载数据但不可原地恢复。具体期限以该项目通知和控制台为准；本次未重新验证账号状态。

由于该项目是独立实验环境，预计不影响当前 Ember Cloud。建议不为保留实验实例单独升级 Pro；如仍需复测，先检查和保留必要的合成数据、原始报告及逻辑导出，再按需恢复或重新创建测试项目。不要删除、迁移或修改现有共享数据库，也不要通过人为持续请求规避免费层政策。

## 7. 后续方向与重新选型条件

### V1：继续 Neon

- 保持已验证的 PostgreSQL 契约与现行部署，不为短期免费额度做数据库迁移。
- 优先减少不必要的数据库唤醒，保留可靠的 outbox、lease fencing、幂等、预算、取消及 bounded reconciliation；不能以省钱为由丢失任务。
- 监测 CU-hours、冷启动/尾延迟、任务恢复、SQL/连接使用量和真实账单；接近配额或生产可用性/备份目标时，提交付费方案评估。
- 对真实用户数据定义备份、恢复和导出要求，定期验证逻辑恢复。

### V2：事件驱动的 Cloudflare-native Runtime

遵循 [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md)：探索 Workers + SQLite-backed Durable Objects + Alarms + Queues + R2；D1 只作为有明确需求时的可选全局控制面。

薄 DO 负责 agent-local 状态协调及调度，耗时模型或 sandbox I/O 继续由独立 Worker 执行。V2 的潜在收益是按需唤醒、减少空闲轮询和加强 per-agent 调度，而不是承诺零空闲成本。

ADR-0005 的目标包括在条件成熟时退出 Neon，但不等于已经批准迁移、已经实施 V2 或承诺固定时间。迁移前必须获得独立批准，验证租户隔离、事务/幂等/预算语义、故障恢复、schema 生命周期、导出与回滚、端到端延迟和实际费用。

### 何时重新考虑 Supabase

若未来需要其集成的 BaaS 功能、确定性常驻 compute，或优化后的 Neon 在真实工作负载中表现出持续成本/性能劣势，可重新对比 Neon Launch 与 Supabase Pro，并复用已有 PostgreSQL 兼容性证据。重新选择须检查实际套餐、区域、容量、恢复能力与迁移风险，而不是仅凭一次免费额度预警。

## References

- [Issue #132 — Managed PostgreSQL: Supabase vs Neon + Hyperdrive](https://github.com/basicv8vc/Ember/issues/132)
- [PR #135 — Neon/Supabase validation](https://github.com/basicv8vc/Ember/pull/135)（原始实测、成本模型及备份恢复记录）
- [PR #139 — Follow-up compatibility and claim diagnostics](https://github.com/basicv8vc/Ember/pull/139)
- [L4 Cloudflare Workers P0](../product/L4_CF_WORKERS_P0.md)
- [Ember Cloud](../cloud-staging.md)
- [Cloudflare deployment](../../infra/cloudflare/README.md)
- [ADR-0005 — Cloudflare-native Cloud Runtime V2](../adr/0005-cloudflare-native-runtime-v2.md)
- [Neon pricing](https://neon.com/pricing) / [Supabase pricing](https://supabase.com/pricing)（重新评估时核实）
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)

本文件仅记录决策与证据；不新增运行依赖，不变更数据库、代码、部署、凭证或付费计划。
