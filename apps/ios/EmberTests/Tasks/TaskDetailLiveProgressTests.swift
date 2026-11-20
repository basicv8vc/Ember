import Foundation
import XCTest
@testable import Ember

@MainActor
final class TaskDetailLiveProgressTests: XCTestCase {
    func testObserveActiveDetailPollsIncrementallyUntilTerminalAndLoadsResultAndArtifacts() async throws {
        let taskID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001")!
        let artifactID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002")!
        let repo = ProgressiveDetailRepository(taskID: taskID, artifactID: artifactID)
        let store = SessionTaskStore(repository: repo)

        await store.observeActiveDetail(
            taskID: taskID,
            pollInterval: .milliseconds(10),
            maxPolls: 5
        )

        XCTAssertEqual(store.tasksByID[taskID]?.status, .completed)
        XCTAssertEqual(store.eventsByTaskID[taskID]?.map(\.sequence), [1, 2])
        XCTAssertEqual(store.resultsByTaskID[taskID]?.result?.summaryText, "Summary ready")
        XCTAssertEqual(store.artifactsByTaskID[taskID]?.map(\.artifactID), [artifactID])
        let fetchCount = await repo.fetchTaskCallCount
        XCTAssertEqual(fetchCount, 2, "Polling should stop immediately once the task reaches terminal state")
    }

    func testObserveActiveDetailStopsAtBoundedMaxPollsForLongRunningTask() async throws {
        let taskID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0003")!
        let repo = AlwaysRunningDetailRepository(taskID: taskID)
        let store = SessionTaskStore(repository: repo)

        await store.observeActiveDetail(
            taskID: taskID,
            pollInterval: .milliseconds(5),
            maxPolls: 2
        )

        XCTAssertEqual(store.tasksByID[taskID]?.status, .running)
        let fetchCount = await repo.fetchTaskCallCount
        XCTAssertEqual(fetchCount, 3, "Initial load + 2 bounded polls")
    }
}

private actor ProgressiveDetailRepository: SessionTaskRepositoryProtocol {
    nonisolated let isMockOnly: Bool = true
    let taskID: UUID
    let artifactID: UUID
    private let agentID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0099")!
    private let traceID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0088")!
    private(set) var fetchTaskCallCount = 0

    init(taskID: UUID, artifactID: UUID) {
        self.taskID = taskID
        self.artifactID = artifactID
    }

    func listTasks(after cursor: String?, limit: Int) async throws -> SessionTaskListDTO {
        SessionTaskListDTO(tasks: [])
    }

    func fetchTask(id: UUID) async throws -> SessionTaskDetailDTO {
        fetchTaskCallCount += 1
        let isDone = fetchTaskCallCount >= 2
        let task = SessionTaskDTO(
            taskID: taskID,
            agentID: agentID,
            kind: .pythonAgent,
            title: "Analyze sales CSV",
            status: isDone ? .completed : .running,
            attemptCount: 1,
            cancelRequested: false,
            createdAt: "2026-11-20T10:00:00Z",
            updatedAt: isDone ? "2026-11-20T10:00:05Z" : "2026-11-20T10:00:01Z",
            resultState: isDone ? nil : .pending
        )
        return SessionTaskDetailDTO(summary: task)
    }

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> SessionTaskEventPageDTO {
        let all = [
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 1,
                phase: .started,
                occurredAt: "2026-11-20T10:00:01Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(taskKind: .pythonAgent)
            ),
            SessionTaskEventDTO(
                taskID: taskID,
                sequence: 2,
                phase: .completed,
                occurredAt: "2026-11-20T10:00:05Z",
                traceID: traceID,
                payload: SessionTaskEventPayloadDTO(taskKind: .pythonAgent, artifactID: artifactID)
            ),
        ]
        let availableCount = fetchTaskCallCount >= 2 ? 2 : 1
        let after = sequence ?? 0
        let filtered = all.prefix(availableCount).filter { $0.sequence > after }
        return SessionTaskEventPageDTO(taskID: taskID, events: Array(filtered))
    }

    func fetchResult(taskID: UUID) async throws -> SessionTaskResultDTO {
        SessionTaskResultDTO(
            taskID: taskID,
            taskStatus: .completed,
            resultState: .available,
            result: SessionTaskTextResult(
                summaryText: "Summary ready",
                detailText: "Detailed markdown report",
                modelLabel: "fake-python-agent",
                simulated: true,
                producedAt: "2026-11-20T10:00:05Z"
            )
        )
    }

    func fetchArtifacts(taskID: UUID) async throws -> TaskArtifactsListDTO {
        if fetchTaskCallCount >= 2 {
            return TaskArtifactsListDTO(
                taskID: taskID,
                artifacts: [
                    TaskArtifactItemDTO(
                        artifactID: artifactID,
                        filename: "report.csv",
                        mediaType: "text/csv",
                        size: 128,
                        sha256: String(repeating: "a", count: 64),
                        createdBy: .run,
                        createdAt: "2026-11-20T10:00:05Z"
                    )
                ]
            )
        }
        return TaskArtifactsListDTO(taskID: taskID, artifacts: [])
    }

    func downloadArtifact(artifactID: UUID, filename: String, mediaType: String) async throws -> DownloadedTaskArtifact {
        throw SessionTaskRepositoryError.notFound
    }

    func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        throw SessionTaskRepositoryError.endpointNotReady
    }
}

private actor AlwaysRunningDetailRepository: SessionTaskRepositoryProtocol {
    nonisolated let isMockOnly: Bool = true
    let taskID: UUID
    private let agentID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0099")!
    private(set) var fetchTaskCallCount = 0

    init(taskID: UUID) {
        self.taskID = taskID
    }

    func listTasks(after cursor: String?, limit: Int) async throws -> SessionTaskListDTO {
        SessionTaskListDTO(tasks: [])
    }

    func fetchTask(id: UUID) async throws -> SessionTaskDetailDTO {
        fetchTaskCallCount += 1
        let task = SessionTaskDTO(
            taskID: taskID,
            agentID: agentID,
            kind: .pythonAgent,
            title: "Long running analysis",
            status: .running,
            attemptCount: 1,
            cancelRequested: false,
            createdAt: "2026-11-20T10:00:00Z",
            updatedAt: "2026-11-20T10:00:01Z",
            resultState: .pending
        )
        return SessionTaskDetailDTO(summary: task)
    }

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> SessionTaskEventPageDTO {
        SessionTaskEventPageDTO(taskID: taskID, events: [])
    }

    func fetchResult(taskID: UUID) async throws -> SessionTaskResultDTO {
        throw SessionTaskRepositoryError.notFound
    }

    func fetchArtifacts(taskID: UUID) async throws -> TaskArtifactsListDTO {
        TaskArtifactsListDTO(taskID: taskID, artifacts: [])
    }

    func downloadArtifact(artifactID: UUID, filename: String, mediaType: String) async throws -> DownloadedTaskArtifact {
        throw SessionTaskRepositoryError.notFound
    }

    func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        throw SessionTaskRepositoryError.endpointNotReady
    }
}
