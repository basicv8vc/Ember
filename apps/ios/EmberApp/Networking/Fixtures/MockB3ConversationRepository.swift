import Foundation

actor MockAuthController: LiveAuthControlling {
    private var isSignedIn = true
    private var cleanupHooks: [@Sendable () async -> Void] = []

    func signInWithApple() async throws -> EmberSessionRecord {
        isSignedIn = true
        return EmberSessionRecord(
            sessionID: UUID(uuidString: "00000000-0000-4000-8000-00000000b302")!,
            consumerID: UUID(uuidString: "00000000-0000-4000-8000-00000000b303")!,
            accessToken: EmberAccessToken("ems_mock_b3_session_token")!,
            expiresAt: Date().addingTimeInterval(3600),
            storedAt: Date()
        )
    }

    func logout() async -> LogoutOutcome {
        isSignedIn = false
        for hook in cleanupHooks {
            await hook()
        }
        return .revokedRemotely
    }

    func registerSignOutCleanup(_ hook: @escaping @Sendable () async -> Void) async {
        cleanupHooks.append(hook)
    }

    func signedInState() -> Bool {
        isSignedIn
    }
}

/// Mock B1-shaped conversation repository used by `--ember-mock-chat-tasks` UI verification
/// to drive `LiveConversationHost` with `task_reference`, `outcome_reference`, and normal chat.
actor MockB3ConversationRepository: LiveConversationServiceProtocol {
    static let consumerID = UUID(uuidString: "00000000-0000-4000-8000-00000000b303")!
    static let conversationID = ConversationID(
        rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b304")!
    )

    private let taskRepository: MockSessionTaskRepository
    private var messages: [ConversationMessage]
    private var pendingTurnID: UUID?

    init(taskRepository: MockSessionTaskRepository, initialUserMessages: [String] = []) {
        self.taskRepository = taskRepository
        self.messages = Self.buildMessages(extraUserTexts: initialUserMessages)
    }

    func bootstrap() async throws -> EmberMeDTO {
        let baseDate = Date(timeIntervalSince1970: 1_763_196_800)
        return EmberMeDTO(
            consumerID: Self.consumerID,
            agent: EmberMeDTO.Agent(
                agentID: MockSessionTaskRepository.agentID,
                displayName: "Ember (Mock)"
            ),
            conversation: EmberMeDTO.Conversation(
                conversationID: Self.conversationID.rawValue,
                transcriptEpoch: 0,
                createdAt: baseDate,
                updatedAt: Date()
            )
        )
    }

    func load() async throws -> ConversationSnapshot {
        let persistedMessages = await taskRepository.appendedUserMessages()
        messages = Self.buildMessages(extraUserTexts: persistedMessages)
        return ConversationSnapshot(
            conversation: Conversation(
                id: Self.conversationID,
                createdAt: Date(timeIntervalSince1970: 1_763_196_800),
                updatedAt: Date()
            ),
            messages: messages,
            assistantTurns: []
        )
    }

    func recoverAfterRelaunch() async throws -> ConversationSnapshot {
        try await load()
    }

    func pending() async throws -> LiveConversationJournal.Pending? { nil }

    func activeTurn() async throws -> LiveConversationJournal.Turn? { nil }

    func rejectedDraft() async throws -> LiveConversationJournal.Pending? { nil }

    func uploadAttachment(filename: String, mediaType: String, data: Data) async throws -> StagedUploadReceiptDTO {
        let safeName = B3AttachmentLimits.safeUploadFilename(filename, mediaType: mediaType)
        guard B3AttachmentLimits.allowedMediaTypes.contains(mediaType),
              data.count <= B3AttachmentLimits.maxFileBytes else {
            throw LiveB1Failure.rejected
        }
        let now = ISO8601DateFormatter().string(from: Date())
        let expires = ISO8601DateFormatter().string(from: Date().addingTimeInterval(86_400))
        return StagedUploadReceiptDTO(
            uploadID: UUID(),
            filename: safeName,
            mediaType: mediaType,
            size: data.count,
            sha256: String(repeating: "0", count: 64),
            expiresAt: expires,
            createdAt: now
        )
    }

    func send(text: String, attachmentIDs: [UUID] = []) async throws -> LiveB1Receipt {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, attachmentIDs.count <= B3AttachmentLimits.maxAttachmentsPerMessage else {
            throw LiveB1Failure.rejected
        }
        await taskRepository.recordUserMessage(trimmed)
        let persisted = await taskRepository.appendedUserMessages()
        messages = Self.buildMessages(extraUserTexts: persisted)

        let turnID = UUID()
        pendingTurnID = turnID
        let userSeq = max(1, messages.count - 1)
        return LiveB1Receipt(
            clientSubmissionID: UUID(),
            conversationID: Self.conversationID.rawValue,
            messageID: UUID(),
            sequence: userSeq,
            text: trimmed,
            turnID: turnID,
            transcriptEpoch: 0
        )
    }

    func reconcilePending() async throws -> LiveB1Receipt? { nil }

    func pollActiveTurn() async throws -> LiveB1Turn? {
        guard let turnID = pendingTurnID else { return nil }
        pendingTurnID = nil
        return LiveB1Turn(
            id: turnID,
            conversationID: Self.conversationID.rawValue,
            status: .completed
        )
    }

    func cancelActiveTurn() async throws -> LiveB1Turn? {
        let turnID = pendingTurnID ?? UUID()
        pendingTurnID = nil
        return LiveB1Turn(
            id: turnID,
            conversationID: Self.conversationID.rawValue,
            status: .cancelled
        )
    }

    func clearOnLogout() async {
        pendingTurnID = nil
    }

    private static func buildMessages(extraUserTexts: [String]) -> [ConversationMessage] {
        let t0 = Date(timeIntervalSince1970: 1_763_196_800)
        var list: [ConversationMessage] = [
            ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b321")!),
                conversationID: conversationID,
                sequence: 1,
                createdAt: t0,
                kind: .user(text: "Please pull out Q4 launch action items from my meeting notes.")
            ),
            ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b322")!),
                conversationID: conversationID,
                sequence: 2,
                createdAt: t0.addingTimeInterval(15),
                kind: .ember(text: "[SIMULATED] I started a Notes action-items task. Track persisted status in the card below:")
            ),
            ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b323")!),
                conversationID: conversationID,
                sequence: 3,
                createdAt: t0.addingTimeInterval(20),
                kind: .taskReference(TaskReference(taskID: MockSessionTaskRepository.notesTaskID))
            ),
            ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b324")!),
                conversationID: conversationID,
                sequence: 4,
                createdAt: t0.addingTimeInterval(120),
                kind: .outcomeReference(.taskResult(taskID: MockSessionTaskRepository.notesTaskID))
            ),
            ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b325")!),
                conversationID: conversationID,
                sequence: 5,
                createdAt: t0.addingTimeInterval(240),
                kind: .user(text: "Also summarize the customer interview transcript when ready.")
            ),
            ConversationMessage(
                id: MessageID(rawValue: UUID(uuidString: "00000000-0000-4000-8000-00000000b326")!),
                conversationID: conversationID,
                sequence: 6,
                createdAt: t0.addingTimeInterval(250),
                kind: .taskReference(TaskReference(taskID: MockSessionTaskRepository.runningTaskID))
            ),
        ]

        var nextSeq = 7
        for (offset, text) in extraUserTexts.enumerated() {
            let suffix = String(format: "%04x", 0xB400 + offset * 2)
            let replySuffix = String(format: "%04x", 0xB401 + offset * 2)
            let userMsgID = UUID(uuidString: "00000000-0000-4000-8000-00000000\(suffix)")!
            let emberMsgID = UUID(uuidString: "00000000-0000-4000-8000-00000000\(replySuffix)")!

            list.append(ConversationMessage(
                id: MessageID(rawValue: userMsgID),
                conversationID: conversationID,
                sequence: nextSeq,
                createdAt: t0.addingTimeInterval(Double(300 + offset * 20)),
                kind: .user(text: text)
            ))
            nextSeq += 1

            list.append(ConversationMessage(
                id: MessageID(rawValue: emberMsgID),
                conversationID: conversationID,
                sequence: nextSeq,
                createdAt: t0.addingTimeInterval(Double(302 + offset * 20)),
                kind: .ember(text: "[SIMULATED] Noted: \"\(text)\" — normal conversation stays in Chat while task work runs separately.")
            ))
            nextSeq += 1
        }
        return list
    }
}
