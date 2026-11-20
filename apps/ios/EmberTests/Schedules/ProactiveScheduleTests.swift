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
