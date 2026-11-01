import CryptoKit
import Foundation

public enum FakeTaskRepositoryError: Error, Equatable {
    case taskNotFound
    case receiptFixtureMissing
    case idempotencyConflict
    case requestEncodingFailed
}

/// An in-memory repository for previews and deterministic UI tests.
///
/// New task IDs are derived from a namespaced hash of the idempotency key. The request body
/// is canonically encoded and hashed only for same-key conflict detection; raw input is not
/// retained in the idempotency record or included in errors. No task is actually executed.
public actor FakeTaskRepository: TaskRepositoryProtocol {
    private struct IdempotencyRecord {
        let requestDigest: String
        let receipt: TaskReceiptDTO
    }

    private let receiptTemplate: TaskReceiptDTO
    private var tasks: [UUID: TaskDTO] = [:]
    private var taskScenarios: [UUID: MockTaskScenarioFixture] = [:]
    private var events: [UUID: [TaskEventDTO]] = [:]
    private var receiptsByIdempotencyKey: [String: IdempotencyRecord] = [:]
    private var cancelRaceApplied = Set<UUID>()

    public init(provider: any MockScenarioProvider = BundledMockScenarioProvider()) throws {
        let receiptScenario = try provider.load(.receipt)
        guard let receipt = receiptScenario.receipt else {
            throw FakeTaskRepositoryError.receiptFixtureMissing
        }
        self.receiptTemplate = receipt

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
        let digest = try Self.requestDigest(request)
        if let existing = receiptsByIdempotencyKey[idempotencyKey] {
            guard existing.requestDigest == digest else {
                throw FakeTaskRepositoryError.idempotencyConflict
            }
            return TaskReceiptDTO(
                taskID: existing.receipt.taskID,
                status: existing.receipt.status,
                acceptedAt: existing.receipt.acceptedAt,
                replayed: true
            )
        }

        let taskID = Self.deterministicUUID(namespace: "ember.fake.task.v1", value: idempotencyKey)
        guard tasks[taskID] == nil else {
            throw FakeTaskRepositoryError.idempotencyConflict
        }

        let task = TaskDTO(
            taskID: taskID,
            agentID: request.agentID,
            kind: request.taskKind,
            status: receiptTemplate.status,
            currentRunID: nil,
            attemptCount: 0,
            createdAt: receiptTemplate.acceptedAt,
            updatedAt: receiptTemplate.acceptedAt,
            deadlineAt: request.deadlineAt
        )
        let event = TaskEventDTO(
            taskID: taskID,
            sequence: 1,
            phase: .accepted,
            occurredAt: receiptTemplate.acceptedAt,
            traceID: Self.deterministicUUID(namespace: "ember.fake.trace.v1", value: taskID.uuidString),
            payload: TaskEventPayloadDTO(taskKind: request.taskKind, replayed: false)
        )
        let accepted = TaskReceiptDTO(
            taskID: taskID,
            status: receiptTemplate.status,
            acceptedAt: receiptTemplate.acceptedAt,
            replayed: false
        )
        tasks[taskID] = task
        events[taskID] = [event]
        receiptsByIdempotencyKey[idempotencyKey] = IdempotencyRecord(
            requestDigest: digest,
            receipt: accepted
        )
        return accepted
    }

    private static func requestDigest(_ request: CreateTaskRequestDTO) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        do {
            let data = try encoder.encode(request)
            return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        } catch {
            throw FakeTaskRepositoryError.requestEncodingFailed
        }
    }

    private static func deterministicUUID(namespace: String, value: String) -> UUID {
        let data = Data("\(namespace)\u{0}\(value)".utf8)
        var bytes = Array(SHA256.hash(data: data).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x80
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
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

private extension CreateTaskRequestDTO {
    var agentID: UUID {
        switch self {
        case let .chat(agentID, _, _, _),
             let .compute(agentID, _, _),
             let .file(agentID, _, _, _, _),
             let .approval(agentID, _, _, _):
            return agentID
        }
    }

    var taskKind: TaskKind {
        switch self {
        case .chat:
            return .mockChat
        case .compute:
            return .mockCompute
        case .file:
            return .mockFile
        case .approval:
            return .mockApproval
        }
    }

    var deadlineAt: String? {
        switch self {
        case let .chat(_, _, _, deadlineAt),
             let .compute(_, _, deadlineAt),
             let .file(_, _, _, _, deadlineAt),
             let .approval(_, _, _, deadlineAt):
            return deadlineAt
        }
    }
}
