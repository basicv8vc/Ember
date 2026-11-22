import XCTest
@testable import Ember

final class TaskDetailPresentationTests: XCTestCase {
    func testCompletedOrdersResultAndFilesFirstBeforeProgressAndTechnicalDetails() {
        let withArtifacts = TaskDetailPresentation.sectionOrder(
            for: .completed,
            hasArtifacts: true,
            hasAvailableResult: true
        )
        XCTAssertEqual(withArtifacts, [.outcome, .artifacts, .progress, .technicalDetails])

        let withoutArtifacts = TaskDetailPresentation.sectionOrder(
            for: .completed,
            hasArtifacts: false,
            hasAvailableResult: true
        )
        XCTAssertEqual(withoutArtifacts, [.outcome, .progress, .technicalDetails])
    }

    func testWaitingApprovalOrdersUserActionRequiredFirst() {
        let withArtifacts = TaskDetailPresentation.sectionOrder(
            for: .waitingApproval,
            hasArtifacts: true
        )
        XCTAssertEqual(
            withArtifacts,
            [.actionRequired, .artifacts, .progress, .outcome, .technicalDetails]
        )

        let withoutArtifacts = TaskDetailPresentation.sectionOrder(
            for: .waitingApproval,
            hasArtifacts: false
        )
        XCTAssertEqual(
            withoutArtifacts,
            [.actionRequired, .progress, .outcome, .technicalDetails]
        )
    }

    func testRunningAndQueuedOrderRealProgressFirst() {
        for status in [TaskStatus.running, .queued] {
            XCTAssertEqual(
                TaskDetailPresentation.sectionOrder(for: status, hasArtifacts: true),
                [.progress, .artifacts, .cancelAction, .outcome, .technicalDetails]
            )
            XCTAssertEqual(
                TaskDetailPresentation.sectionOrder(for: status, hasArtifacts: false),
                [.progress, .cancelAction, .outcome, .technicalDetails]
            )
        }
    }

    func testRetryableFailedFailedAndCancelledOrderStatusGuidanceFirst() {
        XCTAssertEqual(
            TaskDetailPresentation.sectionOrder(for: .retryableFailed, hasArtifacts: true),
            [.statusGuidance, .progress, .artifacts, .cancelAction, .outcome, .technicalDetails]
        )

        XCTAssertEqual(
            TaskDetailPresentation.sectionOrder(
                for: .failed,
                hasArtifacts: true,
                hasAvailableResult: false
            ),
            [.statusGuidance, .artifacts, .progress, .outcome, .technicalDetails]
        )

        XCTAssertEqual(
            TaskDetailPresentation.sectionOrder(
                for: .failed,
                hasArtifacts: true,
                hasAvailableResult: true
            ),
            [.statusGuidance, .outcome, .artifacts, .progress, .technicalDetails]
        )

        XCTAssertEqual(
            TaskDetailPresentation.sectionOrder(for: .cancelled, hasArtifacts: false),
            [.statusGuidance, .progress, .outcome, .technicalDetails]
        )
    }

    func testOrderedArtifactsPlacesGeneratedRunOutputsBeforeUserInputs() {
        let user1 = makeArtifact(id: 1, filename: "notes.txt", createdBy: .user)
        let run1 = makeArtifact(id: 2, filename: "action_items.csv", createdBy: .run)
        let user2 = makeArtifact(id: 3, filename: "appendix.md", createdBy: .user)
        let run2 = makeArtifact(id: 4, filename: "summary.pdf", createdBy: .run)

        let ordered = TaskDetailPresentation.orderedArtifacts([user1, run1, user2, run2])
        XCTAssertEqual(ordered.map(\.displayFilename), [
            "action_items.csv",
            "summary.pdf",
            "notes.txt",
            "appendix.md",
        ])
    }

    func testLatestServerErrorCodeAndEventTitleUseSequenceOrder() {
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b314")!
        let traceID = UUID(uuidString: "00000000-0000-4000-8000-00000000b390")!

        let events = [
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 3,
                phase: .failed,
                occurredAt: "2026-11-15T08:05:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(errorCode: .executionTimeout)
            ),
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 1,
                phase: .accepted,
                occurredAt: "2026-11-15T08:00:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO()
            ),
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 2,
                phase: .retryScheduled,
                occurredAt: "2026-11-15T08:02:00Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(errorCode: .sandboxNotReady)
            ),
        ]

        XCTAssertEqual(TaskDetailPresentation.latestServerErrorCode(in: events), .executionTimeout)
        XCTAssertEqual(TaskDetailPresentation.latestEventTitleKey(in: events), "card.event.failed")
        XCTAssertNil(TaskDetailPresentation.latestServerErrorCode(in: []))
        XCTAssertNil(TaskDetailPresentation.latestEventTitleKey(in: []))
    }

    private func makeArtifact(
        id: Int,
        filename: String,
        createdBy: TaskArtifactCreator
    ) -> TaskArtifactItemDTO {
        TaskArtifactItemDTO(
            artifactID: UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", id))!,
            filename: filename,
            mediaType: "text/plain",
            size: 128,
            sha256: String(repeating: "a", count: 64),
            createdBy: createdBy,
            createdAt: "2026-11-15T09:02:00Z"
        )
    }
}
