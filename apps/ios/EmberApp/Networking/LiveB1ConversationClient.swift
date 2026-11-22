import Foundation

/// Live B1 wire adapter. No Mock fixtures or client-issued message/sequence identities.
enum LiveB1Failure: Error, Equatable, Sendable {
    case invalidResponse
    case rejected
    case notFound
    case conflict
    case unavailable
    case unknownAcknowledgement
    case staleEpoch
    case storageUnavailable
}

private struct LiveWireKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private enum LiveWire {
    static func key(_ name: String) -> LiveWireKey { LiveWireKey(stringValue: name)! }

    static func check(_ container: KeyedDecodingContainer<LiveWireKey>, allowed: Set<String>) throws {
        guard Set(container.allKeys.map(\.stringValue)).isSubset(of: allowed) else {
            throw LiveB1Failure.invalidResponse
        }
    }

    static func uuid(_ container: KeyedDecodingContainer<LiveWireKey>, _ name: String) throws -> UUID {
        let value = try container.decode(String.self, forKey: key(name))
        guard let id = UUID(uuidString: value) else { throw LiveB1Failure.invalidResponse }
        return id
    }

    static func date(_ container: KeyedDecodingContainer<LiveWireKey>, _ name: String) throws -> Date {
        let value = try container.decode(String.self, forKey: key(name))
        guard let date = EmberWireDate.parse(value) else { throw LiveB1Failure.invalidResponse }
        return date
    }

    static func integer(_ container: KeyedDecodingContainer<LiveWireKey>, _ name: String, min: Int = 0) throws -> Int {
        let number = try container.decode(Int.self, forKey: key(name))
        guard number >= min else { throw LiveB1Failure.invalidResponse }
        return number
    }
}

enum LiveB1OutcomeKind: String, Codable, Equatable, Sendable {
    case meaningfulChange = "meaningful_change"
    case noChange = "no_change"
    case failed
    case denied
}

/// A B1 history row, including the explicitly simulated Ember response marker.
struct LiveB1Message: Decodable, Sendable {
    enum Payload: Sendable {
        case user(String, submissionID: UUID)
        case ember(String, simulated: Bool, modelLabel: String)
        case activity(String, source: String)
        case task(UUID)
        case commitment(UUID)
        case outcome(taskID: UUID, outcomeKind: LiveB1OutcomeKind, commitmentID: UUID?)
    }

    let id: UUID
    let sequence: Int
    let createdAt: Date
    let payload: Payload

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: LiveWireKey.self)
        let kind = try c.decode(String.self, forKey: LiveWire.key("kind"))
        let base: Set<String> = ["message_id", "sequence", "created_at", "kind"]
        let fields: Set<String>
        switch kind {
        case "user": fields = ["text", "client_submission_id"]
        case "ember": fields = ["text", "model_label", "simulated"]
        case "activity": fields = ["text", "source"]
        case "task_reference": fields = ["task_id"]
        case "commitment_reference": fields = ["commitment_id"]
        case "outcome_reference": fields = ["outcome"]
        default: throw LiveB1Failure.invalidResponse
        }
        try LiveWire.check(c, allowed: base.union(fields))
        id = try LiveWire.uuid(c, "message_id")
        sequence = try LiveWire.integer(c, "sequence", min: 1)
        createdAt = try LiveWire.date(c, "created_at")
        switch kind {
        case "user":
            let text = try c.decode(String.self, forKey: LiveWire.key("text"))
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.count <= 4096 else { throw LiveB1Failure.invalidResponse }
            payload = .user(text, submissionID: try LiveWire.uuid(c, "client_submission_id"))
        case "ember":
            let text = try c.decode(String.self, forKey: LiveWire.key("text"))
            let label = try c.decode(String.self, forKey: LiveWire.key("model_label"))
            guard !text.isEmpty, text.count <= 8192, !label.isEmpty else {
                throw LiveB1Failure.invalidResponse
            }
            payload = .ember(text,
                simulated: try c.decode(Bool.self, forKey: LiveWire.key("simulated")),
                modelLabel: label)
        case "activity":
            let text = try c.decode(String.self, forKey: LiveWire.key("text"))
            let source = try c.decode(String.self, forKey: LiveWire.key("source"))
            guard !text.isEmpty, text.count <= 280, !source.isEmpty else {
                throw LiveB1Failure.invalidResponse
            }
            payload = .activity(text, source: source)
        case "task_reference": payload = .task(try LiveWire.uuid(c, "task_id"))
        case "commitment_reference": payload = .commitment(try LiveWire.uuid(c, "commitment_id"))
        case "outcome_reference":
            let outcome = try c.nestedContainer(keyedBy: LiveWireKey.self, forKey: LiveWire.key("outcome"))
            try LiveWire.check(outcome, allowed: ["outcome_kind", "task_id", "commitment_id"])
            let outcomeKind = try outcome.decode(LiveB1OutcomeKind.self, forKey: LiveWire.key("outcome_kind"))
            let commitmentID: UUID?
            if let rawCommitment = try outcome.decodeIfPresent(String.self, forKey: LiveWire.key("commitment_id")) {
                guard let parsed = UUID(uuidString: rawCommitment) else {
                    throw LiveB1Failure.invalidResponse
                }
                commitmentID = parsed
            } else {
                commitmentID = nil
            }
            payload = .outcome(
                taskID: try LiveWire.uuid(outcome, "task_id"),
                outcomeKind: outcomeKind,
                commitmentID: commitmentID
            )
        default: throw LiveB1Failure.invalidResponse
        }
    }

    func domainMessage(conversationID: ConversationID) -> ConversationMessage {
        let kind: ConversationMessageKind
        switch payload {
        case .user(let text, _): kind = .user(text: text)
        case .ember(let text, let simulated, _):
            kind = .ember(text: simulated ? "[SIMULATED] " + text : text)
        case .activity(let text, _):
            kind = .activity(ActivityMessage(text: text, source: .system))
        case .task(let id): kind = .taskReference(TaskReference(taskID: id))
        case .commitment(let id):
            kind = .commitmentReference(CommitmentReference(commitmentID: id))
        case .outcome(let id, _, _): kind = .outcomeReference(.taskResult(taskID: id))
        }
        return ConversationMessage(
            id: MessageID(rawValue: id),
            conversationID: conversationID,
            sequence: sequence,
            createdAt: createdAt,
            kind: kind)
    }
}

struct LiveB1Page: Decodable, Sendable {
    let conversationID: UUID
    let transcriptEpoch: Int
    let messages: [LiveB1Message]
    let nextAfter: Int
    let hasMore: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: LiveWireKey.self)
        try LiveWire.check(c, allowed: ["conversation_id", "transcript_epoch", "messages", "next_after", "has_more"])
        conversationID = try LiveWire.uuid(c, "conversation_id")
        transcriptEpoch = try LiveWire.integer(c, "transcript_epoch")
        messages = try c.decode([LiveB1Message].self, forKey: LiveWire.key("messages"))
        nextAfter = try LiveWire.integer(c, "next_after")
        hasMore = try c.decode(Bool.self, forKey: LiveWire.key("has_more"))
        guard messages.count <= 100 else { throw LiveB1Failure.invalidResponse }
        for index in messages.indices.dropFirst()
        where messages[index].sequence <= messages[index - 1].sequence {
            throw LiveB1Failure.invalidResponse
        }
        if let last = messages.last, last.sequence != nextAfter {
            throw LiveB1Failure.invalidResponse
        }
    }
}

struct LiveB1Receipt: Decodable, Sendable {
    let clientSubmissionID: UUID
    let conversationID: UUID
    let messageID: UUID
    let sequence: Int
    let text: String
    let createdAt: Date
    let turnID: UUID
    let transcriptEpoch: Int

    init(
        clientSubmissionID: UUID,
        conversationID: UUID,
        messageID: UUID,
        sequence: Int,
        text: String,
        createdAt: Date = Date(),
        turnID: UUID,
        transcriptEpoch: Int
    ) {
        self.clientSubmissionID = clientSubmissionID
        self.conversationID = conversationID
        self.messageID = messageID
        self.sequence = sequence
        self.text = text
        self.createdAt = createdAt
        self.turnID = turnID
        self.transcriptEpoch = transcriptEpoch
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: LiveWireKey.self)
        try LiveWire.check(c, allowed: ["message", "turn", "transcript_epoch"])
        transcriptEpoch = try LiveWire.integer(c, "transcript_epoch")
        let m = try c.nestedContainer(keyedBy: LiveWireKey.self, forKey: LiveWire.key("message"))
        try LiveWire.check(m, allowed: ["message_id", "conversation_id", "sequence",
                                        "created_at", "kind", "text", "client_submission_id"])
        guard try m.decode(String.self, forKey: LiveWire.key("kind")) == "user" else {
            throw LiveB1Failure.invalidResponse
        }
        messageID = try LiveWire.uuid(m, "message_id")
        conversationID = try LiveWire.uuid(m, "conversation_id")
        clientSubmissionID = try LiveWire.uuid(m, "client_submission_id")
        sequence = try LiveWire.integer(m, "sequence", min: 1)
        createdAt = try LiveWire.date(m, "created_at")
        text = try m.decode(String.self, forKey: LiveWire.key("text"))
        guard !text.isEmpty, text.count <= 4096 else { throw LiveB1Failure.invalidResponse }
        let t = try c.nestedContainer(keyedBy: LiveWireKey.self, forKey: LiveWire.key("turn"))
        try LiveWire.check(t, allowed: ["turn_id", "status", "created_at"])
        guard try t.decode(String.self, forKey: LiveWire.key("status")) == "running" else {
            throw LiveB1Failure.invalidResponse
        }
        turnID = try LiveWire.uuid(t, "turn_id")
        _ = try LiveWire.date(t, "created_at")
    }
}

enum LiveV2StreamEvent: Sendable {
    case delta(turnID: UUID, text: String)
    case committed(turn: LiveB1Turn, responseMessageID: UUID, sequence: Int)
    case handedOff(turnID: UUID, status: LiveB1Turn.Status)
}

enum LiveV2StreamFallbackError: Error, Equatable, Sendable {
    case endpointUnavailable
}

struct LiveB1Turn: Decodable, Sendable {
    enum Status: String, Decodable, Sendable { case running, completed, failed, cancelled }
    let id: UUID
    let conversationID: UUID
    let status: Status

    init(id: UUID, conversationID: UUID, status: Status) {
        self.id = id
        self.conversationID = conversationID
        self.status = status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: LiveWireKey.self)
        try LiveWire.check(c, allowed: ["turn_id", "conversation_id", "source_message_id",
                                         "status", "created_at", "updated_at",
                                         "response_message_id", "failure_reason"])
        id = try LiveWire.uuid(c, "turn_id")
        conversationID = try LiveWire.uuid(c, "conversation_id")
        _ = try LiveWire.uuid(c, "source_message_id")
        _ = try LiveWire.date(c, "created_at")
        _ = try LiveWire.date(c, "updated_at")
        status = try c.decode(Status.self, forKey: LiveWire.key("status"))
        let response = try c.decodeIfPresent(String.self, forKey: LiveWire.key("response_message_id"))
        if let response, UUID(uuidString: response) == nil { throw LiveB1Failure.invalidResponse }
        let reason = try c.decodeIfPresent(String.self, forKey: LiveWire.key("failure_reason"))
        if status == .completed || status == .failed {
            guard response != nil else { throw LiveB1Failure.invalidResponse }
        }
        if status == .failed {
            guard reason == "timeout" || reason == "internal_error" else {
                throw LiveB1Failure.invalidResponse
            }
        } else if reason != nil { throw LiveB1Failure.invalidResponse }
    }
}

/// All B1 calls go through the L1 actor. Only this adapter knows wire routes and statuses.
struct LiveB1ConversationClient: Sendable {
    let auth: LiveAuthSessionCoordinator

    func bootstrap() async throws -> EmberMeDTO { try await auth.restoreSession() }

    func uploadAttachment(filename: String, mediaType: String, data: Data) async throws -> StagedUploadReceiptDTO {
        let normalizedType = B3AttachmentLimits.normalizedMediaType(mediaType)
        let safeFilename = B3AttachmentLimits.safeUploadFilename(filename, mediaType: normalizedType)
        guard B3AttachmentLimits.isSafeMediaType(normalizedType),
              data.count <= B3AttachmentLimits.maxFileBytes else {
            throw LiveB1Failure.rejected
        }
        let response = try await Self.sendMultipartUpload(
            using: auth,
            filename: safeFilename,
            mediaType: normalizedType,
            data: data
        )
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.uploadFailure(response.statusCode)
        }
        let receipt = try decode(StagedUploadReceiptDTO.self, response.data)
        guard receipt.size == data.count else {
            throw LiveB1Failure.invalidResponse
        }
        return receipt
    }

    static func sendMultipartUpload(
        using auth: LiveAuthSessionCoordinator,
        filename: String,
        mediaType: String,
        data: Data
    ) async throws -> EmberAPIResponse {
        let boundary = "EmberBoundary-\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let body = makeMultipartUploadBody(
            boundary: boundary,
            filename: filename,
            mediaType: mediaType,
            fileData: data
        )
        return try await auth.authorizedRequest(EmberAuthenticatedRequest(
            method: "POST",
            pathComponents: ["v1", "me", "uploads"],
            body: body,
            contentType: "multipart/form-data; boundary=\(boundary)",
            idempotency: .nonIdempotent(clientSubmissionID: nil)
        ))
    }

    private static func makeMultipartUploadBody(
        boundary: String,
        filename: String,
        mediaType: String,
        fileData: Data
    ) -> Data {
        var body = Data()
        func appendUTF8(_ string: String) {
            body.append(Data(string.utf8))
        }

        appendUTF8("--\(boundary)\r\n")
        appendUTF8("Content-Disposition: form-data; name=\"filename\"\r\n\r\n")
        appendUTF8("\(filename)\r\n")

        appendUTF8("--\(boundary)\r\n")
        appendUTF8("Content-Disposition: form-data; name=\"media_type\"\r\n\r\n")
        appendUTF8("\(mediaType)\r\n")

        appendUTF8("--\(boundary)\r\n")
        appendUTF8("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
        appendUTF8("Content-Type: \(mediaType)\r\n\r\n")
        body.append(fileData)
        appendUTF8("\r\n--\(boundary)--\r\n")
        return body
    }

    func send(_ submission: ConversationSubmission) async throws -> LiveB1Receipt {
        let body = try encodeSubmissionBody(submission)
        let response = try await auth.authorizedRequest(EmberAuthenticatedRequest(
            method: "POST",
            pathComponents: ["v1", "conversations",
                             submission.conversationID.rawValue.uuidString.lowercased(), "messages"],
            body: body, contentType: "application/json",
            idempotency: .nonIdempotent(clientSubmissionID: submission.clientSubmissionID.uuidString)))
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.failure(response.statusCode)
        }
        let receipt = try decode(LiveB1Receipt.self, response.data)
        try validate(receipt, for: submission)
        return receipt
    }

    func streamSend(
        _ submission: ConversationSubmission
    ) async throws -> (receipt: LiveB1Receipt, events: AsyncThrowingStream<LiveV2StreamEvent, Error>) {
        let body = try encodeSubmissionBody(submission)
        let response = try await auth.authorizedStreamRequest(EmberAuthenticatedRequest(
            method: "POST",
            pathComponents: ["v2", "conversations",
                             submission.conversationID.rawValue.uuidString.lowercased(), "messages", "stream"],
            body: body,
            contentType: "application/json",
            accept: "text/event-stream",
            idempotency: .nonIdempotent(clientSubmissionID: submission.clientSubmissionID.uuidString)))
        if response.statusCode == 404 {
            throw LiveV2StreamFallbackError.endpointUnavailable
        }
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.failure(response.statusCode)
        }
        if let contentType = response.contentType,
           !contentType.lowercased().contains("text/event-stream") {
            throw LiveV2StreamFallbackError.endpointUnavailable
        }

        var capturedContinuation: AsyncThrowingStream<LiveV2StreamEvent, Error>.Continuation?
        let stream = AsyncThrowingStream<LiveV2StreamEvent, Error> { continuation in
            capturedContinuation = continuation
        }
        guard let eventContinuation = capturedContinuation else {
            throw LiveB1Failure.invalidResponse
        }

        let gate = AcceptedStreamGate()
        let readerTask = Task {
            var parser = ServerSentEventParser()
            var acceptedReceipt: LiveB1Receipt?

            do {
                for try await byte in response.bytes {
                    try Task.checkCancellation()
                    let frames = try parser.append(byte)
                    for frame in frames {
                        if acceptedReceipt == nil {
                            guard frame.event == "turn.accepted" else { continue }
                            let receipt = try decode(LiveB1Receipt.self, Data(frame.data.utf8))
                            try validate(receipt, for: submission)
                            acceptedReceipt = receipt
                            gate.resume(returning: receipt)
                            continue
                        }
                        guard let currentReceipt = acceptedReceipt else { continue }
                        if let event = try decodeStreamEvent(frame, receipt: currentReceipt) {
                            eventContinuation.yield(event)
                        }
                    }
                }
                if acceptedReceipt == nil {
                    gate.resume(throwing: LiveB1Failure.unknownAcknowledgement)
                    eventContinuation.finish()
                } else {
                    eventContinuation.finish()
                }
            } catch {
                if acceptedReceipt == nil {
                    gate.resume(throwing: LiveB1Failure.unknownAcknowledgement)
                    eventContinuation.finish()
                } else {
                    eventContinuation.finish(throwing: error)
                }
            }
        }

        eventContinuation.onTermination = { _ in
            readerTask.cancel()
        }

        let receipt = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.install(continuation)
            }
        } onCancel: {
            readerTask.cancel()
            gate.resume(throwing: CancellationError())
        }

        return (receipt, stream)
    }

    private func encodeSubmissionBody(_ submission: ConversationSubmission) throws -> Data {
        struct Body: Encodable {
            let client_submission_id: String
            let text: String
            let transcript_epoch: Int64
            let attachment_ids: [String]?
        }
        let attachmentIDs = submission.attachmentIDs.isEmpty
            ? nil
            : submission.attachmentIDs.map { $0.uuidString.lowercased() }
        return try JSONEncoder().encode(Body(
            client_submission_id: submission.clientSubmissionID.uuidString.lowercased(),
            text: submission.text,
            transcript_epoch: submission.transcriptEpoch,
            attachment_ids: attachmentIDs))
    }

    private func decodeStreamEvent(
        _ frame: ServerSentEventFrame,
        receipt: LiveB1Receipt
    ) throws -> LiveV2StreamEvent? {
        struct DeltaPayload: Decodable {
            let turn_id: UUID
            let text: String
        }
        struct CommittedPayload: Decodable {
            let turn: LiveB1Turn
            let response_message_id: UUID
            let sequence: Int
        }
        struct HandedOffPayload: Decodable {
            let turn_id: UUID
            let status: LiveB1Turn.Status
        }

        let data = Data(frame.data.utf8)
        switch frame.event {
        case "turn.delta":
            let payload = try decode(DeltaPayload.self, data)
            guard payload.turn_id == receipt.turnID else { return nil }
            return .delta(turnID: payload.turn_id, text: payload.text)
        case "turn.committed":
            let payload = try decode(CommittedPayload.self, data)
            guard payload.turn.id == receipt.turnID,
                  payload.turn.conversationID == receipt.conversationID else {
                throw LiveB1Failure.invalidResponse
            }
            return .committed(
                turn: payload.turn,
                responseMessageID: payload.response_message_id,
                sequence: payload.sequence
            )
        case "turn.handed_off":
            let payload = try decode(HandedOffPayload.self, data)
            guard payload.turn_id == receipt.turnID else { return nil }
            return .handedOff(turnID: payload.turn_id, status: payload.status)
        default:
            return nil
        }
    }

    func lookup(_ submissionID: UUID) async throws -> LiveB1Receipt? {
        let response = try await auth.authorizedRequest(.read(pathComponents: [
            "v1", "message-submissions", submissionID.uuidString.lowercased()
        ]))
        if response.statusCode == 404 { return nil }
        guard response.statusCode == 200 else { throw Self.failure(response.statusCode) }
        return try decode(LiveB1Receipt.self, response.data)
    }

    func page(conversationID: UUID, after: Int, limit: Int = 50) async throws -> LiveB1Page {
        guard after >= 0, (1...100).contains(limit) else { throw LiveB1Failure.invalidResponse }
        let response = try await auth.authorizedRequest(EmberAuthenticatedRequest(
            method: "GET",
            pathComponents: ["v1", "conversations", conversationID.uuidString.lowercased(), "messages"],
            idempotency: .idempotentRead,
            queryItems: [URLQueryItem(name: "after", value: String(after)),
                         URLQueryItem(name: "limit", value: String(limit))]))
        guard response.statusCode == 200 else { throw Self.failure(response.statusCode) }
        let page = try decode(LiveB1Page.self, response.data)
        guard page.conversationID == conversationID else { throw LiveB1Failure.invalidResponse }
        return page
    }

    func turn(conversationID: UUID, turnID: UUID) async throws -> LiveB1Turn {
        try await turnRequest(method: "GET", conversationID: conversationID, turnID: turnID)
    }

    func cancel(conversationID: UUID, turnID: UUID) async throws -> LiveB1Turn {
        try await turnRequest(method: "POST", conversationID: conversationID, turnID: turnID)
    }

    private func turnRequest(method: String, conversationID: UUID, turnID: UUID) async throws -> LiveB1Turn {
        var path = ["v1", "conversations", conversationID.uuidString.lowercased(),
                    "turns", turnID.uuidString.lowercased()]
        if method == "POST" { path.append("cancel") }
        let response = try await auth.authorizedRequest(EmberAuthenticatedRequest(
            method: method, pathComponents: path,
            idempotency: method == "GET" ? .idempotentRead : .nonIdempotent(clientSubmissionID: nil)))
        guard response.statusCode == 200 else { throw Self.failure(response.statusCode) }
        let value = try decode(LiveB1Turn.self, response.data)
        guard value.id == turnID, value.conversationID == conversationID else {
            throw LiveB1Failure.invalidResponse
        }
        return value
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw LiveB1Failure.invalidResponse }
    }

    private func validate(_ receipt: LiveB1Receipt, for submission: ConversationSubmission) throws {
        guard receipt.clientSubmissionID == submission.clientSubmissionID,
              receipt.conversationID == submission.conversationID.rawValue,
              Int64(receipt.transcriptEpoch) == submission.transcriptEpoch,
              receipt.text == submission.text else { throw LiveB1Failure.invalidResponse }
    }

    private static func failure(_ code: Int) -> LiveB1Failure {
        switch code {
        case 401, 403: .rejected
        case 404: .notFound
        case 409: .conflict
        case 429, 500...599: .unavailable
        default: .invalidResponse
        }
    }

    private static func uploadFailure(_ code: Int) -> LiveB1Failure {
        switch code {
        case 400, 401, 403: .rejected
        case 404: .notFound
        case 409: .conflict
        case 429, 500...599: .unavailable
        default: .invalidResponse
        }
    }
}

private final class AcceptedStreamGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<LiveB1Receipt, Error>?
    private var pendingResult: Result<LiveB1Receipt, Error>?
    private var settled = false

    func install(_ continuation: CheckedContinuation<LiveB1Receipt, Error>) {
        let immediate: Result<LiveB1Receipt, Error>? = lock.withLock {
            if let pendingResult {
                self.pendingResult = nil
                return pendingResult
            }
            self.continuation = continuation
            return nil
        }
        if let immediate {
            continuation.resume(with: immediate)
        }
    }

    func resume(returning receipt: LiveB1Receipt) {
        complete(with: .success(receipt))
    }

    func resume(throwing error: Error) {
        complete(with: .failure(error))
    }

    private func complete(with result: Result<LiveB1Receipt, Error>) {
        let target: CheckedContinuation<LiveB1Receipt, Error>? = lock.withLock {
            guard !settled else { return nil }
            settled = true
            if let continuation {
                self.continuation = nil
                return continuation
            }
            self.pendingResult = result
            return nil
        }
        target?.resume(with: result)
    }
}
