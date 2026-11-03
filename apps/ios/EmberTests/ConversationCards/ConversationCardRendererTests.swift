import XCTest
@testable import Ember

final class ConversationCardRendererTests: XCTestCase {
    func testTaskActivityPreservesQueuedRunningAndCompletedSnapshots() {
        for status in [TaskStatus.queued, .running, .completed] {
            let connection: ConnectionPhase = status == .running ? .connecting : .connected
            let command: TaskCommandInFlight? = status == .running ? .cancellingTask : nil
            let record = makeRecord(
                taskStatus: status,
                presentationStatus: status,
                connection: connection,
                command: command
            )

            let facts = TaskActivityCard.facts(
                for: record.task,
                presentation: record.presentation,
                cancelResponse: nil
            )

            XCTAssertEqual(facts.status, status)
            XCTAssertEqual(facts.connectionPhase, connection)
            XCTAssertEqual(facts.commandInFlight, command)
            XCTAssertFalse(facts.cancellationPending)
        }
    }

    func testTaskStatusRemainsIndependentFromConversationReplyState() {
        let conversationReplyState = ConversationReplyState.generating
        let record = makeRecord(
            taskStatus: .completed,
            presentationStatus: .queued,
            title: "The conversation is still waiting for a response"
        )

        let facts = TaskActivityCard.facts(
            for: record.task,
            presentation: record.presentation,
            cancelResponse: nil
        )

        XCTAssertEqual(conversationReplyState, .generating)
        XCTAssertEqual(facts.status, .completed)
        XCTAssertEqual(record.presentation.taskStatus, .queued)
    }

    func testActivityEventsRenderOnlySuppliedDTOsInSequenceOrder() {
        let last = makeEvent(sequence: 3, phase: .completed)
        let first = makeEvent(sequence: 1, phase: .accepted)
        let middle = makeEvent(
            sequence: 2,
            phase: .progress,
            payload: TaskEventPayloadDTO(
                attempt: 2,
                fromStatus: .running,
                toStatus: .running,
                simulated: true
            )
        )

        let ordered = ConversationCardRenderer.ActivityEvents.orderedEvents([last, first, middle])

        XCTAssertEqual(ordered, [first, middle, last])
        XCTAssertEqual(ordered.map(\.phase), [.accepted, .progress, .completed])
        XCTAssertEqual(ordered.count, 3, "Rendering must not add steps that are absent from the event DTOs")

        let progressFacts = ActivityEventRow.facts(for: ordered[1])
        XCTAssertEqual(progressFacts.titleKey, "card.event.progress")
        XCTAssertEqual(progressFacts.attempt, 2)
        XCTAssertEqual(progressFacts.fromStatus, .running)
        XCTAssertEqual(progressFacts.toStatus, .running)
        XCTAssertTrue(progressFacts.isMockOnly)
    }

    func testCommitmentUsesStableMockFixtureAndOmitsUnavailableSchedule() {
        let fixture = ConversationCardRenderer.commitmentFixture

        XCTAssertEqual(fixture.id, ConversationFixtures.commitmentID)
        XCTAssertEqual(fixture.title, "Review the weekly plan")
        XCTAssertEqual(fixture.status.rawValue, "active")
        XCTAssertTrue(fixture.isMockOnly)
        XCTAssertNil(fixture.schedule)
        XCTAssertNil(CommitmentCard.schedulePresentation(for: fixture.schedule))
    }

    func testOutcomeUsesReadableContentOnlyFromMockOutcomeFixture() {
        let fixture = MockOutcomeFixture(
            label: "固定演示清单",
            content: "固定演示结果，不来自当前对话。"
        )
        let record = makeRecord(taskStatus: .completed, outcomeFixture: fixture)

        let presentation = ConversationCardRenderer.outcomePresentation(for: record)

        XCTAssertEqual(presentation.title, fixture.label)
        XCTAssertEqual(presentation.readableContent, fixture.content)
        XCTAssertTrue(presentation.isMockOnly)
    }

    func testMissingOutcomeFixtureShowsUnavailableResultWithoutSyntheticContent() {
        let record = makeRecord(
            taskStatus: .completed,
            outcomeFixture: nil,
            title: "Conversation text that must not become a result"
        )

        let presentation = ConversationCardRenderer.outcomePresentation(for: record)

        XCTAssertEqual(presentation.title, String(localized: "card.result", table: "ConversationCards"))
        XCTAssertNil(presentation.readableContent)
        XCTAssertFalse(presentation.isMockOnly)
    }

    func testUnreadableOutcomeFixtureShowsUnavailableResultAndKeepsMockDisclosure() {
        let record = makeRecord(
            taskStatus: .completed,
            outcomeFixture: MockOutcomeFixture(label: "固定演示结果", content: " \n\t ")
        )

        let presentation = ConversationCardRenderer.outcomePresentation(for: record)

        XCTAssertEqual(presentation.title, "固定演示结果")
        XCTAssertNil(presentation.readableContent)
        XCTAssertTrue(presentation.isMockOnly)
    }

    private func makeRecord(
        taskStatus: TaskStatus,
        presentationStatus: TaskStatus? = nil,
        connection: ConnectionPhase = .connected,
        command: TaskCommandInFlight? = nil,
        events: [TaskEventDTO] = [],
        outcomeFixture: MockOutcomeFixture? = nil,
        title: String = "Task Activity · MOCK ONLY"
    ) -> TaskJourneyRecord {
        let task = TaskDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            agentID: UUID(uuidString: "00000000-0000-4000-8000-000000000201")!,
            kind: .mockChat,
            status: taskStatus,
            currentRunID: taskStatus == .running
                ? UUID(uuidString: "00000000-0000-4000-8000-000000000301")!
                : nil,
            attemptCount: taskStatus == .running ? 1 : 0,
            createdAt: "2026-11-02T00:00:00Z",
            updatedAt: "2026-11-02T01:00:00Z",
            deadlineAt: nil
        )

        return TaskJourneyRecord(
            title: title,
            task: task,
            events: events,
            presentation: TaskPresentationState(
                taskStatus: presentationStatus ?? taskStatus,
                connectionPhase: connection,
                commandInFlight: command,
                capability: .mockOnly
            ),
            origin: .createdInThisSession,
            outcomeFixture: outcomeFixture,
            approvalAvailability: .notApplicable
        )
    }

    private func makeEvent(
        sequence: Int,
        phase: TaskEventPhase,
        payload: TaskEventPayloadDTO = TaskEventPayloadDTO()
    ) -> TaskEventDTO {
        TaskEventDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            sequence: sequence,
            phase: phase,
            occurredAt: "2026-11-02T01:00:00Z",
            traceID: UUID(uuidString: "00000000-0000-4000-8000-000000000301")!,
            payload: payload
        )
    }
}
