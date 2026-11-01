# Ember iOS — Architecture Proposal

> Status: PROPOSED, not authorized for coding · 2026-11-01
> Ember base `f02075b7d8139149efdb6bc28ac05d7f5d764ae5` · Charter `IOS_PRODUCT_LEAD.md`

## 推荐

- **工程归属**：推荐在 Ember monorepo 的 `apps/ios/` 内建立独立 Xcode 工程（保留同一 GitHub PR、API fixture 与跨团队审查），备选独立私有 iOS repo（Xcode CI 灵活，但接口/文档漂移成本高）。**需 CTO 批准**，现有 main 无 `apps/ios`、`.xcodeproj`。
- **Deployment target**：推荐 iOS 17+（`NavigationStack`、SwiftUI/Observation 能力，结合 Shua iOS 17+ 的经验）；备选 iOS 16+（更广覆盖，需 `ObservableObject` 兼容和更多测试）；**需 CTO 批准**，不因 Shua 选择自行定案。
- **依赖**：第一轮只用 Apple 原生 SwiftUI / Foundation / URLSession / AuthenticationServices 等系统 Framework。无第三方 SDK、监控/分析或付费基础设施；需要新增时先走 CTO Review。
- **中心架构**：任务为一等实体，消息只是交互表层。iOS 不运行 Agent、不持有 Postgres 或 Worker 租约、不决定 cloud/Mac placement。Authority = cloud Task/Run/Event/Artifact + verified identity。

## CTO review-driven M1 build prerequisite

Before **any** three-lane coding begins, the iOS Lead owns a **separate M1 Draft PR** establishing `apps/ios/Ember.xcodeproj`, shared app/unit/UI-test schemes, minimal launchable SwiftUI app, discoverable source groups and real Simulator smoke. M1 is a build-verified baseline, **not** an “integrate Xcode only after all three lanes” task. Agents A/B/C inherit it and independently run tests from their own worktrees; the Lead alone may change the project file and app composition root.

Proposed pinned local toolchain: Apple silicon Mac, macOS Tahoe 26.6+, **Xcode 27.1**, iOS 27.1 Simulator if installed, target iOS 17.0. Confirm installed versions with `sw_vers`, `xcodebuild -version`, `xcode-select -p` and `xcrun simctl list devices available` at M1. Xcode requirements: https://developer.apple.com/xcode/system-requirements/. Local Mac is the initial test executor, **not** existing Linux CI; macOS hosted CI is deferred until CTO authorizes costs. If this environment is unavailable, M1 is blocked pending CTO-approved alternative, not “tests passed”. Exact commands and test evidence are in `IOS_SPRINT_PLAN.md`.

## 逻辑层与建议目录（仅待批文件布局）

```text
apps/ios/
  Ember.xcodeproj
  EmberApp/
    App/               App entry, ScenePhase, dependency composition
    Features/
      Onboarding/      privacy explanation, sign-in states
      Inbox/           task summaries / known task placeholders
      Compose/         input template, submission gate
      TaskDetail/      promise, timeline, approval, outcome, cancel
      Settings/        account, privacy, notification intent
    DesignSystem/      ComposerCard, TaskStatusBadge, ActivityRow, Empty/Error views
    Domain/            wire DTOs, UI TaskPresentationState, reducers
    Networking/        APIClient, SSEParser, AuthenticationProviding
    Persistence/       local task index/cursors, bounded drafts (review privacy)
    Security/          credential storage abstraction, no real keys in test fixtures
  EmberTests/          unit + contract fixture
  EmberUITests/        simulator golden paths + accessibility IDs
```

不复制 Shua 源文件；可复用的是交互原则（详见 `IOS_UI_REFERENCE_AUDIT.md`）。UI Design System 与平台 DTO 单向依赖，视图不直接访问网络、Keychain 或 SQL。批准后最先冻结 `TaskClientProtocol`、只读 DTO 与 `TaskPresentationState`，再三线并行。

## 状态与数据流

- `@MainActor @Observable` 的 `TaskDetailStore` 持有已验证快照、按序事件、游标、连接健康、UI 操作请求态；`InboxStore` 持有 server list [PROPOSED]。视图只发意图。
- `APIClient` = 注入 `URLSession` 的类型化 HTTP wrapper；`TaskRepository` 聚合 snapshot/events/stream/artifacts；`AuthSession` 只给授权头、不泄漏 token 给 UI。可用 fake repositories 做 SwiftUI Preview，必须有全局“模拟”标记。
- 接收 `POST` 前生成稳定 Idempotency-Key；只有收到 202/200 Receipt 才登记承诺。断网的未知 ACK 必须保留原键/载荷或由服务端提供查询，否则禁止自动创建新 key。敏感请求离线持久化的文件保护、期限与清除策略需 CTO 隐私批准。
- `URLSession.bytes(for:)` / AsyncSequence 编写增量 SSE Parser：分块 UTF-8、CRLF/LF、空行帧界、`event: task`、`id`、`data` 多行、注释心跳；验证 JSON 与单调 `sequence` 后再更新已确认游标。支持取消 stream 与指数退避+jitter，前台恢复时先拉快照/缺口。不能把 keep-alive、重新连接次数变成 progress 事件。
- `ScenePhase`：active 拉服务端权威 snapshot、按最后 cursor 回补；background 结束/停止依赖长 SSE。真正持续执行只发生在云端。`BGTaskScheduler` 不作为定时可靠保障，不暗示关闭 App 后实时连接。
- `NavigationStack` 单入口；任务详情用 `task_id` 导航，深链/通知点击须先账户鉴权再拉资源。审批是独立 Confirmation Sheet，展示服务端可信动作详情后才可点击；现有 digest-only DTO 禁止生产确认。
- `Keychain` 只作为设备安全存储技术建议，**不得在未审核的签名/登录流中塞固定 dev bearer token**。生产用户登录、会话续期、登出撤销、数据清理、共享设备处理均归 CTO/Platform 安全契约。
- 默认本地只存最小索引（Task IDs/最后事件游标/偏好）；原文、事件敏感字段、结果缓存的加密、留存、备份范围需单独审批。任何后台推送，Payload 应是最小信息，不带任务正文/审批秘密；APNs 与通知方案 CTO 审批。
- 来源于 P0-B 的 wire DTO 用 Swift 手写 `Codable` 显式 snake_case + 严格测试；若后续自动 OpenAPI 客户端生成，需 Platform 合约冻结和 CTO 批准，避免跨语言漂移。

## 可靠性与测试矩阵

| 测试层               | 必测内容                                                                                                              | 证据标准                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Domain reducer 单元  | 所有 7 个状态、terminal 不回退、重复事件丢弃、乱序回补                                                                | XCTest 真实结果                                                            |
| API contract fixture | Receipt 202/200、Agent 201、Task/Events/SSE、Cancel 202/200、Approval/Artifact、Error 400/401/403/404/409/429/503/504 | 与 Ember `packages/contracts`、`apps/api/src/**` 审核的 JSON fixtures 对齐 |
| SSE parser           | chunk split、`Last-Event-ID`、多行 JSON data、heartbeat、不匹配游标 400、网络断开                                     | 无真网可测                                                                 |
| UI Test (simulator)  | onboarding→任务→详情→取消/失败/审批、前后台、重启、Dark、Dynamic Type、VoiceOver 语义标签                             | 截图 + xcodebuild/Simulator 日志；没有 Mac runner 则 NOT RUN               |
| 集成（经批准环境）   | 真正 server ack、唯一任务、回放、数据隔离与权限、无假成果                                                             | 只在 CTO 提供的安全测试环境；不使用生产凭据                                |
| 生产验收             | auth、安全、日志隐私、APNs、模型费用/限额、App Store                                                                  | 均尚未授权、NOT RUN                                                        |

UI 可以先用强制“MOCK ONLY” fixtures 实作可点击的模拟器体验，但不让其发送真实敏感信息，不伪装执行中或通知成功。

## 技术与产品风险

1. 现有 API 仅具 local dev bearer token，没有正式登录；无 `GET /v1/tasks` 列表、无 Agent 列表；“长期承诺”的历史恢复不可能靠本机缓存保证。
2. 当前 `mock.chat` 的 FakeLLM 和 fake sandbox 无用户价值真实执行；真实 Cloud Model Gateway 及费用/安全策略属于 CTO/Platform，不以 iOS 代码绕过。
3. `ApprovalViewDto` 只有 `action_digest` 没有可理解的动作目标/范围，禁止生产级批准。
4. 本地 UI 渲染可采用原生 SwiftUI 文本 Markdown/安全纯文本，而非第一天嵌入 WKWebView。若需要复杂富文本，基于 Shua 的渲染/动画经验单独评审性能。
5. 与 Platform 的接口以 `IOS_API_DEPENDENCIES.md` 为准，客户端对 [PROPOSED] 接口只能定义 protocol/fake，不能写“已接入”或变更共享安全模块。

**授权点**：CTO 审批 app 目录、target、身份/隐私与 API 依赖后冻结模型；随后才允许 Agent 按 `IOS_SPRINT_PLAN.md` 编码。
