import Foundation
import XCTest
@testable import Ember

@MainActor
final class ProactiveScheduleTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []

    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        sessions.removeAll()
        registrations.removeAll()
        try await super.tearDown()
    }

    func testLiveRepositoryRoundTripAgainstV2SchedulesContract() async throws {
        let scheduleID = UUID(uuidString: "22222222-3333-4444-8555-666666666666")!
        let scheduleIDLower = scheduleID.uuidString.lowercased()

        let scheduleJSON: @Sendable (String) -> String = { status in
            """
            {
              "scheduleId": "\(scheduleIDLower)",
              "kind": "brief",
              "title": "Morning Brief",
              "prompt": "Summarize today's priorities",
              "deliveryMode": "model_brief",
              "status": "\(status)",
              "scheduleKind": "cron_tz",
              "intervalSeconds": null,
              "cronExpr": "0 8 * * *",
              "timezone": "Asia/Shanghai",
              "misfirePolicy": "coalesce_latest",
              "nextFireAt": "2026-11-21T00:00:00Z",
              "lastFiredAt": null,
              "occurrenceCount": 0,
              "version": 1,
              "createdAt": "2026-11-20T08:00:00Z",
              "updatedAt": "2026-11-20T08:00:00Z",
              "latestRun": null
            }
            """
        }

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path == "/v2/schedules" {
                return .json(statusCode: 200, body: "{\"schedules\":[\(scheduleJSON("active"))]}")
            }
            if request.httpMethod == "POST" && path == "/v2/schedules" {
                return .json(statusCode: 201, body: scheduleJSON("active"))
            }
            if request.httpMethod == "POST" && path == "/v2/schedules/\(scheduleIDLower)/pause" {
                return .json(statusCode: 200, body: scheduleJSON("paused"))
            }
            if request.httpMethod == "POST" && path == "/v2/schedules/\(scheduleIDLower)/resume" {
                return .json(statusCode: 200, body: scheduleJSON("active"))
            }
            if request.httpMethod == "POST" && path == "/v2/schedules/\(scheduleIDLower)/cancel" {
                return .json(statusCode: 200, body: scheduleJSON("cancelled"))
            }
            return .json(statusCode: 404, body: "{}")
        }

        let repo = try makeLiveRepository()
        let list = try await repo.listSchedules()
        XCTAssertEqual(list.schedules.count, 1)
        XCTAssertEqual(list.schedules[0].scheduleId, scheduleID)
        XCTAssertEqual(list.schedules[0].kind, .brief)
        XCTAssertEqual(list.schedules[0].deliveryMode, .modelBrief)
        XCTAssertEqual(list.schedules[0].cronExpr, "0 8 * * *")

        let created = try await repo.createSchedule(CreateProactiveScheduleRequestDTO(
            kind: .brief,
            title: "Morning Brief",
            prompt: "Summarize today's priorities",
            trigger: .cron(cronExpr: "0 8 * * *", timezone: "Asia/Shanghai"),
            timezone: "Asia/Shanghai",
            deliveryMode: .modelBrief
        ))
        XCTAssertEqual(created.status, .active)

        let paused = try await repo.pauseSchedule(id: scheduleID)
        XCTAssertEqual(paused.status, .paused)

        let resumed = try await repo.resumeSchedule(id: scheduleID)
        XCTAssertEqual(resumed.status, .active)

        let cancelled = try await repo.cancelSchedule(id: scheduleID)
        XCTAssertEqual(cancelled.status, .cancelled)
    }

    func testLiveRepository404MapsToEndpointNotReadyForV1Compatibility() async throws {
        register { _ in .json(statusCode: 404, body: "{}") }

        let store = ProactiveScheduleStore(repository: try makeLiveRepository())
        await store.refresh()

        XCTAssertTrue(store.isEndpointUnavailable)
        XCTAssertNil(store.errorMessage)
        XCTAssertTrue(store.schedules.isEmpty)
    }

    func testStoreCreatePauseResumeCancelAndSignOutClear() async throws {
        let repo = InMemoryProactiveScheduleRepository(items: [])
        let store = ProactiveScheduleStore(repository: repo)

        let created = await store.create(CreateProactiveScheduleRequestDTO(
            kind: .followUp,
            title: "Follow up on Q4 budget",
            prompt: "Check whether finance approved the Q4 budget.",
            trigger: .once(fireAt: "2026-11-21T09:00:00Z"),
            timezone: "Asia/Shanghai",
            deliveryMode: .directReminder
        ))
        XCTAssertTrue(created)
        XCTAssertEqual(store.schedules.count, 1)
        let id = try XCTUnwrap(store.schedules.first?.scheduleId)
        XCTAssertEqual(store.schedules.first?.status, .active)

        await store.pause(id: id)
        XCTAssertEqual(store.schedules.first?.status, .paused)

        await store.resume(id: id)
        XCTAssertEqual(store.schedules.first?.status, .active)

        await store.cancel(id: id)
        XCTAssertEqual(store.schedules.first?.status, .cancelled)

        store.clear()
        XCTAssertTrue(store.schedules.isEmpty)
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.isEndpointUnavailable)
    }

    func testSchedulesComposerUsesModelBriefForFollowUpAndBriefAndDirectReminderForReminder() throws {
        let tz = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz
        let dailyTime = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 21, hour: 8, minute: 30)))
        let fireAt = Date(timeIntervalSince1970: 1_795_255_200)

        let followUpReq = ProactiveSchedulesSheetView.makeCreateRequest(
            kind: .followUp,
            title: "Follow up on Q4 budget",
            prompt: "Summarize finance approval status",
            dailyTime: dailyTime,
            oneTimeFireAt: fireAt,
            timeZone: tz,
            calendar: calendar
        )
        XCTAssertEqual(followUpReq.kind, .followUp)
        XCTAssertEqual(followUpReq.deliveryMode, .modelBrief)
        XCTAssertEqual(followUpReq.trigger, .once(fireAt: fireAt.ISO8601Format()))

        let reminderReq = ProactiveSchedulesSheetView.makeCreateRequest(
            kind: .reminder,
            title: "Call Alex",
            prompt: "Call Alex at 4pm",
            dailyTime: dailyTime,
            oneTimeFireAt: fireAt,
            timeZone: tz,
            calendar: calendar
        )
        XCTAssertEqual(reminderReq.kind, .reminder)
        XCTAssertEqual(reminderReq.deliveryMode, .directReminder)
        XCTAssertEqual(reminderReq.trigger, .once(fireAt: fireAt.ISO8601Format()))

        let briefReq = ProactiveSchedulesSheetView.makeCreateRequest(
            kind: .brief,
            title: "Morning Brief",
            prompt: "Daily priorities",
            dailyTime: dailyTime,
            oneTimeFireAt: fireAt,
            timeZone: tz,
            calendar: calendar
        )
        XCTAssertEqual(briefReq.kind, .brief)
        XCTAssertEqual(briefReq.deliveryMode, .modelBrief)
        XCTAssertEqual(briefReq.trigger, .cron(cronExpr: "30 8 * * *", timezone: "America/Los_Angeles"))
    }

    func testNextFireAtFormatsInScheduleTimezoneRatherThanDeviceTimezone() throws {
        // 2026-11-22T13:00:00Z = 08:00 AM America/New_York = 09:00 PM Asia/Shanghai.
        let instant = try XCTUnwrap(ConversationCardFormatting.date(from: "2026-11-22T13:00:00Z"))
        let usLocale = Locale(identifier: "en_US_POSIX")
        let shanghaiFallback = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))

        let nyFormatted = ProactiveSchedulesSheetView.formatNextFireAt(
            instant,
            timezoneID: "America/New_York",
            locale: usLocale,
            fallbackTimeZone: shanghaiFallback
        )
        XCTAssertTrue(nyFormatted.contains("8:00"), "Expected 8:00 AM in America/New_York, got: \(nyFormatted)")
        XCTAssertTrue(nyFormatted.contains("AM"), "Expected AM in America/New_York, got: \(nyFormatted)")

        let shanghaiFormatted = ProactiveSchedulesSheetView.formatNextFireAt(
            instant,
            timezoneID: "Asia/Shanghai",
            locale: usLocale,
            fallbackTimeZone: shanghaiFallback
        )
        XCTAssertTrue(shanghaiFormatted.contains("9:00"), "Expected 9:00 PM in Asia/Shanghai, got: \(shanghaiFormatted)")
        XCTAssertTrue(shanghaiFormatted.contains("PM"), "Expected PM in Asia/Shanghai, got: \(shanghaiFormatted)")

        let invalidFallback = ProactiveSchedulesSheetView.formatNextFireAt(
            instant,
            timezoneID: "Invalid/Zone",
            locale: usLocale,
            fallbackTimeZone: shanghaiFallback
        )
        XCTAssertEqual(invalidFallback, shanghaiFormatted)
    }

    func testLiveHostColdLaunchAndForegroundReturnSurfaceAppClosedProactiveDeliveries() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-proactive-relaunch-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api,
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let journal = LiveConversationJournal(directory: directory)
        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: journal
        )

        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let reminderID = "aaaaaaaa-1111-4111-8111-111111111111"
        let briefID = "bbbbbbbb-2222-4222-8222-222222222222"
        let pageCalls = LockedCounter()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me" {
                return .json(statusCode: 200, body: AuthFixture.meJSON)
            }
            guard request.httpMethod == "GET",
                  path == "/v1/conversations/\(conversationID)/messages" else {
                return .json(statusCode: 404, body: "{}")
            }
            let callIndex = pageCalls.increment()
            if callIndex == 1 {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id": "\(conversationID)",
                  "transcript_epoch": 0,
                  "messages": [
                    {
                      "message_id": "\(reminderID)",
                      "sequence": 1,
                      "created_at": "2026-11-21T08:00:00Z",
                      "kind": "ember",
                      "text": "Reminder: Call Alex\\n\\nCheck Q4 invoice receipt.",
                      "model_label": "ember-proactive-scheduler",
                      "simulated": false
                    }
                  ],
                  "next_after": 1,
                  "has_more": false
                }
                """)
            }
            return .json(statusCode: 200, body: """
            {
              "conversation_id": "\(conversationID)",
              "transcript_epoch": 0,
              "messages": [
                {
                  "message_id": "\(reminderID)",
                  "sequence": 1,
                  "created_at": "2026-11-21T08:00:00Z",
                  "kind": "ember",
                  "text": "Reminder: Call Alex\\n\\nCheck Q4 invoice receipt.",
                  "model_label": "ember-proactive-scheduler",
                  "simulated": false
                },
                {
                  "message_id": "\(briefID)",
                  "sequence": 2,
                  "created_at": "2026-11-21T08:05:00Z",
                  "kind": "ember",
                  "text": "**Morning Brief**\\n\\nTop priority: sign-off meeting at 10 AM.",
                  "model_label": "fake-model",
                  "simulated": true
                }
              ],
              "next_after": 2,
              "has_more": false
            }
            """)
        }

        let host = LiveConversationHostModel(repository: repo, auth: auth)
        defer { host.suspendForDisappearance() }
        host.handleScenePhase(.active)
        host.handleViewAppeared()
        await host.start()

        let coldLaunchTexts = host.screen.timeline.compactMap { entry -> String? in
            if case .message(let msg) = entry, msg.author == .ember { return msg.text }
            return nil
        }
        XCTAssertTrue(coldLaunchTexts.contains(where: { $0.contains("Reminder: Call Alex") }))

        // Simulate app going to background while cloud executes Morning Brief, then returning active.
        host.handleScenePhase(.background)
        host.handleScenePhase(.active)
        for _ in 0..<50 {
            let texts = host.screen.timeline.compactMap { entry -> String? in
                if case .message(let msg) = entry, msg.author == .ember { return msg.text }
                return nil
            }
            if texts.contains(where: { $0.contains("**Morning Brief**") }) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let resumedTexts = host.screen.timeline.compactMap { entry -> String? in
            if case .message(let msg) = entry, msg.author == .ember { return msg.text }
            return nil
        }
        XCTAssertTrue(resumedTexts.contains(where: { $0.contains("Reminder: Call Alex") }))
        XCTAssertTrue(resumedTexts.contains(where: { $0.contains("**Morning Brief**") }))
    }

    private func makeLiveRepository() throws -> LiveProactiveScheduleRepository {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
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
        return LiveProactiveScheduleRepository(auth: auth)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() -> Int {
        lock.withLock {
            count += 1
            return count
        }
    }
}
