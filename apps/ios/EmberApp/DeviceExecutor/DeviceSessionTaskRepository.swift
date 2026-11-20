import Foundation

/// Adapts the on-device `DeviceTaskExecutor` to Ember's existing `SessionTaskRepositoryProtocol`,
/// allowing `SessionTaskStore`, `TaskInboxView`, and `TaskDetailView` (including artifact QuickLook &
/// ShareLink export) to inspect, monitor, and cancel local device tasks without cloud round-trips.
struct DeviceSessionTaskRepository: SessionTaskRepositoryProtocol {
    let executor: DeviceTaskExecutor
    let isMockOnly: Bool = false

    func listTasks(after cursor: String?, limit: Int) async throws -> SessionTaskListDTO {
        let records = try await executor.allRecords()
        let ordered = records.map(\.task).sorted { lhs, rhs in
            if lhs.updatedDate != rhs.updatedDate {
                return lhs.updatedDate > rhs.updatedDate
            }
            if lhs.createdAt != rhs.createdAt {
                return lhs.createdAt > rhs.createdAt
            }
            return lhs.taskID.uuidString < rhs.taskID.uuidString
        }

        let pageLimit = min(max(limit, 1), 50)
        let startIndex: Int
        if let cursor, !cursor.isEmpty {
            guard let cursorIndex = ordered.firstIndex(where: {
                $0.taskID.uuidString.caseInsensitiveCompare(cursor) == .orderedSame
            }) else {
                return SessionTaskListDTO(tasks: [], nextAfter: nil, hasMore: false)
            }
            startIndex = cursorIndex + 1
        } else {
            startIndex = 0
        }

        guard startIndex < ordered.count else {
            return SessionTaskListDTO(tasks: [], nextAfter: nil, hasMore: false)
        }
        let endIndex = min(startIndex + pageLimit, ordered.count)
        let slice = Array(ordered[startIndex..<endIndex])
        let hasMore = endIndex < ordered.count
        let nextAfter = hasMore ? slice.last?.taskID.uuidString.lowercased() : nil
        return SessionTaskListDTO(tasks: slice, nextAfter: nextAfter, hasMore: hasMore)
    }

    func fetchTask(id: UUID) async throws -> SessionTaskDetailDTO {
        guard let record = try await executor.record(for: id) else {
            throw SessionTaskRepositoryError.notFound
        }
        return SessionTaskDetailDTO(
            summary: record.task,
            result: record.result?.result
        )
    }

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> SessionTaskEventPageDTO {
        guard let record = try await executor.record(for: taskID) else {
            throw SessionTaskRepositoryError.notFound
        }
        let cursor = sequence ?? 0
        let filtered = record.events
            .filter { $0.sequence > cursor }
            .sorted { $0.sequence < $1.sequence }
            .prefix(100)
        return SessionTaskEventPageDTO(taskID: taskID, events: Array(filtered))
    }

    func fetchResult(taskID: UUID) async throws -> SessionTaskResultDTO {
        guard let record = try await executor.record(for: taskID) else {
            throw SessionTaskRepositoryError.notFound
        }
        if let result = record.result {
            return result
        }
        return SessionTaskResultDTO(
            taskID: taskID,
            taskStatus: record.task.status,
            resultState: record.task.status.isTerminal ? .unavailable : .pending,
            result: nil
        )
    }

    func fetchArtifacts(taskID: UUID) async throws -> TaskArtifactsListDTO {
        guard let record = try await executor.record(for: taskID) else {
            throw SessionTaskRepositoryError.notFound
        }
        return TaskArtifactsListDTO(
            taskID: taskID,
            artifacts: record.artifacts.map { $0.asTaskArtifactItemDTO() }
        )
    }

    func downloadArtifact(
        artifactID: UUID,
        filename: String,
        mediaType: String
    ) async throws -> DownloadedTaskArtifact {
        let records = try await executor.allRecords()
        for record in records {
            if let match = record.artifacts.first(where: { $0.artifactID == artifactID }) {
                let (_, data) = try await executor.artifactData(taskID: record.task.taskID, artifactID: artifactID)
                let safeFilename = B3AttachmentLimits.safeUploadFilename(match.filename, mediaType: match.mediaType)
                return DownloadedTaskArtifact(
                    artifactID: artifactID,
                    filename: safeFilename,
                    mediaType: match.mediaType,
                    data: data
                )
            }
        }
        throw SessionTaskRepositoryError.notFound
    }

    func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        do {
            return try await executor.cancelTask(id: id)
        } catch DeviceExecutorError.taskNotFound {
            throw SessionTaskRepositoryError.notFound
        } catch {
            throw SessionTaskRepositoryError.unavailable
        }
    }
}
