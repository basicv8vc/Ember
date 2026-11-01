# M1 Simulator Verification

Date: 2026-11-01 (Asia/Shanghai)
Base SHA: `afbf4b5618c616b6feccec37dd02950565db92a4`
Simulator: iPhone 17 Pro Max, iOS 27.0, UDID `EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5`
Toolchain: macOS 26.5.1 (25F80), Xcode 26.3 (17C529), iOS deployment target 17.0. The CTO approved this available alternative on 2026-11-01.

## Results

- `xcodebuild -list -project apps/ios/Ember.xcodeproj` — exit 0; lists App, Unit Test, and UI Test targets, plus the shared `Ember` scheme. Log: `xcodebuild-list.log`.
- `xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5' CODE_SIGNING_ALLOWED=NO build` — exit 0. Log: `xcodebuild-build.log`.
- `xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5' CODE_SIGNING_ALLOWED=NO test` — exit 0. `FoundationSmokeTests.testMockNoticeClearlyDisclaimsRealAIExecution` passed (1/1); `LaunchSmokeUITests.testLaunchDisplaysMockOnlyNotice` passed (1/1). Log: `xcodebuild-test.log`.
- `xcrun simctl launch --terminate-running-process EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5 com.basicv8vc.ember` — exit 0; app launched as PID 1388. Screenshot: `Ember-Mock-Only.png`.

Xcode emitted non-fatal diagnostics about the local provisioning-profile lookup and the iOS 27.0 runtime build number. The runtime also emitted duplicate system Objective-C class warnings during the UI test. No test failures occurred in the successful final run.
