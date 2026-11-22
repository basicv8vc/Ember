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

        let oneTimeBriefReq = ProactiveSchedulesSheetView.makeCreateRequest(
            kind: .brief,
            title: "Afternoon Brief",
            prompt: "Check release blockers",
            dailyTime: dailyTime,
            oneTimeFireAt: fireAt,
            frequency: .once,
            timeZone: tz,
            calendar: calendar
        )
        XCTAssertEqual(oneTimeBriefReq.kind, .brief)
        XCTAssertEqual(oneTimeBriefReq.deliveryMode, .modelBrief)
        XCTAssertEqual(oneTimeBriefReq.trigger, .once(fireAt: fireAt.ISO8601Format()))

        let dailyReminderReq = ProactiveSchedulesSheetView.makeCreateRequest(
            kind: .reminder,
            title: "Hydrate",
            prompt: "Drink water",
            dailyTime: dailyTime,
            oneTimeFireAt: fireAt,
            frequency: .daily,
            timeZone: tz,
            calendar: calendar
        )
        XCTAssertEqual(dailyReminderReq.kind, .reminder)
        XCTAssertEqual(dailyReminderReq.deliveryMode, .directReminder)
        XCTAssertEqual(dailyReminderReq.trigger, .cron(cronExpr: "30 8 * * *", timezone: "America/Los_Angeles"))
    }

    func testLiveRepository403MapsToPolicyDeniedMessageAndFormattedCadence() async throws {
        register { request in
            if request.httpMethod == "POST", request.url?.path == "/v2/schedules" {
                return .json(statusCode: 403, body: "{\"code\":\"POLICY_DENIED\"}")
            }
            return .json(statusCode: 200, body: "{\"schedules\":[]}")
        }

        let store = ProactiveScheduleStore(repository: try makeLiveRepository())
        let created = await store.create(CreateProactiveScheduleRequestDTO(
            kind: .brief,
            title: "Daily AI Brief",
            prompt: "Summarize priorities",
            trigger: .cron(cronExpr: "30 8 * * *", timezone: "Asia/Shanghai"),
            timezone: "Asia/Shanghai",
            deliveryMode: .modelBrief
        ))
        XCTAssertFalse(created)
        XCTAssertEqual(
            store.errorMessage,
            String(localized: "schedules.error.policy_denied", table: "Conversation")
        )

        let dailySchedule = ProactiveScheduleDTO(
            scheduleId: UUID(),
            kind: .brief,
            title: "Daily AI Brief",
            prompt: "Summarize priorities",
            deliveryMode: .modelBrief,
            status: .active,
            scheduleKind: .cronTZ,
            cronExpr: "30 8 * * *",
            timezone: "Asia/Shanghai",
            createdAt: "2026-11-22T00:00:00Z",
            updatedAt: "2026-11-22T00:00:00Z"
        )
        XCTAssertEqual(
            ProactiveSchedulesSheetView.formattedCadence(for: dailySchedule),
            String(localized: "schedules.cadence.daily \("08:30")", table: "Conversation")
        )

        let intervalSchedule = ProactiveScheduleDTO(
            scheduleId: UUID(),
            kind: .reminder,
            title: "Posture Check",
            prompt: "Stretch",
            deliveryMode: .directReminder,
            status: .active,
            scheduleKind: .interval,
            intervalSeconds: 3600,
            timezone: "Asia/Shanghai",
            createdAt: "2026-11-22T00:00:00Z",
            updatedAt: "2026-11-22T00:00:00Z"
        )
        XCTAssertEqual(
            ProactiveSchedulesSheetView.formattedCadence(for: intervalSchedule),
            String(localized: "schedules.cadence.every_hours \(1)", table: "Conversation")
        )
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

    func testScheduleDisplayResultPrefersDetailTextAndMapsFriendlyFailureReasons() throws {
        let schedule = ProactiveScheduleDTO(
            scheduleId: UUID(),
            kind: .brief,
            title: "Morning Brief",
            prompt: "Summarize today's priorities.",
            deliveryMode: .modelBrief,
            status: .active,
            scheduleKind: .cronTZ,
            cronExpr: "0 8 * * *",
            timezone: "Asia/Shanghai",
            createdAt: "2026-11-21T00:00:00Z",
            updatedAt: "2026-11-21T00:00:00Z"
        )

        let completedRun = ProactiveScheduleRunDTO(
            occurrenceSeq: 1,
            taskId: UUID().uuidString.lowercased(),
            status: "completed",
            summaryText: "Morning Brief",
            detailText: "Top priority: finalize Q4 launch checklist.",
            reasonCode: "ok",
            resultMessageId: UUID().uuidString.lowercased(),
            scheduledFor: "2026-11-21T00:00:00Z",
            completedAt: "2026-11-21T00:00:05Z"
        )
        XCTAssertEqual(
            ProactiveSchedulesSheetView.displayResultText(for: schedule, run: completedRun),
            "Top priority: finalize Q4 launch checklist."
        )

        let titleOnlyRun = ProactiveScheduleRunDTO(
            occurrenceSeq: 1,
            taskId: UUID().uuidString.lowercased(),
            status: "completed",
            summaryText: "Morning Brief",
            detailText: nil,
            reasonCode: "ok",
            scheduledFor: "2026-11-21T00:00:00Z",
            completedAt: "2026-11-21T00:00:05Z"
        )
        XCTAssertNil(
            ProactiveSchedulesSheetView.displayResultText(for: schedule, run: titleOnlyRun),
            "Redundant summaryText matching schedule title must not be repeated"
        )

        let budgetReason = try XCTUnwrap(ProactiveSchedulesSheetView.localizedFailureReason(for: "budget_exceeded"))
        XCTAssertFalse(budgetReason.contains("budget_exceeded"))
        let timeoutReason = try XCTUnwrap(ProactiveSchedulesSheetView.localizedFailureReason(for: "model_timeout"))
        XCTAssertFalse(timeoutReason.contains("model_timeout"))
        let unknownReason = try XCTUnwrap(ProactiveSchedulesSheetView.localizedFailureReason(for: "custom_code"))
        XCTAssertTrue(unknownReason.contains("custom_code"))
    }

    func testScheduleStoreTracksActiveCountInFlightRunsNextFireDateAndConflictError() async throws {
        let soonFireAt = Date().addingTimeInterval(45).ISO8601Format()
        let laterFireAt = Date().addingTimeInterval(180).ISO8601Format()
        let soonID = UUID()
        let laterID = UUID()
        let pausedID = UUID()

        let soon = ProactiveScheduleDTO(
            scheduleId: soonID,
            kind: .followUp,
            title: "Soon follow-up",
            prompt: "Check status",
            deliveryMode: .modelBrief,
            status: .active,
            scheduleKind: .once,
            timezone: "Asia/Shanghai",
            nextFireAt: soonFireAt,
            createdAt: "2026-11-21T00:00:00Z",
            updatedAt: "2026-11-21T00:00:00Z",
            latestRun: ProactiveScheduleRunDTO(
                occurrenceSeq: 1,
                taskId: UUID().uuidString.lowercased(),
                status: "running",
                scheduledFor: soonFireAt
            )
        )
        let later = ProactiveScheduleDTO(
            scheduleId: laterID,
            kind: .reminder,
            title: "Later reminder",
            prompt: "Call Alex",
            deliveryMode: .directReminder,
            status: .active,
            scheduleKind: .once,
            timezone: "Asia/Shanghai",
            nextFireAt: laterFireAt,
            createdAt: "2026-11-21T00:00:00Z",
            updatedAt: "2026-11-21T00:00:00Z"
        )
        let paused = ProactiveScheduleDTO(
            scheduleId: pausedID,
            kind: .brief,
            title: "Paused brief",
            prompt: "Brief",
            deliveryMode: .modelBrief,
            status: .paused,
            scheduleKind: .cronTZ,
            cronExpr: "0 8 * * *",
            timezone: "Asia/Shanghai",
            nextFireAt: Date().addingTimeInterval(10).ISO8601Format(),
            createdAt: "2026-11-21T00:00:00Z",
            updatedAt: "2026-11-21T00:00:00Z"
        )

        let store = ProactiveScheduleStore(repository: InMemoryProactiveScheduleRepository(items: [later, paused, soon]))
        await store.refresh()

        XCTAssertEqual(store.activeCount, 2)
        XCTAssertTrue(store.hasInFlightRun)
        XCTAssertEqual(
            store.nextActiveFireDate?.timeIntervalSince1970 ?? 0,
            ConversationCardFormatting.date(from: soonFireAt)?.timeIntervalSince1970 ?? -1,
            accuracy: 1.0
        )

        register { request in
            if request.httpMethod == "POST", request.url?.path.hasSuffix("/pause") == true {
                return .json(statusCode: 409, body: "{\"error\":{\"code\":\"CONFLICT\"}}")
            }
            return .json(statusCode: 404, body: "{}")
        }
        let liveStore = ProactiveScheduleStore(repository: try makeLiveRepository())
        await liveStore.pause(id: soonID)
        XCTAssertNotNil(liveStore.errorMessage)
        XCTAssertNotEqual(
            liveStore.errorMessage,
            String(localized: "schedules.error.unavailable", table: "Conversation")
        )
    }

    func testLiveHostArrivingScheduleAutoRefreshesVisibleChat() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-proactive-arrival-\(UUID().uuidString)", isDirectory: true)
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
        let scheduleRepo = LiveProactiveScheduleRepository(auth: auth)

        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let scheduleID = UUID().uuidString.lowercased()
        let arrivedMsgID = UUID().uuidString.lowercased()
        let dueISO = Date().addingTimeInterval(0.3).ISO8601Format()
        let listCalls = LockedCounter()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me" {
                return .json(statusCode: 200, body: AuthFixture.meJSON)
            }
            if request.httpMethod == "GET", path == "/v2/schedules" {
                let n = listCalls.increment()
                if n == 1 {
                    return .json(statusCode: 200, body: """
                    {
                      "schedules": [
                        {
                          "scheduleId": "\(scheduleID)",
                          "kind": "reminder",
                          "title": "Drink water",
                          "prompt": "Hydrate now",
                          "deliveryMode": "direct_reminder",
                          "status": "active",
                          "scheduleKind": "once",
                          "intervalSeconds": null,
                          "cronExpr": null,
                          "timezone": "Asia/Shanghai",
                          "misfirePolicy": "coalesce_latest",
                          "nextFireAt": "\(dueISO)",
                          "lastFiredAt": null,
                          "occurrenceCount": 0,
                          "version": 1,
                          "createdAt": "2026-11-21T00:00:00Z",
                          "updatedAt": "2026-11-21T00:00:00Z",
                          "latestRun": null
                        }
                      ]
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {
                  "schedules": [
                    {
                      "scheduleId": "\(scheduleID)",
                      "kind": "reminder",
                      "title": "Drink water",
                      "prompt": "Hydrate now",
                      "deliveryMode": "direct_reminder",
                      "status": "completed",
                      "scheduleKind": "once",
                      "intervalSeconds": null,
                      "cronExpr": null,
                      "timezone": "Asia/Shanghai",
                      "misfirePolicy": "coalesce_latest",
                      "nextFireAt": null,
                      "lastFiredAt": "\(dueISO)",
                      "occurrenceCount": 1,
                      "version": 2,
                      "createdAt": "2026-11-21T00:00:00Z",
                      "updatedAt": "\(dueISO)",
                      "latestRun": {
                        "occurrenceSeq": 1,
                        "taskId": "\(UUID().uuidString.lowercased())",
                        "status": "completed",
                        "summaryText": "Drink water",
                        "detailText": "Hydrate now",
                        "reasonCode": "ok",
                        "resultMessageId": "\(arrivedMsgID)",
                        "scheduledFor": "\(dueISO)",
                        "completedAt": "\(dueISO)"
                      }
                    }
                  ]
                }
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                let delivered = listCalls.current >= 2
                let messagesJSON = delivered
                    ? """
                    [{
                      "message_id": "\(arrivedMsgID)",
                      "sequence": 1,
                      "created_at": "2026-11-21T08:00:00Z",
                      "kind": "ember",
                      "text": "Reminder: Drink water\\n\\nHydrate now",
                      "model_label": "ember-proactive-scheduler",
                      "simulated": false
                    }]
                    """
                    : "[]"
                return .json(statusCode: 200, body: """
                {
                  "conversation_id": "\(conversationID)",
                  "transcript_epoch": 0,
                  "messages": \(messagesJSON),
                  "next_after": \(delivered ? 1 : 0),
                  "has_more": false
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let host = LiveConversationHostModel(
            repository: repo,
            auth: auth,
            scheduleRepository: scheduleRepo
        )
        defer { host.suspendForDisappearance() }
        host.handleScenePhase(.active)
        host.handleViewAppeared()
        await host.start()

        for _ in 0..<120 {
            let texts = host.screen.timeline.compactMap { entry -> String? in
                if case .message(let msg) = entry, msg.author == .ember { return msg.text }
                return nil
            }
            if texts.contains(where: { $0.contains("Reminder: Drink water") }) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        let arrivedTexts = host.screen.timeline.compactMap { entry -> String? in
            if case .message(let msg) = entry, msg.author == .ember { return msg.text }
            return nil
        }
        XCTAssertTrue(arrivedTexts.contains(where: { $0.contains("Reminder: Drink water") }))
        XCTAssertEqual(host.scheduleStore.schedules.first?.status, .completed)
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

    var current: Int {
        lock.withLock { count }
    }

    func increment() -> Int {
        lock.withLock {
            count += 1
            return count
        }
    }
}
