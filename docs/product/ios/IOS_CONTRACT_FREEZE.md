# Ember iOS B0 Shared Contract Freeze

> Draft for iOS Lead review · 2026-11-01 · Issue #41
> Base: 3f3c55077857608e2580deedb1c2d016e18d9501 (merged M1, PR #40)

## Scope

This change freezes the small Swift surface needed by the next iOS worktrees: task wire DTOs, one feature-facing repository protocol, a URLSession transport wrapper, deterministic mock scenarios, and a fake repository. It does not change API, authentication, tenant, security, privacy, persistence, or cost contracts.

The DTO field names and enum values were checked against the TypeScript source at the Base SHA:

- Task receipt and create request: packages/contracts/src/task-schemas.ts
- Task detail, event page, and cancel response: apps/api/src/tasks/dto.ts
- Event names and payload allowlist: packages/contracts/src/event-schemas.ts and packages/domain/src/types.ts
- Approval response: packages/contracts/src/approval-schemas.ts and apps/api/src/approvals/routes.ts
- Task status set: packages/domain/src/types.ts

These are repository source references, not a promise that an API is deployed or ready for consumer authentication. All task kinds in this freeze are the existing mock kinds.

## Frozen public signatures

TaskRepositoryProtocol is the only feature/store-facing task repository abstraction:

    func createTask(_ request: CreateTaskRequestDTO, idempotencyKey: String) async throws -> TaskReceiptDTO
    func fetchTask(id: UUID) async throws -> TaskDTO
    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> TaskEventPageDTO
    func cancelTask(id: UUID) async throws -> TaskCancelDTO

CreateTaskRequestDTO is a correlated enum, so its kind and input cannot disagree. It supports only mock.chat, mock.compute, mock.file, and mock.approval. The idempotency key remains a separate header argument and is never encoded into the request body.

EmberAPIClient is a concrete transport wrapper, not a second repository:

    func send(_ request: URLRequest) async throws -> EmberAPIResponse

It uses an injected URLSession and returns response bytes plus the HTTP status code. It defines no endpoint methods, auth flow, credentials, SSE parser, retry policy, or production environment. URLSession is injected directly, so no second transport protocol is needed.

TaskDTO contains only the audited detail fields. TaskEventDTO contains the audited event fields and closed typed payload vocabulary. ApprovalDTO carries only the existing digest-based approval metadata; it does not contain human-readable action details and this freeze adds no decision operation.

## Independent state dimensions

TaskStatus represents only server task lifecycle. ConnectionPhase represents local transport health. TaskCommandInFlight represents a local create/cancel command in progress. TaskExecutionCapability represents the selected mock/real capability; every bundled scenario is MOCK ONLY.

TaskPresentationState composes those four fields without folding connection or command state into a server status. A completed TaskDTO has no readable result field and there is no result, inbox, auth, notification, or SSE endpoint in this contract.

## Dependencies explicitly proposed for later review

These are not implemented dependencies of this freeze. They remain proposals from the API gap audit at this Base SHA and require their own owner and review:

- Consumer mobile identity/session and tenant membership: PROPOSED; no consumer login, refresh, or mobile credential contract exists.
- Default agent and task Inbox: PROPOSED; the API has no default-agent or task-list endpoint.
- A displayable, persisted task outcome: PROPOSED; there is no general result-reading endpoint in the task contract.
- Real bounded text task kinds: PROPOSED; current supported task kinds are mock-only.
- Human-readable approval action details: PROPOSED; the current ApprovalDTO exposes a digest, not an action description.
- iOS SSE parsing/reconnect behavior: deferred client implementation; the platform stream route exists, but this freeze adds no stream client.
- APNs notifications and secure notification deep links: PROPOSED; no mobile notification contract is added here.

## Deterministic fixtures

The JSON values are synthetic examples authored for this baseline. Their shapes and enum values come from the TypeScript source listed above; the UUIDs, timestamps, trace IDs, digest, and mock outcome text are deterministic fixture values, not captured production data.

| Fixture | Purpose |
| --- | --- |
| receipt.json | Accepted queued receipt; receipt is not completion |
| queued.json | Queued snapshot and accepted event |
| running.json | Running snapshot with accepted, started, and progress events |
| completed.json | Completed mock task plus a result string explicitly marked fixture-only |
| missing_result.json | Completed task with no readable outcome |
| disconnected_reconnected.json | Same running server status across disconnected, connecting, and connected local states |
| cancel_race.json | Completion wins a cancellation race; the fake advances snapshot and event history |
| approval_unavailable.json | Waiting-for-approval task where approval presentation is unavailable |
| approval_pending.json | Existing digest-only ApprovalDTO wire shape |

MockScenarioProvider loads these resources from the app bundle. FakeTaskRepository is an in-memory, deterministic preview/test implementation. It returns one fixed receipt for the first use of an idempotency key and marks a repeated key as replayed. It does not execute submitted input or expose a result-reading method. The completed outcome string is available only as mock fixture data and is not part of TaskDTO or TaskRepositoryProtocol.

## Ownership and verification

Files changed are limited to Domain, Networking/Protocols, Networking/Fixtures, EmberTests/Contracts, and this document. Ember.xcodeproj, App, Features, DesignSystem, Security, apps/api, apps/worker, packages, migrations, credentials, and third-party dependencies are unchanged. The existing M1 filesystem-synchronized groups discover new Swift source and fixture resources without a project-file edit.

The local machine reports macOS 26.5.1 (25F80), Xcode 26.3 (17C529), and an available iOS 27.0 Simulator (iPhone 17 Pro Max, EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5). The Issue #41 prompt explicitly scopes the existing CTO toolchain exception to M1. The runs below pass locally but do not constitute official B0 build/test acceptance. A separate CTO extension or the approved compatible toolchain is required before claiming that acceptance.

### Verification commands

    xcodebuild -list -project apps/ios/Ember.xcodeproj
    xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5' CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=EBEC779E-39C4-48AE-BBBF-7B8C8B76F5E5' CODE_SIGNING_ALLOWED=NO test

Results on the local toolchain:

- xcodebuild -list -project apps/ios/Ember.xcodeproj — exit 0; lists Ember, EmberTests, EmberUITests, and the shared Ember scheme.
- Simulator build command above — exit 0; new Swift files compiled without editing project.pbxproj.
- Simulator test command above — exit 0; 11 unit tests and 1 UI test passed.

Unit tests cover DTO decoding, fixture stability, state separation, request encoding, fake receipt replay, event cursor behavior, and the cancel race. The UI smoke test passed through the full Ember scheme. Xcode emitted the existing provisioning-profile diagnostic and the iOS 27.0 runtime emitted duplicate Objective-C class warnings; neither caused a failure. These results are local evidence only, pending the separately scoped CTO toolchain decision.

## Known gaps and rollback

This contract does not establish production auth, real task kinds, task Inbox, result retrieval, human-readable approval detail, server push, SSE, or live API integration. Those remain separately owned and reviewed work.

Rollback is a single revert of the B0 Draft PR. It does not require a database or server change.
