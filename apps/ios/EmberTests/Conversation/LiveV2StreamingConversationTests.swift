import Foundation
import XCTest
@testable import Ember

@MainActor
final class LiveV2StreamingConversationTests: XCTestCase {
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

    func testSSEStreamDeliversDeltasAndCommitsAuthoritativeMessageWithLatencyMetrics() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888888111"
        let userMessageID = "55555555-5555-4555-8555-555555555111"
        let assistantMessageID = "77777777-7777-4777-8777-777777777111"
        let streamRequestHeaders = LockedBox<(accept: String?, idempotency: String?, path: String?)>((nil, nil, nil))
        let hasCommitted = LockedFlag(false)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if hasCommitted.value {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Hello Ember","client_submission_id":"66666666-6666-4666-8666-666666666111"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-22T01:00:01Z","kind":"ember","text":"Hello Founder!","model_label":"deepseek-v4.1-flash","simulated":false}
                      ],
                      "next_after":2,
                      "has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(conversationID)",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,
                  "has_more":false
                }
                """)
            }
            if request.httpMethod == "POST", path == "/v2/conversations/\(conversationID)/messages/stream" {
                streamRequestHeaders.set((
                    accept: request.value(forHTTPHeaderField: "Accept"),
                    idempotency: request.value(forHTTPHeaderField: "Idempotency-Key"),
                    path: path
                ))
                let body = request.httpBody ?? Data()
                let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? "66666666-6666-4666-8666-666666666111"
                hasCommitted.value = true

                let sse = """
                : heartbeat

                event: turn.accepted
                data: {"message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Hello Ember","client_submission_id":"\(clientID)"},"turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-22T01:00:00Z"},"transcript_epoch":0}

                event: turn.delta
                data: {"turn_id":"\(turnID)","text":"Hello "}

                event: turn.delta
                data: {"turn_id":"\(turnID)","text":"Founder!"}

                event: turn.committed
                data: {"turn":{"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","status":"completed","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:01Z","response_message_id":"\(assistantMessageID)","failure_reason":null},"response_message_id":"\(assistantMessageID)","sequence":2}
                """ + "\n\n"
                return URLProtocolStubResponse(
                    statusCode: 201,
                    headers: ["Content-Type": "text/event-stream; charset=utf-8"],
                    body: Data(sse.utf8)
                )
            }
            return .json(statusCode: 404, body: "{}")
        }

        let setup = try makeRepository(directory: directory, supportsStreaming: true)
        let model = LiveConversationHostModel(
            repository: setup.repo,
            auth: setup.auth,
            taskRepository: setup.taskRepo
        )
        models.append(model)

        await model.start()
        await model.send("Hello Ember")

        for _ in 0..<80 {
            if model.reply == .idle, model.lastTurnMetrics != nil { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        let headers = streamRequestHeaders.value
        XCTAssertEqual(headers.path, "/v2/conversations/\(conversationID)/messages/stream")
        XCTAssertEqual(headers.accept, "text/event-stream")
        XCTAssertNil(headers.idempotency)

        XCTAssertEqual(model.reply, .idle)
        XCTAssertNil(model.streamingReplyText)
        XCTAssertEqual(model.lastTurnMetrics?.mode, "sse")
        XCTAssertEqual(model.lastTurnMetrics?.deltaCount, 2)
        XCTAssertNotNil(model.lastTurnMetrics?.ttftMs)
        let activeTurn = try await setup.repo.activeTurn()
        XCTAssertNil(activeTurn)

        let texts = model.screen.timeline.compactMap { entry -> String? in
            if case .message(let msg) = entry { return msg.text }
            return nil
        }
        XCTAssertEqual(texts, ["Hello Ember", "Hello Founder!"])
    }

    func testSSE404FallsBackCleanlyToB1DurablePostWithSameSubmissionID() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888888222"
        let userMessageID = "55555555-5555-4555-8555-555555555222"
        let assistantMessageID = "77777777-7777-4777-8777-777777777222"
        let postedIDs = LockedStrings()
        let turnFinished = LockedFlag(false)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if turnFinished.value {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Fallback test","client_submission_id":"\(postedIDs.values.first ?? "66666666-6666-4666-8666-666666666222")"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-22T01:00:01Z","kind":"ember","text":"Handled by B1","model_label":"fake-responder","simulated":true}
                      ],
                      "next_after":2,"has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            if request.httpMethod == "POST", path == "/v2/conversations/\(conversationID)/messages/stream" {
                if let body = request.httpBody,
                   let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                   let id = obj["client_submission_id"] as? String {
                    postedIDs.append(id)
                }
                return .json(statusCode: 404, body: "{}")
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                let body = request.httpBody ?? Data()
                let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? ""
                postedIDs.append(clientID)
                turnFinished.value = true
                return .json(statusCode: 201, body: """
                {
                  "message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Fallback test","client_submission_id":"\(clientID)"},
                  "turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-22T01:00:00Z"},
                  "transcript_epoch":0
                }
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/turns/\(turnID)" {
                return .json(statusCode: 200, body: """
                {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","response_message_id":"\(assistantMessageID)","status":"completed","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:01Z"}
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let setup = try makeRepository(directory: directory, supportsStreaming: true)
        let model = LiveConversationHostModel(
            repository: setup.repo,
            auth: setup.auth,
            taskRepository: setup.taskRepo
        )
        models.append(model)
        model.handleScenePhase(.active)
        model.handleViewAppeared()
        await model.start()
        await model.send("Fallback test")

        for _ in 0..<80 {
            if model.reply == .idle, model.lastTurnMetrics?.mode == "poll" { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(postedIDs.values.count, 2)
        XCTAssertEqual(postedIDs.values.first, postedIDs.values.last)
        XCTAssertEqual(model.lastTurnMetrics?.mode, "poll")
        XCTAssertEqual(model.reply, .idle)
    }

    func testSSEHandedOffTransitionsToDurablePollingAndRecoversCompletedReply() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888888333"
        let userMessageID = "55555555-5555-4555-8555-555555555333"
        let assistantMessageID = "77777777-7777-4777-8777-777777777333"
        let handedOffCompleted = LockedFlag(false)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if handedOffCompleted.value {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Handoff test","client_submission_id":"66666666-6666-4666-8666-666666666333"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-22T01:00:02Z","kind":"ember","text":"Finished in durable queue","model_label":"deepseek-v4.1-flash","simulated":false}
                      ],
                      "next_after":2,"has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            if request.httpMethod == "POST", path == "/v2/conversations/\(conversationID)/messages/stream" {
                let body = request.httpBody ?? Data()
                let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? ""
                let sse = """
                event: turn.accepted
                data: {"message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Handoff test","client_submission_id":"\(clientID)"},"turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-22T01:00:00Z"},"transcript_epoch":0}

                event: turn.delta
                data: {"turn_id":"\(turnID)","text":"Partial "}

                event: turn.handed_off
                data: {"turn_id":"\(turnID)","status":"running"}
                """ + "\n\n"
                return URLProtocolStubResponse(
                    statusCode: 201,
                    headers: ["Content-Type": "text/event-stream; charset=utf-8"],
                    body: Data(sse.utf8)
                )
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/turns/\(turnID)" {
                handedOffCompleted.value = true
                return .json(statusCode: 200, body: """
                {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","response_message_id":"\(assistantMessageID)","status":"completed","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:02Z"}
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let setup = try makeRepository(directory: directory, supportsStreaming: true)
        let model = LiveConversationHostModel(
            repository: setup.repo,
            auth: setup.auth,
            taskRepository: setup.taskRepo
        )
        models.append(model)
        model.handleScenePhase(.active)
        model.handleViewAppeared()
        await model.start()
        await model.send("Handoff test")

        for _ in 0..<80 {
            if model.reply == .idle, handedOffCompleted.value, model.lastTurnMetrics != nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(model.reply, .idle)
        XCTAssertNil(model.streamingReplyText)
        let texts = model.screen.timeline.compactMap { entry -> String? in
            if case .message(let msg) = entry { return msg.text }
            return nil
        }
        XCTAssertEqual(texts, ["Handoff test", "Finished in durable queue"])
    }

    func testSSEPreExecution401RefreshesTokenOnceAndResubmitsSameSubmissionID() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888888444"
        let userMessageID = "55555555-5555-4555-8555-555555555444"
        let postedIDs = LockedStrings()
        let tokensSeen = LockedStrings()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path == "/v2/conversations/\(conversationID)/messages/stream" {
                let authHeader = request.value(forHTTPHeaderField: "Authorization") ?? ""
                tokensSeen.append(authHeader)
                let body = request.httpBody ?? Data()
                let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? ""
                postedIDs.append(clientID)

                if tokensSeen.values.count == 1 {
                    return .json(statusCode: 401, body: "{}")
                }
                let sse = """
                event: turn.accepted
                data: {"message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Auth retry","client_submission_id":"\(clientID)"},"turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-22T01:00:00Z"},"transcript_epoch":0}
                """ + "\n\n"
                return URLProtocolStubResponse(
                    statusCode: 201,
                    headers: ["Content-Type": "text/event-stream; charset=utf-8"],
                    body: Data(sse.utf8)
                )
            }
            return .json(statusCode: 404, body: "{}")
        }

        let setup = try makeRepository(
            directory: directory,
            supportsStreaming: true,
            configureAPI: { api in
                api.setRefreshResults([.success(AuthFixture.sessionResponse(tokenSuffix: "refreshed"))])
            }
        )
        _ = try await setup.repo.bootstrap()
        let session = try await setup.repo.sendStreaming(text: "Auth retry")
        XCTAssertEqual(postedIDs.values.count, 2)
        XCTAssertEqual(postedIDs.values[0], postedIDs.values[1])
        XCTAssertEqual(tokensSeen.values, ["Bearer ems_alpha", "Bearer ems_refreshed"])
        XCTAssertEqual(session.receipt.turnID.uuidString.lowercased(), turnID)
    }

    private func makeRepository(
        directory: URL,
        supportsStreaming: Bool,
        configureAPI: (FakeEmberSessionAPI) -> Void = { _ in }
    ) throws -> (repo: LiveConversationRepository, auth: LiveAuthSessionCoordinator, taskRepo: LiveB1SessionTaskRepository) {
        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        configureAPI(api)
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
        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: LiveConversationJournal(directory: directory),
            supportsStreaming: supportsStreaming
        )
        let taskRepo = LiveB1SessionTaskRepository(auth: auth)
        return (repo, auth, taskRepo)
    }

    private func makeTempDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("v2-sse-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        directories.append(dir)
        return dir
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Bool
    init(_ initial: Bool) { storage = initial }
    var value: Bool {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private final class LockedStrings: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    func append(_ value: String) { lock.withLock { storage.append(value) } }
    var values: [String] { lock.withLock { storage } }
}

private final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: T
    init(_ initial: T) { storage = initial }
    var value: T { lock.withLock { storage } }
    func set(_ newValue: T) { lock.withLock { storage = newValue } }
}
