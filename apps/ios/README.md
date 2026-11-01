# Ember iOS M1 Foundation

This is the first native SwiftUI application shell for Ember. It contains no authentication, API client, credentials, third-party dependencies, analytics, or business workflow. The visible launch screen permanently states `MOCK ONLY · No real AI execution`.

## Environment used for M1 verification

The planning baseline was Apple Silicon, macOS Tahoe 26.6+, Xcode 27.1, iOS deployment target 17.0, and a local iOS Simulator. The CTO approved using the available compatible environment for this M1 run: macOS 26.5.1 (build 25F80), Xcode 26.3 (build 17C529), and iOS 27.0 Simulator, device `iPhone 17 Pro Max`, UDID `EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5`. The deployment target remains iOS 17.0. The full initial environment capture and approval record is in `../../docs/product/ios/M1_ENVIRONMENT_REPORT.md`.

## Build and test

From the repository root:

```bash
xcodebuild -list -project apps/ios/Ember.xcodeproj
xcodebuild -project apps/ios/Ember.xcodeproj \
  -scheme Ember \
  -destination 'platform=iOS Simulator,id=EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5' \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/Ember.xcodeproj \
  -scheme Ember \
  -destination 'platform=iOS Simulator,id=EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5' \
  CODE_SIGNING_ALLOWED=NO test
```

## Verification evidence

Verified on 2026-11-01: `xcodebuild -list` exit 0; Simulator build exit 0; Simulator test exit 0. The test run executed one Unit Smoke Test and one UI Launch Test, both passed. The app was also launched directly on the same Simulator. The exact commands, exit statuses, test counts, and runtime warnings are summarized in `evidence/verification-summary.md`. Full logs are in `evidence/xcodebuild-list.log`, `evidence/xcodebuild-build.log`, and `evidence/xcodebuild-test.log`. The launch screenshot is `evidence/Ember-Mock-Only.png`.

Xcode 26.3 logged non-fatal device-build-number and local provisioning-profile diagnostics. The iOS 27.0 runtime also logged duplicate system Objective-C class warnings. The Simulator build, launch, and XCTest run nevertheless completed successfully. Revalidate with the originally planned Xcode 27.1 / iOS 27.1 runtime when available.

## Project layout and source discovery

`Ember.xcodeproj` defines `Ember`, `EmberTests`, and `EmberUITests`, with the shared `Ember` scheme. Each target uses an Xcode filesystem-synchronized root group. Add new `.swift` files under that target's source directory and Xcode discovers them automatically; no `.pbxproj` membership edit is needed.

- `EmberApp/App/`: app entry and composition root
- `EmberApp/Features/Launch/`: M1 launch screen
- `EmberApp/Features/`: reserved module roots for future feature work
- `EmberApp/DesignSystem/`, `Domain/`, `Networking/`, `Persistence/`: reserved native module roots
- `EmberTests/`: XCTest unit smoke test
- `EmberUITests/`: simulator UI launch smoke test
- `evidence/`: captured build/test logs and simulator screenshot for this M1 run

## Scope and limits

The launch screen is a static foundation only. It does not authenticate, persist user data, access the network, run an AI model, schedule notifications, or perform business actions. Simulator validation does not establish physical-device, production-service, or App Store readiness. This M1 PR does not start A/B/C coding; those lanes remain gated on CTO approval and merge of M1.

## Rollback

Revert the M1 foundation commit or close the Draft PR. The work is isolated to `apps/ios/` plus its environment evidence and does not modify Ember Platform or production configuration.
