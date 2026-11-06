# Ember L3-A Apple Sign In 真机准备记录

更新日期：2026-11-06（Asia/Shanghai）  
分支：`feature/ios-l3a-apple-sign-in`  
实现提交：`37e380dcaeeb2f7cdf4abefcc47f264ff6782912`  
基线：`main` / `a2276ed299d7d61570898053a6ec32523bd4862a`

## 工程改动与静态检查

- Ember App Target 已开启 `com.apple.SignInWithApple` Xcode capability，并在 `apps/ios/EmberApp/Ember.entitlements` 声明 `com.apple.developer.applesignin = ["Default"]`。
- Bundle ID 保持 `com.basicv8vc.ember`。
- `plutil -lint`（工程和 entitlement）及 `git diff --check` 通过；Xcode Build Settings 显示正确的 entitlement 路径和 Bundle ID。

## 本机与真机环境

- Xcode：26.3（17C529）。macOS：26.5.1。
- 已配对的实体设备：iPhone 12 Pro Max（iPhone13,4），iOS 27.0.1（24A446），Developer Mode 开启。
- 钥匙串有有效 Apple Development 证书（Team ID `HS8L97WQXN`）及 Apple Distribution 证书（Team ID `9RN3YNYN27`）；两者 Team ID 不同，不能据此确认 Ember App ID 属于哪一队。
- Xcode 报告没有已登录 Developer Account；本机 MobileDevice Provisioning Profiles 目录为空。当前已选 App Store Connect API 账号也未返回 `com.basicv8vc.ember`，因此没有用它修改任何 Apple Developer 资源。
- 构建时启动卷曾只剩 164 MiB；清除本次生成的临时 DerivedData 后目前约有 2.7 GiB，仍低于本机 iOS QA 的 25 GiB 空间门槛。没有清理其他项目、模拟器或用户数据。

## 构建与验证结果

- 实体设备构建：退出码 65。Xcode 报 `No Accounts` 和没有匹配 `com.basicv8vc.ember` 的 iOS App Development provisioning profile；没有生成可安装的签名产物。
- 本机模拟器构建：退出码 65，因启动卷空间不足，Xcode 无法写入 build database。
- GitHub Actions iOS L2 Validation（run `42230975104`）：构建 App 与两个测试 bundle、iOS Unit Tests、iOS UI Tests 均通过；截图 XCResult artifact 步骤通过。该截图属于 CI 模拟器，不是真机证据。完整结果：[iOS CI run](https://github.com/basicv8vc/Ember/actions/runs/42230975104)。
- GitHub Actions Verify（Node 24 LTS + PostgreSQL 17，run `42230974944`）：lint、格式、typecheck、unit、build、迁移、PostgreSQL integration/chaos、HTTP/E2E 和 Demo CLI 均通过。完整结果：[后端 CI run](https://github.com/basicv8vc/Ember/actions/runs/42230974944)。
- 未安装本分支 App，未运行真实 Apple ID 系统授权、Cloud Session、Keychain 持久化或 Logout；没有启用 Fake Model。
- 脱敏真机截图：未采集。当前没有签名构建可安装；CI 模拟器截图不作为本分支真机证据。

## 继续真机验证所需条件

1. Account Holder/Admin 在 Xcode 添加并授权拥有 `com.basicv8vc.ember` 的 Developer Team；确认现有 App ID，并在 Developer portal 为它启用 Sign in with Apple（按现有服务架构设置为 primary 或关联已有 primary）。
2. 在该 Team 注册测试 iPhone，生成并安装包含 Sign in with Apple entitlement 的 iOS App Development profile；也可在正确账号可用后让 Xcode Automatic Signing 完成。
3. 将 Mac 更新至 macOS 26.6 或更高版本并安装 Xcode 27 系列，以支持当前 iOS 27 真机；释放足够空间后重建、安装并采集脱敏截图。
4. Apple 系统授权可以在 App 已签名后继续；Cloud Session、Keychain 持久化和服务端 Logout 需要 CTO 提供已批准的 HTTPS `EMBER_CLOUD_BASE_URL` 及已配置 Apple identity verification 的 Ember 后端。本机未配置该 URL。当前 Live Cloud 页面没有用户可点的 Logout 控件，Logout 验证还需要明确的产品入口或获批的设备测试触发方式。

Apple 参考： [Xcode SDK 与系统要求](https://developer.apple.com/xcode/system-requirements/)、[在 Xcode 配置 Sign in with Apple](https://developer.apple.com/documentation/xcode/configuring-sign-in-with-apple)、[启用 App ID 能力](https://developer.apple.com/help/account/identifiers/enable-app-capabilities)。
