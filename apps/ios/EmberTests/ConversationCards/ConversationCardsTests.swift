import XCTest
@testable import Ember

final class ConversationCardsTests: XCTestCase {
    func testAcceptedEventDoesNotImplyTaskStartedOrCompleted() {
        let event = makeEvent(phase: .accepted)

        let facts = ActivityEventRow.facts(for: event)

        XCTAssertEqual(facts.titleKey, "card.event.accepted")
        XCTAssertNil(facts.fromStatus)
        XCTAssertNil(facts.toStatus)
    }

    func testEventPreservesStatusTransitionAndCancellationRequestSeparately() {
        let event = makeEvent(
            phase: .progress,
            payload: TaskEventPayloadDTO(
                fromStatus: .running,
                toStatus: .running,
                cancelRequested: true,
                simulated: true
            )
        )

        let facts = ActivityEventRow.facts(for: event)

        XCTAssertEqual(facts.titleKey, "card.event.progress")
        XCTAssertEqual(facts.fromStatus, .running)
        XCTAssertEqual(facts.toStatus, .running)
        XCTAssertTrue(facts.cancelRequested)
        XCTAssertTrue(facts.isMockOnly)
    }

    func testTaskCancellationIsPendingOnlyWhenRequestWasAcceptedAndNonterminal() {
        let task = makeTask(status: .running)
        let pending = TaskCancelDTO(
            taskID: task.taskID,
            status: .running,
            cancelRequested: true,
            cancelRequestedAt: "2026-11-02T01:00:00Z",
            terminal: false,
            updatedAt: "2026-11-02T01:00:00Z"
        )
        let terminal = TaskCancelDTO(
            taskID: task.taskID,
            status: .completed,
            cancelRequested: false,
            cancelRequestedAt: nil,
            terminal: true,
            updatedAt: "2026-11-02T01:00:01Z"
        )

        XCTAssertTrue(TaskActivityCard.facts(
            for: task,
            presentation: makePresentation(connection: .connected),
            cancelResponse: pending
        ).cancellationPending)
        XCTAssertFalse(TaskActivityCard.facts(
            for: makeTask(status: .completed),
            presentation: makePresentation(connection: .connected),
            cancelResponse: terminal
        ).cancellationPending)
        XCTAssertFalse(TaskActivityCard.facts(
            for: makeTask(status: .running),
            presentation: makePresentation(connection: .connected),
            cancelResponse: nil
        ).cancellationPending)
    }

    func testCancellationResponseForAnotherTaskDoesNotAppearOnThisCard() {
        let task = makeTask(status: .running)
        let responseForAnotherTask = TaskCancelDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000102")!,
            status: .running,
            cancelRequested: true,
            cancelRequestedAt: "2026-11-02T01:00:00Z",
            terminal: false,
            updatedAt: "2026-11-02T01:00:00Z"
        )

        let facts = TaskActivityCard.facts(
            for: task,
            presentation: makePresentation(connection: .connected),
            cancelResponse: responseForAnotherTask
        )

        XCTAssertFalse(facts.cancellationPending)
    }

    func testTerminalTaskSnapshotSuppressesStalePendingCancellationResponse() {
        for status in [TaskStatus.completed, .failed, .cancelled] {
            let task = makeTask(status: status)
            let stalePendingResponse = TaskCancelDTO(
                taskID: task.taskID,
                status: .running,
                cancelRequested: true,
                cancelRequestedAt: "2026-11-02T01:00:00Z",
                terminal: false,
                updatedAt: "2026-11-02T01:00:00Z"
            )

            let facts = TaskActivityCard.facts(
                for: task,
                presentation: makePresentation(connection: .connected),
                cancelResponse: stalePendingResponse
            )

            XCTAssertFalse(facts.cancellationPending, "\(status.rawValue) Tasks must not show cancellation pending")
        }
    }

    func testConnectionLossAndCancelRequestDoNotRewriteTaskStatus() {
        let task = makeTask(status: .running)
        let cancellation = TaskCancelDTO(
            taskID: task.taskID,
            status: .running,
            cancelRequested: true,
            cancelRequestedAt: "2026-11-02T01:00:00Z",
            terminal: false,
            updatedAt: "2026-11-02T01:00:00Z"
        )

        let facts = TaskActivityCard.facts(
            for: task,
            presentation: makePresentation(connection: .disconnected, command: .cancellingTask),
            cancelResponse: cancellation
        )

        XCTAssertEqual(facts.status, .running)
        XCTAssertEqual(facts.connectionPhase, .disconnected)
        XCTAssertEqual(facts.commandInFlight, .cancellingTask)
        XCTAssertTrue(facts.cancellationPending)
    }

    func testTaskCardUsesTaskSnapshotStatusInsteadOfConversationPresentationStatus() {
        let facts = TaskActivityCard.facts(
            for: makeTask(status: .completed),
            presentation: makePresentation(taskStatus: .queued, connection: .connected),
            cancelResponse: nil
        )

        XCTAssertEqual(facts.status, .completed)
    }

    func testCommitmentCardOmitsScheduleWhenNoUsableScheduleDataExists() {
        XCTAssertNil(CommitmentCard.schedulePresentation(for: nil))
        XCTAssertNil(CommitmentCard.schedulePresentation(for: .interval(seconds: nil, nextDueAt: "not-a-date")))
        XCTAssertNil(CommitmentCard.schedulePresentation(for: .interval(seconds: 0, nextDueAt: nil)))
    }

    func testCommitmentCardSupportsEveryLifecycleStatus() {
        XCTAssertEqual(CommitmentCard.Status.allCases, [.active, .paused, .completed, .cancelled])
    }

    func testCommitmentCardRetainsOnlyTheSuppliedScheduleFacts() throws {
        let dueAt = "2026-11-03T09:00:00Z"
        let presentation = try XCTUnwrap(
            CommitmentCard.schedulePresentation(for: .interval(seconds: 3_600, nextDueAt: dueAt))
        )

        XCTAssertEqual(presentation.kind, .interval)
        XCTAssertNotNil(presentation.intervalDescription)
        XCTAssertEqual(presentation.nextDueAt, ConversationCardFormatting.date(from: dueAt))
    }

    func testOutcomeCopyAndShareContentRequiresReadableText() {
        XCTAssertFalse(OutcomeCard.hasReadableContent(nil))
        XCTAssertFalse(OutcomeCard.hasReadableContent(" \n\t "))
        XCTAssertTrue(OutcomeCard.hasReadableContent("A readable result"))
    }

    private func makeEvent(
        phase: TaskEventPhase,
        payload: TaskEventPayloadDTO = TaskEventPayloadDTO()
    ) -> TaskEventDTO {
        TaskEventDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            sequence: 1,
            phase: phase,
            occurredAt: "2026-11-02T01:00:00Z",
            traceID: UUID(uuidString: "00000000-0000-4000-8000-000000000301")!,
            payload: payload
        )
    }

    private func makeTask(status: TaskStatus) -> TaskDTO {
        TaskDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            agentID: UUID(uuidString: "00000000-0000-4000-8000-000000000201")!,
            kind: .mockChat,
            status: status,
            currentRunID: status == .running ? UUID(uuidString: "00000000-0000-4000-8000-000000000301")! : nil,
            attemptCount: status == .running ? 1 : 0,
            createdAt: "2026-11-02T00:00:00Z",
            updatedAt: "2026-11-02T01:00:00Z",
            deadlineAt: nil
        )
    }

    private func makePresentation(
        taskStatus: TaskStatus? = .running,
        connection: ConnectionPhase,
        command: TaskCommandInFlight? = nil
    ) -> TaskPresentationState {
        TaskPresentationState(
            taskStatus: taskStatus,
            connectionPhase: connection,
            commandInFlight: command,
            capability: .mockOnly
        )
    }
}
