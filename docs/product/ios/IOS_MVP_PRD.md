# Ember iOS MVP PRD — IOS-LEAD-001

> Status: PROPOSED / CTO + Jia review required · 2026-11-01
> Audit base: Ember `f02075b7d8139149efdb6bc28ac05d7f5d764ae5`; Shua `13711dcb1516f99ca95af7a084caf4e7bda496fe`
> Owner: iOS Product Lead · Product decision: Jia · Technical/safety gate: CTO

## 一句话产品

用户把一件具体工作交给 Ember，得到持久接收的承诺、真实可解释的进度，最后取回可用成果；暂不把 Ember 包装成万能聊天机器人。主体验为 **Promise → Progress → Outcome**。关闭 iPhone 不撤销服务端已接收的任务；没有 Mac 也可完成核心流程。

## 唯一首用场景：零散笔记 → 可执行行动清单

对象：有会议记录、学习笔记、零散工作想法，却没有时间手动整理的普通用户。第一句：“帮我把以下笔记整理成优先级明确的行动清单，指出信息缺口和接下来最重要的三步。”用户直接粘贴文本；Ember 承诺生成一份结构化 Markdown 结果（行动项、优先级、责任/时间未知标记、待澄清事项、下三步），任务全程可追踪，结果可复制/分享。对敏感笔记，必须先有明确云端处理与留存说明，不能默默上传。

为什么是它：

- 输出可检验：同一任务有独立结果，脱离聊天上下文仍可使用；不需要外部账号、真实写入动作或网页检索。
- 可以小步验证 durable ack、离开/返回、失败与恢复，不要求后台驻留或 Mac。
- 第一版“持续推进”表示**本次承诺的持久生命周期**，不等于跨天自主跟进；跨天 Goals、长期 Memory、Scheduler/主动每日简报属后续能力，不提前承诺。

对比：① 通用聊天＝快但任务与可追踪结果缺席；② “iPhone 控制 Mac Coding Agent”是 Founder 认可的后续 Hero Feature，但需要可信设备身份、Mac Executor Gateway、审批与设备权限，且不能成为无 Mac 用户的 P0 门槛。故选择笔记整理为 **Cloud-only 的第一个产品价值切片**，Mac Hero 进入后续探索。

## 能力标记与发布门禁

- **EXISTING / local P0-B**：`POST /v1/agents` 创建逻辑 Agent、`POST /v1/tasks` 幂等持久接收、`GET task`、Events/SSE、取消、Mock Approval、Artifacts；仓库已有真实 PostgreSQL 实现与本地测试。它们**不是已上线的消费者服务**。
- **MOCK ONLY**：`mock.chat` 的 FakeLLM，`mock.file`/`mock.approval` 的模拟操作；可做连接与状态 Demo，所有相关画面须持续显示“模拟演示，不代表真实处理”。
- **PROPOSED / blocked**：真实受控 Cloud Model Gateway、受约束的 notes-to-actions 执行类型/输出、生产级用户认证、任务列表/恢复、任务输入/结果展示契约、内容隐私/保留策略；这些由 CTO/Platform 批准并实现后方可测试真实价值。
- **PROPOSED later gate**：APNs 通知注册/投递/隐私，文字审批说明及 ActionIntent/Capability，设备同步；P0 UI 展示意图但未经端到端验证不可称“主动通知”。
- 原则：绝不把 FakeLLM 结果标为“AI 已整理完成”；不能为满足产品愿景绕过 P0-C2 安全 gate 或启用未经批准的服务。

## In scope（第一轮规划；实现受 Gate 限制）

1. 首次打开：简短价值说明 + 云端处理/隐私提示；“先看示例”（明确静态 Demo）或完成正式登录（PROPOSED）。
2. 单一默认伙伴 Ember：已登录且服务端可恢复 Agent；首轮可以通过 `POST /v1/agents` 验证创建，不能仅依赖本机 ID 伪装跨设备存在。
3. 首屏“承诺列表/任务收件箱”，顶部新建任务；用户粘贴材料并提交；请求未确认前只显示“正在提交”，202/200 Receipt 才表示“已接收”，而非“正在执行”。
4. 任务详情为主角：任务名称、真实状态、时间轴、授权卡、结果/失败/取消；事件只表达服务器报告的事实。
5. SSE 断线续接，冷启动重新同步；取消请求确认与最终完成分开；连接中断时不自动声称任务失败。
6. 完成后展示可信 Artifact/输出、复制/系统分享；没有可取回成果不得出现空白“已完成报告”。
7. VoiceOver、Dynamic Type、深浅色、弱网/中断、中文/英文文案走查；P0 不做复杂人格/宠物/外部 SDK。

## Out of scope

Mac 远控与设备发现、浏览器自动化、邮件/日历/金融账户 Connector、外部写入、跨天定时任务、长期 Memory、多个默认 Persona、模型/Provider BYOK 设置、付费套餐、生产部署/App Store 上架；无 CTO 批准不得添加用户数据分析 SDK。

## 用户故事与可验收 DoD（均为提案）

| Story      | 可观察验收                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| 第一次委托 | 有可理解的任务模板、可编辑文本和明确数据传输说明；提交失败草稿不消失                                         |
| 承诺确认   | 网络超时前不冒称成功；使用原幂等键同载荷重试避免重复任务；202 新建、200 重放                                 |
| 进展诚实   | `queued/running/waiting_approval/retryable_failed/completed/failed/cancelled` 与细分事件映射正确；无假进度条 |
| 离开后返回 | 恢复已知 Task ID + 游标；与 server snapshot 对账；无“iOS 后台持续运行”宣传                                   |
| 成果交付   | 仅有权威、可读取、完整 Artifact 才展示结果；错误、缺失和真实完成分开                                         |
| 取消与审批 | Cancel 202 不说“已停止”；批准/拒绝/过期有明确结果；无可读动作说明时禁用真实审批                              |
| 质量       | 模拟器覆盖 happy、断线、幂等重放、取消 race、审批过期、404/401、无障碍；未实际运行不写 PASS                  |

Proposed product validation targets (not current SLO): 5 位普通用户中的至少 4 位能无需引导完成首任务；100% 的“已接收”屏幕有服务端 Receipt；0 次将 Mock 结果标成真实；所有终态可在冷启动后解释；真实服务端执行与成本阈值另由 CTO 批准。具体数值在试用数据到来后复审。

## Open decisions

本文件不授予生产授权。请见 `IOS_STATUS.md` 的 3 项 CTO Review Request；验收首轮文档不等于上线许可。参照 `IOS_API_DEPENDENCIES.md`、`IOS_USER_JOURNEY.md`、`IOS_SPRINT_PLAN.md`。
