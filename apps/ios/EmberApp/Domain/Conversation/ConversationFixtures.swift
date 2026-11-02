import Foundation

/// Deterministic mock data for UI previews and repository tests.
public enum ConversationFixtures {
    public static let mainConversationID = ConversationID(
        rawValue: UUID(uuidString: "71000000-0000-4000-8000-000000000001")!
    )
    public static let taskID = UUID(uuidString: "72000000-0000-4000-8000-000000000001")!
    public static let commitmentID = UUID(uuidString: "73000000-0000-4000-8000-000000000001")!
    public static let artifactID = UUID(uuidString: "74000000-0000-4000-8000-000000000001")!
    public static let outcomeID = UUID(uuidString: "75000000-0000-4000-8000-000000000001")!

    public static let firstTurnID = AssistantTurnID(
        rawValue: UUID(uuidString: "76000000-0000-4000-8000-000000000001")!
    )
    public static let secondTurnID = AssistantTurnID(
        rawValue: UUID(uuidString: "76000000-0000-4000-8000-000000000002")!
    )
    public static let thirdTurnID = AssistantTurnID(
        rawValue: UUID(uuidString: "76000000-0000-4000-8000-000000000003")!
    )

    private static let baseTime = Date(timeIntervalSince1970: 1_793_520_000)

    public static let mainConversation = try! makeMainConversation()
    public static let emptyConversation = ConversationSnapshot(
        conversation: Conversation(
            id: ConversationID(rawValue: UUID(uuidString: "71000000-0000-4000-8000-000000000002")!),
            createdAt: baseTime,
            updatedAt: baseTime
        ),
        messages: [],
        assistantTurns: []
    )

    public static func makeRepository() throws -> InMemoryConversationRepository {
        try InMemoryConversationRepository(fixtures: [mainConversation, emptyConversation])
    }

    private static func makeMainConversation() throws -> ConversationSnapshot {
        let conversation = Conversation(
            id: mainConversationID,
            createdAt: baseTime,
            updatedAt: baseTime.addingTimeInterval(90)
        )

        let userOneID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000001")!)
        let emberOneID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000002")!)
        let taskMessageID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000003")!)
        let activityMessageID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000004")!)
        let userTwoID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000005")!)
        let emberTwoID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000006")!)
        let commitmentMessageID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000007")!)
        let outcomeMessageID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000008")!)
        let userThreeID = MessageID(rawValue: UUID(uuidString: "77000000-0000-4000-8000-000000000009")!)

        let messages = [
            ConversationMessage(
                id: userOneID,
                conversationID: mainConversationID,
                sequence: 1,
                turnID: firstTurnID,
                createdAt: baseTime,
                kind: .user(text: "整理这周的会议笔记。")
            ),
            ConversationMessage(
                id: emberOneID,
                conversationID: mainConversationID,
                sequence: 2,
                turnID: firstTurnID,
                createdAt: baseTime.addingTimeInterval(5),
                kind: .ember(text: "我先按主题归纳，再列出可执行事项。")
            ),
            ConversationMessage(
                id: taskMessageID,
                conversationID: mainConversationID,
                sequence: 3,
                turnID: firstTurnID,
                createdAt: baseTime.addingTimeInterval(7),
                kind: .taskReference(TaskReference(taskID: taskID))
            ),
            ConversationMessage(
                id: activityMessageID,
                conversationID: mainConversationID,
                sequence: 4,
                turnID: firstTurnID,
                createdAt: baseTime.addingTimeInterval(8),
                kind: .activity(ActivityMessage(text: "整理任务已接收（演示数据）", source: .task))
            ),
            ConversationMessage(
                id: userTwoID,
                conversationID: mainConversationID,
                sequence: 5,
                turnID: secondTurnID,
                createdAt: baseTime.addingTimeInterval(30),
                kind: .user(text: "再加上负责人和优先级。")
            ),
            ConversationMessage(
                id: emberTwoID,
                conversationID: mainConversationID,
                sequence: 6,
                turnID: secondTurnID,
                createdAt: baseTime.addingTimeInterval(35),
                kind: .ember(text: "好的，我会把负责人和优先级放进清单。")
            ),
            ConversationMessage(
                id: commitmentMessageID,
                conversationID: mainConversationID,
                sequence: 7,
                turnID: secondTurnID,
                createdAt: baseTime.addingTimeInterval(40),
                kind: .commitmentReference(CommitmentReference(commitmentID: commitmentID))
            ),
            ConversationMessage(
                id: outcomeMessageID,
                conversationID: mainConversationID,
                sequence: 8,
                turnID: secondTurnID,
                createdAt: baseTime.addingTimeInterval(45),
                kind: .outcomeReference(
                    .artifact(artifactID: artifactID, taskID: taskID)
                )
            ),
            ConversationMessage(
                id: userThreeID,
                conversationID: mainConversationID,
                sequence: 9,
                turnID: thirdTurnID,
                createdAt: baseTime.addingTimeInterval(90),
                kind: .user(text: "把结果整理成一段简短摘要。")
            ),
        ]

        let turns = try [
            AssistantTurn(
                id: firstTurnID,
                conversationID: mainConversationID,
                triggeringMessage: messages[0],
                createdAt: baseTime
            ),
            AssistantTurn(
                id: secondTurnID,
                conversationID: mainConversationID,
                triggeringMessage: messages[4],
                createdAt: baseTime.addingTimeInterval(30)
            ),
            AssistantTurn(
                id: thirdTurnID,
                conversationID: mainConversationID,
                triggeringMessage: messages[8],
                createdAt: baseTime.addingTimeInterval(90)
            ),
        ]

        return ConversationSnapshot(
            conversation: conversation,
            messages: messages,
            assistantTurns: turns
        )
    }
}
