import Foundation
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

    func testResolveCloudTargetIsolatesV2StagingFromV1AndFailsClosedOnHTTP() {
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
}
