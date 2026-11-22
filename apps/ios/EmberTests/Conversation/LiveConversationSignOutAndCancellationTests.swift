import Foundation
import XCTest
@testable import Ember

private enum LiveTestJSON {
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

private final class FailingDeleteSessionStore: EmberSessionStore, @unchecked Sendable {
    private let underlying: InMemoryEmberSessionStore

    init(underlying: InMemoryEmberSessionStore) {
        self.underlying = underlying
    }

    func load() throws -> EmberSessionRecord? {
        try underlying.load()
    }

    func save(_ record: EmberSessionRecord) throws {
        try underlying.save(record)
    }

    func replace(_ record: EmberSessionRecord) throws {
        try underlying.replace(record)
    }

    func delete() throws {
        throw AuthError.keychainUnavailable
    }
}

@MainActor
final class LiveConversationSignOutAndCancellationTests: XCTestCase {
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
            from: Data(LiveTestJSON.receipt(
                pending.clientSubmissionID.uuidString.lowercased()).utf8))
        try await journal.accepted(receipt, for: pending, consumerID: AuthFixture.consumerID)
        return journal
    }

    func testSignOutSuccessClearsStateAndSurfacesSignIn() async throws {
        let setup = try make()
        register { _ in .json(statusCode: 200, body: LiveTestJSON.emptyPage) }

        let journal = LiveConversationJournal(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(repository: repository, auth: setup.auth)
        models.append(model)

        await model.start()
        XCTAssertFalse(model.requiresSignIn)
        XCTAssertNotNil(model.profile)

        await model.signOut()

        XCTAssertTrue(model.requiresSignIn, "Sign out must surface the sign-in entry")
        XCTAssertNil(model.profile, "Sign out must clear profile")
        XCTAssertNil(model.snapshot, "Sign out must clear conversation snapshot")
        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.command, .idle)
        XCTAssertEqual(model.status, String(localized: "conversation.live.signed_out", table: "Conversation"))

        // Keychain record must be removed
        XCTAssertNil(try setup.store.load())
    }

    func testSignOutRemoteUnconfirmedStillClearsStateAndSurfacesSignIn() async throws {
        let setup = try make { api in
            api.setLogoutResult(.failure(.transportFailure))
        }
        register { _ in .json(statusCode: 200, body: LiveTestJSON.emptyPage) }

        let journal = LiveConversationJournal(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(repository: repository, auth: setup.auth)
        models.append(model)

        await model.start()
        XCTAssertFalse(model.requiresSignIn)

        await model.signOut()

        XCTAssertTrue(model.requiresSignIn, "remoteUnconfirmed must still clear screen and surface sign-in")
        XCTAssertNil(model.profile)
        XCTAssertNil(model.snapshot)
        XCTAssertEqual(model.status, String(localized: "conversation.live.sign_out_unconfirmed", table: "Conversation"))

        // Local credential must still be deleted
        XCTAssertNil(try setup.store.load())
    }

    func testSignOutLocalCleanupFailedDoesNotClaimSuccessOrClearState() async throws {
        let inMemoryStore = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        let failingStore = FailingDeleteSessionStore(underlying: inMemoryStore)

        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL, client: EmberAPIClient(session: session))
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api, transport: transport,
            store: failingStore,
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-signout-fail-\(UUID().uuidString)", isDirectory: true)
        directories.append(directory)

        register { _ in .json(statusCode: 200, body: LiveTestJSON.emptyPage) }

        let journal = LiveConversationJournal(directory: directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth), journal: journal)
        let model = LiveConversationHostModel(repository: repository, auth: auth)
        models.append(model)

        await model.start()
        XCTAssertFalse(model.requiresSignIn)
        XCTAssertNotNil(model.profile)

        await model.signOut()

        XCTAssertFalse(model.requiresSignIn, "localCleanupFailed must not claim logout or surface sign-in")
        XCTAssertNotNil(model.profile, "profile must remain intact when local cleanup failed")
        XCTAssertEqual(model.status, String(localized: "conversation.live.sign_out_local_error", table: "Conversation"))
    }

    func testCancellationRacingInFlightPollDoesNotOverwriteCancelledUIState() async throws {
        let setup = try make()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" || path.contains("cancel") {
                return .json(statusCode: 200, body: LiveTestJSON.cancelledTurn)
            }
            if request.httpMethod == "GET" && path.contains("/turns/") {
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LiveTestJSON.runningTurn)
                stub.delayNanoseconds = 100_000_000 // 100ms in-flight delay
                return stub
            }
            return .json(statusCode: 200, body: LiveTestJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(repository: repository, auth: setup.auth)
        models.append(model)

        await model.start()
        XCTAssertEqual(model.reply, .generating)

        // Cancel while poll is in-flight
        await model.stop()

        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.status, String(localized: "conversation.live.turn_cancelled", table: "Conversation"))

        // Wait to verify late poll response does not overwrite cancelled state
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.status, String(localized: "conversation.live.turn_cancelled", table: "Conversation"))
    }

    func testSignOutRacingInFlightPollDoesNotRestorePreviousUserScreen() async throws {
        let setup = try make()
        let pollCount = Counter()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path.contains("/turns/") {
                pollCount.increment()
                if pollCount.value == 1 {
                    return .json(statusCode: 200, body: LiveTestJSON.runningTurn)
                }
                var stub = URLProtocolStubResponse.json(statusCode: 200, body: LiveTestJSON.completedTurn)
                stub.delayNanoseconds = 100_000_000
                return stub
            }
            return .json(statusCode: 200, body: LiveTestJSON.emptyPage)
        }

        let journal = try await seedActiveTurn(directory: setup.directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth), journal: journal)
        let model = LiveConversationHostModel(repository: repository, auth: setup.auth)
        models.append(model)

        await model.start()
        XCTAssertEqual(model.reply, .generating)

        // Sign out while poll is in-flight
        await model.signOut()

        XCTAssertTrue(model.requiresSignIn)
        XCTAssertNil(model.snapshot)
        XCTAssertNil(model.profile)

        // Wait to ensure late completed poll does not restore snapshot
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(model.requiresSignIn)
        XCTAssertNil(model.snapshot, "Late poll must never restore snapshot after logout")
        XCTAssertNil(model.profile)
    }

    private func make(
        configure: (FakeEmberSessionAPI) -> Void = { _ in }
    ) throws -> (auth: LiveAuthSessionCoordinator, store: InMemoryEmberSessionStore, directory: URL) {
        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        configure(api)
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL, client: EmberAPIClient(session: session))
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ember-signout-test-\(UUID().uuidString)", isDirectory: true)
        directories.append(directory)
        let journal = LiveConversationJournal(directory: directory)
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api, transport: transport,
            store: store,
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            signOutCleanupHooks: [{ try? await journal.reset() }],
            now: { AuthFixture.epoch }
        ))
        return (auth, store, directory)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}
