import Foundation
import SwiftUI
import XCTest
@testable import Ember

@MainActor
final class WebEvidenceSourcesTests: XCTestCase {
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

    func testStrictWireDecodingAcceptsValidPageAndRejectsMalformedContracts() throws {
        let validJSON = """
        {
          "conversation_id": "44444444-4444-4444-8444-444444444444",
          "transcript_epoch": 0,
          "items": [
            {
              "response_message_id": "77777777-7777-4777-8777-777777777777",
              "sequence": 4,
              "web_evidence": {
                "schema_version": 1,
                "turn_id": "88888888-8888-4888-8888-888888888888",
                "status": "completed",
                "sources": [
                  {
                    "source_id": "src-1",
                    "index": 1,
                    "title": "Swift Concurrency Guide",
                    "url": "https://www.swift.org/documentation/concurrency/",
                    "domain": "www.swift.org",
                    "snippet": "Structured concurrency keeps async tasks scoped.",
                    "published_at": "2026-11-20T09:00:00Z",
                    "fetched": true
                  },
                  {
                    "source_id": "src-2",
                    "index": 2,
                    "title": "Apple Developer Documentation",
                    "url": "https://developer.apple.com/documentation",
                    "domain": "developer.apple.com",
                    "fetched": false
                  }
                ]
              }
            }
          ],
          "next_after": 4,
          "has_more": false
        }
        """

        let page = try JSONDecoder().decode(LiveV2WebEvidencePage.self, from: Data(validJSON.utf8))
        XCTAssertEqual(page.items.count, 1)
        let domainEvidence = try XCTUnwrap(page.items.first?.webEvidence.domainEvidence())
        XCTAssertTrue(domainEvidence.hasDisplayableSources)
        XCTAssertEqual(domainEvidence.sources.count, 2)
        XCTAssertEqual(domainEvidence.sources[0].displayDomain, "swift.org")
        XCTAssertTrue(domainEvidence.sources[0].fetched)
        XCTAssertNotNil(domainEvidence.sources[0].formattedPublishedDate)
        XCTAssertFalse(domainEvidence.sources[1].fetched)
        XCTAssertNil(domainEvidence.sources[1].formattedPublishedDate)

        // Unsupported schema version
        let wrongVersionJSON = validJSON.replacingOccurrences(of: "\"schema_version\": 1", with: "\"schema_version\": 2")
        XCTAssertThrowsError(try JSONDecoder().decode(LiveV2WebEvidencePage.self, from: Data(wrongVersionJSON.utf8)))

        // Unknown top-level field
        let unknownKeyJSON = """
        {
          "schema_version": 1,
          "turn_id": "88888888-8888-4888-8888-888888888888",
          "status": "completed",
          "extra": true,
          "sources": [
            {
              "source_id": "src-1",
              "index": 1,
              "title": "Test",
              "url": "https://example.com",
              "domain": "example.com",
              "fetched": false
            }
          ]
        }
        """
        XCTAssertThrowsError(try JSONDecoder().decode(LiveB1WebEvidence.self, from: Data(unknownKeyJSON.utf8)))

        // Completed status with zero sources violates contract
        let emptyCompletedJSON = """
        {
          "schema_version": 1,
          "turn_id": "88888888-8888-4888-8888-888888888888",
          "status": "completed",
          "sources": []
        }
        """
        XCTAssertThrowsError(try JSONDecoder().decode(LiveB1WebEvidence.self, from: Data(emptyCompletedJSON.utf8)))
    }

    func testDomainEvidenceFiltersUnsafeURLsWithoutFailing() throws {
        let mixedSourcesJSON = """
        {
          "schema_version": 1,
          "turn_id": "88888888-8888-4888-8888-888888888888",
          "status": "partial",
          "sources": [
            {
              "source_id": "bad-local",
              "index": 1,
              "title": "Internal Metadata",
              "url": "http://169.254.169.254/latest",
              "domain": "169.254.169.254",
              "fetched": true
            },
            {
              "source_id": "good-public",
              "index": 2,
              "title": "Ember Public Docs",
              "url": "https://example.org/docs",
              "domain": "example.org",
              "fetched": false
            }
          ]
        }
        """

        let dto = try JSONDecoder().decode(LiveB1WebEvidence.self, from: Data(mixedSourcesJSON.utf8))
        let evidence = try XCTUnwrap(dto.domainEvidence())
        XCTAssertEqual(evidence.sources.map(\.sourceID), ["good-public"])
        XCTAssertTrue(evidence.hasDisplayableSources)

        let allUnsafeJSON = """
        {
          "schema_version": 1,
          "turn_id": "88888888-8888-4888-8888-888888888888",
          "status": "completed",
          "sources": [
            {
              "source_id": "bad-creds",
              "index": 1,
              "title": "Cred URL",
              "url": "https://secret:pass@example.com",
              "domain": "example.com",
              "fetched": true
            }
          ]
        }
        """
        let unsafeDto = try JSONDecoder().decode(LiveB1WebEvidence.self, from: Data(allUnsafeJSON.utf8))
        let emptyEvidence = try XCTUnwrap(unsafeDto.domainEvidence())
        XCTAssertFalse(emptyEvidence.hasDisplayableSources)
    }

    func testSSECommittedWithWebEvidenceAttachesCardAndClearsOnSignOut() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888888222"
        let userMessageID = "55555555-5555-4555-8555-555555555222"
        let assistantMessageID = "77777777-7777-4777-8777-777777777222"
        let hasCommitted = LockedFlag(false)
        let webEvidenceCallCount = LockedCounter()

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
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-28T01:00:00Z","kind":"user","text":"Check release notes","client_submission_id":"66666666-6666-4666-8666-666666666222"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-28T01:00:01Z","kind":"ember","text":"Here is what I found.","model_label":"deepseek-chat","simulated":false}
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
            if request.httpMethod == "GET", path == "/v2/conversations/\(conversationID)/web-evidence" {
                webEvidenceCallCount.increment()
                // Simulate older/partial backend where /web-evidence isn't serving this item yet (404),
                // confirming SSE turn.committed web_evidence still displays immediately.
                return .json(statusCode: 404, body: "{}")
            }
            if request.httpMethod == "POST", path == "/v2/conversations/\(conversationID)/messages/stream" {
                let body = request.httpBody ?? Data()
                let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? "66666666-6666-4666-8666-666666666222"
                hasCommitted.value = true

                let sse = """
                event: turn.accepted
                data: {"message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-28T01:00:00Z","kind":"user","text":"Check release notes","client_submission_id":"\(clientID)"},"turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-28T01:00:00Z"},"transcript_epoch":0}

                event: turn.delta
                data: {"turn_id":"\(turnID)","text":"Here is what I found."}

                event: turn.committed
                data: {"turn":{"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","status":"completed","created_at":"2026-11-28T01:00:00Z","updated_at":"2026-11-28T01:00:01Z","response_message_id":"\(assistantMessageID)","failure_reason":null},"response_message_id":"\(assistantMessageID)","sequence":2,"web_evidence":{"schema_version":1,"turn_id":"\(turnID)","status":"completed","sources":[{"source_id":"s1","index":1,"title":"Release Notes 2026","url":"https://ember.example.com/releases/2026","domain":"ember.example.com","snippet":"Verified changelog details.","fetched":true}]}}
                """ + "\n\n"
                return URLProtocolStubResponse(
                    statusCode: 201,
                    headers: ["Content-Type": "text/event-stream; charset=utf-8"],
                    body: Data(sse.utf8)
                )
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory, supportsStreaming: true)
        await model.start()
        XCTAssertTrue(model.screen.timeline.isEmpty)

        await model.send("Check release notes")
        let settled = await waitUntil(timeoutSeconds: 3) {
            model.reply == .idle && model.screen.timeline.count == 3
        }
        XCTAssertTrue(settled, "Expected user message, assistant message, and web sources card")
        XCTAssertGreaterThanOrEqual(webEvidenceCallCount.value, 1)

        XCTAssertEqual(model.screen.timeline[0].id, "conversation-message-\(userMessageID)")
        XCTAssertEqual(model.screen.timeline[1].id, "conversation-message-\(assistantMessageID)")
        XCTAssertEqual(model.screen.timeline[2].id, "conversation-web-sources-\(assistantMessageID)")
        guard case .inlineContent = model.screen.timeline[2] else {
            return XCTFail("Expected inlineContent web sources card after assistant message")
        }

        await model.signOut()
        XCTAssertTrue(model.streamedWebEvidenceByConversation.isEmpty)
        XCTAssertTrue(model.screen.timeline.isEmpty)
    }

    func testHistoryHydrationPagesWebEvidenceAndSkipsProseOnlyMessages() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let msgWithMarkdownOnlyID = "77777777-7777-4777-8777-777777777301"
        let msgWithEvidencePage1ID = "77777777-7777-4777-8777-777777777302"
        let msgWithEvidencePage2ID = "77777777-7777-4777-8777-777777777303"
        let requestedAfter = LockedBox<[String]>([])

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(conversationID)",
                  "transcript_epoch":0,
                  "messages":[
                    {"message_id":"\(msgWithMarkdownOnlyID)","sequence":1,"created_at":"2026-11-28T01:00:00Z","kind":"ember","text":"Check [plain link](https://markdown-only.example.com)","model_label":"deepseek-chat","simulated":false},
                    {"message_id":"\(msgWithEvidencePage1ID)","sequence":2,"created_at":"2026-11-28T01:00:01Z","kind":"ember","text":"Answer 1","model_label":"deepseek-chat","simulated":false},
                    {"message_id":"\(msgWithEvidencePage2ID)","sequence":3,"created_at":"2026-11-28T01:00:02Z","kind":"ember","text":"Answer 2","model_label":"deepseek-chat","simulated":false}
                  ],
                  "next_after":3,
                  "has_more":false
                }
                """)
            }
            if request.httpMethod == "GET", path == "/v2/conversations/\(conversationID)/web-evidence" {
                let queryItems = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                let after = queryItems?.first(where: { $0.name == "after" })?.value ?? "0"
                requestedAfter.modify { $0.append(after) }
                if after == "0" {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "items":[
                        {
                          "response_message_id":"\(msgWithEvidencePage1ID)",
                          "sequence":2,
                          "web_evidence":{
                            "schema_version":1,
                            "turn_id":"88888888-8888-4888-8888-888888888302",
                            "status":"completed",
                            "sources":[
                              {"source_id":"s1","index":1,"title":"Page 1 Source","url":"https://one.example.com","domain":"one.example.com","fetched":true}
                            ]
                          }
                        }
                      ],
                      "next_after":2,
                      "has_more":true
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(conversationID)",
                  "transcript_epoch":0,
                  "items":[
                    {
                      "response_message_id":"\(msgWithEvidencePage2ID)",
                      "sequence":3,
                      "web_evidence":{
                        "schema_version":1,
                        "turn_id":"88888888-8888-4888-8888-888888888303",
                        "status":"partial",
                        "sources":[
                          {"source_id":"s2","index":1,"title":"Page 2 Source","url":"https://two.example.com","domain":"two.example.com","fetched":false}
                        ]
                      }
                    }
                  ],
                  "next_after":3,
                  "has_more":false
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory, supportsStreaming: false)
        await model.start()

        // Expected timeline: msg1 (prose-only, NO card!), msg2 + card2, msg3 + card3
        XCTAssertEqual(requestedAfter.value, ["0", "2"])
        XCTAssertEqual(model.screen.timeline.map(\.id), [
            "conversation-message-\(msgWithMarkdownOnlyID)",
            "conversation-message-\(msgWithEvidencePage1ID)",
            "conversation-web-sources-\(msgWithEvidencePage1ID)",
            "conversation-message-\(msgWithEvidencePage2ID)",
            "conversation-web-sources-\(msgWithEvidencePage2ID)",
        ])
    }

    func testSSEMalformedWebEvidenceDoesNotInterruptCommittedTurn() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888888444"
        let userMessageID = "55555555-5555-4555-8555-555555555444"
        let assistantMessageID = "77777777-7777-4777-8777-777777777444"
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
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-28T01:00:00Z","kind":"user","text":"Hi","client_submission_id":"66666666-6666-4666-8666-666666666444"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-28T01:00:01Z","kind":"ember","text":"Reply stays intact.","model_label":"deepseek-chat","simulated":false}
                      ],
                      "next_after":2,
                      "has_more":false
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
                let clientID = (obj?["client_submission_id"] as? String) ?? "66666666-6666-4666-8666-666666666444"
                hasCommitted.value = true
                let sse = """
                event: turn.accepted
                data: {"message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-28T01:00:00Z","kind":"user","text":"Hi","client_submission_id":"\(clientID)"},"turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-28T01:00:00Z"},"transcript_epoch":0}

                event: turn.committed
                data: {"turn":{"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","status":"completed","created_at":"2026-11-28T01:00:00Z","updated_at":"2026-11-28T01:00:01Z","response_message_id":"\(assistantMessageID)","failure_reason":null},"response_message_id":"\(assistantMessageID)","sequence":2,"web_evidence":{"schema_version":99,"turn_id":"\(turnID)","status":"completed","sources":[]}}
                """ + "\n\n"
                return URLProtocolStubResponse(
                    statusCode: 201,
                    headers: ["Content-Type": "text/event-stream; charset=utf-8"],
                    body: Data(sse.utf8)
                )
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory, supportsStreaming: true)
        await model.start()
        await model.send("Hi")
        let settled = await waitUntil(timeoutSeconds: 3) {
            model.reply == .idle && model.screen.timeline.count == 2
        }
        XCTAssertTrue(settled)
        XCTAssertEqual(model.screen.timeline.map(\.id), [
            "conversation-message-\(userMessageID)",
            "conversation-message-\(assistantMessageID)",
        ])
    }

    func testWebSourcesPresentationCollapsesAtThreeAndFormatsAccessibilityLabels() {
        let sources = (1...5).compactMap { index in
            WebSource(
                sourceID: "s-\(index)",
                index: index,
                title: "Source Title \(index)",
                url: URL(string: "https://www.source\(index).example.com/post")!,
                domain: "www.source\(index).example.com",
                snippet: "Snippet \(index)",
                publishedAt: index == 1 ? "2026-11-25T10:00:00Z" : nil,
                fetched: index % 2 == 1
            )
        }
        XCTAssertEqual(sources.count, 5)
        XCTAssertTrue(ConversationWebSourcesPresentation.shouldShowExpandToggle(totalCount: sources.count))
        XCTAssertFalse(ConversationWebSourcesPresentation.shouldShowExpandToggle(totalCount: 3))

        let collapsed = ConversationWebSourcesPresentation.visibleSources(from: sources, isExpanded: false)
        let expanded = ConversationWebSourcesPresentation.visibleSources(from: sources, isExpanded: true)
        XCTAssertEqual(collapsed.map(\.index), [1, 2, 3])
        XCTAssertEqual(expanded.map(\.index), [1, 2, 3, 4, 5])

        let readLabel = ConversationWebSourcesPresentation.rowAccessibilityLabel(for: sources[0])
        XCTAssertTrue(readLabel.contains("Source Title 1"))
        XCTAssertTrue(readLabel.contains("source1.example.com"))
        XCTAssertTrue(readLabel.contains(ConversationWebSourcesPresentation.statusText(fetched: true)))
        XCTAssertNotNil(sources[0].formattedPublishedDate)

        let searchedLabel = ConversationWebSourcesPresentation.rowAccessibilityLabel(for: sources[1])
        XCTAssertTrue(searchedLabel.contains(ConversationWebSourcesPresentation.statusText(fetched: false)))
        XCTAssertNil(sources[1].formattedPublishedDate)
    }

    private func makeHostModel(directory: URL, supportsStreaming: Bool) throws -> LiveConversationHostModel {
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
        let journal = LiveConversationJournal(directory: directory)
        let repository = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: journal,
            supportsStreaming: supportsStreaming
        )
        let model = LiveConversationHostModel(
            repository: repository,
            auth: auth,
            pollingWindow: .seconds(5),
            taskPollInterval: .seconds(1)
        )
        models.append(model)
        return model
    }

    private func makeTempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("WebEvidenceTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directories.append(url)
        return url
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }

    private func waitUntil(timeoutSeconds: TimeInterval, condition: @escaping () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
        return condition()
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Bool

    init(_ initial: Bool) { self.storage = initial }

    var value: Bool {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}

private final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: T

    init(_ initial: T) { self.storage = initial }

    var value: T { lock.withLock { storage } }

    func modify(_ body: (inout T) -> Void) {
        lock.withLock { body(&storage) }
    }
}
