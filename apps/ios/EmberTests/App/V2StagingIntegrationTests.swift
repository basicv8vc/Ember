import Foundation
import SwiftUI
import XCTest
@testable import Ember

@MainActor
final class V2StagingIntegrationTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []

    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        sessions.removeAll()
        registrations.removeAll()
        try await super.tearDown()
    }

    func testResolveCloudTargetIsolatesV2StagingFromV1AndFailsClosedOnHTTP() throws {
        let v1 = AppCompositionRoot.resolveCloudTarget(arguments: [], environment: [:])
        XCTAssertEqual(v1?.baseURL.absoluteString, AppCompositionRoot.defaultCloudBaseURL)
        XCTAssertEqual(v1?.keychainConfiguration, .live)
        XCTAssertEqual(v1?.journalSubdirectory, "EmberConversation")
        XCTAssertEqual(v1?.authFenceSubdirectory, "EmberAuth")
        XCTAssertEqual(v1?.environmentBadge, "LIVE CLOUD")
        XCTAssertEqual(v1?.isV2Staging, false)

        let v2Flag = AppCompositionRoot.resolveCloudTarget(
            arguments: ["--ember-v2-staging"],
            environment: [:]
        )
        XCTAssertEqual(v2Flag?.baseURL.absoluteString, AppCompositionRoot.v2StagingCloudBaseURL)
        XCTAssertEqual(v2Flag?.keychainConfiguration.account, "ember.session.v2-staging")
        XCTAssertNotEqual(v2Flag?.keychainConfiguration, .live)
        XCTAssertEqual(v2Flag?.journalSubdirectory, "EmberConversation-v2-staging")
        XCTAssertEqual(v2Flag?.authFenceSubdirectory, "EmberAuth-v2-staging")
        XCTAssertEqual(v2Flag?.environmentBadge, "V2 STAGING")
        XCTAssertEqual(v2Flag?.isV2Staging, true)

        let v2Env = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: ["EMBER_CLOUD_BASE_URL": "https://ember-v2-staging.slowfast.dev"]
        )
        XCTAssertEqual(v2Env, v2Flag)

        let insecure = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: ["EMBER_CLOUD_BASE_URL": "http://ember-v2-staging.slowfast.dev"]
        )
        XCTAssertNil(insecure, "Non-HTTPS cloud URL must fail closed")

        let suiteName = "ember.v2.target.persist.\(UUID().uuidString.lowercased())"
        let isolatedDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        isolatedDefaults.removePersistentDomain(forName: suiteName)
        defer { isolatedDefaults.removePersistentDomain(forName: suiteName) }

        // Default clean UserDefaults resolves V1 even in Debug builds.
        let cleanDefault = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: [:],
            userDefaults: isolatedDefaults
        )
        XCTAssertEqual(cleanDefault?.baseURL.absoluteString, AppCompositionRoot.defaultCloudBaseURL)
        XCTAssertEqual(cleanDefault?.keychainConfiguration, .live)

        // Ephemeral --ember-v2-staging must not persist on its own.
        _ = AppCompositionRoot.resolveCloudTarget(
            arguments: ["--ember-v2-staging"],
            environment: [:],
            userDefaults: isolatedDefaults
        )
        XCTAssertFalse(isolatedDefaults.bool(forKey: AppCompositionRoot.persistedV2StagingDefaultsKey))

        // --ember-v2-staging + --ember-persist-v2-staging (or Debug toggle) persists V2 Staging across empty-arg relaunches.
        let persisted = AppCompositionRoot.resolveCloudTarget(
            arguments: ["--ember-v2-staging", "--ember-persist-v2-staging"],
            environment: [:],
            userDefaults: isolatedDefaults
        )
        XCTAssertEqual(persisted?.baseURL.absoluteString, AppCompositionRoot.v2StagingCloudBaseURL)
        let desktopRelaunch = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: [:],
            userDefaults: isolatedDefaults
        )
        XCTAssertEqual(desktopRelaunch?.baseURL.absoluteString, AppCompositionRoot.v2StagingCloudBaseURL)
        XCTAssertEqual(desktopRelaunch?.keychainConfiguration.account, "ember.session.v2-staging")
        XCTAssertEqual(desktopRelaunch?.journalSubdirectory, "EmberConversation-v2-staging")
        XCTAssertEqual(desktopRelaunch?.environmentBadge, "V2 STAGING")

        // Explicit --ember-live-cloud still forces V1 even when V2 Staging is persisted.
        let forcedV1 = AppCompositionRoot.resolveCloudTarget(
            arguments: ["--ember-live-cloud"],
            environment: [:],
            userDefaults: isolatedDefaults
        )
        XCTAssertEqual(forcedV1?.baseURL.absoluteString, AppCompositionRoot.defaultCloudBaseURL)
        XCTAssertEqual(forcedV1?.keychainConfiguration, .live)

        AppCompositionRoot.setPersistedV2Staging(false, userDefaults: isolatedDefaults)
        let resetToV1 = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: [:],
            userDefaults: isolatedDefaults
        )
        XCTAssertEqual(resetToV1?.baseURL.absoluteString, AppCompositionRoot.defaultCloudBaseURL)

        // Release/Info.plist EmberCloudBaseURL configures V2 Staging without Debug persistence.
        let infoPlistV2 = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: [:],
            userDefaults: isolatedDefaults,
            bundleInfo: [AppCompositionRoot.infoPlistCloudBaseURLKey: AppCompositionRoot.v2StagingCloudBaseURL]
        )
        XCTAssertEqual(infoPlistV2?.baseURL.absoluteString, AppCompositionRoot.v2StagingCloudBaseURL)
        XCTAssertEqual(infoPlistV2?.isV2Staging, true)

        // Non-HTTPS Info.plist URL must fail closed.
        let invalidInfoPlist = AppCompositionRoot.resolveCloudTarget(
            arguments: [],
            environment: [:],
            userDefaults: isolatedDefaults,
            bundleInfo: [AppCompositionRoot.infoPlistCloudBaseURLKey: "http://ember-v2-staging.slowfast.dev"]
        )
        XCTAssertNil(invalidInfoPlist)
    }

    func testSessionRecoveryFenceIsolationBetweenV1AndV2Staging() throws {
        let v1Target = try XCTUnwrap(AppCompositionRoot.resolveCloudTarget(arguments: [], environment: [:]))
        let v2Target = try XCTUnwrap(AppCompositionRoot.resolveCloudTarget(arguments: ["--ember-v2-staging"], environment: [:]))

        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-fence-isolation-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let v1Fence = FileSessionRecoveryFence(
            directory: tempRoot.appendingPathComponent(v1Target.authFenceSubdirectory, isDirectory: true)
        )
        let v2Fence = FileSessionRecoveryFence(
            directory: tempRoot.appendingPathComponent(v2Target.authFenceSubdirectory, isDirectory: true)
        )

        XCTAssertFalse(v1Fence.isArmed)
        XCTAssertFalse(v2Fence.isArmed)

        // Arming V2 Staging must not arm V1.
        try v2Fence.arm()
        XCTAssertTrue(v2Fence.isArmed)
        XCTAssertFalse(v1Fence.isArmed)

        // Arming V1 leaves both independently armed.
        try v1Fence.arm()
        XCTAssertTrue(v1Fence.isArmed)
        XCTAssertTrue(v2Fence.isArmed)

        // Clearing V2 Staging must not disarm V1.
        v2Fence.clear()
        XCTAssertFalse(v2Fence.isArmed)
        XCTAssertTrue(v1Fence.isArmed)

        // Clearing V1 disarms V1 cleanly.
        v1Fence.clear()
        XCTAssertFalse(v1Fence.isArmed)
        XCTAssertFalse(v2Fence.isArmed)
    }

    func testV2StagingFullJourneyAuthMemorySchedulesAndSignOutClear() async throws {
        let stagingBaseURL = URL(string: "https://ember-v2-staging.test.invalid")!
        let memoryID = UUID(uuidString: "33333333-4444-4555-8666-777777777777")!
        let scheduleID = UUID(uuidString: "44444444-5555-4666-8777-888888888888")!
        let memoryIDLower = memoryID.uuidString.lowercased()
        let scheduleIDLower = scheduleID.uuidString.lowercased()

        let session = StubSession.make()
        sessions.append(session)
        let registration = StubURLProtocol.register({ request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path == "/v2/memories" {
                return .json(statusCode: 200, body: "{\"items\":[],\"limits\":{\"max_items\":50,\"max_content_chars\":500}}")
            }
            if request.httpMethod == "POST" && path == "/v2/memories" {
                return .json(statusCode: 201, body: """
                {
                  "item": {
                    "memory_id": "\(memoryIDLower)",
                    "kind": "preference",
                    "key": null,
                    "content": "Concise morning briefs",
                    "provenance": {"source": "user_settings", "conversation_id": null, "message_id": null},
                    "created_at": "2026-11-20T12:00:00Z",
                    "updated_at": "2026-11-20T12:00:00Z"
                  },
                  "created": true
                }
                """)
            }
            if request.httpMethod == "PATCH" && path == "/v2/memories/\(memoryIDLower)" {
                return .json(statusCode: 200, body: """
                {
                  "item": {
                    "memory_id": "\(memoryIDLower)",
                    "kind": "preference",
                    "key": null,
                    "content": "Concise 3-bullet morning briefs",
                    "provenance": {"source": "user_settings", "conversation_id": null, "message_id": null},
                    "created_at": "2026-11-20T12:00:00Z",
                    "updated_at": "2026-11-20T12:05:00Z"
                  }
                }
                """)
            }
            if request.httpMethod == "GET" && path == "/v2/schedules" {
                return .json(statusCode: 200, body: "{\"schedules\":[]}")
            }
            if request.httpMethod == "POST" && path == "/v2/schedules" {
                return .json(statusCode: 201, body: """
                {
                  "scheduleId": "\(scheduleIDLower)",
                  "kind": "brief",
                  "title": "Morning Brief",
                  "prompt": "Summarize priorities",
                  "deliveryMode": "model_brief",
                  "status": "active",
                  "scheduleKind": "cron_tz",
                  "intervalSeconds": null,
                  "cronExpr": "0 8 * * *",
                  "timezone": "Asia/Shanghai",
                  "misfirePolicy": "coalesce_latest",
                  "nextFireAt": "2026-11-21T00:00:00Z",
                  "lastFiredAt": null,
                  "occurrenceCount": 0,
                  "version": 1,
                  "createdAt": "2026-11-20T12:00:00Z",
                  "updatedAt": "2026-11-20T12:00:00Z",
                  "latestRun": null
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }, forHost: stagingBaseURL.host!)
        registrations.append(registration)

        let transport = try EmberAuthenticatedTransport(
            baseURL: stagingBaseURL,
            client: EmberAPIClient(session: session)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))

        let memoryStore = PersonalMemoryStore(repository: LivePersonalMemoryRepository(auth: auth))
        let scheduleStore = ProactiveScheduleStore(repository: LiveProactiveScheduleRepository(auth: auth))

        await memoryStore.refresh()
        let saved = await memoryStore.save(kind: .preference, content: "Concise morning briefs")
        XCTAssertTrue(saved)
        let updated = await memoryStore.update(id: memoryID, kind: .preference, content: "Concise 3-bullet morning briefs")
        XCTAssertTrue(updated)
        XCTAssertEqual(memoryStore.items.first?.content, "Concise 3-bullet morning briefs")

        await scheduleStore.refresh()
        let createdSchedule = await scheduleStore.create(CreateProactiveScheduleRequestDTO(
            kind: .brief,
            title: "Morning Brief",
            prompt: "Summarize priorities",
            trigger: .cron(cronExpr: "0 8 * * *", timezone: "Asia/Shanghai"),
            timezone: "Asia/Shanghai",
            deliveryMode: .modelBrief
        ))
        XCTAssertTrue(createdSchedule)
        XCTAssertEqual(scheduleStore.schedules.first?.scheduleId, scheduleID)

        // Sign-out clears all V2 stores cleanly.
        memoryStore.clear()
        scheduleStore.clear()
        XCTAssertTrue(memoryStore.items.isEmpty)
        XCTAssertTrue(scheduleStore.schedules.isEmpty)
    }

    func testCloudDeviceMonitorIsWiredOnlyForLiveV2AndStopsOnSignOut() async throws {
        let stagingURL = URL(string: "https://ember-v2-staging.slowfast.dev")!
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: try EmberAuthenticatedTransport(baseURL: stagingURL, client: EmberAPIClient()),
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let hostModel = LiveConversationHostModel(
            repository: StubLiveConversationService(),
            auth: auth,
            cloudBaseURL: stagingURL,
            deviceAuthProvider: auth
        )
        XCTAssertNotNil(hostModel.cloudDeviceMonitor)
        XCTAssertFalse(hostModel.isDeviceExecutorEnabled)

        hostModel.handleScenePhase(.background)
        await hostModel.signOut()
        XCTAssertFalse(hostModel.cloudDeviceMonitor?.isRunning ?? true)

        let v1Model = LiveConversationHostModel(
            repository: StubLiveConversationService(),
            auth: auth,
            cloudBaseURL: nil,
            deviceAuthProvider: nil
        )
        XCTAssertNil(v1Model.cloudDeviceMonitor)
    }

    func testDeviceExecutorLifecycleEnableStartScenePhaseDisableSignOutAndPerAccountIsolation() async throws {
        let stagingURL = URL(string: "https://ember-v2-staging.slowfast.dev")!
        let suiteName = "ember.v2.staging.test.\(UUID().uuidString.lowercased())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-v2-device-lifecycle-\(UUID().uuidString.lowercased())", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let accountA = UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!
        let accountB = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!
        let service = SwitchableAccountConversationService(consumerID: accountA)
        let transport = StagingStubCloudDeviceTransport()
        let credStore = InMemoryCloudDeviceCredentialStore()
        let journal = CloudDeviceExecutionJournal(directory: tempDir)
        let workspace = DeviceSandboxWorkspace(rootDirectory: tempDir)

        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: try EmberAuthenticatedTransport(baseURL: stagingURL, client: EmberAPIClient()),
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))

        let hostModel = LiveConversationHostModel(
            repository: service,
            auth: auth,
            cloudBaseURL: stagingURL,
            deviceAuthProvider: auth,
            userDefaults: defaults,
            deviceExecutorTransport: transport,
            deviceExecutorCredentialStore: credStore,
            deviceExecutorJournal: journal,
            deviceExecutorWorkspace: workspace
        )

        // 1. Account A starts with opt-in disabled.
        await hostModel.start()
        XCTAssertFalse(hostModel.isDeviceExecutorEnabled)
        XCTAssertFalse(hostModel.cloudDeviceMonitor?.isRunning ?? true)

        // 2. Enabling starts and registers the live CloudDeviceAdapterMonitor.
        await hostModel.setDeviceExecutorEnabled(true)
        await transport.waitForClaimEntry()
        XCTAssertTrue(hostModel.isDeviceExecutorEnabled)
        XCTAssertTrue(hostModel.cloudDeviceMonitor?.isRunning ?? false)
        let regAfterEnable = await transport.registerCount
        XCTAssertGreaterThanOrEqual(regAfterEnable, 1)

        // 3. Rapid background -> active transitions stay serialized cleanly.
        hostModel.handleScenePhase(.background)
        hostModel.handleScenePhase(.active)
        await Task.yield()
        await hostModel.setDeviceExecutorEnabled(false)
        XCTAssertFalse(hostModel.isDeviceExecutorEnabled)
        XCTAssertFalse(hostModel.cloudDeviceMonitor?.isRunning ?? true)

        // 4. Re-enable then sign out: executor stops and preference clears in memory for next account.
        await hostModel.setDeviceExecutorEnabled(true)
        await transport.waitForSecondClaimOrStopSafe()
        await hostModel.signOut()
        XCTAssertFalse(hostModel.isDeviceExecutorEnabled)
        XCTAssertFalse(hostModel.cloudDeviceMonitor?.isRunning ?? true)

        // 5. Account B signs in on the SAME staging host: must NOT inherit Account A's opt-in.
        await service.setConsumerID(accountB)
        await hostModel.start()
        XCTAssertFalse(hostModel.isDeviceExecutorEnabled)
        XCTAssertFalse(hostModel.cloudDeviceMonitor?.isRunning ?? true)

        // 6. Switching back to Account A remembers Account A's saved opt-in.
        await service.setConsumerID(accountA)
        await hostModel.start()
        XCTAssertTrue(hostModel.isDeviceExecutorEnabled)
        await hostModel.setDeviceExecutorEnabled(false)
    }
}

private actor SwitchableAccountConversationService: LiveConversationServiceProtocol {
    private var consumerID: UUID

    init(consumerID: UUID) {
        self.consumerID = consumerID
    }

    func setConsumerID(_ id: UUID) {
        consumerID = id
    }

    func bootstrap() async throws -> EmberMeDTO {
        EmberMeDTO(
            consumerID: consumerID,
            agent: .init(agentID: UUID(), displayName: "Ember"),
            conversation: .init(conversationID: UUID(), transcriptEpoch: 1, createdAt: Date(), updatedAt: Date())
        )
    }
    func load() async throws -> ConversationSnapshot {
        ConversationSnapshot(
            conversation: Conversation(id: ConversationID(rawValue: UUID()), createdAt: Date(), updatedAt: Date()),
            messages: [],
            assistantTurns: []
        )
    }
    func recoverAfterRelaunch() async throws -> ConversationSnapshot { try await load() }
    func pending() async throws -> LiveConversationJournal.Pending? { nil }
    func activeTurn() async throws -> LiveConversationJournal.Turn? { nil }
    func rejectedDraft() async throws -> LiveConversationJournal.Pending? { nil }
    func uploadAttachment(filename: String, mediaType: String, data: Data) async throws -> StagedUploadReceiptDTO {
        throw LiveB1Failure.rejected
    }
    func send(text: String, attachmentIDs: [UUID]) async throws -> LiveB1Receipt {
        throw LiveB1Failure.rejected
    }
    func reconcilePending() async throws -> LiveB1Receipt? { nil }
    func pollActiveTurn() async throws -> LiveB1Turn? { nil }
    func cancelActiveTurn() async throws -> LiveB1Turn? { nil }
    func clearOnLogout() async {}
}

private actor StagingStubCloudDeviceTransport: CloudDeviceAPITransporting {
    private(set) var registerCount = 0
    private(set) var claimCount = 0
    private var claimWaiters: [CheckedContinuation<Void, Never>] = []

    func waitForClaimEntry() async {
        if claimCount > 0 { return }
        await withCheckedContinuation { continuation in
            claimWaiters.append(continuation)
        }
    }

    func waitForSecondClaimOrStopSafe() async {
        let target = claimCount + 1
        while claimCount < target {
            await withCheckedContinuation { continuation in
                claimWaiters.append(continuation)
            }
        }
    }

    func register(credential: CloudDeviceCredential) async throws -> CloudDeviceRegistrationReceipt {
        registerCount += 1
        return CloudDeviceRegistrationReceipt(
            deviceId: credential.id,
            capability: CloudDeviceContract.textCapability,
            version: CloudDeviceContract.capabilityVersion,
            readyUntilMs: Int64(Date().timeIntervalSince1970 * 1000) + 30_000
        )
    }

    func claim(credential: CloudDeviceCredential) async throws -> CloudDeviceClaimResponse {
        claimCount += 1
        let waiters = claimWaiters
        claimWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        return .idle
    }

    func renew(
        credential: CloudDeviceCredential,
        taskID: UUID,
        fence: CloudDeviceFence,
        previousLeaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> CloudDeviceRenewOutcome {
        .renewed(leaseExpiresAtMs: deadlineAtMs)
    }

    func submitResult(
        credential: CloudDeviceCredential,
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome {
        .committed(replayed: false)
    }
}

private actor StubLiveConversationService: LiveConversationServiceProtocol {
    func bootstrap() async throws -> EmberMeDTO {
        EmberMeDTO(
            consumerID: UUID(),
            agent: .init(agentID: UUID(), displayName: "Ember"),
            conversation: .init(conversationID: UUID(), transcriptEpoch: 1, createdAt: Date(), updatedAt: Date())
        )
    }
    func load() async throws -> ConversationSnapshot {
        ConversationSnapshot(
            conversation: Conversation(id: ConversationID(rawValue: UUID()), createdAt: Date(), updatedAt: Date()),
            messages: [],
            assistantTurns: []
        )
    }
    func recoverAfterRelaunch() async throws -> ConversationSnapshot { try await load() }
    func pending() async throws -> LiveConversationJournal.Pending? { nil }
    func activeTurn() async throws -> LiveConversationJournal.Turn? { nil }
    func rejectedDraft() async throws -> LiveConversationJournal.Pending? { nil }
    func uploadAttachment(filename: String, mediaType: String, data: Data) async throws -> StagedUploadReceiptDTO {
        throw LiveB1Failure.rejected
    }
    func send(text: String, attachmentIDs: [UUID]) async throws -> LiveB1Receipt {
        throw LiveB1Failure.rejected
    }
    func reconcilePending() async throws -> LiveB1Receipt? { nil }
    func pollActiveTurn() async throws -> LiveB1Turn? { nil }
    func cancelActiveTurn() async throws -> LiveB1Turn? { nil }
    func clearOnLogout() async {}
}
