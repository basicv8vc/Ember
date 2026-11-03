import XCTest
@testable import Ember

@MainActor
final class ConversationHostIntegrationTests: XCTestCase {
    func testLoadsPreloadedMultiTurnConversationIntoOrderedTranscriptEntries() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let model = ConversationHostModel(repository: repository)
        let taskSession = try makeTaskSession(linkedTaskID: ConversationFixtures.taskID)

        await model.load()

        let snapshot = try XCTUnwrap(model.snapshot)
        XCTAssertEqual(model.loadState, .loaded(snapshot))
        XCTAssertEqual(snapshot.conversation.id, ConversationFixtures.mainConversationID)
        XCTAssertEqual(snapshot.messages.map(\.sequence), Array(1...9))
        XCTAssertEqual(snapshot.assistantTurns.count, 3)

        let entries = ConversationTimelineAdapter.entries(
            from: snapshot,
            taskJourneySession: taskSession,
            onOpenTaskDetail: { _ in },
            onOpenCommitmentDetail: { _ in }
        )
        XCTAssertEqual(entries.count, 9)
        XCTAssertEqual(
            entries.map(\.id),
            snapshot.messages.map { "conversation-message-\($0.id.rawValue.uuidString.lowercased())" }
        )

        guard case .message(let first) = entries[0] else {
            return XCTFail("The first fixture slot should render as a native message bubble.")
        }
        XCTAssertEqual(first.author, .user)
        guard case .message(let second) = entries[1] else {
            return XCTFail("The second fixture slot should render as a native message bubble.")
        }
        XCTAssertEqual(second.author, .ember)
        guard case .inlineContent = entries[2] else {
            return XCTFail("The Task reference should render through the inline card slot.")
        }
        guard case .activity = entries[3] else {
            return XCTFail("The activity reference should render as an activity row.")
        }
        guard case .inlineContent = entries[6], case .inlineContent = entries[7] else {
            return XCTFail("Commitment and outcome references should render through inline card slots.")
        }
    }

    func testSendingPersistsUserTurnAndDeterministicEmberReply() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let model = ConversationHostModel(repository: repository, replyDelayNanoseconds: 0)
        await model.load()

        let text = "Help me plan the day."
        await model.send(text)
        await model.waitForReply()

        let snapshot = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        XCTAssertEqual(snapshot.messages.map(\.sequence), Array(1...11))
        XCTAssertEqual(snapshot.assistantTurns.count, 4)

        let userMessage = snapshot.messages[9]
        let emberMessage = snapshot.messages[10]
        guard case .user(let userText) = userMessage.kind else {
            return XCTFail("A submitted draft should be appended as a user message.")
        }
        guard case .ember(let replyText) = emberMessage.kind else {
            return XCTFail("The deterministic mock response should be appended as an Ember message.")
        }

        XCTAssertEqual(userText, text)
        XCTAssertEqual(replyText, ConversationHostModel.mockReply(for: text))
        XCTAssertEqual(userMessage.turnID, emberMessage.turnID)
        XCTAssertEqual(snapshot.assistantTurns.last?.triggeringMessageID, userMessage.id)
        XCTAssertEqual(model.replyState, .idle)
    }

    func testRepositorySequenceRemainsStableAcrossMultipleNewTurns() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let model = ConversationHostModel(repository: repository, replyDelayNanoseconds: 0)
        await model.load()

        await model.send("One new plan.")
        await model.waitForReply()
        await model.send("One more note.")
        await model.waitForReply()

        let snapshot = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        XCTAssertEqual(snapshot.messages.map(\.sequence), Array(1...13))
        XCTAssertEqual(snapshot.messages[9].turnID, snapshot.messages[10].turnID)
        XCTAssertEqual(snapshot.messages[11].turnID, snapshot.messages[12].turnID)
        XCTAssertNotEqual(snapshot.messages[9].turnID, snapshot.messages[11].turnID)
        XCTAssertEqual(snapshot.assistantTurns.count, 5)
    }

    func testSuggestedPromptPopulatesDraftWithoutSending() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let before = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        let prompt = "Help me reflect on this week."

        XCTAssertEqual(ConversationInteractionRules.promptSelection(prompt), .populateDraft(prompt))

        let after = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        XCTAssertEqual(after, before)
    }

    func testStoppingReplyDoesNotChangeAnyTaskStatus() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let taskSession = try makeTaskSession(linkedTaskID: ConversationFixtures.taskID)
        let statusesBefore = Dictionary(
            uniqueKeysWithValues: taskSession.records.map { ($0.id, $0.task.status) }
        )
        let model = ConversationHostModel(repository: repository, replyDelayNanoseconds: 60_000_000_000)
        await model.load()

        await model.send("Please plan the afternoon.")
        XCTAssertEqual(model.replyState, .generating)
        await model.stopReply()
        await model.waitForReply()

        let statusesAfter = Dictionary(
            uniqueKeysWithValues: taskSession.records.map { ($0.id, $0.task.status) }
        )
        XCTAssertEqual(statusesAfter, statusesBefore)
        XCTAssertEqual(model.replyState, .idle)

        let snapshot = try await repository.fetchConversation(id: ConversationFixtures.mainConversationID)
        XCTAssertEqual(snapshot.messages.count, 11)
        guard case .user = snapshot.messages[9].kind else {
            return XCTFail("Stopping the local mock reply should keep the submitted user message.")
        }
        XCTAssertFalse(snapshot.messages.contains {
            if case .ember = $0.kind { $0.turnID == snapshot.messages[9].turnID } else { false }
        })
        guard case .activity(let stoppedActivity) = snapshot.messages[10].kind else {
            return XCTFail("Stopping the mock reply should record a Conversation activity row.")
        }
        XCTAssertTrue(stoppedActivity.text.contains("No Ember task was cancelled"))
    }

    func testTaskReferencesResolveFromTheInjectedTaskSessionRecords() throws {
        let taskSession = try makeTaskSession(linkedTaskID: ConversationFixtures.taskID)

        let record = try XCTUnwrap(
            ConversationTimelineAdapter.taskRecord(
                withID: ConversationFixtures.taskID,
                in: taskSession.records
            )
        )

        XCTAssertEqual(record.task.taskID, ConversationFixtures.taskID)
        XCTAssertEqual(record.task.status, .completed)
    }

    func testMissingTaskAndUnreadableOutcomeStayUnavailable() throws {
        let taskSession = try makeTaskSession(linkedTaskID: ConversationFixtures.taskID)
        let missingTaskID = UUID(uuidString: "72000000-0000-4000-8000-000000000099")!

        XCTAssertNil(
            ConversationTimelineAdapter.taskRecord(withID: missingTaskID, in: taskSession.records)
        )
        XCTAssertNil(
            ConversationTimelineAdapter.outcomeRecord(
                for: .taskResult(taskID: missingTaskID),
                in: taskSession.records
            )
        )
        let missingTaskOutcome = ConversationTimelineAdapter.outcomePresentation(
            for: .taskResult(taskID: missingTaskID), taskRecords: taskSession.records
        )
        XCTAssertEqual(missingTaskOutcome.title, String(localized: "card.result", table: "ConversationCards"))
        XCTAssertNil(missingTaskOutcome.readableContent)
        XCTAssertFalse(missingTaskOutcome.isMockOnly)

        let missingResultRecord = try XCTUnwrap(
            taskSession.records.first { $0.origin == .fixture(.missingResult) }
        )
        let missingFixtureOutcome = ConversationTimelineAdapter.outcomePresentation(
            for: .taskResult(taskID: missingResultRecord.task.taskID),
            taskRecords: taskSession.records
        )
        XCTAssertEqual(missingFixtureOutcome.title, String(localized: "card.result", table: "ConversationCards"))
        XCTAssertNil(missingFixtureOutcome.readableContent)
        XCTAssertFalse(missingFixtureOutcome.isMockOnly)
    }

    func testOutcomeAdapterUsesRendererCompletedOnlyProtection() throws {
        let taskSession = try makeTaskSession(
            linkedTaskID: ConversationFixtures.taskID,
            staleOutcomeForQueuedTask: true
        )
        let queuedRecord = try XCTUnwrap(taskSession.records.first { $0.origin == .fixture(.queued) })

        let presentation = ConversationTimelineAdapter.outcomePresentation(
            for: .taskResult(taskID: queuedRecord.task.taskID),
            taskRecords: taskSession.records
        )

        XCTAssertEqual(
            presentation,
            ConversationCardRenderer.outcomePresentation(for: queuedRecord)
        )
        XCTAssertNil(presentation.readableContent)
        XCTAssertFalse(presentation.isMockOnly)
    }

    func testCommitmentReferenceMustMatchSharedRendererFixtureID() {
        let fixture = ConversationCardRenderer.commitmentFixture
        let knownReference = CommitmentReference(commitmentID: fixture.id)

        let resolved = ConversationTimelineAdapter.commitmentFixture(for: knownReference)
        XCTAssertEqual(resolved?.id, fixture.id)
        XCTAssertEqual(resolved?.title, fixture.title)
        XCTAssertEqual(resolved?.status, fixture.status)

        let unknownReference = CommitmentReference(
            commitmentID: UUID(uuidString: "72000000-0000-4000-8000-000000000099")!
        )
        XCTAssertNil(ConversationTimelineAdapter.commitmentFixture(for: unknownReference))
    }

    func testEmptyConversationLoadsAsEmptyState() async throws {
        let repository = try ConversationFixtures.makeRepository()
        let emptyID = ConversationFixtures.emptyConversation.conversation.id
        let model = ConversationHostModel(conversationID: emptyID, repository: repository)

        await model.load()

        XCTAssertEqual(model.loadState, .empty(ConversationFixtures.emptyConversation))
        XCTAssertTrue(model.showsEmptyState)
        XCTAssertTrue(try XCTUnwrap(model.snapshot).messages.isEmpty)
    }

    private func makeTaskSession(
        linkedTaskID: UUID,
        staleOutcomeForQueuedTask: Bool = false
    ) throws -> TaskJourneySession {
        let provider = ConversationTaskFixtureProvider(
            linkedTaskID: linkedTaskID,
            staleOutcomeForQueuedTask: staleOutcomeForQueuedTask
        )
        let repository = try FakeTaskRepository(provider: provider)
        return TaskJourneySession(repository: repository, provider: provider)
    }
}

private struct ConversationTaskFixtureProvider: MockScenarioProvider {
    let linkedTaskID: UUID
    let staleOutcomeForQueuedTask: Bool

    func load(_ scenarioID: MockScenarioID) throws -> MockTaskScenarioFixture {
        if scenarioID == .receipt {
            return MockTaskScenarioFixture(
                scenarioID: .receipt,
                receipt: TaskReceiptDTO(
                    taskID: UUID(uuidString: "79000000-0000-4000-8000-000000000001")!,
                    status: .queued,
                    acceptedAt: "2026-11-03T00:00:00Z",
                    replayed: false
                ),
                task: nil,
                events: [],
                cancelResponse: nil,
                snapshotAfterCancel: nil,
                eventAfterCancel: nil,
                approvalAvailability: .notApplicable,
                presentationStates: [],
                outcomeFixture: nil
            )
        }

        let taskID = scenarioID == .completed ? linkedTaskID : taskID(for: scenarioID)
        let status: TaskStatus
        switch scenarioID {
        case .receipt:
            status = .queued
        case .queued:
            status = .queued
        case .running, .disconnectedReconnected, .cancelRace:
            status = .running
        case .completed, .missingResult:
            status = .completed
        case .approvalUnavailable:
            status = .waitingApproval
        }

        let task = TaskDTO(
            taskID: taskID,
            agentID: UUID(uuidString: "79000000-0000-4000-8000-000000000201")!,
            kind: .mockChat,
            status: status,
            currentRunID: nil,
            attemptCount: 0,
            createdAt: "2026-11-03T00:00:00Z",
            updatedAt: "2026-11-03T00:00:00Z",
            deadlineAt: nil
        )
        let presentation = TaskPresentationState(
            taskStatus: status,
            connectionPhase: scenarioID == .disconnectedReconnected ? .disconnected : .connected,
            commandInFlight: nil,
            capability: .mockOnly
        )
        let outcome = scenarioID == .completed || (scenarioID == .queued && staleOutcomeForQueuedTask)
            ? MockOutcomeFixture(label: "MOCK ONLY result", content: "MOCK ONLY sample result")
            : nil

        return MockTaskScenarioFixture(
            scenarioID: scenarioID,
            receipt: nil,
            task: task,
            events: [],
            cancelResponse: nil,
            snapshotAfterCancel: nil,
            eventAfterCancel: nil,
            approvalAvailability: scenarioID == .approvalUnavailable ? .unavailable : .notApplicable,
            presentationStates: [presentation],
            outcomeFixture: outcome
        )
    }

    private func taskID(for scenarioID: MockScenarioID) -> UUID {
        let index = MockScenarioID.allCases.firstIndex(of: scenarioID) ?? 0
        return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", index + 1))!
    }
}
