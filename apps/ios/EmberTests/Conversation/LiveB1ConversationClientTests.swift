import Foundation
import XCTest
@testable import Ember

/// Real URLProtocol HTTP boundary, without any network, Apple account or Mock conversation.
@MainActor
final class LiveB1ConversationClientTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []

    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        sessions.removeAll()
        registrations.removeAll()
        try await super.tearDown()
    }

    func testSendUsesB1RouteAndAdoptsServerReceipt() async throws {
        let fixture = try makeClient()
        let submission = makeSubmission()
        let recorder = RequestRecorder()
        let replyBody = receiptJSON(for: submission)
        register { request in
            recorder.record(request)
            return .json(statusCode: 201, body: replyBody)
        }

        let receipt = try await fixture.client.send(submission)
        XCTAssertEqual(receipt.messageID.uuidString.lowercased(), "55555555-5555-4555-8555-555555555555")
        XCTAssertEqual(receipt.sequence, 6)
        XCTAssertEqual(receipt.clientSubmissionID, submission.clientSubmissionID)

        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path,
                       "/v1/conversations/44444444-4444-4444-8444-444444444444/messages")
        XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ems_alpha")
        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["client_submission_id", "text", "transcript_epoch"])
        XCTAssertEqual(object["client_submission_id"] as? String,
                       submission.clientSubmissionID.uuidString.lowercased())
        XCTAssertEqual(object["transcript_epoch"] as? Int, 0)
        XCTAssertEqual(recorder.requests.count, 1)
    }

    func testLookupUsesTenantWideSubmissionPath() async throws {
        let fixture = try makeClient()
        let submission = makeSubmission()
        let recorder = RequestRecorder()
        let replyBody = receiptJSON(for: submission)
        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: replyBody)
        }

        let receipt = try await fixture.client.lookup(submission.clientSubmissionID)
        XCTAssertEqual(receipt?.clientSubmissionID, submission.clientSubmissionID)
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.url?.path,
                       "/v1/message-submissions/" + submission.clientSubmissionID.uuidString.lowercased())
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(request.httpMethod, "GET")
    }

    func testLookup404IsNotAnAcceptedReceipt() async throws {
        let fixture = try makeClient()
        register { _ in .json(statusCode: 404, body: "{}") }
        let found = try await fixture.client.lookup(UUID())
        XCTAssertNil(found)
    }

    func testMessagePagesPreserveServerOrderEpochAndSimulatedFlag() async throws {
        let fixture = try makeClient()
        let recorder = RequestRecorder()
        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: """
            {
              "conversation_id":"44444444-4444-4444-8444-444444444444",
              "transcript_epoch":0,
              "messages":[
                {"message_id":"55555555-5555-4555-8555-555555555555",
                 "sequence":6,"created_at":"2026-11-06T00:00:00Z","kind":"user",
                 "text":"hello","client_submission_id":"66666666-6666-4666-8666-666666666666"},
                {"message_id":"77777777-7777-4777-8777-777777777777",
                 "sequence":7,"created_at":"2026-11-06T00:00:01Z","kind":"ember",
                 "text":"hello back","model_label":"fake-responder","simulated":true}
              ],
              "next_after":7,"has_more":false
            }
            """)
        }
        let page = try await fixture.client.page(conversationID: AuthFixture.conversationID, after: 5, limit: 50)
        XCTAssertEqual(page.messages.map(\.sequence), [6, 7])
        XCTAssertEqual(page.nextAfter, 7)
        XCTAssertEqual(page.transcriptEpoch, 0)
        let second = page.messages[1].domainMessage(conversationID: ConversationID(rawValue: AuthFixture.conversationID))
        XCTAssertEqual(second.kind, .ember(text: "[SIMULATED] hello back"))

        let query = URLComponents(url: try XCTUnwrap(recorder.requests.first?.url),
                                  resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "after" })?.value, "5")
        XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "50")
    }

    func testUnknownMessageKindIsRejected() throws {
        let data = Data("""
            {
              "conversation_id":"44444444-4444-4444-8444-444444444444",
              "transcript_epoch":0,
              "messages":[{"message_id":"77777777-7777-4777-8777-777777777777",
              "sequence":1,"created_at":"2026-11-06T00:00:01Z","kind":"mystery"}],
              "next_after":1,"has_more":false
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(LiveB1Page.self, from: data))
    }

    func testCancellationAndTurnPollingUseFrozenRoutes() async throws {
        let fixture = try makeClient()
        let recorder = RequestRecorder()
        let runningBody = turnJSON(status: "running")
        let cancelledBody = turnJSON(status: "cancelled")
        register { request in
            recorder.record(request)
            let isCancel = request.url?.path.hasSuffix("/cancel") ?? false
            return .json(statusCode: 200, body: isCancel ? cancelledBody : runningBody)
        }
        let id = UUID(uuidString: "88888888-8888-4888-8888-888888888888")!
        let turn = try await fixture.client.turn(conversationID: AuthFixture.conversationID, turnID: id)
        XCTAssertEqual(turn.status, .running)
        let cancelled = try await fixture.client.cancel(conversationID: AuthFixture.conversationID, turnID: id)
        XCTAssertEqual(cancelled.status, .cancelled)
        XCTAssertEqual(recorder.requests.map(\.httpMethod), ["GET", "POST"])
        XCTAssertNil(recorder.requests.last?.httpBody)
    }

    func testSendConflictNeverReplays() async throws {
        let fixture = try makeClient()
        let counter = Counter()
        register { _ in
            counter.increment()
            return .json(statusCode: 409, body: "{}")
        }
        do {
            _ = try await fixture.client.send(makeSubmission())
            XCTFail("expected a conflict")
        } catch let error as LiveB1Failure {
            XCTAssertEqual(error, .conflict)
        }
        XCTAssertEqual(counter.value, 1)
    }

    func testMessagePageDecodesTaskAndOutcomeReferencesWithOutcomeKinds() async throws {
        let fixture = try makeClient()
        let taskID = "00000000-0000-4000-8000-00000000b311"
        let commitmentID = "00000000-0000-4000-8000-00000000b399"
        register { _ in
            .json(statusCode: 200, body: """
            {
              "conversation_id":"44444444-4444-4444-8444-444444444444",
              "transcript_epoch":0,
              "messages":[
                {"message_id":"55555555-5555-4555-8555-555555555551",
                 "sequence":1,"created_at":"2026-11-15T00:00:00Z",
                 "kind":"task_reference","task_id":"\(taskID)"},
                {"message_id":"55555555-5555-4555-8555-555555555552",
                 "sequence":2,"created_at":"2026-11-15T00:00:01Z",
                 "kind":"outcome_reference",
                 "outcome":{"outcome_kind":"meaningful_change","task_id":"\(taskID)","commitment_id":"\(commitmentID)"}}
              ],
              "next_after":2,"has_more":false
            }
            """)
        }
        let page = try await fixture.client.page(conversationID: AuthFixture.conversationID, after: 0, limit: 50)
        XCTAssertEqual(page.messages.count, 2)
        let convID = ConversationID(rawValue: AuthFixture.conversationID)
        XCTAssertEqual(page.messages[0].domainMessage(conversationID: convID).kind,
                       .taskReference(TaskReference(taskID: UUID(uuidString: taskID)!)))
        XCTAssertEqual(page.messages[1].domainMessage(conversationID: convID).kind,
                       .outcomeReference(.taskResult(taskID: UUID(uuidString: taskID)!)))
        if case .outcome(let decodedTaskID, let outcomeKind, let decodedCommitmentID) = page.messages[1].payload {
            XCTAssertEqual(decodedTaskID.uuidString.lowercased(), taskID)
            XCTAssertEqual(outcomeKind, LiveB1OutcomeKind.meaningfulChange)
            XCTAssertEqual(decodedCommitmentID?.uuidString.lowercased(), commitmentID)
        } else {
            XCTFail("Expected outcome payload")
        }
    }

    func testOutcomeReferenceRejectsUnknownOutcomeKind() throws {
        let data = Data("""
            {
              "conversation_id":"44444444-4444-4444-8444-444444444444",
              "transcript_epoch":0,
              "messages":[
                {"message_id":"55555555-5555-4555-8555-555555555552",
                 "sequence":1,"created_at":"2026-11-15T00:00:01Z",
                 "kind":"outcome_reference",
                 "outcome":{"outcome_kind":"invented_kind","task_id":"00000000-0000-4000-8000-00000000b311"}}
              ],
              "next_after":1,"has_more":false
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(LiveB1Page.self, from: data))
    }

    func testUploadAttachmentUsesB3RouteAndDecodesReceipt() async throws {
        let fixture = try makeClient()
        let recorder = RequestRecorder()
        let uploadID = "99999999-9999-4999-8999-999999999999"
        let sha = String(repeating: "a", count: 64)
        let csvData = Data("month,revenue\nJan,1200\n".utf8)

        register { request in
            recorder.record(request)
            return .json(statusCode: 201, body: """
            {
              "upload_id":"\(uploadID)",
              "filename":"sales_data.csv",
              "media_type":"text/csv",
              "size":\(csvData.count),
              "sha256":"\(sha)",
              "expires_at":"2026-11-17T00:00:00Z",
              "created_at":"2026-11-16T00:00:00Z"
            }
            """)
        }

        let receipt = try await fixture.client.uploadAttachment(
            filename: "sales_data.csv",
            mediaType: "text/csv",
            data: csvData
        )
        XCTAssertEqual(receipt.uploadID.uuidString.lowercased(), uploadID)
        XCTAssertEqual(receipt.filename, "sales_data.csv")
        XCTAssertEqual(receipt.mediaType, "text/csv")
        XCTAssertEqual(receipt.size, csvData.count)

        let req = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/v1/me/uploads")
        let contentType = try XCTUnwrap(req.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(contentType.hasPrefix("multipart/form-data; boundary="))
        let body = try XCTUnwrap(req.httpBody)
        let bodyString = try XCTUnwrap(String(data: body, encoding: .utf8))
        XCTAssertTrue(bodyString.contains("name=\"filename\"\r\n\r\nsales_data.csv\r\n"))
        XCTAssertTrue(bodyString.contains("name=\"media_type\"\r\n\r\ntext/csv\r\n"))
        XCTAssertTrue(bodyString.contains("name=\"file\"; filename=\"sales_data.csv\"\r\nContent-Type: text/csv\r\n\r\nmonth,revenue\nJan,1200\n"))
    }

    func testUploadAttachmentAcceptsPDFAndImageAndRejectsBlockedMIME() async throws {
        let fixture = try makeClient()
        let pdfBytes = Data("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n".utf8)
        let sha = String(repeating: "b", count: 64)
        register { _ in
            .json(statusCode: 201, body: """
            {
              "upload_id":"88888888-8888-4888-8888-888888888888",
              "filename":"report.pdf",
              "media_type":"application/pdf",
              "size":\(pdfBytes.count),
              "sha256":"\(sha)",
              "expires_at":"2026-11-17T00:00:00Z",
              "created_at":"2026-11-16T00:00:00Z"
            }
            """)
        }

        let pdfReceipt = try await fixture.client.uploadAttachment(
            filename: "report.pdf",
            mediaType: "application/pdf",
            data: pdfBytes
        )
        XCTAssertEqual(pdfReceipt.mediaType, "application/pdf")

        do {
            _ = try await fixture.client.uploadAttachment(
                filename: "index.html",
                mediaType: "text/html",
                data: Data("<h1>blocked</h1>".utf8)
            )
            XCTFail("Expected text/html to be rejected client-side")
        } catch let error as LiveB1Failure {
            XCTAssertEqual(error, .rejected)
        }
    }

    func testSendWithAttachmentsIncludesAttachmentIDs() async throws {
        let fixture = try makeClient()
        let uploadID = UUID(uuidString: "99999999-9999-4999-8999-999999999999")!
        let submission = ConversationSubmission(
            clientSubmissionID: UUID(),
            conversationID: ConversationID(rawValue: AuthFixture.conversationID),
            transcriptEpoch: 0,
            text: "Analyze this CSV",
            attachmentIDs: [uploadID]
        )
        let recorder = RequestRecorder()
        let replyBody = receiptJSON(for: submission)
        register { request in
            recorder.record(request)
            return .json(statusCode: 201, body: replyBody)
        }

        _ = try await fixture.client.send(submission)
        let req = try XCTUnwrap(recorder.requests.first)
        let body = try XCTUnwrap(req.httpBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["client_submission_id", "text", "transcript_epoch", "attachment_ids"])
        XCTAssertEqual(obj["attachment_ids"] as? [String], [uploadID.uuidString.lowercased()])
    }

    private func makeClient() throws -> (client: LiveB1ConversationClient, session: URLSession) {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL, client: EmberAPIClient(session: session))
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        return (LiveB1ConversationClient(auth: auth), session)
    }

    private func makeSubmission() -> ConversationSubmission {
        ConversationSubmission(
            clientSubmissionID: UUID(),
            conversationID: ConversationID(rawValue: AuthFixture.conversationID),
            transcriptEpoch: 0,
            text: "hello")
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }

    private func receiptJSON(for submission: ConversationSubmission) -> String {
        """
        {
          "message":{
            "message_id":"55555555-5555-4555-8555-555555555555",
            "conversation_id":"44444444-4444-4444-8444-444444444444",
            "sequence":6,"created_at":"2026-11-06T00:00:00Z",
            "kind":"user","text":"\(submission.text)",
            "client_submission_id":"\(submission.clientSubmissionID.uuidString.lowercased())"
          },
          "turn":{"turn_id":"88888888-8888-4888-8888-888888888888",
                  "status":"running","created_at":"2026-11-06T00:00:00Z"},
          "transcript_epoch":0
        }
        """
    }

    private func turnJSON(status: String) -> String {
        """
        {
          "turn_id":"88888888-8888-4888-8888-888888888888",
          "conversation_id":"44444444-4444-4444-8444-444444444444",
          "source_message_id":"55555555-5555-4555-8555-555555555555",
          "status":"\(status)","created_at":"2026-11-06T00:00:00Z",
          "updated_at":"2026-11-06T00:00:01Z",
          "response_message_id":null,"failure_reason":null
        }
        """
    }
}
