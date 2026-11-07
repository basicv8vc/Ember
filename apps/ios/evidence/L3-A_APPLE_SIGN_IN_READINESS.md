# Ember L3-A Apple Sign In 真机准备记录

更新日期：2026-11-07（Asia/Shanghai）
分支：`feature/ios-l3a-apple-sign-in`  
被测代码 Git SHA：`82725ec8caec924ce16750d9ce3939e0ded5a916`
基线：`main` / `a2276ed299d7d61570898053a6ec32523bd4862a`

## 工程改动与静态检查

- Ember App Target 已开启 `com.apple.SignInWithApple` Xcode capability，并在 `apps/ios/EmberApp/Ember.entitlements` 声明 `com.apple.developer.applesignin = ["Default"]`。
- Bundle ID 保持 `com.basicv8vc.ember`。
- `plutil -lint`（工程和 entitlement）及 `git diff --check` 通过；Xcode Build Settings 显示正确的 entitlement 路径和 Bundle ID。

## 本机与真机环境

- Xcode：26.3（17C529）。macOS：26.5.1。
- 已配对且当前可用的实体设备：iPhone XR（iPhone11,8），iOS 18.7.10（22H374），用户已解锁设备；Developer Mode 开启。
- 钥匙串有 Apple Development 证书（Team ID `HS8L97WQXN`）和 Apple Distribution 证书（Team ID `9RN3YNYN27`）；Team ID 标识不同 Developer Team，同一个开发者姓名不代表同一个 Team。Shua 工程使用 `9RN3YNYN27`。证书归属不能证明 Ember 的 App ID 属于哪一 Team；当前没有本机安装的匹配 profile。
- Jia Li Apple Account 已在 Xcode 登录，账号列出的 Team 为 `Jia Li, Admin`。L3-A `Signing & Capabilities` 起初未选 Team；我用 Shua 所用的 Team `9RN3YNYN27` 发起自动签名，不把 Team ID 写入本次功能改动。
- 启动卷当前约有 12 GiB 可用空间。没有清理其他项目、模拟器或用户数据。

## 构建与验证结果

- 实体设备构建：退出码 65。登录后对 Team `9RN3YNYN27` 执行 `xcodebuild -allowProvisioningUpdates -allowProvisioningDeviceRegistration`，Xcode 报 `com.basicv8vc.ember` 不能注册到该 Team（Bundle ID 当前不可用），并报告通配 profile 不含 Sign in with Apple capability/entitlement。没有生成可安装的签名产物。
- XR 已连接、解锁且可用，但尚未安装 App。失败发生在 Apple Developer 自动签名/App ID 阶段；没有运行真实 Apple ID 系统授权。
- 本机模拟器构建：退出码 65，因启动卷空间不足，Xcode 无法写入 build database。
- GitHub Actions 在被测代码 SHA `82725ec8caec924ce16750d9ce3939e0ded5a916` 上通过：iOS L2 Validation（run `42232185080`，App 与两个测试 bundle 构建、Unit/UI Tests、XCResult 截图步骤）和 Verify（run `42232185056`，lint、格式、typecheck、unit、build、迁移、PostgreSQL integration/chaos、HTTP/E2E、Demo CLI）。CI 截图是模拟器证据，不是真机证据。
- 文档更新提交 SHA `8119934035f852b825911e417fc3fdbbe64b9c5c` 的自动 CI run `42356171389`（iOS）与 `42356171423`（backend）在 runner 启动前被 GitHub 拒绝：账号近期付款失败或 spending limit 需提高；jobs 没有执行任何 step。需仓库/组织账单管理员处理付款或额度后重跑，不能把它当作代码测试结果。
- 未安装本分支 App，未运行真实 Apple ID 系统授权、Cloud Session、Keychain 持久化或 Logout；没有启用 Fake Model。
- 脱敏真机截图：未采集。当前没有签名构建可安装；CI 模拟器截图不作为本分支真机证据。

## 继续真机验证所需条件

1. 账号已登录，但 Xcode 对 Team `9RN3YNYN27` 明确拒绝注册 `com.basicv8vc.ember`。Account Holder/Admin 需在 Apple Developer `Certificates, Identifiers & Profiles > Identifiers` 搜索这个 Bundle ID，确认它实际归属的 Team；保持 Bundle ID 不变，并在其所属 Team 启用 Sign in with Apple（按现有登录架构配置 primary 或关联已有 primary）。若所属 Team 与 `9RN3YNYN27` 不同，需让 Xcode 使用获授权的所属 Team，不能在 9RN 下重复注册。
2. 确认 App ID/team 后，在该 Team 注册 XR 并生成带 Sign in with Apple entitlement 的开发 profile，或重试 Automatic Signing；随后在 iPhone XR 构建、安装、采集脱敏截图并验证真实 Apple ID 系统授权。无需等待 Staging 上线即可先验证系统授权 UI。
3. Cloud Session、Keychain 持久化和服务端 Logout 需要 CTO 提供已批准的 HTTPS `EMBER_CLOUD_BASE_URL` 及已配置 Apple identity verification 的 Ember 后端。本机未配置该 URL；当前 Live Cloud 页面没有用户可点的 Logout 控件，因此这两项超出当前真机验证范围。

Apple 参考： [Xcode SDK 与系统要求](https://developer.apple.com/xcode/system-requirements/)、[在 Xcode 配置 Sign in with Apple](https://developer.apple.com/documentation/xcode/configuring-sign-in-with-apple)、[启用 App ID 能力](https://developer.apple.com/help/account/identifiers/enable-app-capabilities)。
