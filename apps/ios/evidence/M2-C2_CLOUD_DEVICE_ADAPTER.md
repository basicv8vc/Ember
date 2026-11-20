# M2-C2 Cloud Device Adapter Evidence (`device.text.process` / `stats`)

## Scope & Architectural Authority Split

Implemented under `apps/ios/EmberApp/DeviceExecutor/Cloud/`:

- `CloudDeviceContracts.swift` — Typed wire contracts and invariants aligned with Agent F's M2-F2 contract (`device.text.process`, version `1`, `operation: "stats"`, UTF-8 bytes / Unicode scalars / LF line count, origin validation allowing `https://` generally and `http://` strictly for loopback/local-LAN V2 QA).
- `CloudDeviceCredentialStore.swift` — Keychain-backed 32-byte (`64` lowercase hex chars) `X-Device-Token` and UUIDv4 `deviceId` storage scoped by SHA-256 of `(origin, accountID)` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), plus in-memory test store.
- `CloudDeviceAPIClient.swift` — Redirect-blocking `URLSession` client with `Authorization: Bearer`, `X-Device-Token`, and optional `X-Ember-Local-Access` for:
  - `POST /v2/devices/{deviceId}/register`
  - `POST /v2/devices/{deviceId}/claim`
  - `POST /v2/devices/{deviceId}/tasks/{taskId}/renew`
  - `POST /v2/devices/{deviceId}/tasks/{taskId}/result`
- `CloudDeviceExecutionJournal.swift` — App-Sandbox encrypted-at-rest (`.completeFileProtectionUnlessOpen`, `isExcludedFromBackup = true`, atomic temp + `fsync` replace, bounded to 200 records / 4 MiB preserving `.pendingCommit` and active records over oldest terminal records).
- `CloudDeviceExecutorAdapter.swift` — Lifecycle coordinator:
  - **Cloud AgentHead Authority**: Every claim, checkpoint, lease renewal, and result submission preserves Cloud-issued `taskId`, `operationId`, `runId`, `leaseEpoch`, `leaseExpiresAtMs`, and `deadlineAtMs` verbatim. Local UUIDs or attempt counters are never substituted as task authority.
  - **Local Native Execution & Recovery**: Delegates `stats` execution to M2-C1 `NativeTextTool` inside `DeviceSandboxWorkspace` under the Cloud `taskId`/`runId`, checkpoints tool output locally, durably stages `CloudDeviceResultSubmission` before posting `/result`, replays unknown ACKs with the original fence until HTTP 200 `{ kind: "committed", replayed }` or HTTP 409 `{ kind: "fenced" }`, renews incomplete claims on cold recovery before resuming, and fails closed on HTTP `403` revoked / `409` register conflict.
- `CloudDeviceAdapterMonitor.swift` & `DeviceExecutorWorkbenchView.swift` — Optional M2-C2 status/connect panel behind `--ember-device-executor` (and `--ember-cloud-adapter-qa` for automated local V2 relay connection), leaving default Live Cloud and Mock app launches untouched.

## Verification

- **Unit & Wire Contract Suite (`CloudDeviceAdapterTests`, 12 tests)** + **M2-C1 Regression (`DeviceExecutorTests`, 17 tests)** under `SWIFT_STRICT_CONCURRENCY=complete`:
  - Tested on iOS Simulator (`iPhone 18 Pro`, iOS `27.2`) and physical iPhone (`iPhone 12 Pro Max`, `iPhone13,4`, iOS `27.0.1`).
- **Live End-to-End 联调 against Agent F M2-F2 Local `workerd` (`origin/feat/v2-m2-f2-iphone-native-execution`)**:
  - Real `Ember.app` in iOS Simulator (`--ember-device-executor --ember-cloud-adapter-qa`) registered against `V2LocalRuntimeHarness` + LAN relay (`127.0.0.1`).
  - Case 1 (Normal completion): Cloud dispatched `"Ember Cloud → iPhone\r\nLine 2 🚀"`, iOS claimed, executed native stats, and committed `{ utf8Bytes: 35, unicodeScalars: 30, lines: 2 }`.
  - Case 2 (Dropped `/result` ACK recovery): Relay dropped HTTP response after `workerd` commit; iOS retained Cloud fence and replayed `/result`, confirming `observedReplayed = true` and Agent Head terminal `completed` `{ utf8Bytes: 26, unicodeScalars: 26, lines: 3 }`.
