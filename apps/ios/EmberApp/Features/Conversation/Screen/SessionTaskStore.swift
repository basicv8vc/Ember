import Foundation
import Observation

@MainActor @Observable
final class SessionTaskStore {
    private let repository: (any SessionTaskRepositoryProtocol)?
    private var generation: UInt64 = 0

    private(set) var tasksByID: [UUID: SessionTaskDTO] = [:]
    private(set) var eventsByTaskID: [UUID: [SessionTaskEventDTO]] = [:]
    private(set) var resultsByTaskID: [UUID: SessionTaskResultDTO] = [:]
    private(set) var cancelResponseByTaskID: [UUID: TaskCancelDTO] = [:]
    private(set) var missingTaskIDs: Set<UUID> = []
    private(set) var loadingDetailTaskIDs: Set<UUID> = []
    private(set) var cancellingTaskIDs: Set<UUID> = []
    private(set) var isLoadingList = false
    private(set) var listErrorMessage: String?
    private(set) var listEndpointUnavailable = false
    private(set) var detailErrorByTaskID: [UUID: String] = [:]
    private(set) var resultErrorByTaskID: [UUID: String] = [:]
    private(set) var cancelErrorByTaskID: [UUID: String] = [:]

    init(repository: (any SessionTaskRepositoryProtocol)? = nil) {
        self.repository = repository
    }

    var hasRepository: Bool { repository != nil }
    var isMockOnly: Bool { repository?.isMockOnly ?? false }

    var orderedTasks: [SessionTaskDTO] {
        tasksByID.values.sorted { lhs, rhs in
            if lhs.updatedDate != rhs.updatedDate {
                return lhs.updatedDate > rhs.updatedDate
            }
            if lhs.createdAt != rhs.createdAt {
                return lhs.createdAt > rhs.createdAt
            }
            return lhs.taskID.uuidString < rhs.taskID.uuidString
        }
    }

    func tasks(in group: SessionTaskStatusGroup) -> [SessionTaskDTO] {
        orderedTasks.filter { $0.status.sessionGroup == group }
    }

    var needsInterventionCount: Int {
        tasks(in: .needsIntervention).count
    }

    var inProgressCount: Int {
        tasks(in: .inProgress).count
    }

    func isMock(_ task: SessionTaskDTO?, result: SessionTaskResultDTO? = nil) -> Bool {
        isMockOnly || task?.kind.isMockOnly == true || result?.result?.simulated == true
    }

    func refreshAll(
        referencedTaskIDs: Set<UUID> = [],
        referencedResultTaskIDs: Set<UUID> = []
    ) async {
        guard let repository else { return }
        let startGeneration = generation
        isLoadingList = true
        listErrorMessage = nil
        listEndpointUnavailable = false
        defer {
            if generation == startGeneration {
                isLoadingList = false
            }
        }

        var fetchedIDs = Set<UUID>()
        do {
            let tasks = try await repository.listTasks()
            guard generation == startGeneration else { return }
            for task in tasks {
                tasksByID[task.taskID] = task
                missingTaskIDs.remove(task.taskID)
                fetchedIDs.insert(task.taskID)
            }
        } catch is CancellationError {
            return
        } catch let error as SessionTaskRepositoryError where error == .endpointNotReady {
            guard generation == startGeneration else { return }
            listEndpointUnavailable = true
        } catch {
            guard generation == startGeneration else { return }
            listErrorMessage = String(localized: "tasks.error.list_load", table: "Conversation")
        }

        let remainingIDs = referencedTaskIDs.subtracting(fetchedIDs)
        for taskID in remainingIDs {
            guard generation == startGeneration, !Task.isCancelled else { return }
            await refreshSingleTask(taskID, using: repository, generation: startGeneration)
        }

        let candidateResultIDs = referencedResultTaskIDs.union(
            tasksByID.values.filter { $0.status.isTerminal }.map(\.taskID)
        )
        for taskID in candidateResultIDs {
            guard generation == startGeneration, !Task.isCancelled else { return }
            if let task = tasksByID[taskID], !task.status.isTerminal, resultsByTaskID[taskID] == nil {
                continue
            }
            if resultsByTaskID[taskID]?.resultState == .available {
                continue
            }
            await refreshResult(taskID, using: repository, generation: startGeneration)
        }
    }

    func syncReferences(from snapshot: ConversationSnapshot?) async {
        let refs = Self.referencedIDs(in: snapshot)
        await refreshAll(
            referencedTaskIDs: refs.taskIDs,
            referencedResultTaskIDs: refs.resultTaskIDs
        )
    }

    func loadDetail(taskID: UUID) async {
        guard let repository else { return }
        let startGeneration = generation
        loadingDetailTaskIDs.insert(taskID)
        detailErrorByTaskID[taskID] = nil
        defer {
            if generation == startGeneration {
                loadingDetailTaskIDs.remove(taskID)
            }
        }

        await refreshSingleTask(taskID, using: repository, generation: startGeneration)
        guard generation == startGeneration, !Task.isCancelled else { return }

        let afterSequence = eventsByTaskID[taskID]?.last?.sequence
        do {
            let page = try await repository.fetchEvents(taskID: taskID, after: afterSequence)
            guard generation == startGeneration else { return }
            mergeEvents(page.events, for: taskID)
        } catch is CancellationError {
            return
        } catch let error as SessionTaskRepositoryError where error == .notFound {
            guard generation == startGeneration else { return }
            if tasksByID[taskID] == nil {
                missingTaskIDs.insert(taskID)
            }
        } catch {
            guard generation == startGeneration else { return }
            if detailErrorByTaskID[taskID] == nil {
                detailErrorByTaskID[taskID] = String(localized: "tasks.error.detail_load", table: "Conversation")
            }
        }

        if let task = tasksByID[taskID], task.status.isTerminal {
            await refreshResult(taskID, using: repository, generation: startGeneration)
        }
    }

    func cancelTask(taskID: UUID) async {
        guard let repository, !cancellingTaskIDs.contains(taskID) else { return }
        let startGeneration = generation
        cancellingTaskIDs.insert(taskID)
        cancelErrorByTaskID[taskID] = nil
        defer {
            if generation == startGeneration {
                cancellingTaskIDs.remove(taskID)
            }
        }

        do {
            let cancelDTO = try await repository.cancelTask(id: taskID)
            guard generation == startGeneration else { return }
            cancelResponseByTaskID[taskID] = cancelDTO
            await loadDetail(taskID: taskID)
        } catch is CancellationError {
            return
        } catch {
            guard generation == startGeneration else { return }
            cancelErrorByTaskID[taskID] = String(localized: "tasks.error.cancel_failed", table: "Conversation")
        }
    }

    func clear() {
        generation &+= 1
        tasksByID.removeAll()
        eventsByTaskID.removeAll()
        resultsByTaskID.removeAll()
        cancelResponseByTaskID.removeAll()
        missingTaskIDs.removeAll()
        loadingDetailTaskIDs.removeAll()
        cancellingTaskIDs.removeAll()
        isLoadingList = false
        listErrorMessage = nil
        listEndpointUnavailable = false
        detailErrorByTaskID.removeAll()
        resultErrorByTaskID.removeAll()
        cancelErrorByTaskID.removeAll()
    }

    private func refreshSingleTask(
        _ taskID: UUID,
        using repository: any SessionTaskRepositoryProtocol,
        generation startGeneration: UInt64
    ) async {
        do {
            let task = try await repository.fetchTask(id: taskID)
            guard generation == startGeneration else { return }
            tasksByID[taskID] = task
            missingTaskIDs.remove(taskID)
            detailErrorByTaskID[taskID] = nil
        } catch is CancellationError {
            return
        } catch let error as SessionTaskRepositoryError where error == .notFound {
            guard generation == startGeneration else { return }
            missingTaskIDs.insert(taskID)
            tasksByID.removeValue(forKey: taskID)
        } catch {
            guard generation == startGeneration else { return }
            detailErrorByTaskID[taskID] = String(localized: "tasks.error.detail_load", table: "Conversation")
        }
    }

    private func refreshResult(
        _ taskID: UUID,
        using repository: any SessionTaskRepositoryProtocol,
        generation startGeneration: UInt64
    ) async {
        do {
            let result = try await repository.fetchResult(taskID: taskID)
            guard generation == startGeneration else { return }
            resultsByTaskID[taskID] = result
            resultErrorByTaskID[taskID] = nil
        } catch is CancellationError {
            return
        } catch let error as SessionTaskRepositoryError where error == .notFound {
            // Unavailable or endpoint not yet populated for this task.
            guard generation == startGeneration else { return }
            resultErrorByTaskID[taskID] = nil
        } catch {
            guard generation == startGeneration else { return }
            resultErrorByTaskID[taskID] = String(localized: "tasks.error.result_load", table: "Conversation")
        }
    }

    private func mergeEvents(_ incoming: [SessionTaskEventDTO], for taskID: UUID) {
        guard !incoming.isEmpty else { return }
        var existingBySequence = Dictionary(
            uniqueKeysWithValues: (eventsByTaskID[taskID] ?? []).map { ($0.sequence, $0) }
        )
        for event in incoming {
            existingBySequence[event.sequence] = event
        }
        eventsByTaskID[taskID] = existingBySequence.values.sorted { $0.sequence < $1.sequence }
    }

    static func referencedIDs(in snapshot: ConversationSnapshot?) -> (taskIDs: Set<UUID>, resultTaskIDs: Set<UUID>) {
        guard let messages = snapshot?.messages else { return ([], []) }
        var taskIDs = Set<UUID>()
        var resultTaskIDs = Set<UUID>()
        for message in messages {
            switch message.kind {
            case .taskReference(let reference):
                taskIDs.insert(reference.taskID)
            case .outcomeReference(let outcome):
                switch outcome {
                case .taskResult(let taskID):
                    taskIDs.insert(taskID)
                    resultTaskIDs.insert(taskID)
                case .artifact(_, let taskID):
                    if let taskID {
                        taskIDs.insert(taskID)
                        resultTaskIDs.insert(taskID)
                    }
                case .commitmentOutcome:
                    break
                }
            case .user, .ember, .activity, .commitmentReference:
                break
            }
        }
        return (taskIDs, resultTaskIDs)
    }
}
