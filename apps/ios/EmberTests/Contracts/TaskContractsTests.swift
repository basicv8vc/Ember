import Foundation
import XCTest
@testable import Ember

final class TaskContractsTests: XCTestCase {
    private let provider = BundledMockScenarioProvider()

    func testReceiptAndTaskSnapshotDecodeAuditedWireFields() throws {
        let receipt = try provider.load(.receipt).receipt
        let queued = try provider.load(.queued).task

        XCTAssertEqual(receipt?.status, .queued)
        XCTAssertFalse(receipt?.replayed ?? true)
        XCTAssertEqual(queued?.status, .queued)
        XCTAssertNil(queued?.currentRunID)
        XCTAssertEqual(queued?.kind, .mockChat)
    }

    func testEventsDecodeClosedVocabularyAndPreserveSequence() throws {
        let running = try provider.load(.running)

        XCTAssertEqual(running.events.map(\.sequence), [1, 2, 3])
        XCTAssertEqual(running.events[0].phase, .accepted)
        XCTAssertEqual(running.events[1].payload.runStatus, .running)
        XCTAssertEqual(running.events[2].payload.simulated, true)
        XCTAssertNil(running.events[2].payload.artifactID)
    }

    func testApprovalDTOUsesDigestOnlyShape() throws {
        let approval = try provider.loadApprovalFixture()

        XCTAssertEqual(approval.status, .pending)
        XCTAssertEqual(approval.actionDigest.count, 64)
        XCTAssertNil(approval.decidedAt)
    }

    func testAllRequiredScenariosAreDeterministicAndSeparateOutcomeFixtures() throws {
        for scenarioID in MockScenarioID.allCases {
            XCTAssertEqual(try provider.load(scenarioID).scenarioID, scenarioID)
        }

        let completed = try provider.load(.completed)
        let missing = try provider.load(.missingResult)
        let reconnect = try provider.load(.disconnectedReconnected)
        let approvalUnavailable = try provider.load(.approvalUnavailable)

        XCTAssertNotNil(completed.outcomeFixture)
        XCTAssertNil(missing.outcomeFixture)
        XCTAssertEqual(
            reconnect.presentationStates.map(\.connectionPhase),
            [.disconnected, .connecting, .connected]
        )
        XCTAssertTrue(reconnect.presentationStates.allSatisfy { $0.taskStatus == .running })
        XCTAssertEqual(approvalUnavailable.approvalAvailability, .unavailable)
        XCTAssertNil(approvalUnavailable.outcomeFixture)
    }

    func testPresentationStateKeepsServerAndLocalDimensionsIndependent() {
        let state = TaskPresentationState(
            taskStatus: .running,
            connectionPhase: .disconnected,
            commandInFlight: .creatingTask,
            capability: .mockOnly
        )

        XCTAssertEqual(state.taskStatus, .running)
        XCTAssertEqual(state.connectionPhase, .disconnected)
        XCTAssertEqual(state.commandInFlight, .creatingTask)
        XCTAssertEqual(state.capability, .mockOnly)
    }

    func testCreateTaskRequestEncodesOnlySupportedMockWireShape() throws {
        let request = CreateTaskRequestDTO.chat(
            agentID: UUID(uuidString: "00000000-0000-4000-8000-000000000201")!,
            prompt: "fixture prompt",
            maxOutputTokens: 32,
            deadlineAt: nil
        )
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let input = try XCTUnwrap(object["input"] as? [String: Any])

        XCTAssertEqual(object["agent_id"] as? String, "00000000-0000-4000-8000-000000000201")
        XCTAssertEqual(object["kind"] as? String, "mock.chat")
        XCTAssertEqual(input["prompt"] as? String, "fixture prompt")
        XCTAssertEqual(input["maxOutputTokens"] as? Int, 32)
        XCTAssertNil(object["idempotency_key"])
        XCTAssertNil(object["tenant_id"])
    }
}

final class FakeTaskRepositoryTests: XCTestCase {
    func testReceiptIsDeterministicAndSameKeyReplays() async throws {
        let repository = try FakeTaskRepository()
        let secondRepository = try FakeTaskRepository()
        let request = CreateTaskRequestDTO.compute(
            agentID: UUID(uuidString: "00000000-0000-4000-8000-000000000201")!,
            text: "fixture",
            deadlineAt: nil
        )

        let first = try await repository.createTask(request, idempotencyKey: "fixture-key-01")
        let replay = try await repository.createTask(request, idempotencyKey: "fixture-key-01")
        let independent = try await secondRepository.createTask(request, idempotencyKey: "other-key-02")

        XCTAssertEqual(first.taskID, replay.taskID)
        XCTAssertEqual(first, independent)
        XCTAssertEqual(first.status, .queued)
        XCTAssertFalse(first.replayed)
        XCTAssertTrue(replay.replayed)
    }

    func testEventCursorIsExclusiveAndPageIsOrdered() async throws {
        let repository = try FakeTaskRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-000000000102")!

        let page = try await repository.fetchEvents(taskID: taskID, after: 1)

        XCTAssertEqual(page.events.map(\.sequence), [2, 3])
        XCTAssertEqual(page.taskID, taskID)
    }

    func testCompletionWinsCancelRaceAndIsVisibleInSnapshotAndEvents() async throws {
        let repository = try FakeTaskRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-000000000106")!

        let before = try await repository.fetchTask(id: taskID)
        let cancellation = try await repository.cancelTask(id: taskID)
        let after = try await repository.fetchTask(id: taskID)
        let events = try await repository.fetchEvents(taskID: taskID, after: 2)

        XCTAssertEqual(before.status, .running)
        XCTAssertEqual(cancellation.status, .completed)
        XCTAssertTrue(cancellation.terminal)
        XCTAssertFalse(cancellation.cancelRequested)
        XCTAssertEqual(after.status, .completed)
        XCTAssertEqual(events.events.map(\.phase), [.completed])
    }

    func testCompletedTaskCanHaveNoReadableOutcome() throws {
        let scenario = try BundledMockScenarioProvider().load(.missingResult)

        XCTAssertEqual(scenario.task?.status, .completed)
        XCTAssertNil(scenario.outcomeFixture)
    }
}
