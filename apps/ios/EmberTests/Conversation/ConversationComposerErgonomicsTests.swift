import SwiftUI
import UIKit
import XCTest
@testable import Ember

@MainActor
final class ConversationComposerErgonomicsTests: XCTestCase {
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

    func testTriggerStopDeduplicatesRapidTapsAndLeavesDraftUntouchedInMockHost() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let model = ConversationHostModel(
            repository: repository,
            replyDelayNanoseconds: 5_000_000_000
        )
        await model.load()

        await model.send("Start a slow mock reply")
        XCTAssertEqual(model.replyState, .generating)
        XCTAssertFalse(model.isSubmitting)
        XCTAssertFalse(model.isStoppingReply)

        // Rapid double-tap on Stop must execute only once and stop the reply cleanly.
        model.triggerStopReply()
        XCTAssertTrue(model.isStoppingReply)
        model.triggerStopReply()

        for _ in 0..<40 {
            if !model.isStoppingReply, model.replyState == .idle { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        XCTAssertEqual(model.replyState, .idle)
        XCTAssertFalse(model.isStoppingReply)
        let snapshot = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        let stopActivities = snapshot.messages.filter {
            if case .activity(let activity) = $0.kind {
                return activity.text.contains("No Ember task was cancelled")
            }
            return false
        }
        XCTAssertEqual(stopActivities.count, 1)
    }

    func testLiveHostTriggerStopDeduplicatesRapidCancelRequests() async throws {
        let setup = try makeLiveAuth()
        let cancelCount = LockedCounter()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" || path.contains("cancel") {
                cancelCount.increment()
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: """
                {
                  "turn_id":"88888888-8888-4888-8888-888888888888",
                  "conversation_id":"\(conversationID)",
                  "source_message_id":"55555555-5555-4555-8555-555555555555",
                  "status":"cancelled",
                  "created_at":"2026-11-06T00:00:01Z",
                  "updated_at":"2026-11-06T00:00:03Z"
                }
                """)
                stub.delayNanoseconds = 120_000_000
                return stub
            }
            if request.httpMethod == "GET", path.contains("/turns/") {
                return .json(statusCode: 200, body: """
                {
                  "turn_id":"88888888-8888-4888-8888-888888888888",
                  "conversation_id":"\(conversationID)",
                  "source_message_id":"55555555-5555-4555-8555-555555555555",
                  "status":"running",
                  "created_at":"2026-11-06T00:00:01Z",
                  "updated_at":"2026-11-06T00:00:02Z"
                }
                """)
            }
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            return .json(statusCode: 200, body: """
            {
              "conversation_id":"\(conversationID)",
              "transcript_epoch":0,"messages":[],"next_after":0,"has_more":false
            }
            """)
        }

        let journal = LiveConversationJournal(directory: setup.directory)
        try await journal.bind(consumerID: AuthFixture.consumerID)
        let pending = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(uuidString: "77777777-7777-4777-8777-777777777777")!,
            conversationID: AuthFixture.conversationID,
            transcriptEpoch: 0,
            text: "hello"
        )
        try await journal.prepare(pending, consumerID: AuthFixture.consumerID)
        let receiptJSON = """
        {
          "message":{
            "message_id":"55555555-5555-4555-8555-555555555555",
            "conversation_id":"\(conversationID)",
            "sequence":6, "created_at":"2026-11-06T00:00:00Z", "kind":"user",
            "text":"hello","client_submission_id":"77777777-7777-4777-8777-777777777777"
          },
          "turn":{"turn_id":"88888888-8888-4888-8888-888888888888",
                  "status":"running","created_at":"2026-11-06T00:00:01Z"},
          "transcript_epoch":0
        }
        """
        let receipt = try JSONDecoder().decode(LiveB1Receipt.self, from: Data(receiptJSON.utf8))
        try await journal.accepted(receipt, for: pending, consumerID: AuthFixture.consumerID)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: journal
        )
        let model = LiveConversationHostModel(repository: repository, auth: setup.auth)
        models.append(model)

        await model.start()
        XCTAssertEqual(model.reply, .generating)
        XCTAssertFalse(model.isStopping)

        model.triggerStop()
        XCTAssertTrue(model.isStopping)
        XCTAssertTrue(model.screen.isStopping)
        model.triggerStop()
        model.triggerStop()

        for _ in 0..<50 {
            if !model.isStopping, model.reply == .idle { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        XCTAssertEqual(cancelCount.value, 1, "Rapid Stop taps must issue only one cancelActiveTurn request")
        XCTAssertEqual(model.reply, .idle)
        XCTAssertFalse(model.isStopping)
        XCTAssertFalse(model.screen.isStopping)
    }

    func testHostedComposerWithAttachmentChipsAndEmptyStateRendersWithin320ptViewport() throws {
        let attachmentID = UUID(uuidString: "00000000-0000-4000-8000-00000000c101")!
        let attachment = ComposerAttachment(
            id: attachmentID,
            filename: "q4-launch-risks-and-metrics-summary.csv",
            mediaType: "text/csv",
            sizeBytes: 24_576
        )
        let emptyState = ConversationScreenState(
            timeline: [],
            replyState: .idle,
            attachments: [attachment]
        )

        let harness = HostedComposerHarnessView(initialState: emptyState, initialDraft: "Draft")
        let controller = UIHostingController(rootView: harness)
        let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene
        let window = windowScene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 568)
        controller.view.frame = window.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let fittedSize = controller.sizeThatFits(in: CGSize(width: 320, height: 568))
        XCTAssertLessThanOrEqual(fittedSize.width, 320)
        XCTAssertGreaterThan(fittedSize.height, 0)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(controller.view.bounds.width, 320)
    }

    private func makeLiveAuth() throws -> (auth: LiveAuthSessionCoordinator, directory: URL) {
        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-composer-test-\(UUID().uuidString)", isDirectory: true)
        directories.append(directory)
        let journal = LiveConversationJournal(directory: directory)
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api,
            transport: transport,
            store: store,
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            signOutCleanupHooks: [{ try? await journal.reset() }],
            now: { AuthFixture.epoch }
        ))
        return (auth, directory)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

private struct HostedComposerHarnessView: View {
    @State var state: ConversationScreenState
    @State var draft: String

    init(initialState: ConversationScreenState, initialDraft: String) {
        _state = State(initialValue: initialState)
        _draft = State(initialValue: initialDraft)
    }

    var body: some View {
        ConversationScreen(
            state: state,
            draft: $draft,
            actions: ConversationScreenActions(
                send: { _ in },
                retry: {},
                stopGenerating: { state.replyState = .idle },
                selectPrompt: { draft = $0 },
                onPickAttachment: {},
                onRemoveAttachment: { id in
                    state.attachments.removeAll { $0.id == id }
                }
            )
        )
    }
}
