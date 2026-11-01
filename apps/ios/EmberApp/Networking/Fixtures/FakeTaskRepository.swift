import Foundation

public enum FakeTaskRepositoryError: Error, Equatable {
    case taskNotFound
    case receiptFixtureMissing
}

/// A fixed, in-memory repository for previews and deterministic UI tests.
///
/// It returns the bundled receipt for each first idempotency key and marks a repeated key
/// as replayed. It does not execute the submitted input or produce a real task outcome.
public actor FakeTaskRepository: TaskRepositoryProtocol {
    private let receipt: TaskReceiptDTO
    private var tasks: [UUID: TaskDTO] = [:]
    private var taskScenarios: [UUID: MockTaskScenarioFixture] = [:]
    private var events: [UUID: [TaskEventDTO]] = [:]
    private var receiptsByIdempotencyKey: [String: TaskReceiptDTO] = [:]
    private var cancelRaceApplied = Set<UUID>()

    public init(provider: any MockScenarioProvider = BundledMockScenarioProvider()) throws {
        let receiptScenario = try provider.load(.receipt)
        guard let receipt = receiptScenario.receipt else {
            throw FakeTaskRepositoryError.receiptFixtureMissing
        }
        self.receipt = receipt

        for scenarioID in MockScenarioID.allCases where scenarioID != .receipt {
            let scenario = try provider.load(scenarioID)
            guard let task = scenario.task else { continue }
            taskScenarios[task.taskID] = scenario
            tasks[task.taskID] = task
            events[task.taskID] = scenario.events.sorted { $0.sequence < $1.sequence }
        }
    }

    public func createTask(
        _ request: CreateTaskRequestDTO,
        idempotencyKey: String
    ) async throws -> TaskReceiptDTO {
        _ = request
        if let existing = receiptsByIdempotencyKey[idempotencyKey] {
            return TaskReceiptDTO(
                taskID: existing.taskID,
                status: existing.status,
                acceptedAt: existing.acceptedAt,
                replayed: true
            )
        }

        let accepted = TaskReceiptDTO(
            taskID: receipt.taskID,
            status: receipt.status,
            acceptedAt: receipt.acceptedAt,
            replayed: false
        )
        receiptsByIdempotencyKey[idempotencyKey] = accepted
        return accepted
    }

    public func fetchTask(id: UUID) async throws -> TaskDTO {
        guard let task = tasks[id] else {
            throw FakeTaskRepositoryError.taskNotFound
        }
        return task
    }

    public func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> TaskEventPageDTO {
        guard tasks[taskID] != nil else {
            throw FakeTaskRepositoryError.taskNotFound
        }
        let cursor = sequence ?? 0
        let page = (events[taskID] ?? [])
            .filter { $0.sequence > cursor }
            .sorted { $0.sequence < $1.sequence }
            .prefix(100)
        return TaskEventPageDTO(taskID: taskID, events: Array(page))
    }

    public func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        guard let task = tasks[id] else {
            throw FakeTaskRepositoryError.taskNotFound
        }

        if let scenario = taskScenarios[id],
           scenario.scenarioID == .cancelRace,
           !cancelRaceApplied.contains(id),
           let response = scenario.cancelResponse {
            cancelRaceApplied.insert(id)
            if let completedTask = scenario.snapshotAfterCancel {
                tasks[id] = completedTask
            }
            if let completion = scenario.eventAfterCancel {
                var taskEvents = events[id] ?? []
                if !taskEvents.contains(where: { $0.sequence == completion.sequence }) {
                    taskEvents.append(completion)
                    events[id] = taskEvents.sorted { $0.sequence < $1.sequence }
                }
            }
            return response
        }

        let terminal = task.status == .completed || task.status == .failed || task.status == .cancelled
        return TaskCancelDTO(
            taskID: id,
            status: task.status,
            cancelRequested: !terminal,
            cancelRequestedAt: terminal ? nil : task.updatedAt,
            terminal: terminal,
            updatedAt: task.updatedAt
        )
    }
}
