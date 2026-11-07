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
- 钥匙串有 Apple Development 证书（Team ID `HS8L97WQXN`）和 Apple Distribution 证书（Team ID `9RN3YNYN27`）；两者对应不同 Developer Team。Shua 工程使用 `9RN3YNYN27`。这次实际签名的 App TeamIdentifier 与 provisioning profile 均为 `9RN3YNYN27`，App ID 为 `9RN3YNYN27.com.basicv8vc.ember`，profile 含 `com.apple.developer.applesignin = ["Default"]`。
- Jia Li Apple Account 已在 Xcode 登录，账号列出的 Team 为 `Jia Li, Admin`。L3-A `Signing & Capabilities` 起初未选 Team；我用 Shua 所用的 Team `9RN3YNYN27` 发起自动签名，不把 Team ID 写入本次功能改动。
- 启动卷当前约有 1.1 GiB 可用空间；继续设备构建前需要释放空间。没有清理其他项目、模拟器或用户数据。

## 构建与验证结果

- 初次自动签名返回退出码 65，提示 Bundle ID 在当时的签名状态下不可注册且通配 profile 不含 Apple 登录 entitlement。按用户确认的 App ID 配置重试后，`xcodebuild` 成功（退出码 0），Xcode 生成并使用 Team `9RN3YNYN27` 的 `iOS Team Provisioning Profile: com.basicv8vc.ember`。
- 签名产物经 `codesign` 检查为 Bundle ID `com.basicv8vc.ember`、TeamIdentifier `9RN3YNYN27`；embedded profile 含 Apple 登录 `Default` entitlement。`devicectl` 已将 App 安装到已解锁的 iPhone XR，并用 `--ember-live-cloud` 启动成功。
- 启动时未设置 `EMBER_CLOUD_BASE_URL`，App 按 Live fail-closed 设计显示配置不可用页；没有启动默认 Mock 演示，也没有点击 Apple 登录按钮或向服务端发送凭据。脱敏截图：[iPhone XR Live 配置提示](iphone-xr-live-cloud-config-unavailable.png)。
- 本机模拟器构建：退出码 65，因启动卷空间不足，Xcode 无法写入 build database。
- GitHub Actions 在被测代码 SHA `82725ec8caec924ce16750d9ce3939e0ded5a916` 上通过：iOS L2 Validation（run `42232185080`，App 与两个测试 bundle 构建、Unit/UI Tests、XCResult 截图步骤）和 Verify（run `42232185056`，lint、格式、typecheck、unit、build、迁移、PostgreSQL integration/chaos、HTTP/E2E、Demo CLI）。CI 截图是模拟器证据，不是真机证据。
- 文档更新提交 SHA `8119934035f852b825911e417fc3fdbbe64b9c5c` 与 `ff39d0bba309a8887ff79b7b62b84f8e207b8e00` 的自动 CI jobs 均在 runner 启动前被 GitHub 拒绝：账号近期付款失败或 spending limit 需提高；jobs 没有执行任何 step。需仓库/组织账单管理员处理付款或额度后重跑，不能把它当作代码测试结果。
- 真实 Apple ID 系统授权、Cloud Session、Keychain 持久化和 Logout 尚未验证；当前没有配置获批的 Live Cloud endpoint。没有启用 Fake Model。

## 继续真机验证所需条件

1. Apple Developer 签名、App ID 和 profile 已可用于真机安装；无需再等 Staging 上线才能验证设备安装。
2. 真实 Apple ID 登录需要 CTO 提供获批的 HTTPS `EMBER_CLOUD_BASE_URL` 和已配置 Apple identity verification 的 Ember 后端。App 会把 Apple identity token/nonce 交给该 API 换取 session，因此没有 endpoint 时不触发登录，避免凭据发往未授权目的地。
3. Cloud Session、Keychain 持久化和 Logout 需要上述后端；当前 Live Cloud 页面没有用户可操作的 Logout 控件，还需确定 Logout 验证入口。
4. 当前启动卷仅剩约 1.1 GiB；后续设备构建或验证前需要释放磁盘空间。

Apple 参考： [Xcode SDK 与系统要求](https://developer.apple.com/xcode/system-requirements/)、[在 Xcode 配置 Sign in with Apple](https://developer.apple.com/documentation/xcode/configuring-sign-in-with-apple)、[启用 App ID 能力](https://developer.apple.com/help/account/identifiers/enable-app-capabilities)。
