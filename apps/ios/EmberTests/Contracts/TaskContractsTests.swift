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

    func testUnknownTaskEventPayloadKeysAreRejectedWithoutEchoingThem() throws {
        let running = try provider.load(.running)
        var event = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(running.events[0])) as? [String: Any]
        )
        var payload = try XCTUnwrap(event["payload"] as? [String: Any])
        payload["futureField"] = "do-not-echo"
        event["payload"] = payload
        let data = try JSONSerialization.data(withJSONObject: event)

        XCTAssertThrowsError(try JSONDecoder().decode(TaskEventDTO.self, from: data)) { error in
            XCTAssertFalse(String(describing: error).contains("futureField"))
            XCTAssertFalse(String(describing: error).contains("do-not-echo"))
        }
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
    func testSameKeyAndSameRequestReturnsTheSameTaskAndMarksReplay() async throws {
        let repository = try FakeTaskRepository()
        let secondRepository = try FakeTaskRepository()
        let request = CreateTaskRequestDTO.compute(
            agentID: UUID(uuidString: "00000000-0000-4000-8000-000000000201")!,
            text: "fixture",
            deadlineAt: nil
        )

        let first = try await repository.createTask(request, idempotencyKey: "fixture-key-01")
        let replay = try await repository.createTask(request, idempotencyKey: "fixture-key-01")
        let independent = try await secondRepository.createTask(request, idempotencyKey: "fixture-key-01")

        XCTAssertEqual(first.taskID, replay.taskID)
        XCTAssertEqual(first, independent)
        XCTAssertEqual(first.status, .queued)
        XCTAssertFalse(first.replayed)
        XCTAssertTrue(replay.replayed)
    }

    func testDifferentKeysCreateDistinctReadableTasksAndMatchingEvents() async throws {
        let repository = try FakeTaskRepository()
        let agentID = UUID(uuidString: "00000000-0000-4000-8000-000000000201")!
        let chat = CreateTaskRequestDTO.chat(
            agentID: agentID,
            prompt: "first fixture prompt",
            maxOutputTokens: 32,
            deadlineAt: nil
        )
        let compute = CreateTaskRequestDTO.compute(
            agentID: agentID,
            text: "second fixture input",
            deadlineAt: nil
        )

        let chatReceipt = try await repository.createTask(chat, idempotencyKey: "chat-key-01")
        let computeReceipt = try await repository.createTask(compute, idempotencyKey: "compute-key-02")
        let chatTask = try await repository.fetchTask(id: chatReceipt.taskID)
        let computeTask = try await repository.fetchTask(id: computeReceipt.taskID)
        let chatEvents = try await repository.fetchEvents(taskID: chatReceipt.taskID, after: nil)
        let computeEvents = try await repository.fetchEvents(taskID: computeReceipt.taskID, after: nil)

        XCTAssertNotEqual(chatReceipt.taskID, computeReceipt.taskID)
        XCTAssertEqual(chatTask.kind, .mockChat)
        XCTAssertEqual(computeTask.kind, .mockCompute)
        XCTAssertEqual(chatEvents.events.map(\.payload.taskKind), [.mockChat])
        XCTAssertEqual(computeEvents.events.map(\.payload.taskKind), [.mockCompute])
        XCTAssertEqual(chatEvents.events.first?.taskID, chatReceipt.taskID)
        XCTAssertEqual(computeEvents.events.first?.taskID, computeReceipt.taskID)
    }

    func testSameKeyWithDifferentRequestReturnsDeterministicNonEchoingConflict() async throws {
        let repository = try FakeTaskRepository()
        let agentID = UUID(uuidString: "00000000-0000-4000-8000-000000000201")!
        let original = CreateTaskRequestDTO.chat(
            agentID: agentID,
            prompt: "sensitive original prompt",
            maxOutputTokens: 32,
            deadlineAt: nil
        )
        let conflicting = CreateTaskRequestDTO.chat(
            agentID: agentID,
            prompt: "sensitive changed prompt",
            maxOutputTokens: 32,
            deadlineAt: nil
        )
        _ = try await repository.createTask(original, idempotencyKey: "conflict-key-03")

        for _ in 0..<2 {
            do {
                _ = try await repository.createTask(conflicting, idempotencyKey: "conflict-key-03")
                XCTFail("Expected an idempotency conflict")
            } catch let error as FakeTaskRepositoryError {
                XCTAssertEqual(error, .idempotencyConflict)
                XCTAssertFalse(String(describing: error).contains("sensitive"))
            }
        }
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
