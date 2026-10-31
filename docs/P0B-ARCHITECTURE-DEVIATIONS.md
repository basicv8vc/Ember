# Ember P0-B: 架构偏离与设计决策审计报告 (P0B-ARCHITECTURE-DEVIATIONS)

> **文档性质:** 架构核对与偏离追踪报告  
> **核对基线:** `docs/architecture/Personal_Agent_Platform_Architecture_RFC_v0.2.md`  
> **任务书标准:** `docs/architecture/Personal_Agent_Platform_P0-B_Minimum_Vertical_Slice_Task_Spec.md`  
> **代码基线 SHA:** `2ec04f6c7459820c20813554a749c60447d33e88` (main / PR #24)  
> **审计日期:** 2026-10-31

---

## 一、审计摘要与结论

本报告对 Ember P0-B 垂直切片实现的实际代码、数据库 Schema、状态机与接口契约，对照上游权威文档 **Architecture RFC v0.2** 进行逐项核对。

**核心结论：**

1. **核对范围内未发现违规或未受控的架构偏离。**
2. 所有状态机扩充、错误终止路径及持久化契约，均已通过 **ADR-0001、ADR-0002、ADR-0003** 获得 CTO 预先批准并冻结，属于受控的前向演进。
3. 未覆盖或未实现的上层能力（如 Heavy Path、真实云 Sandbox、BYOK、多地域数据库迁移）均属于 RFC v0.2 §1.3 及 Task Spec §15 明确界定的 **P0-B 非目标（Non-goals）**，未越界伪造实现。

---

## 二、受控架构决策与演进项（Approved Architectural Decisions）

| 偏离/决策项                                                              | RFC v0.2 初始定义                                                                                          | P0-B 最终实现                                                                                                                | 依据与批准文档                        | 兼容性与影响分析                                                                  |
| :----------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ | :-------------------------------------------------------------------------------- |
| **ADR-0001 (OQ-1):**<br>`retryable_failed` / `waiting_approval` 直接取消 | RFC v0.2 §4.1 状态机仅允许 `retryable_failed → queued \| failed`；取消时机作为 Open Question (OQ-1) 待决。 | 允许 `retryable_failed → cancelled` 及 `waiting_approval → cancelled`，取消意图原子写入且具备调度抢占优先级。                | **ADR-0001**<br>(Accepted 2026-10-28) | 完全向后兼容。避免了竞态条件下已被用户取消的任务再次被调度重试或在批准后复活。    |
| **ADR-0002 (OQ-2):**<br>Pre-claim Deadline 终止 (`queued → failed`)      | 任务仅在 Worker 认领创建 Run 后才能进入 `running` 或终止，未声明认领前已过期的处理。                       | 允许单一正向边 `queued → failed`：在 claim 时检测到任务已过 deadline/budget 时，不创建人工 Run 即可安全收敛至终态。          | **ADR-0002**<br>(Accepted 2026-10-28) | 严格防止了不可认领的死亡任务永久堆积在 `queued` 状态中，保持无有效 Run 的不变量。 |
| **ADR-0003 (B06-D1~D6):**<br>Artifact / Workspace / Checkpoint 契约冻结  | RFC v0.2 §3.3 提出了 Persistent Workspace 与 Blob 存储的概念设计，未限定具体存储实现与锁协议。             | 明确了 Blob（不可变）、StagedBlob（私有隔离）、Artifact（已发布元数据）三级生命周期；采用 CAS 版本乐观锁与原子结果提交事务。 | **ADR-0003**<br>(Accepted 2026-10-29) | 隔离了文件物理路径与公共 API，彻底杜绝路径遍历、孤儿半提交和并发写覆盖。          |

---

## 三、范围限定与阶段边界对照（Scope Delimitation）

| 维度                              | RFC v0.2 长期规划                                                      | P0-B 实际实现范围                                                                       | 判定依据                                                              |
| :-------------------------------- | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| **执行路径 (Execution Paths)**    | 三条路径：Fast Path、Standard Path、Heavy Path (Warm Pool / Always-on) | **仅实现 Fast Path (`mock.chat`) 与 Standard Path (`mock.compute`)**；Heavy Path 不实现 | Task Spec §3 及 §15：P0-B 聚焦最小垂直切片，不引入暖池容器与常驻 VM。 |
| **沙箱提供商 (Sandbox Provider)** | Cloudflare、E2B、Daytona、Boat 四家候选对比                            | **仅实现 `FakeSandboxProvider`（纯内存/SHA-256 仿真）**；真实云提供商留待 P0-C1         | Task Spec §15/16：P0-B 禁止调用、开通或配置任何收费外部云服务。       |
| **模型推理 (LLM Inference)**      | 真实 LLM API、提示缓存算法、模型路由                                   | **`DeterministicFakeLLM`（可重现内存模拟）**                                            | Task Spec §15：测试不需要付费模型 API Key。                           |
| **多租户认证 (Authentication)**   | 生产 OAuth / OIDC、BYOK Key Vault                                      | **固定格式 Bearer Dev Token (`Bearer dev_token_<tenant>_<principal>`)**                 | Task Spec §7：本地控制面验证最小鉴权与租户边界，不做生产认证中心。    |
| **Blob 存储 (Storage)**           | 生产 S3 / Cloudflare R2                                                | **`LocalBlobStore`（基于受控临时目录的本地文件存储）**                                  | Task Spec §6：提供一致的抽象接口，保证本地可重复验证。                |

---

## 四、未发现偏离核对清单（No-Deviation Verification Checklist）

- [x] **PostgreSQL 状态持久化权威性：** 任务状态流转完全以数据库事务及 行级锁 (`SELECT FOR UPDATE SKIP LOCKED`) 为唯一权威仲裁，无内存分裂脑。
- [x] **Durable Ack 语义：** 必须在数据库事务 Commit 后才向客户端返回 `2022 Accepted` 与 Task ID，无丢失确认。
- [x] **Tenant 强制隔离：** 所有 Repository 查询及 API 路由严格限定 `tenant_id` 复合主键/外键；跨租户请求统一返回 `404 Not Found`，彻底消除存在性预言机（Existence Oracle）。
- [x] **Lease Fencing 与租约保护：** `lease_epoch` 与超时回收机制完备，迟到的旧 Worker 提交被严格拦截 (`FENCE_REJECTED`)。
- [x] **SSE 断线恢复：** 基于事件日志游标 (`Last-Event-ID`) 的严格单调递增重放，事件顺序与数据库序列一致。
- [x] **遥测脱敏与成本模拟：** 强制 `cost_source = "simulated"` 且 `actual_vendor_cost_usd = null`，日志及 Trace 彻底剔除敏感 Token、私钥与原始 Prompt。

---

## 五、待审与后续行动（Pending Actions for P0-C1 / V1）

1. **P0-C1 多沙箱接入：** 依据 `docs/P0-C1-SANDBOX-SMOKE-HARNESS-SPEC.md`，设计对四家真实云沙箱的适配层，保持对 `@ember/contracts` 中 `SandboxProvider` 契约的 100% 兼容。
2. **生产级 S3/R2 BlobStore 适配器：** 将当前已冻结的 `LocalBlobStore` 接口迁移为兼容 AWS SDK v3 / S3 协议的远程对象存储驱动。
3. **长期未覆盖项：** 生产 OAuth 接入、跨地域网络预算控制及真实计费对账系统，列入 V1 架构演进路线。
