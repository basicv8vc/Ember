# M2-C2 Cloud Device Adapter Evidence (`device.text.process` / `stats`)

## Baseline & Scope

- **Main Baseline**: `c0ab1eb` (`M2-F2: First Cloud-managed iPhone Native Execution (#195)`, including M2-C1 `#192`)
- **Branch**: `feat/v2-m2-c2-cloud-device-adapter` (rebased onto `origin/main` `c0ab1eb`)
- **PR**: `#197` (base branch: `main`, Ready for Review)

Implemented under `apps/ios/EmberApp/DeviceExecutor/Cloud/` (plus unified stats fields in `NativeTextTool.swift` and `scenePhase` forwarding in `DeviceExecutorWorkbenchView.swift`):

- `CloudDeviceContracts.swift` — Typed wire contracts and invariants aligned with Agent F's final M2-F2 contract (`device.text.process`, version `1`, `operation: "stats"`, UTF-8 bytes / Unicode scalars / LF line count, 30s lease / 10s renewal experimental parameters, origin validation allowing `https://` generally and `http://` strictly for loopback/local-LAN V2 QA). Adds `CloudDeviceTextStats(nativeToolOutput:)` so wire results originate directly from `NativeTextTool` output.
- `CloudDeviceCredentialStore.swift` — Keychain-backed 32-byte (`64` lowercase hex chars) `X-Device-Token` and UUIDv4 `deviceId` storage scoped by SHA-256 of `(origin, accountID)` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), plus in-memory test store.
- `CloudDeviceAPIClient.swift` — Redirect-blocking `URLSession` client with `Authorization: Bearer`, `X-Device-Token`, and optional `X-Ember-Local-Access` for:
  - `POST /v2/devices/{deviceId}/register`
  - `POST /v2/devices/{deviceId}/claim`
  - `POST /v2/devices/{deviceId}/tasks/{taskId}/renew`
  - `POST /v2/devices/{deviceId}/tasks/{taskId}/result`
- `CloudDeviceExecutionJournal.swift` — App-Sandbox encrypted-at-rest (`.completeFileProtectionUnlessOpen`, `isExcludedFromBackup = true`, atomic temp + `fsync` replace, bounded to 200 records / 4 MiB preserving `.pendingCommit` and active records over oldest terminal records).
- `CloudDeviceExecutorAdapter.swift` — Lifecycle, concurrency, lease, and execution coordinator:
  - **P1-1 (iOS Lifecycle)**: Wired to `scenePhase` via `handleScenePhase(_:)`. Entering `.background` immediately stops claiming new tasks and acquires a UIKit background task (`BackgroundTaskManaging` / `UIKitBackgroundTaskManager`) with a real expiration handler when work is in-flight. On background expiration, active execution is cooperatively interrupted while preserving durable `.claimed` / `.checkpointed` / `.pendingCommit` journal state and releasing the `UIBackgroundTaskIdentifier`. Returning to `.active` forces device re-registration, prioritizes flushing unacknowledged `.pendingCommit` submissions, and verifies unfinished claims via `/renew` with the original Cloud Fence.
  - **P1-2 (Stop / Start Concurrency Safety & Journal Persistence Gate)**: `stop()` cancels active work and awaits the prior execution loop's full exit before returning. Monotonic loop generations prevent duplicate execution loops on rapid Stop → Start, duplicate Start, or Reconnect. `recordCheckpoint()` and `stageResultSubmission()` results are strictly validated; persistence errors or `nil`/fenced records halt submission so unpersisted results are never posted. Persisted `pendingSubmission` records remain eligible for Unknown ACK replay.
  - **P1-3 (Real Execution Path Lease Safety)**: Checks Cloud lease and deadline before `NativeTextTool` execution, inside `cancellationProbe` during execution, before checkpointing, and before staging new results. Renews via `/renew` when remaining lease falls within the 10s renewal window; stops immediately without submitting if lease expires or Cloud returns `fenced`. Already-staged `pendingSubmission` records still replay with their original Cloud Fence so Agent Head decides `committed(replayed: true)` vs `fenced`.
  - **P2 (Unified NativeTool Result Source)**: `NativeTextTool.runStats` computes `utf8_bytes`, `unicode_scalars`, and `lf_line_count` per Agent F's exact contract alongside existing M2-C1 fields; `CloudDeviceExecutorAdapter` constructs `CloudDeviceTextStats(nativeToolOutput:)` directly from the `NativeToolOutput` (or restored checkpoint) with zero dual calculation.
- `CloudDeviceAdapterMonitor.swift` & `DeviceExecutorWorkbenchView.swift` — Forwards `scenePhase` to `CloudDeviceAdapterMonitor` and guards async `statusHandler` callbacks with a monotonic `connectionGeneration` so stale callbacks from a disconnected adapter never overwrite a newly connected adapter's state.

## Verification Matrix

| Verification Layer | Status | Scope & Details |
| --- | --- | --- |
| **iOS Simulator Full Unit Suite** (`iPhone 18 Pro`, iOS `27.2`, `SWIFT_STRICT_CONCURRENCY=complete`) | **PASS** | `EmberTests`: **385/385** passed (including **23/23** `CloudDeviceAdapterTests` and **17/17** `DeviceExecutorTests`) in `14.172s`. |
| **Workbench UI Smoke Test** (`iPhone 18 Pro`, iOS `27.2`, `SWIFT_STRICT_CONCURRENCY=complete`) | **PASS** | `EmberUITests/DeviceExecutorWorkbenchUITests`: **1/1** passed in `12.134s`. |
| **Physical iPhone Unit Tests** (`iPhone 12 Pro Max`, `iPhone13,4`, UDID `00008101-000E0D923E01001E`, iOS `27.0.1`, `DEVELOPMENT_TEAM=9RN3YNYN27`, `SWIFT_STRICT_CONCURRENCY=complete`) | **PASS** | `CloudDeviceAdapterTests`: **23/23** passed (`0.280s`); `DeviceExecutorTests`: **17/17** passed (`1.758s`); total **40/40** passed in `2.038s`. |
| **Simulator E2E vs Latest `main` M2-F2 `workerd` (`c0ab1eb`)** | **PASS** | Real `Ember.app` on iOS Simulator (`--ember-device-executor --ember-cloud-adapter-qa`) against `tests/integration/support/iphone-native-qa.ts` (`V2LocalRuntimeHarness` + LAN relay `192.168.31.106`).<br>• **Case 1 (Normal completion, `"𝄞\r\ne\u{0301}\n"`)**: `Ember.app` registered, claimed, executed `NativeTextTool`, committed (`replayed: false`), Agent Head `completed` `{ utf8Bytes: 10, unicodeScalars: 6, lines: 3 }`.<br>• **Case 2 (Dropped `/result` ACK replay, `"Line 1\nLine 2\r\nLine 3"`)**: Relay dropped HTTP response (`result_ack_dropped`), `Ember.app` retained original Cloud Fence and replayed `/result`, confirming `replayed: true` and Agent Head `completed` `{ utf8Bytes: 21, unicodeScalars: 21, lines: 3 }`. |
| **Physical iPhone Network E2E (M2-D1)** | **PENDING (M2-D1)** | `Ember.app` installed and launched on physical `iPhone 12 Pro Max` with `local-device-qa.json` copied to App Documents, but timed out waiting for `device_registered` over LAN (`192.168.31.106:59786`) — production ATS remains strictly unmodified and physical LAN E2E requires interactive Local Network permission / network validation under Agent D's M2-D1 acceptance. Simulator E2E is **not** counted as Physical iPhone E2E. |

## Acceptance Criteria Test Coverage (`CloudDeviceAdapterTests`, 23 tests)

1. Foreground/background transitions & recovery: `testBackgroundSuspendsClaimingAndForegroundReregistersAndRecoversPrioritizingPending`
2. Background expiration & identifier cleanup: `testBackgroundExpirationInterruptsExecutionPreservesJournalAndReleasesBackgroundTask`
3. Deterministic Stop / Start & Monitor Reconnect concurrency: `testStopWaitsForOldLoopAndRapidStopStartNeverCreatesDuplicateLoops`, `testMonitorReconnectIgnoresStaleStatusCallbacksFromPreviousAdapter`
4. Lease expiration, renewal success, and fencing on real execution path: `testRealExecutionChecksExpiredLeaseBeforeRunningTool`, `testRealExecutionRenewsLowLeaseAndCommitsOnSuccess`, `testRealExecutionStopsWhenLeaseExpiresDuringNativeToolWithoutSubmitting`, `testLongExecutionRenewsLeaseAndStopsWhenCloudFencesRun`
5. Journal write/stage failure blocks unpersisted submission: `testJournalWriteFailureBlocksResultSubmission`, `testStageFailureOnFencedJournalRecordBlocksResultSubmission`
6. Unknown ACK replay & app restart recovery: `testUnknownAckOnResultPreservesFenceAcrossRestartAndReplaysIdempotently`, `testPendingSubmissionStillReplaysOriginalFenceAfterLocalLeaseExpiry`, `testUnfinishedClaimRenewsAndCompletesWhenCloudStillOwnsLease`, `testUnfinishedClaimRenewsWithOriginalFenceOnRestartAndHandlesFencing`
7. Cloud cancellation / device revocation / capability conflict: `testRevokedDeviceAndCapabilityConflictFailClosedWithoutRetry`, `testHigherEpochClaimSupersedesPriorLocalRunRecord`, `testOversizedOfferTextSubmitsFencedFailedStatusWithoutOutput`
8. Empty text, Unicode, Emoji, CRLF/LF/CR stats contract & unified `NativeToolOutput` source: `testCloudDeviceTextStatsMatchesF2UnicodeAndLFContract`, `testWireResultOriginatesDirectlyFromNativeToolOutputAndMatchesF2Contract`
