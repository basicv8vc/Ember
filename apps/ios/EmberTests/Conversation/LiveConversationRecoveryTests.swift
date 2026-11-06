import Foundation
import XCTest
@testable import Ember

private enum LiveRecoveryJSON {
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

private final class LiveRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var postIDs: [String] = []
    private var receiptLookups = 0
    private var bootstrapReads = 0

    func recordPOST(_ request: URLRequest) {
        let data = request.httpBody ?? Data()
        let dictionary = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        lock.withLock { postIDs.append(dictionary?["client_submission_id"] as? String ?? "") }
    }

    func recordLookup() { lock.withLock { receiptLookups += 1 } }
    func recordPage() { lock.withLock { bootstrapReads += 1 } }

    var sentIDs: [String] { lock.withLock { postIDs } }
    var lookups: Int { lock.withLock { receiptLookups } }
    var pages: Int { lock.withLock { bootstrapReads } }
}

/// Exercise real URLProtocol transport with a persistent journal and an L1 session coordinator.
/// The second repository is a cold-launch stand-in: it has no first instance's actor state.
@MainActor
final class LiveConversationRecoveryTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []
    private var directories: [URL] = []

    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        sessions.removeAll()
        registrations.removeAll()
        directories.removeAll()
        try await super.tearDown()
    }

    func testUnknownACKThenReceiptFoundOnRelaunchNeverPostsTwice() async throws {
        let capture = LiveRequestCapture()
        let setup = try make()
        register { request in
            let path = request.url?.path ?? ""
            if path.contains("/message-submissions/") {
                capture.recordLookup()
                let id = request.url?.lastPathComponent ?? ""
                return .json(statusCode: 200, body: LiveRecoveryJSON.receipt(id))
            }
            if request.httpMethod == "POST" {
                capture.recordPOST(request)
                return .failure(URLError(.timedOut))
            }
            capture.recordPage()
            return .json(statusCode: 200, body: LiveRecoveryJSON.emptyPage)
        }

        let first = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        _ = try await first.bootstrap()
        do {
            _ = try await first.send(text: "hello")
            XCTFail("expected unknown acknowledgement")
        } catch let error as LiveB1Failure {
            XCTAssertEqual(error, .unknownAcknowledgement)
        }

        let persisted = try await first.pending()
        let savedID = try XCTUnwrap(persisted?.clientSubmissionID)
        XCTAssertEqual(capture.sentIDs, [savedID.uuidString.lowercased()])

        let second = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        let recovered = try await second.reconcilePending()
        XCTAssertEqual(recovered?.clientSubmissionID, savedID)
        let remaining = try await second.pending()
        let active = try await second.activeTurn()
        XCTAssertNil(remaining)
        XCTAssertEqual(active?.turnID,
                       UUID(uuidString: "88888888-8888-4888-8888-888888888888"))
        XCTAssertEqual(capture.sentIDs, [savedID.uuidString.lowercased()])
        XCTAssertEqual(capture.lookups, 1)
    }

    func testUnknownACKLookup404RepostsSameImmutableID() async throws {
        let capture = LiveRequestCapture()
        let setup = try make()
        register { request in
            let path = request.url?.path ?? ""
            if path.contains("/message-submissions/") {
                capture.recordLookup()
                return .json(statusCode: 404, body: "{}")
            }
            if request.httpMethod == "POST" {
                capture.recordPOST(request)
                if capture.sentIDs.count == 1 { return .failure(URLError(.networkConnectionLost)) }
                return .json(statusCode: 200,
                             body: LiveRecoveryJSON.receipt(capture.sentIDs.last ?? ""))
            }
            return .json(statusCode: 200, body: LiveRecoveryJSON.emptyPage)
        }

        let first = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        _ = try await first.bootstrap()
        do { _ = try await first.send(text: "hello") }
        catch { XCTAssertEqual(error as? LiveB1Failure, .unknownAcknowledgement) }

        let second = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        _ = try await second.reconcilePending()
        XCTAssertEqual(capture.sentIDs.count, 2)
        XCTAssertEqual(capture.sentIDs[0], capture.sentIDs[1])
        XCTAssertEqual(capture.lookups, 1)
        let pending = try await second.pending()
        XCTAssertNil(pending)
    }

    func testTranscriptEpochChangeDiscardsOldIntentWithoutReplay() async throws {
        let capture = LiveRequestCapture()
        let setup = try make(configure: { api in
            api.setBootstrapResults([
                .success(AuthFixture.me(transcriptEpoch: 0)),
                .success(AuthFixture.me(transcriptEpoch: 1)),
            ])
        })
        register { request in
            if request.url?.path.contains("/message-submissions/") == true {
                capture.recordLookup()
                return .json(statusCode: 404, body: "{}")
            }
            capture.recordPOST(request)
            return .failure(URLError(.timedOut))
        }

        let first = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        _ = try await first.bootstrap()
        do { _ = try await first.send(text: "hello") }
        catch { XCTAssertEqual(error as? LiveB1Failure, .unknownAcknowledgement) }

        let second = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        do {
            _ = try await second.reconcilePending()
            XCTFail("must reject a pending send from the deleted transcript epoch")
        } catch let error as LiveB1Failure {
            XCTAssertEqual(error, .staleEpoch)
        }
        XCTAssertEqual(capture.sentIDs.count, 1)
        XCTAssertEqual(capture.lookups, 0)
        let remaining = try await second.pending()
        XCTAssertNil(remaining)
    }

    func testTerminal409DoesNotAutoRepostAfterRelaunchEvenWhenReceiptIs404() async throws {
        let capture = LiveRequestCapture()
        let setup = try make()
        register { request in
            if request.url?.path.contains("/message-submissions/") == true {
                capture.recordLookup()
                return .json(statusCode: 404, body: "{}")
            }
            if request.httpMethod == "POST" {
                capture.recordPOST(request)
                return .json(statusCode: 409, body: "{}")
            }
            return .json(statusCode: 200, body: LiveRecoveryJSON.emptyPage)
        }

        let first = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        _ = try await first.bootstrap()
        do {
            _ = try await first.send(text: "hello")
            XCTFail("409 must be terminal")
        } catch let error as LiveB1Failure {
            XCTAssertEqual(error, .conflict)
        }
        let rejected = try await first.rejectedDraft()
        let original = try XCTUnwrap(rejected)
        XCTAssertEqual(original.text, "hello")
        XCTAssertEqual(capture.sentIDs.count, 1)

        // The backend returns 404 for this original ID, but that cannot reopen
        // the terminal 409. A fresh launch must never auto POST.
        let lookup = try await LiveB1ConversationClient(auth: setup.auth)
            .lookup(original.clientSubmissionID)
        XCTAssertNil(lookup)

        let relaunched = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        let resolved = try await relaunched.reconcilePending()
        XCTAssertNil(resolved)
        let restored = try await relaunched.recoverAfterRelaunch()
        XCTAssertTrue(restored.messages.isEmpty)
        let pending = try await relaunched.pending()
        let draft = try await relaunched.rejectedDraft()
        XCTAssertNil(pending)
        XCTAssertEqual(draft?.clientSubmissionID, original.clientSubmissionID)
        XCTAssertEqual(capture.sentIDs.count, 1, "409 cannot cause automatic replay")
        XCTAssertEqual(capture.lookups, 1, "startup must not reconcile terminal 409")
    }

    func testOfflineBootstrapDoesNotGenerateMockReplyOrSend() async throws {
        let setup = try make(configure: { api in
            api.setBootstrapResults([.failure(.offline)])
        })
        let capture = LiveRequestCapture()
        register { request in
            capture.recordPOST(request)
            return .json(statusCode: 200, body: LiveRecoveryJSON.emptyPage)
        }
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: setup.auth),
            journal: LiveConversationJournal(directory: setup.directory))
        do {
            _ = try await repository.load()
            XCTFail("offline Cloud load must not succeed from Mock data")
        } catch let error as AuthError {
            XCTAssertEqual(error, .offline)
        }
        XCTAssertTrue(capture.sentIDs.isEmpty)
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
            .appendingPathComponent("ember-l2-recovery-\(UUID().uuidString)", isDirectory: true)
        directories.append(directory)
        return (auth, directory)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}
