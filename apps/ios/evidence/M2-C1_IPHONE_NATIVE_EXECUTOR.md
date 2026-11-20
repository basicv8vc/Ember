# Ember M2-C1 — First iPhone Native Executor Verification

- Date: 2026-11-20 (Asia/Shanghai)
- Branch: `feat/v2-m2-c1-ios-native-executor`
- Base: `origin/main` (`d3c559c`)
- Scope: Minimal runnable iPhone native execution node prototype (Swift + Apple native frameworks; no embedded Python runtime; no Cloud Runtime integration, which Agent F handles in parallel)

## Architecture & Implemented Capabilities

All new native runtime files live under `apps/ios/EmberApp/DeviceExecutor/`:

- [`DeviceExecutorContracts.swift`](../EmberApp/DeviceExecutor/DeviceExecutorContracts.swift): Typed `DeviceToolName`, strictly `Sendable` `DeviceJSONValue` with depth bounds, `DeviceToolStep`, `DeviceTaskSubmission`, `DeviceSandboxPolicy`, `DeviceExecutionMetrics`, `DeviceGeneratedArtifact`, `DeviceTaskOutcome`, `DeviceRecoveryReport`, and `DeviceExecutorError`.
- [`DeviceSandboxWorkspace.swift`](../EmberApp/DeviceExecutor/DeviceSandboxWorkspace.swift): Per-task App Sandbox confinement under `Application Support/EmberDeviceExecutor/` (`isExcludedFromBackup = true`, `.completeFileProtectionUnlessOpen`), canonical path traversal / symlink escape guards, media-type allowlist + active web content blocklist (`text/html`, `image/svg+xml`, `text/javascript`, etc.), per-file and per-workspace byte quotas, SHA-256 checksums, and atomic staging-to-workspace publication.
- [`DeviceResourceMonitor.swift`](../EmberApp/DeviceExecutor/DeviceResourceMonitor.swift): App Store-compliant process telemetry using `task_vm_info` (`phys_footprint`), `getrusage` (user/system CPU time), `DispatchTime`, `ProcessInfo.thermalState` / `isLowPowerModeEnabled`, and `utsname` machine identifier.
- [`NativeTool.swift`](../EmberApp/DeviceExecutor/NativeTool.swift), [`NativeTextTool.swift`](../EmberApp/DeviceExecutor/NativeTextTool.swift), [`NativeJSONTool.swift`](../EmberApp/DeviceExecutor/NativeJSONTool.swift), [`NativeFileGeneratorTool.swift`](../EmberApp/DeviceExecutor/NativeFileGeneratorTool.swift):
  - `device.text.process`: `NaturalLanguage` (`NLTokenizer` word/sentence counts, `NLLanguageRecognizer`), action-item extraction, Markdown heading extraction, bounded `NSRegularExpression` match/replace, line normalization/dedup/sort, and keyword line summary.
  - `device.json.process`: JSON validation + depth protection, dot/bracket path queries, `where` filter + `group_by` + numeric aggregation (`count`/`sum`/`avg`/`min`/`max`), key projection, and RFC 4180 CSV conversion.
  - `device.file.generate`: Sandboxed file generation for `.txt`, `.md`, `.json`, `.csv`, and multi-page `.pdf` (via `UIKit.UIGraphicsPDFRenderer`), plus step pipeline interpolation (`{{prev.text}}`, `{{prev.json}}`, `{{steps.<id>.text}}`).
- [`DeviceExecutionJournal.swift`](../EmberApp/DeviceExecutor/DeviceExecutionJournal.swift) & [`DeviceTaskExecutor.swift`](../EmberApp/DeviceExecutor/DeviceTaskExecutor.swift): Bounded task queue, `idempotencyKey` + canonical request digest replay/conflict checking, `leaseEpoch` + `bootSessionID` fencing, step-level checkpoint persistence, cooperative cancellation (`cancelTask(id:)`), `UIApplication.beginBackgroundTask` lifecycle integration (`ScenePhase`), and cold-start state recovery (`recoverAndResumeIfNeeded()`).
- [`DeviceSessionTaskRepository.swift`](../EmberApp/DeviceExecutor/DeviceSessionTaskRepository.swift): `SessionTaskRepositoryProtocol` adapter (`isMockOnly = false`) bridging on-device tasks, events, results, and artifacts into `SessionTaskStore` and `TaskDetailView`.
- [`DeviceExecutorBenchmark.swift`](../EmberApp/DeviceExecutor/DeviceExecutorBenchmark.swift) & [`DeviceExecutorWorkbenchView.swift`](../EmberApp/DeviceExecutor/DeviceExecutorWorkbenchView.swift): Reproducible benchmark runner and SwiftUI workbench launched only via `--ember-device-executor` (default Live Cloud launch and existing Mock UI flows remain unchanged).

## Verification Evidence

### 1. Physical Device Verification (`iPhone13,4` / iPhone 12 Pro Max, iOS `27.0.1`)

- Device: `Haha🎀` (`00008101-000E0D923E01001E`), `iPhone 12 Pro Max (iPhone13,4)`, iOS `27.0.1 (24A446)`, Developer Mode enabled, paired over local network.
- Command (run with `DEVELOPMENT_TEAM=9RN3YNYN27 SWIFT_STRICT_CONCURRENCY=complete`, prior to the final `handleBackgroundTaskExpiration` await & CSV-step/UI-test polish):
  ```bash
  xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -configuration Debug \
    -destination 'platform=iOS,id=00008101-000E0D923E01001E' \
    -only-testing:EmberTests/DeviceExecutorTests \
    DEVELOPMENT_TEAM=9RN3YNYN27 SWIFT_STRICT_CONCURRENCY=complete test
  ```
- Result: `DeviceExecutorTests` **11/11 passed in 1.475s** (`0 failures`).
- Observed physical-device benchmark metrics (`thermalState = nominal`, `isLowPowerModeEnabled = false`, 5 iterations per case):

| Case                       | Iterations | P50 (ms) | P95 (ms) | Max (ms) | Mean (ms) | Memory Delta (KiB) | Notes                                                             |
| -------------------------- | ---------: | -------: | -------: | -------: | --------: | -----------------: | ----------------------------------------------------------------- |
| `text_stats_and_extract`   |          5 |    23.10 |    27.40 |    27.40 |     23.70 |              112.0 | 120 lines `NLTokenizer` + extraction                              |
| `json_1k_aggregate_csv`    |          5 |   110.35 |   118.59 |   118.59 |    111.24 |             4160.0 | 1,000 JSON objects filter+group+CSV                               |
| `file_generate_md_csv_pdf` |          5 |    73.00 |    77.74 |    77.74 |     72.72 |              112.0 | Atomic MD + `UIGraphicsPDFRenderer` (prior to adding `.csv` step) |
| `cold_journal_recovery`    |          5 |     5.15 |     5.28 |     5.28 |      5.16 |                0.0 | Recover queued+running+terminal records                           |

- Note on subsequent full-suite physical-device run: the physical iPhone auto-locked (`passcodeRequired: true`) before the later post-edit device test attempt, preventing `testmanagerd` re-launch after edit. In an earlier full `EmberTests` run on the physical device, 354/356 passed and 2 pre-existing conversation/polling tests (`ConversationHostIntegrationTests.testStoppingReplyDoesNotChangeAnyTaskStatus` and `LiveConversationBoundedPollingTests.testPollingAutomaticallyPausesAfterMonotonicWindowAndShowsWaiting`) failed on device while passing on Simulator.

### 2. Post-Final-Edit Verification (`iPhone 18 Pro` Simulator, iOS `27.2`)

- Command (matching `.github/workflows/ios-l2-compile.yml` strict concurrency & signing flags):
  ```bash
  xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -configuration Debug \
    -destination 'platform=iOS Simulator,id=8A4CCF42-FD5C-4CCE-B6B8-05E967E552EF' \
    -parallel-testing-enabled NO \
    -only-testing:EmberTests \
    -only-testing:EmberUITests/DeviceExecutorWorkbenchUITests \
    -only-testing:EmberUITests/LaunchSmokeUITests \
    -only-testing:EmberUITests/LiveModeLaunchUITests \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- SWIFT_STRICT_CONCURRENCY=complete test
  ```
- Results (after final code edits):
  - `EmberTests.xctest`: **356/356 passed in 18.609s** (`0 failures`, including `DeviceExecutorTests` 11/11 with updated 3-file `MD + CSV + PDF` benchmark case).
  - `EmberUITests.xctest` (selected suites): **5/5 passed in 51.160s** (`DeviceExecutorWorkbenchUITests` 1/1, `LaunchSmokeUITests` 1/1, `LiveModeLaunchUITests` 3/3).
