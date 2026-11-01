import Foundation
import Observation

enum TaskJourneyRecordOrigin: Equatable, Sendable {
    case createdInThisSession
    case fixture(MockScenarioID)
}

struct TaskJourneyRecord: Identifiable, Equatable, Sendable {
    var id: UUID { task.taskID }
    var title: String
    var task: TaskDTO
    var events: [TaskEventDTO]
    var presentation: TaskPresentationState
    var origin: TaskJourneyRecordOrigin
    var outcomeFixture: MockOutcomeFixture?
    var approvalAvailability: MockApprovalAvailability
}

enum TaskJourneyInboxMode: Equatable {
    case localSession
    case noHistory
    case unauthorized
    case notFound
    case offline
}

enum TaskJourneyDemoError: Error, Equatable {
    case repositoryUnavailable
    case receiptUnknown
}

@MainActor
@Observable
final class TaskJourneySession {
    private(set) var records: [TaskJourneyRecord] = []
    private(set) var selectedTaskID: UUID?
    private(set) var startupError: String?
    private(set) var isCreating = false
    private(set) var cancellingTaskID: UUID?
    private(set) var cancelMessageByTaskID: [UUID: String] = [:]
    var inboxMode: TaskJourneyInboxMode = .localSession

    private let repository: (any TaskRepositoryProtocol)?
    private let provider: any MockScenarioProvider
    private var returnedFromBackground = false

    var selectedRecord: TaskJourneyRecord? {
        guard let selectedTaskID else { return nil }
        return records.first { $0.id == selectedTaskID }
    }

    init(
        repository injectedRepository: (any TaskRepositoryProtocol)? = nil,
        provider: any MockScenarioProvider = BundledMockScenarioProvider(),
        includeFixtureRecords: Bool = true
    ) {
        self.provider = provider

        do {
            let resolvedRepository = try injectedRepository ?? FakeTaskRepository(provider: provider)
            self.repository = resolvedRepository

            if includeFixtureRecords {
                loadFixtureRecords()
            }
            selectedTaskID = records.first?.id
        } catch {
            self.repository = nil
            startupError = "模拟资料暂不可用。此演示没有连接服务端。"
        }
    }

    func createNoteTask(
        note: String,
        idempotencyKey: String,
        simulateUnknownReceipt: Bool
    ) async throws -> TaskReceiptDTO {
        guard let repository else { throw TaskJourneyDemoError.repositoryUnavailable }
        let content = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { throw TaskJourneyDemoError.repositoryUnavailable }

        isCreating = true
        defer { isCreating = false }

        let request = CreateTaskRequestDTO.chat(
            agentID: Self.fixtureAgentID,
            prompt: "MOCK ONLY. Local preview input; no notes-to-actions task kind exists.\n\n\(content)",
            maxOutputTokens: 512,
            deadlineAt: nil
        )
        let receipt = try await repository.createTask(request, idempotencyKey: idempotencyKey)
        guard Self.isValidCreateReceipt(receipt) else {
            throw TaskJourneyDemoError.receiptUnknown
        }

        // Simulate a lost acknowledgement after the local fake accepted the request. Retrying
        // the unchanged draft and key returns the same receipt with replayed=true.
        if simulateUnknownReceipt {
            throw TaskJourneyDemoError.receiptUnknown
        }

        do {
            let task = try await repository.fetchTask(id: receipt.taskID)
            let eventPage = try await repository.fetchEvents(taskID: receipt.taskID, after: nil)
            let record = TaskJourneyRecord(
                title: "笔记整理 · 本机会话",
                task: task,
                events: eventPage.events,
                presentation: TaskPresentationState(
                    taskStatus: task.status,
                    connectionPhase: .connected,
                    commandInFlight: nil,
                    capability: .mockOnly
                ),
                origin: .createdInThisSession,
                outcomeFixture: nil,
                approvalAvailability: .notApplicable
            )
            records.insert(record, at: 0)
            selectedTaskID = task.taskID
            cancelMessageByTaskID[task.taskID] = nil
        } catch {
            // Follow-up display reads cannot undo a valid create receipt or trigger a new POST.
        }
        return receipt
    }

    private static func isValidCreateReceipt(_ receipt: TaskReceiptDTO) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: receipt.acceptedAt) != nil {
            return true
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: receipt.acceptedAt) != nil
    }

    func select(taskID: UUID) {
        guard records.contains(where: { $0.id == taskID }) else { return }
        selectedTaskID = taskID
        inboxMode = .localSession
    }

    func showInboxMode(_ mode: TaskJourneyInboxMode) {
        inboxMode = mode
    }

    func setConnectionPhase(_ phase: ConnectionPhase, taskID: UUID? = nil) {
        guard let targetID = taskID ?? selectedTaskID,
              let index = records.firstIndex(where: { $0.id == targetID }) else { return }
        var record = records[index]
        record.presentation = TaskPresentationState(
            taskStatus: record.task.status,
            connectionPhase: phase,
            commandInFlight: record.presentation.commandInFlight,
            capability: .mockOnly
        )
        records[index] = record
    }

    func cancel(taskID: UUID) async {
        guard let repository,
              let index = records.firstIndex(where: { $0.id == taskID }) else { return }

        cancellingTaskID = taskID
        var record = records[index]
        record.presentation = TaskPresentationState(
            taskStatus: record.task.status,
            connectionPhase: record.presentation.connectionPhase,
            commandInFlight: .cancellingTask,
            capability: .mockOnly
        )
        records[index] = record
        defer { cancellingTaskID = nil }

        do {
            let response = try await repository.cancelTask(id: taskID)
            try await refresh(taskID: taskID)

            if response.terminal, response.status == .completed {
                cancelMessageByTaskID[taskID] = "取消请求到达前任务已完成；演示没有把它误报为已取消。"
            } else if response.terminal, response.status == .cancelled {
                cancelMessageByTaskID[taskID] = "模拟任务已取消。"
            } else if response.cancelRequested {
                cancelMessageByTaskID[taskID] = "取消请求已收到，等待最终状态确认；当前状态仍是 \(Self.statusTitle(response.status))。"
            } else {
                cancelMessageByTaskID[taskID] = "任务状态仍为 \(Self.statusTitle(response.status))。"
            }
        } catch {
            cancelMessageByTaskID[taskID] = "模拟取消请求失败；任务状态保持不变。"
        }
    }

    func markSceneBackgrounded() {
        returnedFromBackground = true
    }

    func resumeAfterSceneReturn() async {
        guard returnedFromBackground else { return }
        returnedFromBackground = false
        guard let selectedTaskID, repository != nil else { return }

        setConnectionPhase(.connecting, taskID: selectedTaskID)
        do {
            try await refresh(taskID: selectedTaskID)
            setConnectionPhase(.connected, taskID: selectedTaskID)
        } catch {
            setConnectionPhase(.disconnected, taskID: selectedTaskID)
        }
    }

    func refresh(taskID: UUID) async throws {
        guard let repository,
              let index = records.firstIndex(where: { $0.id == taskID }) else { return }
        let task = try await repository.fetchTask(id: taskID)
        let events = try await repository.fetchEvents(taskID: taskID, after: nil).events
        var record = records[index]
        record.task = task
        record.events = events.sorted { $0.sequence < $1.sequence }
        record.presentation = TaskPresentationState(
            taskStatus: task.status,
            connectionPhase: record.presentation.connectionPhase,
            commandInFlight: nil,
            capability: .mockOnly
        )
        records[index] = record
    }

    private func loadFixtureRecords() {
        let scenarioIDs: [MockScenarioID] = [
            .queued,
            .running,
            .completed,
            .missingResult,
            .disconnectedReconnected,
            .cancelRace,
            .approvalUnavailable
        ]
        for scenarioID in scenarioIDs {
            guard let scenario = try? provider.load(scenarioID), let task = scenario.task else { continue }
            let connection = scenario.presentationStates.first?.connectionPhase ?? .connected
            records.append(
                TaskJourneyRecord(
                    title: Self.scenarioTitle(scenarioID),
                    task: task,
                    events: scenario.events.sorted { $0.sequence < $1.sequence },
                    presentation: TaskPresentationState(
                        taskStatus: task.status,
                        connectionPhase: connection,
                        commandInFlight: nil,
                        capability: .mockOnly
                    ),
                    origin: .fixture(scenarioID),
                    outcomeFixture: scenario.outcomeFixture,
                    approvalAvailability: scenario.approvalAvailability
                )
            )
        }
    }

    private static let fixtureAgentID = UUID(uuidString: "00000000-0000-4000-8000-000000000201")!

    static func statusTitle(_ status: TaskStatus) -> String {
        switch status {
        case .queued: "已接收 · 等待执行"
        case .running: "正在处理"
        case .waitingApproval: "等待确认"
        case .retryableFailed: "暂时受阻 · 等待重试"
        case .completed: "处理已结束"
        case .failed: "本次未完成"
        case .cancelled: "已取消"
        }
    }

    private static func scenarioTitle(_ scenarioID: MockScenarioID) -> String {
        switch scenarioID {
        case .receipt: "接收回执 fixture"
        case .queued: "排队中 fixture"
        case .running: "处理中 fixture"
        case .completed: "完成与样例成果 fixture"
        case .missingResult: "完成但无成果 fixture"
        case .disconnectedReconnected: "连接恢复 fixture"
        case .cancelRace: "取消竞态 fixture"
        case .approvalUnavailable: "审批不可用 fixture"
        }
    }
}
