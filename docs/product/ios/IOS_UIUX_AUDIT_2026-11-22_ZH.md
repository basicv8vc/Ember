# Ember iOS UI/UX Audit + Prioritized Improvement Proposal

- **角色**：Principal Product Designer & UI/UX Lead
- **汇报对象**：Ember CTO
- **日期**：2026-11-22
- **代码基线**：`basicv8vc/Ember` / `main` @ [`2445e93349cbb2ef8a67402804881fa7932127fc`](https://github.com/basicv8vc/Ember/commit/2445e93349cbb2ef8a67402804881fa7932127fc)
- **阶段**：Founder Daily Use — Product Experience Refinement
- **交付性质**：静态代码审计 + 设计提案；**未运行真机/模拟器，未开展可用性访谈；仅提交审计文档，不修改生产代码或部署**。

## 执行摘要

**设计判断：保留 Conversation-first 的产品骨架，优化“承诺 → 进展 → 结果”的端到端可理解性，不做全面重设计。**

目前已有的能力包括：Live conversation、SSE 流式回复和轮询恢复、发送确认与错误恢复、Task Inbox 和 Task Detail、Artifact 下载/预览/分享、Personal Memory 查看/新增/编辑/删除、Proactive Schedules 创建/暂停/恢复/取消/展示执行结果。用户面对的主要问题不是“没有页面”，而是多个能力以工程状态、技术标识、复杂表单及分散入口呈现，导致“Ember 实际承诺了什么、现在进展如何、结果在哪”不够直观。

**重要环境约束（上线/验收阻塞项，非单纯 UI 缺陷）**：`AppCompositionRoot` 默认连接 V1 `ember-api.slowfast.dev`，V2 Staging 需显式选择；Memory / Schedules 页面分别存在服务端不支持时的提示分支。因此若 CTO 使用默认 V1 构建进行 Founder Daily Use，“能够在 UI 中发现入口”不等于“能真实完成记忆和计划任务”。**必须用配置明确、能力可用的 V2 测试环境做端到端验收**，不允许通过 UI 隐藏这一事实或模拟成功。见 [AppCompositionRoot.swift L22–29, L61–97, L200–220](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/App/AppCompositionRoot.swift#L22-L29)、[Memory Sheet L40–53](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Memory/PersonalMemorySheetView.swift#L40-L53)、[Schedules Sheet L65–78](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Schedules/ProactiveSchedulesSheetView.swift#L65-L78)。

## 五个体验领域的当前状态

| 领域 | 已实现、应保留的基础 | 主要体验风险 |
| --- | --- | --- |
| Conversation | SSE 流式文本、发送中占位、错误恢复、附件输入、空态提示 | 每个流式 delta 强制滚到底、头部拥挤、技术性错误说明 |
| Memory | 新增、列表、出处、编辑、删除确认及服务端不可用提示 | 管理页优先呈现“输入表单”而非“已记住什么”；原始 key 暴露 |
| Tasks & Artifacts | 任务分类、状态、事件、结果、文件安全下载/预览/分享 | 任务详情技术字段较多且居前，文件离用户的主要结果较远 |
| Proactive & Follow-ups | 创建一次性/每日计划，暂停/恢复/取消，最近运行状态 | 真实聊天 commitment 仍显示 UUID；计划页创建表单优先；“查看聊天”无结果定位 |
| Visual Identity | SwiftUI 系统色、Dynamic Type 字体样式、基础间距/圆角、玻璃输入框 | 品牌识别偏弱；部分技术文本未统一本地化；小屏/辅助功能需实测 |

## 优先改进清单（9 项）

说明：**P0** 直接损害产品信任/目标流程；**P1** 高影响的交互障碍；**P2** 有益但可在核心体验稳定后处理。**S/M/L** 是相对实现工作量预估，未经过 iOS Lead 排期评审。置信度为“代码已证实”或“高概率/需真机验证”。

| 顺位 | 优先级 | 问题与证据 | 用户价值 / 建议改动 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| 1 | **P0** | 真实 `commitmentReference` 渲染成 `Commitment reference` + 原始 UUID；已有 `CommitmentCard` 主要作为展示组件，并未在这条 Live 分支使用。[LiveConversationHost L1157–1164](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift#L1157-L1164) | 使用**来自真实数据**的可读承诺摘要和状态；若无可解析的对应实体，显示“不泄露 ID 的中性状态+可到达的管理入口”，不臆造完成状态。 | M | 代码已证实 |
| 2 | **P1** | 只要 `streamingReplyText` 非 nil 就持续 `scrollTo(bottom)`，未识别用户主动上滑。[Timeline L59–82](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Transcript/ConversationTimelineView.swift#L59-L82) | 用户阅读旧消息时停止强制滚动；仅在视图接近底部且用户未主动离开时跟随新内容，显示“跳到最新”入口。 | M | 代码已证实，体验影响需设备确认 |
| 3 | **P1** | Chat 顶部独立一排放环境标志、Schedules、Memory、Sign out，还叠加 Conversation header；环境标志设 `fixedSize(horizontal: true, ...)`。[LiveConversationHost L1948–2038](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift#L1948-L2038) | 保留“聊天为主”的主界面：品牌/会话状态居前；较少使用的 Memory、计划管理和登出收敛到明确的次级入口（具体 IA **需 CTO 批准**）；测试 320pt 宽度与大字体。 | M | 高概率，需真机验证 |
| 4 | **P1** | 未确认发送、断线、取消等状态含多处工程用语（`Cloud`, `send ID`, `receipt`, `server state`）；部分 Live 文案直接写死英文。[LiveConversationHost L658–830](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift#L658-L830) | 采用“发生了什么 → 是否安全 → 能做什么”一致结构；未知 ACK 只能“确认是否已发送”，不可引导重复提交；完整 en/zh-Hans 本地化，区分中断观察与取消服务端任务。 | S–M | 代码已证实 |
| 5 | **P1** | Task Detail 顶部展示 server truth 提示、执行次数和完整 Task UUID，随后才是活动、结果和文件。[TaskDetail L225–306, L387–518](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/TaskDetail/TaskDetailView.swift#L225-L306) | 结果/下一步操作优先；运行中状态和等待审批优先；ID/尝试次数归入“技术详情”折叠区；保留服务器真相和现有状态机。 | M | 代码已证实 |
| 6 | **P1** | Proactive Sheet 首屏先见创建表单，活跃计划列表在后；Schedule 的“View in chat”回调仅关闭 Sheet / 切换聊天，没有定位到对应结果。[Schedules L52–115, L179–312, L524–532](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Schedules/ProactiveSchedulesSheetView.swift#L52-L115) | 已有计划优先呈现“下次执行 / 最近执行 / 当前状态”；创建保持简洁的次级操作；结果入口应以真实 `resultMessageId` 做定向导航（如果现有模型边界允许，否则标为“在聊天中查看”但不承诺精确定位）。**排序/布局调整需 CTO 批准。** | M | 代码已证实 |
| 7 | **P1** | Memory 管理首屏先是输入卡，再是已保存列表；每条记忆会展示原始 `key`。但**编辑/删除与来源已经存在**，不应重复开发。[Memory L27–104, L143–303](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Memory/PersonalMemorySheetView.swift#L27-L104) | 改为“Ember 记住了什么”优先；保留编辑/删除、来源与操作后反馈；优先隐藏面向内部的数据键，清楚解释“仅明确保存的信息会持续生效”；不扩展隐私权限。 | S–M | 代码已证实 |
| 8 | **P2** | 文件从聊天结果点击后进入 Task Detail，而文件出现在结果和活动之后；预览前需先点击下载，随后才能 Preview 或 Share。[LiveConversationHost L1326–1358](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift#L1326-L1358)、[TaskDetail L483–625](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/TaskDetail/TaskDetailView.swift#L483-L625) | 强化结果/文件的显著入口和“获取中 → 可预览/分享”的连续反馈；保留 MIME、安全扩展名、完整性校验，不绕过文件下载门禁。 | M | 代码已证实 |
| 9 | **P2** | Design Tokens 主要涵盖系统背景、卡片、圆角、间距；Composer 定义 spring 动画；部分 Live 字段仍用英文常量。[Tokens L3–13](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/DesignSystem/EmberDesignTokens.swift#L3-L13)、[Composer L13–17](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Composer/ConversationComposer.swift#L13-L17) | 统一文字层级、状态颜色、交互尺寸、轻量品牌符号，实测浅/深色、Reduce Motion、VoiceOver 和 Dynamic Type；**暂不做拟人化角色或动画大改**。 | S–M | 源码已证实基础薄弱，实际感受待视觉审计 |

## Before → After：关键体验流程

### 首次进入 / 任务发起

- **Before**：真实模式进入 Apple 登录后，出现聊天空状态和 3 个提示词，分别引导 Memory、每日简报和 Follow-up；默认 V1 后端却可能对这些 V2 功能显示“尚未开启”。[AppCompositionRoot L147–170](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/App/AppCompositionRoot.swift#L147-L170)、[LiveConversationHost L1197–1205](https://github.com/basicv8vc/Ember/blob/2445e93349cbb2ef8a67402804881fa7932127fc/apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift#L1197-L1205)。
- **After**：登录后第一视线是一个明确的“试着让 Ember 帮你完成一件事”的对话邀请；快捷示例只展示当前环境可真实履约的能力，或明示尚未可用。优先让用户走通发起工作 → 任务被接受 → 查看结果的真实路径。

### 阅读与发送恢复

- **Before**：流式回复持续把 Timeline 推到底；网络恢复呈现多种 Cloud/receipt 技术提示。
- **After**：用户上滑后位置稳定；新消息可点“跳到最新”。发送中的消息显示“正在发送”；未知状态显示“正在确认是否已发送”，重试动作表达为“检查状态”而非“再次发送”；断线不伪装为任务取消。

### 查看、纠正记忆

- **Before**：进入 Memory 首先看到类型切换器与创建表单，再向下看到保存的内容和技术 key。
- **After**：先看“Ember 已记住”的事实/偏好及来源，直接编辑或删除；保存新记忆作为明确的次级操作。删除确认强调真实的持久状态，不暗示删除历史对话本身。

### 识别承诺、追踪进度

- **Before**：真实对话的承诺可能以 UUID 出现；另一个独立 Sheet 先展示创建表单，用户需进入列表才看到计划状态。
- **After**：对话引用可显示“已安排 / 下次执行 / 查看计划”类可验证摘要；已有计划按“进行中、暂停、完成/取消”可读地展示，能快速打开真实对应结果。缺少可信关联数据时不凭文本推断承诺状态。

### 打开结果和文件

- **Before**：打开 Task 后，先经过技术参数、Activity，才到结果；下载后再点预览或分享。
- **After**：根据任务状态突出当前最重要的信息：运行中看进展，等待审批看需采取的操作，完成看结果/文件；技术参数折叠。文件操作维持既有安全检查，给出清晰进度及下一步。

## 推荐设计方向（待 CTO 审批）

1. **保持双 Tab：Chat / Tasks。** 本轮不新增独立 Memory、Plans、Files Tab。Chat 仍是主入口，Tasks 是唯一集中检查异步工作的地方。
2. **减少聊天主屏的常驻控制。** 建议保留品牌/会话状态、必要的主动事项提示和输入框。Memory、Schedules、Sign out 可通过二级操作区访问，但具体布局须先用 320pt、375pt、393pt 样机验证后提交 CTO。
3. **重用当前真实数据契约。** 只展示服务器确证的任务、计划、执行结果、文件和记忆状态；无数据或接口不可用时显示诚实、可恢复的状态。
4. **微调而非视觉重启。** 使用 Apple 的原生滚动、菜单、Sheet、ShareLink、Dynamic Type 与辅助功能。设定一个低调的 Ember 视觉锚点，而不是铺满卡片和高频动效。

## 小 PR 实施建议（本阶段尚不授权实施）

| 建议 PR | 内容 | 依赖/验收门禁 |
| --- | --- | --- |
| UX-01 | 将 Live 承诺引用改为可信的用户可读表示；完全移除原始 UUID 对外呈现 | CTO 确认 DTO 与 Schedule 的映射语义；测试“有关联/无关联/过期/接口不可用” |
| UX-02 | Timeline 近底才自动跟随 + 跳到最新 | 回归流式 delta、切后台/回前台、动态字体、发送新消息后的滚动 |
| UX-03 | Live 错误/恢复文案及本地化统一 | 严格保留 Unknown ACK 幂等保护；en/zh-Hans；离线/403/404/取消 |
| UX-04 | Chat 头部信息层级 + 空态引导 | **CTO 先批准结构草图**；320pt 宽度、VoiceOver、动态字体 |
| UX-05 | Task Detail 结果优先、技术详情折叠、Artifact 入口优化 | 测试 queued/running/approval/completed/failed/cancelled + 文件完整性门禁 |
| UX-06 | Memory 列表优先、Schedule 已有计划优先、跨入口状态一致 | **CTO 先批准 Sheet 内信息排序**；不改 API/schema；更新保存/删除/暂停/恢复 UI 测试 |
| UX-07 | 视觉细节收敛、无障碍与本地化扫尾 | iPhone SE/小屏、深浅色、Reduce Motion、VoiceOver、en/zh-Hans 截图比较 |

每个 PR 应保持独立可回滚，iOS Lead 负责架构约束与构建/测试审核。**不启用 GitHub Actions CI 作为本轮强制门禁**；使用本机 Xcode 构建、定向 UI/单元测试和真机 Founder 场景验收。

## 测试与验收矩阵

- **新用户**：Apple 登录 → 看懂 Ember 能做什么 → 成功发送第一条消息；不让“尚未启用的 V2 功能”成为默认第一个失败体验。
- **可信承诺**：从聊天明确区分“用户说要做”“Ember 已接受”“正在执行”“已完成”；不显示原始 ID、不凭文本虚构任务。
- **中断恢复**：发送时断网、Unknown ACK、流式断线、后台回来、点击停止；消息不能重复，状态文案必须清楚。
- **任务与文件**：一项真实任务从接受到产出；完成时找到结果和文件；下载失败有可理解的重试；分享仍遵守现有安全校验。
- **Memory**：查看、编辑、删除并确认最新状态；跨登录态不串数据；不把后台未持久化状态当成成功。
- **Proactive**：创建一次性或每日计划、核对时区与下次执行、暂停/恢复/取消、找到最近运行结果。
- **环境与无障碍**：V1 不可用提示、V2 可用路径；320/375/393pt、Dynamic Type、VoiceOver、暗色、中文/英文；避免按钮截断和不可达控件。

**产品级通过标准**（建议）：至少 5 次非开发者的引导式首用走查，每位测试者都应能不解释底层架构地：描述 Ember 能做什么；发起对话；完成一项已有能力支持的委托；找到并管理一条记忆；指出一项活跃承诺及其进展。记录每个任务的成功、误解、卡点和求助动作，不以自测通过替代用户理解。

## 提请 CTO 决策

1. **验收环境**：批准 V2 Staging 作为 Founder Daily Use 的体验基线；默认 V1 的能力缺口明确记录，不能在 UI 中模拟或粉饰。
2. **结构调整范围**：原则批准 Chat 头部收敛、Memory 列表优先和 Schedule 已有计划优先，但任何大范围导航/IA 更改仍需独立评审。
3. **承诺数据语义**：批准由 iOS Lead 核对 `commitmentReference` 是否能可靠关联现有 Proactive Schedule/Commitment 数据；不能确认时只做安全的非技术占位，不伪造数据。
4. **品牌力度**：批准“安静、温暖、可靠”的轻量视觉系统，不引入拟人化大动画、独立 Agent 角色页面或额外功能。

## 审计边界

本报告的“源码已证实”仅指当前代码路径存在某个呈现/交互行为，**不表示已在设备上复现视觉故障**。视觉拥挤、可用性下降、信息查找耗时等均是设计假设，必须经截图/录屏/真机或测试验证。尚未做截图对比、性能测量、无障碍扫描或独立用户研究。未触碰 Cloud Runtime、Auth、Database、Execution Architecture，也未进行生产部署或大范围设计实施。