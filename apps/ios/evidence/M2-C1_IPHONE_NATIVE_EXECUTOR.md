# Ember M2-C1 — First iPhone Native Executor Verification

- Date: 2026-11-20 (Asia/Shanghai)
- Branch: `feat/v2-m2-c1-ios-native-executor`
- Base: `origin/main` (`b669b0e`, merged via `#189` + `#194`)
- Scope: Minimal runnable iPhone native execution node prototype (Swift + Apple native frameworks; no Python runtime; no Cloud Runtime integration, which Agent F handles in parallel)

## Architecture & Implemented Capabilities

All new native runtime files live under `apps/ios/EmberApp/DeviceExecutor/`:

- [`DeviceExecutorContracts.swift`](../EmberApp/DeviceExecutor/DeviceExecutorContracts.swift): Tool identifiers (`device.text.process`, `device.json.process`, `device.file.generate`), strictly `Sendable` `DeviceJSONValue` with depth bounds, `DeviceToolStep`, `DeviceTaskSubmission`, `DeviceSandboxPolicy` (including journal task/byte caps), `DeviceExecutionMetrics`, `DeviceGeneratedArtifact`, `DeviceTaskOutcome`, `DeviceRecoveryReport`, and `DeviceExecutorError`.
- [`DeviceSandboxWorkspace.swift`](../EmberApp/DeviceExecutor/DeviceSandboxWorkspace.swift): Per-task App Sandbox confinement under `Application Support/EmberDeviceExecutor/` (`isExcludedFromBackup = true`, `.completeFileProtectionUnlessOpen`), physical storage keyed by `artifactID` (`<artifactID>.blob`) so same-filename steps never overwrite each other, canonical path traversal / symlink escape guards, media-type allowlist + active web content blocklist (`text/html`, `image/svg+xml`, `text/javascript`, etc.), per-file and per-workspace byte quotas, SHA-256 verification on both write and `readArtifactData`, and atomic staging-to-workspace publication.
- [`DeviceResourceMonitor.swift`](../EmberApp/DeviceExecutor/DeviceResourceMonitor.swift): App Store-compliant process telemetry using `task_vm_info` (`phys_footprint`), `getrusage` (user/system CPU time), `DispatchTime`, `ProcessInfo.thermalState` / `isLowPowerModeEnabled`, and `utsname` machine identifier.
- [`NativeTool.swift`](../EmberApp/DeviceExecutor/NativeTool.swift), [`NativeTextTool.swift`](../EmberApp/DeviceExecutor/NativeTextTool.swift), [`NativeJSONTool.swift`](../EmberApp/DeviceExecutor/NativeJSONTool.swift), [`NativeFileGeneratorTool.swift`](../EmberApp/DeviceExecutor/NativeFileGeneratorTool.swift):
  - `device.text.process`: `NaturalLanguage` (`NLTokenizer` word/sentence counts, `NLLanguageRecognizer`), action-item extraction, Markdown heading extraction, deterministic line normalization/dedup/sort, and keyword line summary. (`regex_match` and `regex_replace` are explicitly disabled in M2-C1.)
  - `device.json.process`: JSON validation + depth protection, dot/bracket path queries, `where` filter + `group_by` + numeric aggregation (`count`/`sum`/`avg`/`min`/`max`), key projection, and RFC 4180 CSV conversion.
  - `device.file.generate`: Sandboxed file generation for `.txt`, `.md`, `.json`, `.csv`, and multi-page `.pdf` (via `UIKit.UIGraphicsPDFRenderer`) with strict extension-vs-MIME consistency checks and step pipeline interpolation (`{{prev.text}}`, `{{prev.json}}`, `{{steps.<id>.text}}`).
- [`DeviceExecutionJournal.swift`](../EmberApp/DeviceExecutor/DeviceExecutionJournal.swift) & [`DeviceTaskExecutor.swift`](../EmberApp/DeviceExecutor/DeviceTaskExecutor.swift): Atomic `insertOrReplay` idempotency inside the journal actor, fenced state transitions (`claimRun`, `checkpointStep`, `commitCompleted`, `requestCancel`, `commitCancelled`, `commitFailed`, `commitInterruptedForRetry`) validating `runID`/`leaseEpoch`/`bootSessionID`/cancellation/deadline without ignoring persistence errors, `currentRunID` clearing on re-queue, journal capacity pruning (`maxJournalTasks` / `maxJournalBytes`), `maxOutputTextBytes` enforcement on `structuredData`, race-free `waitForCompletion` registration, `UIApplication.beginBackgroundTask` lifecycle integration (`ScenePhase`), and cold-start recovery (`recoverAndResumeIfNeeded()`).
- [`DeviceSessionTaskRepository.swift`](../EmberApp/DeviceExecutor/DeviceSessionTaskRepository.swift): `SessionTaskRepositoryProtocol` adapter (`isMockOnly = false`) bridging on-device tasks, events, results, and artifacts into `SessionTaskStore` and `TaskDetailView`.
- [`DeviceExecutorBenchmark.swift`](../EmberApp/DeviceExecutor/DeviceExecutorBenchmark.swift) & [`DeviceExecutorWorkbenchView.swift`](../EmberApp/DeviceExecutor/DeviceExecutorWorkbenchView.swift): Reproducible benchmark runner and SwiftUI workbench launched only via `--ember-device-executor` (default Live Cloud launch and existing Mock UI flows remain unchanged).

## Review Fixes Applied After `8c89a3c`

- **P1-1**: Replaced multi-await idempotency check + insert with atomic `DeviceExecutionJournal.insertOrReplay(...)`.
- **P1-2**: Moved run claiming, step checkpointing, completion, cancellation, failure, and background interruption commits into atomic fenced methods on `DeviceExecutionJournal` (verifying `runID`, `leaseEpoch`, `ownerBootSessionID`, `cancelRequested`, and `deadlineAt`) and propagated persistence errors.
- **P1-3**: Keyed on-disk artifact blobs by `artifactID` (`<artifactID>.blob`) and verified SHA-256 + byte length on every `readArtifactData(for:)` read.
- **P1-4**: Disabled `regex_match` and `regex_replace` in `NativeTextTool` and removed `.regularExpression` usage from line normalization.
- **P2**: Fixed `waitForCompletion()` registration race via actor-local `cachedOutcomes`, fixed `updatingTask` to clear `currentRunID` to `nil` when re-queued, enforced file extension vs. MIME type consistency in `NativeFileGeneratorTool`, enforced `maxOutputTextBytes` on `structuredData`, and added `maxJournalTasks` / `maxJournalBytes` capacity pruning in `DeviceExecutionJournal`.
- **Closure**: Prioritized persisted `cancelRequested` inside `DeviceExecutionJournal.commitFailed()` and `DeviceExecutionJournal.commitInterruptedForRetry()`, with deterministic Cancel-vs-Failure and Cancel-vs-Background-Interruption regression tests.

## Verification Evidence

### 1. Physical Device Verification (`iPhone13,4` / iPhone 12 Pro Max, iOS `27.0.1`)

- Device: `Haha🎀` (`00008101-000E0D923E01001E`), `iPhone 12 Pro Max (iPhone13,4)`, iOS `27.0.1 (24A446)`, Developer Mode enabled, paired over local network.
- Command (run on merged `origin/main` `b669b0e` + final Swift closure `3d4f2de`, `DEVELOPMENT_TEAM=9RN3YNYN27 SWIFT_STRICT_CONCURRENCY=complete`):
  ```bash
  xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -configuration Debug \
    -destination 'platform=iOS,id=00008101-000E0D923E01001E' \
    -only-testing:EmberTests/DeviceExecutorTests \
    DEVELOPMENT_TEAM=9RN3YNYN27 SWIFT_STRICT_CONCURRENCY=complete test
  ```
- Result: `DeviceExecutorTests` **17/17 passed in 1.711s** (`0 failures`).
- Observed physical-device benchmark metrics (`2026-11-20T05:39:39.955Z`, `thermalState = nominal`, `isLowPowerModeEnabled = false`, 5 iterations per case):

| Case                       | Iterations | P50 (ms) | P95 (ms) | Max (ms) | Mean (ms) | Memory Delta (KiB) | Notes                                     |
| -------------------------- | ---------: | -------: | -------: | -------: | --------: | -----------------: | ----------------------------------------- |
| `text_stats_and_extract`   |          5 |    24.02 |    28.05 |    28.05 |     24.29 |               96.0 | 120 lines `NLTokenizer` + extraction      |
| `json_1k_aggregate_csv`    |          5 |   108.47 |   116.06 |   116.06 |    109.44 |             4048.0 | 1,000 JSON objects filter+group+CSV       |
| `file_generate_md_csv_pdf` |          5 |    87.48 |    89.57 |    89.57 |     85.60 |               96.0 | Atomic MD + CSV + `UIGraphicsPDFRenderer` |
| `cold_journal_recovery`    |          5 |     4.96 |     5.25 |     5.25 |      5.02 |                0.0 | Recover queued+running+terminal records   |

### 2. Post-Closure & `origin/main`-Aligned Verification (`iPhone 18 Pro` Simulator, iOS `27.2`)

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
- Results (after merging `origin/main` `b669b0e` and all closure edits):
  - `EmberTests.xctest`: **362/362 passed in 19.718s** (`0 failures`, including `DeviceExecutorTests` **17/17**).
  - `EmberUITests.xctest` (selected suites): **5/5 passed in 53.831s** (`DeviceExecutorWorkbenchUITests` 1/1, `LaunchSmokeUITests` 1/1, `LiveModeLaunchUITests` 3/3).
