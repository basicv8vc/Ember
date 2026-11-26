import Foundation
import XCTest
@testable import Ember

@MainActor
final class LiveConversationRecoveryCopyTests: XCTestCase {
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

    // MARK: - Unknown ACK & Idempotent Recovery

    func testUnknownACKShowsCalmCheckingCopyAndRecoversWithoutDuplicatePost() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let userMessageID = "55555555-5555-4555-8555-555555555701"
        let assistantMessageID = "77777777-7777-4777-8777-777777775701"
        let turnID = "88888888-8888-4888-8888-888888885701"

        let postedIDs = LockedStrings()
        let lookupIDs = LockedStrings()
        let lookupShouldFail = LockedFlag(true)
        let turnCompleted = LockedFlag(false)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                let obj = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
                postedIDs.append((obj?["client_submission_id"] as? String) ?? "")
                return .failure(URLError(.timedOut))
            }
            if request.httpMethod == "GET", path.hasPrefix("/v1/message-submissions/") {
                let queriedID = request.url?.lastPathComponent ?? ""
                lookupIDs.append(queriedID)
                if lookupShouldFail.value {
                    return .failure(URLError(.notConnectedToInternet))
                }
                return .json(statusCode: 200, body: """
                {
                  "message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Check my note","client_submission_id":"\(queriedID)"},
                  "turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-22T01:00:00Z"},
                  "transcript_epoch":0
                }
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/turns/\(turnID)" {
                turnCompleted.value = true
                return .json(statusCode: 200, body: """
                {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","response_message_id":"\(assistantMessageID)","status":"completed","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:02Z"}
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if turnCompleted.value, let id = postedIDs.values.first {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Check my note","client_submission_id":"\(id)"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-22T01:00:02Z","kind":"ember","text":"Checked safely.","model_label":"ember-alpha","simulated":false}
                      ],
                      "next_after":2,"has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        model.handleScenePhase(.active)
        model.handleViewAppeared()
        await model.start()

        await model.send("Check my note")

        XCTAssertEqual(model.command, .unknownAcknowledgement)
        XCTAssertEqual(model.pendingOutgoingText, "Check my note")
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.sendUnknownAckMessage, retryable: true)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendUnknownAckStatus)
        XCTAssertEqual(postedIDs.values.count, 1)

        // Pending bubble displays localized "checking whether sent" note.
        if case .message(let pendingBubble)? = model.screen.timeline.last {
            XCTAssertEqual(
                pendingBubble.deliveryNote,
                String(localized: "conversation.message.pending_ack_note", table: "Conversation")
            )
        } else {
            return XCTFail("Expected pending outgoing message bubble in timeline")
        }

        // First retry fails lookup offline: must not POST a second message and must stay calm.
        await model.retry()
        XCTAssertEqual(model.command, .unknownAcknowledgement)
        XCTAssertEqual(postedIDs.values.count, 1)
        XCTAssertFalse(lookupIDs.values.isEmpty)
        XCTAssertEqual(Set(lookupIDs.values), Set(postedIDs.values))
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.retryUnknownAckMessage, retryable: true)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendUnknownAckStatus)

        // Recovery succeeds via lookup without issuing another POST.
        lookupShouldFail.value = false
        await model.retry()
        for _ in 0..<60 {
            if model.reply == .idle, turnCompleted.value { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(model.reply, .idle)
        XCTAssertNil(model.status)
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(postedIDs.values.count, 1)
        XCTAssertEqual(Set(lookupIDs.values), Set(postedIDs.values))
    }

    func testColdStartFailureWithPendingMessageDistinguishesUnknownACKFromHistoryFailure() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()

        let journal = LiveConversationJournal(directory: directory)
        try await journal.bind(consumerID: AuthFixture.consumerID)
        try await journal.prepare(
            LiveConversationJournal.Pending(
                clientSubmissionID: UUID(),
                conversationID: AuthFixture.conversationID,
                transcriptEpoch: 0,
                text: "Pending before relaunch"
            ),
            consumerID: AuthFixture.consumerID
        )

        register { request in
            let path = request.url?.path ?? ""
            if path.hasPrefix("/v1/message-submissions/") || path.contains("/messages") {
                return .failure(URLError(.notConnectedToInternet))
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let modelWithPending = try makeHostModel(directory: directory, journal: journal)
        await modelWithPending.start()

        XCTAssertEqual(modelWithPending.command, .unknownAcknowledgement)
        XCTAssertEqual(modelWithPending.pendingOutgoingText, "Pending before relaunch")
        XCTAssertEqual(
            modelWithPending.reply,
            .failed(message: LiveConversationCopy.sendUnknownAckMessage, retryable: true)
        )
        XCTAssertEqual(modelWithPending.status, LiveConversationCopy.sendUnknownAckStatus)

        let cleanModel = try makeHostModel(directory: makeTempDirectory())
        await cleanModel.start()

        XCTAssertEqual(cleanModel.command, .unknownAcknowledgement)
        XCTAssertNil(cleanModel.pendingOutgoingText)
        XCTAssertEqual(
            cleanModel.reply,
            .failed(message: LiveConversationCopy.loadUnavailableMessage, retryable: true)
        )
        XCTAssertEqual(cleanModel.status, LiveConversationCopy.loadUnavailableStatus)
    }

    // MARK: - Explicit Rejection & Draft Recovery

    func testExplicitRejectionAndConflictPreserveDraftAndDistinguishFromUnknownACK() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let responseCode = LockedInt(409)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: responseCode.value, body: "{}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        await model.start()

        // 1. 409 Conflict
        await model.send("Conflict draft")
        XCTAssertEqual(model.command, .rejected)
        XCTAssertEqual(model.rejectedDraftText, "Conflict draft")
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.sendConflictMessage, retryable: false)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendRejectedStatus)

        model.dismissReplyError()
        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.command, .idle)
        XCTAssertNil(model.status)

        // 2. Explicit 403 rejection also preserves draft & non-retryable rejection copy
        responseCode.set(403)
        await model.send("Rejected draft")
        XCTAssertEqual(model.command, .rejected)
        XCTAssertEqual(model.rejectedDraftText, "Rejected draft")
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.sendRejectedMessage, retryable: false)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendRejectedStatus)
    }

    func testConflictDuringUnknownAckRetryTransitionsToRejectedAndPreservesDraft() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let postAttempts = LockedInt(0)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                let attempt = postAttempts.incrementAndGet()
                if attempt == 1 {
                    return .failure(URLError(.timedOut))
                }
                return .json(statusCode: 409, body: "{}")
            }
            if request.httpMethod == "GET", path.hasPrefix("/v1/message-submissions/") {
                return .json(statusCode: 404, body: "{}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        await model.start()

        await model.send("Draft hitting conflict on replay")
        XCTAssertEqual(model.command, .unknownAcknowledgement)

        await model.retry()
        XCTAssertEqual(model.command, .rejected)
        XCTAssertEqual(model.rejectedDraftText, "Draft hitting conflict on replay")
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.sendConflictMessage, retryable: false)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendRejectedStatus)
    }

    // MARK: - Streaming & Polling Interruption

    func testSSEStreamInterruptionAndPollingFailureDistinguishSavedMessageFromUnknownACK() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888885702"
        let userMessageID = "55555555-5555-4555-8555-555555555702"
        let assistantMessageID = "77777777-7777-4777-8777-777777775702"
        let pollAttempts = LockedInt(0)
        let shouldFailPoll = LockedFlag(true)
        let dropStreamGate = AsyncGate()
        let pollEntered = AsyncGate()
        let releaseFirstPoll = AsyncGate()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "POST", path == "/v2/conversations/\(conversationID)/messages/stream" {
                let obj = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? UUID().uuidString.lowercased()
                let partialSSE = """
                event: turn.accepted
                data: {"message":{"message_id":"\(userMessageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Stream test","client_submission_id":"\(clientID)"},"turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-22T01:00:00Z"},"transcript_epoch":0}

                event: turn.delta
                data: {"turn_id":"\(turnID)","text":"Working on "}
                """ + "\n\n"
                return URLProtocolStubResponse(
                    statusCode: 200,
                    headers: ["Content-Type": "text/event-stream"],
                    body: Data(partialSSE.utf8),
                    transportErrorAfterBody: URLError(.networkConnectionLost),
                    afterBodyBarrier: { await dropStreamGate.wait() }
                )
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/turns/\(turnID)" {
                let attempt = pollAttempts.incrementAndGet()
                if shouldFailPoll.value {
                    var stub = URLProtocolStubResponse.failure(URLError(.notConnectedToInternet))
                    if attempt == 1 {
                        stub.onStartLoading = { Task { await pollEntered.open() } }
                        stub.requestBarrier = { await releaseFirstPoll.wait() }
                    }
                    return stub
                }
                return .json(statusCode: 200, body: """
                {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(userMessageID)","response_message_id":"\(assistantMessageID)","status":"completed","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:02Z"}
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if !shouldFailPoll.value {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"\(userMessageID)","sequence":1,"created_at":"2026-11-22T01:00:00Z","kind":"user","text":"Stream test","client_submission_id":"66666666-6666-4666-8666-666666665702"},
                        {"message_id":"\(assistantMessageID)","sequence":2,"created_at":"2026-11-22T01:00:02Z","kind":"ember","text":"Finished after stream drop","model_label":"ember-alpha","simulated":false}
                      ],
                      "next_after":2,"has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory, supportsStreaming: true)
        model.handleScenePhase(.active)
        model.handleViewAppeared()
        await model.start()

        await model.send("Stream test")

        // Verify turn.accepted and turn.delta were consumed before simulating the mid-stream network drop.
        for _ in 0..<60 {
            if model.streamingReplyText == "Working on " { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.command, .acknowledged)
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(model.streamingReplyText, "Working on ")
        XCTAssertEqual(model.status, LiveConversationCopy.messageAccepted)

        // Drop the SSE transport mid-stream and verify streamInterruptedChecking while durable polling starts.
        await dropStreamGate.open()
        await pollEntered.wait()
        XCTAssertEqual(model.command, .acknowledged)
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertNil(model.streamingReplyText)
        XCTAssertEqual(model.reply, .generating)
        XCTAssertEqual(model.status, LiveConversationCopy.streamInterruptedChecking)

        await releaseFirstPoll.open()

        for _ in 0..<60 {
            if pollAttempts.value > 0, case .failed(_, retryable: true) = model.reply { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        // Message was saved (acknowledged), NOT unknownAcknowledgement; copy tells user server may still be working.
        XCTAssertEqual(model.command, .acknowledged)
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.replyInterruptedMessage, retryable: true)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.replyInterruptedStatus)

        // Retry fetches completed reply cleanly and clears status.
        shouldFailPoll.value = false
        await model.retry()
        for _ in 0..<60 {
            if model.reply == .idle { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertEqual(model.reply, .idle)
        XCTAssertNil(model.status)
    }

    // MARK: - Cancellation States

    func testCancellationDistinguishesRequestedConfirmedAndUnknownStates() async throws {
        enum CancelMode: Sendable {
            case running
            case cancelled
            case networkFailure
        }

        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = "88888888-8888-4888-8888-888888885703"
        let cancelMode = LockedBox<CancelMode>(.running)
        let loadFailsAfterCancel = LockedFlag(false)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "POST", path.contains("/cancel") {
                switch cancelMode.value {
                case .running:
                    return .json(statusCode: 200, body: """
                    {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"55555555-5555-4555-8555-555555555703","status":"running","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:01Z"}
                    """)
                case .cancelled:
                    return .json(statusCode: 200, body: """
                    {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"55555555-5555-4555-8555-555555555703","status":"cancelled","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:02Z"}
                    """)
                case .networkFailure:
                    return .failure(URLError(.timedOut))
                }
            }
            if request.httpMethod == "GET", path.contains("/turns/") {
                return .json(statusCode: 200, body: """
                {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"55555555-5555-4555-8555-555555555703","status":"running","created_at":"2026-11-22T01:00:00Z","updated_at":"2026-11-22T01:00:01Z"}
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if loadFailsAfterCancel.value {
                    return .failure(URLError(.notConnectedToInternet))
                }
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let journal = LiveConversationJournal(directory: directory)
        try await journal.bind(consumerID: AuthFixture.consumerID)
        let pending = LiveConversationJournal.Pending(
            clientSubmissionID: UUID(),
            conversationID: AuthFixture.conversationID,
            transcriptEpoch: 0,
            text: "Cancel test"
        )
        try await journal.prepare(pending, consumerID: AuthFixture.consumerID)
        let receipt = LiveB1Receipt(
            clientSubmissionID: pending.clientSubmissionID,
            conversationID: AuthFixture.conversationID,
            messageID: UUID(uuidString: "55555555-5555-4555-8555-555555555703")!,
            sequence: 1,
            text: "Cancel test",
            createdAt: Date(),
            turnID: UUID(uuidString: turnID)!,
            transcriptEpoch: 0
        )
        try await journal.accepted(receipt, for: pending, consumerID: AuthFixture.consumerID)

        let model = try makeHostModel(directory: directory, journal: journal)
        model.handleScenePhase(.active)
        model.handleViewAppeared()
        await model.start()

        // 1. Server returns .running: cancellation requested, NOT confirmed cancelled.
        cancelMode.set(.running)
        await model.stop()
        XCTAssertEqual(model.reply, .generating)
        XCTAssertEqual(model.status, LiveConversationCopy.cancelRequested)

        // 2. Network error on cancel: cancellation status unknown, NOT confirmed cancelled.
        cancelMode.set(.networkFailure)
        await model.stop()
        XCTAssertEqual(model.reply, .generating)
        XCTAssertEqual(model.status, LiveConversationCopy.cancelStatusUnknown)

        // 3. Server confirms .cancelled: even if follow-up transcript load fails, cancelled status is preserved.
        cancelMode.set(.cancelled)
        loadFailsAfterCancel.value = true
        await model.stop()
        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.status, LiveConversationCopy.turnCancelled)
        XCTAssertEqual(model.refreshErrorMessage, LiveConversationCopy.refreshUnavailable)
    }

    // MARK: - Authentication Failures

    func testAuthenticationFailuresUpdateLocalizedSignInState() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        api.setRefreshResults([.failure(.unauthenticated)])
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

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 401, body: "{}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: LiveConversationJournal(directory: directory)
        )
        let model = LiveConversationHostModel(repository: repo, auth: auth)
        models.append(model)
        await model.start()

        await model.send("Trigger auth expiry")
        XCTAssertTrue(model.requiresSignIn)
        XCTAssertEqual(model.signInErrorMessage, LiveAuthEntryModel.message(for: .unauthenticated))
        XCTAssertEqual(model.status, LiveAuthEntryModel.message(for: .unauthenticated))
    }

    // MARK: - Service Unavailable (503) & Dismiss Stuck Pending Send

    func testServiceUnavailableSurfacesClearCopyAndDismissRestoresDraftAndUnblocksSend() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let turnID = UUID().uuidString.lowercased()
        let messageID = UUID().uuidString.lowercased()
        let postStatus = LockedInt(503)
        let postedIDs = LockedStrings()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path.contains("/message-submissions/") {
                return .json(statusCode: 404, body: "{}")
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                let obj = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
                let id = (obj?["client_submission_id"] as? String) ?? UUID().uuidString.lowercased()
                postedIDs.append(id)
                let code = postStatus.value
                if code == 503 {
                    return .json(statusCode: 503, body: #"{"error":{"code":"DB_UNAVAILABLE","message":"service unavailable"}}"#)
                }
                return .json(statusCode: 201, body: """
                {
                  "message":{"message_id":"\(messageID)","conversation_id":"\(conversationID)","sequence":1,"created_at":"2026-11-26T22:00:00Z","kind":"user","text":"Fresh message","client_submission_id":"\(id)"},
                  "turn":{"turn_id":"\(turnID)","status":"running","created_at":"2026-11-26T22:00:00Z"},
                  "transcript_epoch":0
                }
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/turns/\(turnID)" {
                return .json(statusCode: 200, body: """
                {"turn_id":"\(turnID)","conversation_id":"\(conversationID)","source_message_id":"\(messageID)","response_message_id":"\(UUID().uuidString.lowercased())","status":"completed","created_at":"2026-11-26T22:00:00Z","updated_at":"2026-11-26T22:00:01Z"}
                """)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 200, body: """
                {"conversation_id":"\(conversationID)","transcript_epoch":0,"messages":[],"next_after":0,"has_more":false}
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        model.handleScenePhase(.active)
        model.handleViewAppeared()
        await model.start()

        // 1. Initial 503 surfaces service-unavailable copy instead of unknown-ack copy.
        await model.send("Stuck message")
        XCTAssertEqual(model.command, .unknownAcknowledgement)
        XCTAssertEqual(model.pendingOutgoingText, "Stuck message")
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.sendServiceUnavailableMessage, retryable: true)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendServiceUnavailableStatus)

        // 2. Retry while backend still returns 503 keeps service-unavailable copy.
        await model.retry()
        XCTAssertEqual(
            model.reply,
            .failed(message: LiveConversationCopy.sendServiceUnavailableMessage, retryable: true)
        )
        XCTAssertEqual(model.status, LiveConversationCopy.sendServiceUnavailableStatus)

        // 3. Dismissing the error restores the draft, clears stuck state, and unblocks a new send.
        model.dismissReplyError()
        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.command, .idle)
        XCTAssertNil(model.status)
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(model.rejectedDraftText, "Stuck message")
        XCTAssertEqual(model.pendingRejectedDraftRestoration?.text, "Stuck message")

        postStatus.set(201)
        await model.send("Fresh message")
        XCTAssertEqual(model.command, .acknowledged)
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(postedIDs.values.count, 3)
        XCTAssertNotEqual(postedIDs.values[0], postedIDs.values[2])
    }

    // MARK: - Localization Completeness (en & zh-Hans)

    func testAllRecoveryAndAuthKeysResolveInEnglishAndSimplifiedChinese() throws {
        let appBundle = Bundle(for: LiveConversationHostModel.self)
        let enPath = try XCTUnwrap(appBundle.path(forResource: "en", ofType: "lproj"))
        let zhPath = try XCTUnwrap(appBundle.path(forResource: "zh-Hans", ofType: "lproj"))
        let enBundle = try XCTUnwrap(Bundle(path: enPath))
        let zhBundle = try XCTUnwrap(Bundle(path: zhPath))

        let keys = [
            "conversation.message.sending_note",
            "conversation.message.pending_ack_note",
            "conversation.reply.sending",
            "conversation.reply.waiting_for_cloud",
            "conversation.reply.streaming",
            "conversation.reply.cancel_cloud_turn",
            "conversation.live.message_accepted",
            "conversation.live.send_unknown_ack_message",
            "conversation.live.send_unknown_ack_status",
            "conversation.live.retry_unknown_ack_message",
            "conversation.live.send_service_unavailable_message",
            "conversation.live.send_service_unavailable_status",
            "conversation.live.send_conflict_message",
            "conversation.live.send_rejected",
            "conversation.live.send_rejected_status",
            "conversation.live.previous_rejected_message",
            "conversation.live.stream_interrupted_checking",
            "conversation.live.reply_interrupted_message",
            "conversation.live.reply_interrupted_status",
            "conversation.live.load_unavailable_message",
            "conversation.live.load_unavailable_status",
            "conversation.live.connection_unavailable",
            "conversation.live.retry_sync_unavailable",
            "conversation.live.refresh_unavailable",
            "conversation.live.waiting_for_cloud",
            "conversation.live.checking_status",
            "conversation.live.turn_failed",
            "conversation.live.turn_cancelled",
            "conversation.live.cancel_requested",
            "conversation.live.cancel_status_unknown",
            "conversation.live.sign_in_prompt",
            "conversation.live.sign_in_cancelled",
            "conversation.live.sign_in_not_allowlisted",
            "conversation.live.sign_in_failed",
            "auth.error.apple_cancelled",
            "auth.error.keychain_unavailable",
            "auth.error.network_unreachable",
            "auth.error.server_unavailable",
            "auth.error.rate_limited",
            "auth.error.session_invalid",
            "auth.error.access_denied",
            "auth.error.rotation_unknown",
            "auth.error.recovery_fence_unavailable",
            "auth.error.stored_session_corrupt",
            "auth.error.unexpected_response",
            "auth.error.invalid_base_url",
            "auth.error.apple_incomplete",
            "auth.error.superseded",
            "auth.error.request_not_completed",
        ]

        let disallowedTerms = ["send id", "receipt", "reconcile", "allowlist", "mock response"]

        for key in keys {
            let enValue = enBundle.localizedString(forKey: key, value: "__MISSING__", table: "Conversation")
            let zhValue = zhBundle.localizedString(forKey: key, value: "__MISSING__", table: "Conversation")

            XCTAssertNotEqual(enValue, "__MISSING__", "Missing English localization for \(key)")
            XCTAssertNotEqual(zhValue, "__MISSING__", "Missing zh-Hans localization for \(key)")
            XCTAssertNotEqual(enValue, key, "English fell back to raw key for \(key)")
            XCTAssertNotEqual(zhValue, key, "zh-Hans fell back to raw key for \(key)")
            XCTAssertFalse(enValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            XCTAssertFalse(zhValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            let loweredEn = enValue.lowercased()
            for term in disallowedTerms {
                XCTAssertFalse(loweredEn.contains(term), "Key \(key) exposes internal jargon '\(term)': \(enValue)")
            }
        }
    }

    // MARK: - Helpers

    private func makeHostModel(
        directory: URL,
        journal: LiveConversationJournal? = nil,
        supportsStreaming: Bool = false
    ) throws -> LiveConversationHostModel {
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
        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: journal ?? LiveConversationJournal(directory: directory),
            supportsStreaming: supportsStreaming
        )
        let taskRepo = LiveB1SessionTaskRepository(auth: auth)
        let model = LiveConversationHostModel(
            repository: repo,
            auth: auth,
            taskRepository: taskRepo
        )
        models.append(model)
        return model
    }

    private func makeTempDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ux03-recovery-tests-\(UUID().uuidString)", isDirectory: true)
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

private final class LockedInt: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Int
    init(_ initial: Int) { storage = initial }
    var value: Int { lock.withLock { storage } }
    func set(_ newValue: Int) { lock.withLock { storage = newValue } }
    func incrementAndGet() -> Int {
        lock.withLock {
            storage += 1
            return storage
        }
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
