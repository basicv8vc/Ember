# M1 Environment Gate Report

Date: 2026-11-01 (Asia/Shanghai)
Task: IOS-M1-FOUNDATION
Worktree branch: `ios/m1-xcode-foundation`
Actual base (`origin/main` after `git fetch origin main`): `afbf4b5618c616b6feccec37dd02950565db92a4`
Requested M0 baseline: `afbf4b5618c616b6feccec37dd02950565db92a4` (matches actual base)

## Commands and recorded output

### `sw_vers`

```text
ProductName: macOS
ProductVersion: 26.5.1
BuildVersion: 25F80
```

### `xcodebuild -version`

```text
Xcode 26.3
Build version 17C529
```

### `xcode-select -p`

```text
/Applications/Xcode.app/Contents/Developer
```

### `xcrun simctl list devices available`

```text
== Devices ==
-- iOS 18.6 --
    WaterPhoto-XR-UI (7276224F-E36A-4730-A492-E704545E9C55) (Shutdown)
-- iOS 26.3 --
    WaterPhoto-iOS26 (9B364F8E-BE62-444A-B62E-04B4C7A9EC97) (Shutdown)
-- iOS 27.0 --
    iPhone 17 Pro Max (EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5) (Shutdown)
```

## Baseline comparison and gate

The planning baseline is Apple Silicon, macOS Tahoe 26.6+, Xcode 27.1, iOS deployment target 17.0, and an available local iOS Simulator (the proposed runtime was iOS 27.1). This Mac reports macOS 26.5.1 and Xcode 26.3; the available runtimes are iOS 18.6, 26.3, and 27.0. The OS and Xcode are below the planned versions, and iOS 27.1 is not installed.

`IOS_SPRINT_PLAN.md` says to stop M1 implementation when the planned toolchain/runtime is unavailable and obtain CTO approval for a compatible alternative. No project or Swift source has been created pending that approval. This worktree is based on the verified main SHA above; it does not modify `main`.

## Approved compatible alternative

On 2026-11-01, CTO approval was received to proceed with the locally available Xcode 26.3 and iOS 27.0 Simulator for M1. The planned-version differences above remain part of the record. No OS or Xcode upgrade was performed.

## M1 verification outcome

- `xcodebuild -list -project apps/ios/Ember.xcodeproj`: exit 0; listed `Ember`, `EmberTests`, `EmberUITests` and shared scheme `Ember`.
- Simulator `build`: exit 0 on iOS 27.0 Simulator UDID `EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5`.
- Simulator `test`: exit 0 on the same device; Unit Smoke Test 1/1 passed and UI Launch Test 1/1 passed.
- The app was manually launched on the Simulator, and `apps/ios/evidence/Ember-Mock-Only.png` captures the required mock disclaimer.
- Full command logs are committed under `apps/ios/evidence/`.
