# L3-A — Apple Sign In 真机准入与验证 Runbook

> **状态：** 项目配置已完成并通过构建验证；真机安装与真实 Apple 登录仍被 3 个外部条件阻塞，需要人工在 Xcode 与 Apple Developer 侧解除。
> **Owner:** iOS Lead
> **Branch:** `feature/l3-a-apple-signin`
> **Baseline:** `origin/main@a2276ed`（含 PR #119 Live Auth、#121 Live Conversation、#126 fail-closed runtime）
> **目标：** 2026-11-08（周日）晚前完成 Ember 第一次 iPhone 真机 AI 对话
> **相关：** `docs/product/ios/IOS_L1_LIVE_AUTH_FOUNDATION.md`（§8 列出的 5 个前置条件中，第 1 项由本文档收敛）

## 1. 本次改动

| 文件                          | 改动                                                                | 原因                                                         |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/ios/Ember.entitlements` | 新增 `com.apple.developer.applesignin = ["Default"]`                | Sign in with Apple 的唯一必需 entitlement                    |
| `apps/ios/Ember.xcodeproj`    | `CODE_SIGN_ENTITLEMENTS = Ember.entitlements`（Debug + Release）    | 把 entitlement 接入签名                                      |
| `apps/ios/Ember.xcodeproj`    | `TargetAttributes.SystemCapabilities.com.apple.SignInWithApple = 1` | 与 Xcode Capabilities 面板一致，自动签名据此申请 App ID 能力 |
| `apps/ios/Ember.xcodeproj`    | 新增 `Ember.entitlements` 文件引用                                  | 让文件在 Xcode 导航器中可见                                  |

**故意没有提交 `DEVELOPMENT_TEAM`。** Team ID（`9RN3YNYN27`）不是密钥，但它把工程钉死在一台机器的账号上；仓库保持开发者无关，Team 通过命令行参数或 Xcode 首次运行时的一次选择提供。`CODE_SIGN_STYLE` 维持 `Automatic`。

entitlements 文件放在 `apps/ios/` 而不是 `EmberApp/` 内部：`EmberApp` 是 Xcode 文件系统同步组（`PBXFileSystemSynchronizedRootGroup`），把 entitlement 放进同步组会被当作资源参与 target 归属判定，放在工程根目录可以完全避开这一歧义。

没有提交任何私钥、证书、Token 或描述文件。

## 2. 已实测 / 待外部条件

| 项目                                         | 结论      | 证据                                                                                                                          |
| -------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 工程文件可解析                               | ✅ 已实测 | `xcodebuild -list` exit 0，3 个 target / 1 个 shared scheme                                                                   |
| entitlement 已接入签名请求                   | ✅ 已实测 | `-showBuildSettings` 输出 `CODE_SIGN_ENTITLEMENTS = Ember.entitlements`；entitlements plist `plutil -lint` = OK               |
| 改动不破坏无签名构建（CI 路径）              | ✅ 已实测 | 模拟器 `CODE_SIGNING_ALLOWED=NO build` → **BUILD SUCCEEDED**                                                                  |
| Xcode 确实在向描述文件要求该能力             | ✅ 已实测 | 设备构建报 `Provisioning profile ... doesn't include the com.apple.developer.applesignin entitlement`（未接入时不会有此报错） |
| 真实签名构建                                 | ⛔ 待外部 | 停在 provisioning：`No Accounts`                                                                                              |
| 真机安装                                     | ⛔ 待外部 | 同上，且磁盘仅剩 189 MB                                                                                                       |
| 真实 Apple 登录（含 identity token 回传）    | ⛔ 待外部 | 依赖 App ID 能力 + 描述文件                                                                                                   |
| Keychain 持久化 / 退出登录（模拟器单元测试） | ⏸ 未复跑  | 见 §5，磁盘不足导致测试未跑完（代码与用例均已存在）                                                                           |

签名链路本身（nonce、attempt ledger、Keychain、session 生命周期）已在 PR #119 落地，L3-A 不重写这部分。

## 3. 阻塞清单（需要你操作，按顺序）

### B1 · 磁盘空间不足（最硬，先解决）

`/System/Volumes/Data` 已用 194 GB / 228 GB，**可用 189 MB**。这已在本次会话中造成两次真实失败：`lipo: No space left on device`、模拟器测试被 SIGTERM 掉。真机安装 + 调试会话至少需要数 GB。

需要你清理空间（我不代删任何个人文件）。`~/Downloads` 15 GB、`~/Library/Developer` 10 GB 是当前最大的两块。可用：

```bash
xcodebuild -project apps/ios/Ember.xcodeproj clean
rm -rf ~/Library/Developer/Xcode/DerivedData/Ember-*     # 可再生
```

目标：至少留出 8 GB。

### B2 · Xcode 未登录 Apple 开发者账号

`defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists` 为空，构建报 `No Accounts: Add a new account in Accounts settings`。没有账号就无法自动创建 App ID 与描述文件。

需要你：**Xcode → Settings → Accounts → + → Apple ID**，登录后完成双重认证。

好消息：`IDEProvisioningTeamByIdentifier` 中 `teamID = 9RN3YNYN27`、`isFreeProvisioningTeam = 0`，说明这是**付费团队**，Sign in with Apple 可用；本机钥匙串中 `Apple Development` 与 `Apple Distribution` 两张证书也都有效。所以 B2 只是"登录态缺失"，不是资格缺失。

### B3 · `com.basicv8vc.ember` 的 App ID 尚未启用该能力

本机 8 个描述文件中没有任何一个属于 `com.basicv8vc.ember`；唯一的通配描述文件 `iOS Team Provisioning Profile: *` 按设计永远不可能包含 Sign in with Apple。登录账号后，Xcode 自动签名会创建带能力的 App ID 和描述文件——前提是 B2 已完成。

### B4 · 测试设备选择

| 设备     | 型号              | iOS     | 建议                                                         |
| -------- | ----------------- | ------- | ------------------------------------------------------------ |
| `phone`  | iPhone XR         | 18.7.10 | **首选**，在本机 Xcode 26.3（iOS 26.2 SDK）支持范围内        |
| `Haha🎀` | iPhone 12 Pro Max | 27.0.1  | 高于本机 SDK，Xcode 26.3 很可能拒绝安装，除非升级到 Xcode 27 |

两台都已 `available (paired)`。若设备未登记在团队下，命令行无法注册（这是 Xcode GUI 的能力），GUI 首次运行会提示注册。

## 4. 解除阻塞后的操作步骤

### 4.1 Xcode GUI（推荐，设备注册只能在 GUI 完成）

1. 打开 `apps/ios/Ember.xcodeproj`。
2. Target `Ember` → Signing & Capabilities → Team 选 `Jia Li (Personal Team)` 或对应团队；确认 **Sign in with Apple** 能力已在列表中（应由本次提交自动带出）。
3. Scheme `Ember` → Edit Scheme → Run → Arguments：
   - Argument Passed On Launch：`--ember-live-cloud`
   - Environment Variable：`EMBER_CLOUD_BASE_URL` = 你的 Cloud API 地址（**必须 https**，`LiveEmberSessionAPI` 拒绝非 https）
4. 选择真机 → Run。首次运行若提示注册设备，允许。

> 只想验证 Apple 登录本身、暂时没有可用的 Cloud API 时，`EMBER_CLOUD_BASE_URL` 可填任意合法 https 地址（例如 `https://api.invalid`）。App 会因 `sessionMissing` 停在登录页，点 Apple 按钮仍会拉起原生授权面板并返回 identity token——这正是 L3-A 要证明的部分；随后的 `POST /v1/auth/session` 会失败，属预期。

### 4.2 命令行

```bash
cd apps/ios
xcodebuild -project Ember.xcodeproj -scheme Ember \
  -configuration Debug -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=9RN3YNYN27 build
```

`-allowProvisioningUpdates` 会在 B2/B3 完成后自动注册 App ID、开启能力、生成描述文件。Team ID 只出现在命令行，不进入仓库。

## 5. Keychain 会话持久化与退出登录

实现已存在且不在本次改动范围内：`KeychainSessionStore` 使用 `kSecClassGenericPassword` + `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` + `kSecAttrSynchronizable = false`，`LiveAuthSessionCoordinator` 覆盖登出清理、越权清理、旋转失败等 40+ 个用例。

本次**未能复跑测试**（磁盘不足，`xcodebuild test` 被 SIGTERM）。空间恢复后请执行：

```bash
cd apps/ios
xcodebuild -project Ember.xcodeproj -scheme Ember \
  -destination 'platform=iOS Simulator,id=D7CA4014-AEE1-469E-ABF5-EC91DE0FAA23' \
  CODE_SIGNING_ALLOWED=NO test
```

真机侧的人工验收项：

1. 登录成功 → 杀进程 → 重开，应直接进入已登录状态（Keychain 恢复 + `bootstrap()`）。
2. App 内退出登录 → 立即杀进程 → 重开，应停留在登录页，且 `bootstrap()` 不发出任何带 Bearer 的请求。
3. 卸载重装 → 应无残留会话（`ThisDeviceOnly` + 卸载清 item）。

## 6. 已知环境问题（与本次改动无关）

- **基线仓库同样复现**：本机 Xcode 在当前 shell 环境下编译含 `#Preview` 的文件会报
  `external macro implementation type 'PreviewsMacros.SwiftUIView' could not be found ... produced malformed response`，
  根因是宏插件以 `sandbox-exec` 启动时被外层沙箱拒绝（`sandbox_apply: Operation not permitted`）。
  在普通 Terminal 或 Xcode GUI 中不会出现；在受限 shell 里可加 `SWIFT 标志 -disable-sandbox` 绕开。**不要**把它写进工程配置。
- `xcodebuild` 每次都会报一条 `Failed to load profile ".../Provisioning Profiles/-"`，是历史遗留的畸形文件名（一个字面量 `-`），不影响构建，可随手删除。

## 7. 回滚

`git revert` 本分支提交即可完全恢复：改动只涉及 `apps/ios/` 的工程配置与一个新增 entitlements 文件，不触碰 Swift 源码、Mock 体验、设计系统或基础设施。撤销后无签名构建行为与 baseline 完全一致。
