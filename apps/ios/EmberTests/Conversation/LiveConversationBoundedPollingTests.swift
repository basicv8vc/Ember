import Foundation
import XCTest
@testable import Ember

private enum LivePollingJSON {
    static let runningTurn = """
        {
          "turn_id":"88888888-8888-4888-8888-888888888888",
          "conversation_id":"44444444-4444-4444-8444-444444444444",
          "source_message_id":"55555555-5555-4555-8555-555555555555",
          "status":"running",
          "created_at":"2026-11-06T00:00:01Z",
          "updated_at":"2026-11-06T00:00:02Z"
        }
        """

    static let completedTurn = """
        {
          "turn_id":"88888888-8888-4888-8888-888888888888",
          "conversation_id":"44444444-4444-4444-8444-444444444444",
          "source_message_id":"55555555-5555-4555-8555-555555555555",
          "response_message_id":"66666666-6666-4666-8666-666666666666",
          "status":"completed",
          "created_at":"2026-11-06T00:00:01Z",
          "updated_at":"2026-11-06T00:00:05Z"
        }
        """

    static let cancelledTurn = """
        {
          "turn_id":"88888888-8888-4888-8888-888888888888",
          "conversation_id":"44444444-4444-4444-8444-444444444444",
          "source_message_id":"55555555-5555-4555-8555-555555555555",
          "status":"cancelled",
          "created_at":"2026-11-06T00:00:01Z",
          "updated_at":"2026-11-06T00:00:03Z"
        }
        """

    static func receipt(_ id: String, epoch: Int = 0) -> String {
        """
        {
          "message":{
            "message_id":"55555555-5555-4555-8555-555555555555",
            "conversation_id":"44444444-4444-4444-8444-444444444444",
            "sequence":6, "created_at":"2026-11-06T00:00:00Z", "kind":"user",
            "text":"hello","client_submission_id":"\(id)"
          },
          "turn":{"turn_id":"88888888-8888-4888-8888-888888888888",
                  "status":"running","created_at":"2026-11-06T00:00:01Z"},
          "transcript_epoch":\(epoch)
        }
        """
    }

    static let emptyPage = """
        {
          "conversation_id":"44444444-4444-4444-8444-444444444444",
          "transcript_epoch":0,"messages":[],"next_after":0,"has_more":false
        }
        """
}

private final class TestMonotonicClock: @unchecked Sendable {
    private let lock = NSLock()
    private var base = ContinuousClock.now
    private var offset: Duration = .zero

    func now() -> ContinuousClock.Instant {
        lock.withLock { base.advanced(by: offset) }
    }

    func advance(by duration: Duration) {
        lock.withLock { offset = offset + duration }
    }
}

private final class NetworkConcurrencyTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var inFlight = 0
    private var maxInFlight = 0
    private var totalRequests = 0

    func enter() {
        lock.withLock {
            inFlight += 1
            maxInFlight = max(maxInFlight, inFlight)
            totalRequests += 1
        }
    }

    func exit() {
        lock.withLock {
            inFlight -= 1
        }
    }

    var maximumConcurrent: Int {
        lock.withLock { maxInFlight }
    }

    var currentInFlight: Int {
        lock.withLock { inFlight }
    }

    var total: Int {
        lock.withLock { totalRequests }
    }
}

private final class TestRequestBarrier: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var isBlocked = false
    private var waitingCount = 0

    func block() {
        lock.withLock { isBlocked = true }
    }

    func waitIfBlocked() async {
        let shouldWait: Bool = lock.withLock {
            if isBlocked {
                waitingCount += 1
                return true
            }
            return false
        }
        guard shouldWait else { return }
        await withCheckedContinuation { cont in
            lock.withLock {
                continuations.append(cont)
            }
        }
    }

    func release() {
        let toResume: [CheckedContinuation<Void, Never>] = lock.withLock {
            isBlocked = false
            let saved = continuations
            continuations.removeAll()
            return saved
        }
        toResume.forEach { $0.resume() }
    }

    var isWaiting: Bool {
        lock.withLock { waitingCount > 0 }
    }
}

private final class TestTurnStatus: @unchecked Sendable {
    private let lock = NSLock()
    private var status: String

    init(_ status: String) {
        self.status = status
    }

    func set(_ status: String) {
        lock.withLock { self.status = status }
    }

    func get() -> String {
        lock.withLock { status }
    }
}

@MainActor
final class LiveConversationBoundedPollingTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []
    private var directories: [URL] = []
    private var models: [LiveConversationHostModel] = []

    override func tearDown() async throws {
        for model in models {
            model.suspendForDisappearance()
        }
        models.removeAll()
        try await Task.sleep(nanoseconds: 50_000_000)

        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        sessions.removeAll()
        registrations.removeAll()
        directories.removeAll()
        try await super.tearDown()
    }

    private func seedActiveTurn(directory: URL) async throws -> LiveConversationJournal {
        let journal = LiveConversationJournal(directory: directory)
        try await journal.bind(consumerID: AuthFixture.consumerID)
        let pending = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(uuidString: "77777777-7777-4777-8777-777777777777")!,
            conversationID: AuthFixture.conversationID,
            transcriptEpoch: 0,
            text: "hello"
        )
        try await journal.prepare(pending, consumerID: AuthFixture.consumerID)
        let receipt = try JSONDecoder().decode(
            LiveB1Receipt.self,
            from: Data(LivePollingJSON.receipt(
                pending.clientSubmissionID.uuidString.lowercased()).utf8))
        try await journal.accepted(receipt, for: pending, consumerID: AuthFixture.consumerID)
        return journal
    }

    func testPollingAutomaticallyPausesAfterMonotonicWindowAndShowsWaiting() async throws {
        let setup = try make()
        let tracker = NetworkConcurrencyTracker()
        let clock = TestMonotonicClock()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(5),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()

        // Initially in generating state and polling
        XCTAssertEqual(model.reply, .generating)
        XCTAssertFalse(model.isPollingPaused)

        // Advance monotonic clock past the 5-second polling window
        clock.advance(by: .seconds(6))

        // Wait for loop to observe monotonic deadline
        for _ in 0..<60 {
            if model.isPollingPaused { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertTrue(model.isPollingPaused)
        XCTAssertEqual(model.reply, .generating, "UI must continue to show waiting (generating), NOT failure")
        XCTAssertEqual(model.status, "Still waiting for Ember Cloud.")
        XCTAssertEqual(model.screen.replyState, .generating)

        let requestsWhenPaused = tracker.total

        // Wait to verify no additional requests are made while paused
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(tracker.total, requestsWhenPaused, "Polling network requests must cease while paused")
        XCTAssertLessThanOrEqual(tracker.maximumConcurrent, 1, "There must never be concurrent in-flight poll requests")
    }

    func testManualResumeCheckRestartsPollingWindow() async throws {
        let setup = try make()
        let clock = TestMonotonicClock()
        let turnStatus = TestTurnStatus(LivePollingJSON.runningTurn)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                return .json(statusCode: 200, body: turnStatus.get())
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(5),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()
        clock.advance(by: .seconds(6))

        for _ in 0..<60 {
            if model.isPollingPaused { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(model.isPollingPaused)

        // Turn completes on server
        turnStatus.set(LivePollingJSON.completedTurn)

        // User taps "Check again" (resumePolling)
        model.resumePolling()
        XCTAssertFalse(model.isPollingPaused)

        for _ in 0..<60 {
            if model.reply == .idle { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.status, "Completed by Ember Cloud.")
        XCTAssertFalse(model.isPollingPaused)
    }

    func testCancellingTurnWhilePollingPaused() async throws {
        let setup = try make()
        let clock = TestMonotonicClock()
        let tracker = NetworkConcurrencyTracker()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" || path.contains("cancel") {
                return .json(statusCode: 200, body: LivePollingJSON.cancelledTurn)
            }
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(5),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()

        // Advance monotonic clock past the 5-second polling window
        clock.advance(by: .seconds(6))

        for _ in 0..<60 {
            if model.isPollingPaused { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(model.isPollingPaused)

        // Cancel turn while paused
        await model.stop()

        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.status, "Turn cancelled on Ember Cloud.")
        XCTAssertFalse(model.isPollingPaused)
    }

    func testLifecycleSceneInactiveAndBackgroundPausesPolling() async throws {
        let setup = try make()
        let tracker = NetworkConcurrencyTracker()
        let clock = TestMonotonicClock()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(30),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()
        XCTAssertEqual(model.reply, .generating)

        // Scene transitions to inactive (e.g. app switcher, incoming call, notification shade)
        model.handleScenePhase(.inactive)
        XCTAssertFalse(model.isSceneActive)

        let requestsAtInactive = tracker.total
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(tracker.total, requestsAtInactive, "Polling must cease immediately in .inactive state")

        // Returning to active restores polling because view is still visible
        model.handleScenePhase(.active)
        XCTAssertTrue(model.isSceneActive)

        // Verify request resumed
        for _ in 0..<30 {
            if tracker.total > requestsAtInactive { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertGreaterThan(tracker.total, requestsAtInactive, "Returning to .active must resume foreground polling")
    }

    func testViewDisappearanceBlocksSceneActiveFromResumingPolling() async throws {
        let setup = try make()
        let tracker = NetworkConcurrencyTracker()
        let clock = TestMonotonicClock()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(30),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()
        XCTAssertEqual(model.reply, .generating)

        // User navigates away: onDisappear fires
        model.handleViewDisappeared()
        XCTAssertFalse(model.isViewVisible)

        let countAtDisappear = tracker.total
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(tracker.total, countAtDisappear)

        // App transitions from background to active while user is elsewhere
        model.handleScenePhase(.active)
        XCTAssertTrue(model.isSceneActive)
        XCTAssertFalse(model.isViewVisible)

        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(tracker.total, countAtDisappear, "Scene activation must NOT start polling if view is not visible")

        // When user navigates back: onAppear fires
        model.handleViewAppeared()
        XCTAssertTrue(model.isViewVisible)

        for _ in 0..<30 {
            if tracker.total > countAtDisappear { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertGreaterThan(tracker.total, countAtDisappear, "View re-appearance must resume polling")
    }

    func testViewAppearsWhileSceneIsInactiveDoesNotPollUntilActive() async throws {
        let setup = try make()
        let tracker = NetworkConcurrencyTracker()
        let clock = TestMonotonicClock()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(30),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        // View appears while scene is already .inactive (e.g. opened under system prompt / alert)
        model.handleScenePhase(.inactive)
        model.handleViewAppeared()
        await model.start()

        XCTAssertTrue(model.isViewVisible)
        XCTAssertFalse(model.isSceneActive)
        XCTAssertEqual(model.reply, .generating)

        let initialReconcileCount = tracker.total
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(tracker.total, initialReconcileCount, "No subsequent foreground polling loop requests should be issued while scene is .inactive")

        // Now scene transitions to .active
        model.handleScenePhase(.active)
        XCTAssertTrue(model.isSceneActive)

        for _ in 0..<30 {
            if tracker.total > initialReconcileCount { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertGreaterThan(tracker.total, initialReconcileCount, "Polling must start when scene becomes .active")
        XCTAssertLessThanOrEqual(tracker.maximumConcurrent, 1)
    }

    func testControllableBarrierAndLateResponseNeverOverwritesOrCreatesConcurrency() async throws {
        let setup = try make()
        let tracker = NetworkConcurrencyTracker()
        let barrier = TestRequestBarrier()
        let clock = TestMonotonicClock()
        let blockPolls = TestTurnStatus("no")

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" || path.contains("cancel") {
                return .json(statusCode: 200, body: LivePollingJSON.cancelledTurn)
            }
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                if blockPolls.get() == "yes" {
                    stub.requestBarrier = { await barrier.waitIfBlocked() }
                }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(30),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()

        // Now activate the barrier for the next poll
        barrier.block()
        blockPolls.set("yes")
        model.resumePolling()

        // Wait until poll request is confirmed in-flight in URLSession on the barrier
        for _ in 0..<60 {
            if tracker.currentInFlight > 0 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(tracker.currentInFlight, 1, "The poll request must be actively in-flight on the network")

        // Cancel while poll is in-flight on the barrier
        let cancelTask = Task { await model.stop() }
        barrier.release()
        _ = await cancelTask.value

        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.status, "Turn cancelled on Ember Cloud.")
        XCTAssertLessThanOrEqual(tracker.maximumConcurrent, 1, "Concurrency must remain strictly <= 1 even with barrier-held responses")

        // Wait to verify late running response did not resurrect generating state
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(model.reply, .idle, "Late response from cancelled poll must never overwrite cancelled state")
    }

    func testRapidPollingTriggersProduceNoConcurrentNetworkRequests() async throws {
        let setup = try make()
        let tracker = NetworkConcurrencyTracker()
        let clock = TestMonotonicClock()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.runningTurn)
                stub.delayNanoseconds = 50_000_000 // 50ms async delay
                stub.onStartLoading = { tracker.enter() }
                stub.onFinishLoading = { tracker.exit() }
                return stub
            }
            return .json(statusCode: 200, body: LivePollingJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(
            repository: repository,
            auth: setup.auth,
            pollingWindow: .seconds(30),
            monotonicNow: { clock.now() }
        )
        models.append(model)

        model.handleViewAppeared()
        await model.start()

        // Rapidly invoke resume and scene activation concurrently
        for _ in 0..<5 {
            model.resumePolling()
            model.handleSceneActive()
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertLessThanOrEqual(tracker.maximumConcurrent, 1, "Rapid triggers must never produce concurrent network requests")
    }

    func testConcurrencyTrackerReportsOverlapWhenConcurrentRequestsAreDeliberatelyMade() async throws {
        let tracker = NetworkConcurrencyTracker()
        let barrier = TestRequestBarrier()
        barrier.block()

        register { request in
            var stub = URLProtocolStubResponse.json(statusCode: 200, body: LivePollingJSON.emptyPage)
            stub.onStartLoading = { tracker.enter() }
            stub.onFinishLoading = { tracker.exit() }
            stub.requestBarrier = { await barrier.waitIfBlocked() }
            return stub
        }

        let session = StubSession.make()
        sessions.append(session)

        let url = URL(string: "https://\(AuthFixture.baseURL.host!)/deliberate-concurrent-test")!
        async let req1 = session.data(from: url)
        async let req2 = session.data(from: url)

        // Wait until both requests are simultaneously in-flight in URLSession
        for _ in 0..<30 {
            if tracker.currentInFlight == 2 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(tracker.currentInFlight, 2, "Tracker must observe 2 overlapping requests in flight")
        XCTAssertEqual(tracker.maximumConcurrent, 2, "Peak concurrency must accurately report 2")

        barrier.release()
        _ = try await (req1, req2)
        XCTAssertEqual(tracker.currentInFlight, 0)
    }

    private func make(
        configure: (FakeEmberSessionAPI) -> Void = { _ in }
    ) throws -> (auth: LiveAuthSessionCoordinator, directory: URL) {
        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        configure(api)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL, client: EmberAPIClient(session: session))
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api, transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-bounded-polling-\(UUID().uuidString)", isDirectory: true)
        directories.append(directory)
        return (auth, directory)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}
