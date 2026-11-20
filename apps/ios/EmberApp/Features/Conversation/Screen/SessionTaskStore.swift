import CryptoKit
import Foundation
import Observation

enum PythonTaskSubmissionOutcome: Equatable, Sendable {
    case submitted(SessionTaskDTO, created: Bool)
    case unknownAcknowledgement
    case endpointNotReady
    case failed(String)
}

@MainActor @Observable
final class SessionTaskStore {
    private let repository: (any SessionTaskRepositoryProtocol)?
    private let pageSize: Int
    private var generation: UInt64 = 0

    private(set) var tasksByID: [UUID: SessionTaskDTO] = [:]
    private(set) var eventsByTaskID: [UUID: [SessionTaskEventDTO]] = [:]
    private(set) var resultsByTaskID: [UUID: SessionTaskResultDTO] = [:]
    private(set) var artifactsByTaskID: [UUID: [TaskArtifactItemDTO]] = [:]
    private(set) var cancelResponseByTaskID: [UUID: TaskCancelDTO] = [:]
    private(set) var missingTaskIDs: Set<UUID> = []
    private(set) var eventsUnavailableTaskIDs: Set<UUID> = []
    private(set) var artifactsUnavailableTaskIDs: Set<UUID> = []
    private(set) var loadingDetailTaskIDs: Set<UUID> = []
    private(set) var loadingArtifactsTaskIDs: Set<UUID> = []
    private(set) var downloadingArtifactIDs: Set<UUID> = []
    private(set) var downloadedArtifactFileByID: [UUID: URL] = [:]
    private(set) var downloadedArtifactPreviewByID: [UUID: String] = [:]
    private(set) var cancellingTaskIDs: Set<UUID> = []
    private(set) var isLoadingList = false
    private(set) var isLoadingMoreTasks = false
    private(set) var hasMoreTasks = false
    private(set) var nextTasksCursor: String?
    private(set) var listErrorMessage: String?
    private(set) var loadMoreErrorMessage: String?
    private(set) var listEndpointUnavailable = false
    private(set) var detailErrorByTaskID: [UUID: String] = [:]
    private(set) var resultErrorByTaskID: [UUID: String] = [:]
    private(set) var artifactListErrorByTaskID: [UUID: String] = [:]
    private(set) var artifactDownloadErrorByID: [UUID: String] = [:]
    private(set) var cancelErrorByTaskID: [UUID: String] = [:]

    init(repository: (any SessionTaskRepositoryProtocol)? = nil, pageSize: Int = 50) {
        self.repository = repository
        self.pageSize = min(max(pageSize, 1), 50)
    }

    var hasRepository: Bool { repository != nil }
    var isMockOnly: Bool { repository?.isMockOnly ?? false }
    var supportsPythonTaskSubmission: Bool { repository?.supportsPythonTaskSubmission ?? false }

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
        loadMoreErrorMessage = nil
        listEndpointUnavailable = false
        defer {
            if generation == startGeneration {
                isLoadingList = false
            }
        }

        var fetchedIDs = Set<UUID>()
        var fetchedTasksByID: [UUID: SessionTaskDTO] = [:]
        var listFetchSucceeded = false
        do {
            let page = try await repository.listTasks(after: nil, limit: pageSize)
            guard generation == startGeneration else { return }
            listFetchSucceeded = true
            for task in page.tasks {
                fetchedTasksByID[task.taskID] = task
                missingTaskIDs.remove(task.taskID)
                seedKnownUnavailableResult(for: task)
                fetchedIDs.insert(task.taskID)
            }
            nextTasksCursor = (page.nextAfter?.isEmpty == false) ? page.nextAfter : nil
            hasMoreTasks = page.hasMore ?? false
        } catch is CancellationError {
            return
        } catch let error as SessionTaskRepositoryError where error == .endpointNotReady {
            guard generation == startGeneration else { return }
            listEndpointUnavailable = true
            nextTasksCursor = nil
            hasMoreTasks = false
        } catch {
            guard generation == startGeneration else { return }
            listErrorMessage = String(localized: "tasks.error.list_load", table: "Conversation")
        }

        if listFetchSucceeded {
            // Preserve chat-referenced tasks that will be refreshed individually below while replacing stale list pages.
            let preservedReferenced = tasksByID.filter { referencedTaskIDs.contains($0.key) && fetchedTasksByID[$0.key] == nil }
            tasksByID = preservedReferenced.merging(fetchedTasksByID) { _, latest in latest }
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
            guard shouldFetchResult(for: taskID) else { continue }
            await refreshResult(taskID, using: repository, generation: startGeneration)
        }

        let terminalPythonIDs = tasksByID.values.filter { task in
            task.status.isTerminal &&
            (task.kind == .pythonAgent || task.kind == .pythonSandbox) &&
            artifactsByTaskID[task.taskID] == nil &&
            !artifactsUnavailableTaskIDs.contains(task.taskID)
        }.map(\.taskID)
        for taskID in terminalPythonIDs {
            guard generation == startGeneration, !Task.isCancelled else { return }
            await refreshArtifacts(taskID, using: repository, generation: startGeneration)
        }
    }

    func loadMoreTasks() async {
        guard let repository,
              !isLoadingList,
              !isLoadingMoreTasks,
              hasMoreTasks,
              let cursor = nextTasksCursor,
              !cursor.isEmpty
        else { return }

        let startGeneration = generation
        isLoadingMoreTasks = true
        loadMoreErrorMessage = nil
        defer {
            if generation == startGeneration {
                isLoadingMoreTasks = false
            }
        }

        do {
            let page = try await repository.listTasks(after: cursor, limit: pageSize)
            guard generation == startGeneration else { return }
            for task in page.tasks {
                tasksByID[task.taskID] = task
                missingTaskIDs.remove(task.taskID)
                seedKnownUnavailableResult(for: task)
            }
            let nextCursor = (page.nextAfter?.isEmpty == false) ? page.nextAfter : nil
            if page.tasks.isEmpty || nextCursor == cursor {
                nextTasksCursor = nil
                hasMoreTasks = false
            } else {
                nextTasksCursor = nextCursor
                hasMoreTasks = page.hasMore ?? false
            }

            let terminalIDs = page.tasks.filter { $0.status.isTerminal }.map(\.taskID)
            for taskID in terminalIDs {
                guard generation == startGeneration, !Task.isCancelled else { return }
                guard shouldFetchResult(for: taskID) else { continue }
                await refreshResult(taskID, using: repository, generation: startGeneration)
            }
        } catch is CancellationError {
            return
        } catch {
            guard generation == startGeneration else { return }
            loadMoreErrorMessage = String(localized: "tasks.error.list_load", table: "Conversation")
        }
    }

    func hasObservableInProgressTask(in snapshot: ConversationSnapshot?) -> Bool {
        let activeInStore = tasksByID.values.contains { task in
            !task.status.isTerminal && task.status != .waitingApproval
        }
        if activeInStore { return true }
        let referenced = Self.referencedIDs(in: snapshot).taskIDs
        return referenced.contains { taskID in
            !missingTaskIDs.contains(taskID) && tasksByID[taskID] == nil
        }
    }

    func syncReferences(from snapshot: ConversationSnapshot?) async {
        let refs = Self.referencedIDs(in: snapshot)
        await refreshAll(
            referencedTaskIDs: refs.taskIDs,
            referencedResultTaskIDs: refs.resultTaskIDs
        )
    }

    func loadDetail(taskID: UUID, silent: Bool = false) async {
        guard let repository else { return }
        let startGeneration = generation
        if !silent {
            loadingDetailTaskIDs.insert(taskID)
        }
        detailErrorByTaskID[taskID] = nil
        defer {
            if !silent, generation == startGeneration {
                loadingDetailTaskIDs.remove(taskID)
            }
        }

        await refreshSingleTask(taskID, using: repository, generation: startGeneration)
        guard generation == startGeneration, !Task.isCancelled else { return }

        if !missingTaskIDs.contains(taskID) {
            let afterSequence = eventsByTaskID[taskID]?.last?.sequence
            do {
                let page = try await repository.fetchEvents(taskID: taskID, after: afterSequence)
                guard generation == startGeneration else { return }
                eventsUnavailableTaskIDs.remove(taskID)
                mergeEvents(page.events, for: taskID)
            } catch is CancellationError {
                return
            } catch SessionTaskRepositoryError.notFound, SessionTaskRepositoryError.endpointNotReady {
                guard generation == startGeneration else { return }
                if tasksByID[taskID] == nil {
                    missingTaskIDs.insert(taskID)
                } else {
                    eventsUnavailableTaskIDs.insert(taskID)
                }
            } catch {
                guard generation == startGeneration else { return }
                if detailErrorByTaskID[taskID] == nil {
                    detailErrorByTaskID[taskID] = String(localized: "tasks.error.detail_load", table: "Conversation")
                }
            }
        }

        if let task = tasksByID[taskID],
           task.status.isTerminal,
           shouldFetchResult(for: taskID) {
            await refreshResult(taskID, using: repository, generation: startGeneration)
        }

        if !missingTaskIDs.contains(taskID), tasksByID[taskID] != nil {
            await refreshArtifacts(taskID, using: repository, generation: startGeneration)
        }
    }

    /// Loads task detail immediately and, while the task remains actively executing
    /// (non-terminal and not waiting for approval), polls incrementally for new timeline events,
    /// terminal result, and downloadable artifacts within a bounded window.
    func observeActiveDetail(
        taskID: UUID,
        pollInterval: Duration = .seconds(2),
        maxPolls: Int = 30
    ) async {
        guard repository != nil else { return }
        let startGeneration = generation
        await loadDetail(taskID: taskID)
        guard generation == startGeneration, !Task.isCancelled else { return }

        var pollsRemaining = max(0, maxPolls)
        while pollsRemaining > 0,
              generation == startGeneration,
              !Task.isCancelled,
              shouldContinueObservingDetail(for: taskID) {
            pollsRemaining -= 1
            do {
                try await Task.sleep(for: pollInterval)
            } catch {
                return
            }
            guard generation == startGeneration,
                  !Task.isCancelled,
                  shouldContinueObservingDetail(for: taskID) else {
                return
            }
            await loadDetail(taskID: taskID, silent: true)
        }
    }

    private func shouldContinueObservingDetail(for taskID: UUID) -> Bool {
        guard !missingTaskIDs.contains(taskID),
              let task = tasksByID[taskID] else {
            return false
        }
        return !task.status.isTerminal && task.status != .waitingApproval
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
        } catch SessionTaskRepositoryError.endpointNotReady {
            guard generation == startGeneration else { return }
            cancelErrorByTaskID[taskID] = String(localized: "tasks.error.cancel_unavailable", table: "Conversation")
        } catch SessionTaskRepositoryError.notFound {
            await refreshSingleTask(taskID, using: repository, generation: startGeneration)
            guard generation == startGeneration else { return }
            if tasksByID[taskID] != nil {
                cancelErrorByTaskID[taskID] = String(localized: "tasks.error.cancel_unavailable", table: "Conversation")
            } else {
                cancelErrorByTaskID[taskID] = String(localized: "tasks.error.cancel_failed", table: "Conversation")
            }
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
        artifactsByTaskID.removeAll()
        cancelResponseByTaskID.removeAll()
        missingTaskIDs.removeAll()
        eventsUnavailableTaskIDs.removeAll()
        artifactsUnavailableTaskIDs.removeAll()
        loadingDetailTaskIDs.removeAll()
        loadingArtifactsTaskIDs.removeAll()
        downloadingArtifactIDs.removeAll()
        downloadedArtifactFileByID.removeAll()
        downloadedArtifactPreviewByID.removeAll()
        cancellingTaskIDs.removeAll()
        isLoadingList = false
        isLoadingMoreTasks = false
        hasMoreTasks = false
        nextTasksCursor = nil
        listErrorMessage = nil
        loadMoreErrorMessage = nil
        listEndpointUnavailable = false
        detailErrorByTaskID.removeAll()
        resultErrorByTaskID.removeAll()
        artifactListErrorByIDReset()
        cancelErrorByTaskID.removeAll()
        Self.cleanupDownloadedTempFiles()
    }

    private func artifactListErrorByIDReset() {
        artifactListErrorByTaskID.removeAll()
        artifactDownloadErrorByID.removeAll()
    }

    func uploadTaskAttachment(
        filename: String,
        mediaType: String,
        data: Data
    ) async throws -> StagedUploadReceiptDTO {
        guard let repository else {
            throw SessionTaskRepositoryError.unavailable
        }
        return try await repository.uploadAttachment(filename: filename, mediaType: mediaType, data: data)
    }

    func submitPythonTask(_ request: SubmitPythonTaskRequestDTO) async -> PythonTaskSubmissionOutcome {
        guard let repository else {
            return .failed(String(localized: "tasks.python.error.unavailable", table: "Conversation"))
        }
        let startGeneration = generation
        do {
            let result = try await repository.submitPythonTask(request)
            guard generation == startGeneration else {
                return .failed(String(localized: "tasks.python.error.unavailable", table: "Conversation"))
            }
            let summary = result.task.summary
            tasksByID[summary.taskID] = summary
            missingTaskIDs.remove(summary.taskID)
            if let embeddedResult = result.task.asResultDTO {
                resultsByTaskID[summary.taskID] = embeddedResult
                resultErrorByTaskID[summary.taskID] = nil
            }
            return .submitted(summary, created: result.created)
        } catch is CancellationError {
            return .failed(String(localized: "tasks.python.error.unavailable", table: "Conversation"))
        } catch SessionTaskRepositoryError.unknownAcknowledgement {
            return .unknownAcknowledgement
        } catch SessionTaskRepositoryError.endpointNotReady {
            return .endpointNotReady
        } catch SessionTaskRepositoryError.invalidInput {
            return .failed(String(localized: "tasks.python.error.invalid_input", table: "Conversation"))
        } catch SessionTaskRepositoryError.idempotencyConflict {
            return .failed(String(localized: "tasks.python.error.idempotency_conflict", table: "Conversation"))
        } catch SessionTaskRepositoryError.budgetExceeded {
            return .failed(String(localized: "tasks.python.error.budget_exceeded", table: "Conversation"))
        } catch SessionTaskRepositoryError.unauthenticated {
            return .failed(String(localized: "tasks.python.error.unauthenticated", table: "Conversation"))
        } catch {
            return .failed(String(localized: "tasks.python.error.unavailable", table: "Conversation"))
        }
    }

    func downloadArtifact(_ item: TaskArtifactItemDTO) async {
        guard let repository, !downloadingArtifactIDs.contains(item.artifactID) else { return }
        if let existingURL = downloadedArtifactFileByID[item.artifactID],
           FileManager.default.fileExists(atPath: existingURL.path) {
            return
        }

        let startGeneration = generation
        downloadingArtifactIDs.insert(item.artifactID)
        artifactDownloadErrorByID[item.artifactID] = nil
        defer {
            if generation == startGeneration {
                downloadingArtifactIDs.remove(item.artifactID)
            }
        }

        do {
            let downloaded = try await repository.downloadArtifact(
                artifactID: item.artifactID,
                filename: item.displayFilename,
                mediaType: item.mediaType
            )
            guard generation == startGeneration, !Task.isCancelled else { return }

            let actualSHA256 = SHA256.hash(data: downloaded.data)
                .map { String(format: "%02x", $0) }
                .joined()
            guard downloaded.data.count == item.size,
                  actualSHA256 == item.sha256.lowercased() else {
                artifactDownloadErrorByID[item.artifactID] = String(
                    localized: "tasks.artifacts.integrity_failed",
                    table: "Conversation"
                )
                return
            }

            let folder = Self.artifactsTempRoot()
                .appendingPathComponent(item.artifactID.uuidString.lowercased(), isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let fileURL = folder.appendingPathComponent(downloaded.filename, isDirectory: false)
            try downloaded.data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            downloadedArtifactFileByID[item.artifactID] = fileURL
            if B3AttachmentLimits.isTextPreviewMediaType(downloaded.mediaType),
               downloaded.data.count <= 2_097_152,
               let text = String(data: downloaded.data, encoding: .utf8) {
                downloadedArtifactPreviewByID[item.artifactID] = text
            }
        } catch is CancellationError {
            return
        } catch SessionTaskRepositoryError.notFound {
            guard generation == startGeneration else { return }
            artifactDownloadErrorByID[item.artifactID] = String(localized: "tasks.artifacts.not_found", table: "Conversation")
        } catch {
            guard generation == startGeneration else { return }
            artifactDownloadErrorByID[item.artifactID] = String(localized: "tasks.artifacts.download_failed", table: "Conversation")
        }
    }

    private func refreshSingleTask(
        _ taskID: UUID,
        using repository: any SessionTaskRepositoryProtocol,
        generation startGeneration: UInt64
    ) async {
        do {
            let detail = try await repository.fetchTask(id: taskID)
            guard generation == startGeneration else { return }
            tasksByID[taskID] = detail.summary
            missingTaskIDs.remove(taskID)
            detailErrorByTaskID[taskID] = nil
            if let embeddedResult = detail.asResultDTO {
                resultsByTaskID[taskID] = embeddedResult
                resultErrorByTaskID[taskID] = nil
            }
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

    private func seedKnownUnavailableResult(for task: SessionTaskDTO) {
        guard task.status.isTerminal,
              task.resultState == .unavailable,
              resultsByTaskID[task.taskID]?.resultState != .available
        else { return }
        resultsByTaskID[task.taskID] = SessionTaskResultDTO(
            taskID: task.taskID,
            taskStatus: task.status,
            resultState: .unavailable,
            result: nil
        )
        resultErrorByTaskID[task.taskID] = nil
    }

    private func shouldFetchResult(for taskID: UUID) -> Bool {
        if resultsByTaskID[taskID]?.resultState == .available {
            return false
        }
        if let task = tasksByID[taskID] {
            if !task.status.isTerminal && resultsByTaskID[taskID] == nil {
                return false
            }
            if task.resultState == .pending || task.resultState == .unavailable {
                return false
            }
        }
        return true
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

    private func refreshArtifacts(
        _ taskID: UUID,
        using repository: any SessionTaskRepositoryProtocol,
        generation startGeneration: UInt64
    ) async {
        loadingArtifactsTaskIDs.insert(taskID)
        artifactListErrorByTaskID[taskID] = nil
        defer {
            if generation == startGeneration {
                loadingArtifactsTaskIDs.remove(taskID)
            }
        }

        do {
            let list = try await repository.fetchArtifacts(taskID: taskID)
            guard generation == startGeneration else { return }
            artifactsUnavailableTaskIDs.remove(taskID)
            artifactsByTaskID[taskID] = list.artifacts
            artifactListErrorByTaskID[taskID] = nil
        } catch is CancellationError {
            return
        } catch SessionTaskRepositoryError.notFound, SessionTaskRepositoryError.endpointNotReady {
            guard generation == startGeneration else { return }
            artifactsUnavailableTaskIDs.insert(taskID)
            artifactListErrorByTaskID[taskID] = nil
        } catch {
            guard generation == startGeneration else { return }
            artifactListErrorByTaskID[taskID] = String(localized: "tasks.artifacts.list_failed", table: "Conversation")
        }
    }

    private static func artifactsTempRoot() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("EmberArtifacts", isDirectory: true)
    }

    private static func cleanupDownloadedTempFiles() {
        try? FileManager.default.removeItem(at: artifactsTempRoot())
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
