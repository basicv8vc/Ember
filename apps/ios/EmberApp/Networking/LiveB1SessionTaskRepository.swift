import Foundation

enum SessionTaskRepositoryError: Error, Equatable, Sendable {
    case unauthenticated
    case notFound
    case endpointNotReady
    case invalidInput
    case idempotencyConflict
    case budgetExceeded
    case unknownAcknowledgement
    case unavailable
    case invalidResponse
}

protocol SessionTaskRepositoryProtocol: Sendable {
    var isMockOnly: Bool { get }
    var supportsPythonTaskSubmission: Bool { get }
    func listTasks(after cursor: String?, limit: Int) async throws -> SessionTaskListDTO
    func fetchTask(id: UUID) async throws -> SessionTaskDetailDTO
    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> SessionTaskEventPageDTO
    func fetchResult(taskID: UUID) async throws -> SessionTaskResultDTO
    func fetchArtifacts(taskID: UUID) async throws -> TaskArtifactsListDTO
    func downloadArtifact(
        artifactID: UUID,
        filename: String,
        mediaType: String
    ) async throws -> DownloadedTaskArtifact
    func cancelTask(id: UUID) async throws -> TaskCancelDTO
    func uploadAttachment(
        filename: String,
        mediaType: String,
        data: Data
    ) async throws -> StagedUploadReceiptDTO
    func submitPythonTask(_ request: SubmitPythonTaskRequestDTO) async throws -> PythonTaskSubmitResultDTO
}

extension SessionTaskRepositoryProtocol {
    var supportsPythonTaskSubmission: Bool { false }

    func listTasks() async throws -> SessionTaskListDTO {
        try await listTasks(after: nil, limit: 50)
    }

    func uploadAttachment(
        filename: String,
        mediaType: String,
        data: Data
    ) async throws -> StagedUploadReceiptDTO {
        throw SessionTaskRepositoryError.endpointNotReady
    }

    func submitPythonTask(_ request: SubmitPythonTaskRequestDTO) async throws -> PythonTaskSubmitResultDTO {
        throw SessionTaskRepositoryError.endpointNotReady
    }
}

/// Live B1 consumer-session client for Task list, detail, events, result, and cancellation.
/// Aligns with PR #160 B1 session routes (`GET /v1/me/tasks`, `GET /v1/me/tasks/:id`, `GET /v1/tasks/:id/result`)
/// and V2 Python task/upload routes (`POST /v1/me/uploads`, `POST /v2/tasks/python`).
struct LiveB1SessionTaskRepository: SessionTaskRepositoryProtocol {
    let auth: LiveAuthSessionCoordinator
    let isMockOnly: Bool = false
    let supportsPythonTaskSubmission: Bool = true

    func listTasks(after cursor: String?, limit: Int) async throws -> SessionTaskListDTO {
        let boundedLimit = min(max(limit, 1), 50)
        var queryItems = [URLQueryItem(name: "limit", value: String(boundedLimit))]
        if let cursor, !cursor.isEmpty {
            queryItems.append(URLQueryItem(name: "after", value: cursor))
        }

        let response = try await sendRead(
            pathComponents: ["v1", "me", "tasks"],
            queryItems: queryItems
        )

        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw SessionTaskRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode)
        }
        return try decode(SessionTaskListDTO.self, from: response.data)
    }

    func fetchTask(id: UUID) async throws -> SessionTaskDetailDTO {
        let response = try await sendRead(pathComponents: [
            "v1", "me", "tasks", id.uuidString.lowercased(),
        ])
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode)
        }
        let detail = try decode(SessionTaskDetailDTO.self, from: response.data)
        guard detail.taskID == id else { throw SessionTaskRepositoryError.invalidResponse }
        return detail
    }

    func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> SessionTaskEventPageDTO {
        let queryItems: [URLQueryItem]
        if let sequence, sequence > 0 {
            queryItems = [URLQueryItem(name: "after", value: String(sequence))]
        } else {
            queryItems = []
        }

        let response = try await sendRead(
            pathComponents: ["v1", "me", "tasks", taskID.uuidString.lowercased(), "events"],
            queryItems: queryItems
        )
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode)
        }
        let page = try decode(SessionTaskEventPageDTO.self, from: response.data)
        guard page.taskID == taskID else { throw SessionTaskRepositoryError.invalidResponse }
        for index in page.events.indices {
            guard page.events[index].taskID == taskID else {
                throw SessionTaskRepositoryError.invalidResponse
            }
            if index > 0 && page.events[index].sequence <= page.events[index - 1].sequence {
                throw SessionTaskRepositoryError.invalidResponse
            }
            if let sequence, page.events[index].sequence <= sequence {
                throw SessionTaskRepositoryError.invalidResponse
            }
        }
        return page
    }

    func fetchResult(taskID: UUID) async throws -> SessionTaskResultDTO {
        let response = try await sendRead(pathComponents: [
            "v1", "tasks", taskID.uuidString.lowercased(), "result",
        ])
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode)
        }
        let result = try decode(SessionTaskResultDTO.self, from: response.data)
        guard result.taskID == taskID else { throw SessionTaskRepositoryError.invalidResponse }
        return result
    }

    func fetchArtifacts(taskID: UUID) async throws -> TaskArtifactsListDTO {
        let response = try await sendRead(pathComponents: [
            "v1", "me", "tasks", taskID.uuidString.lowercased(), "artifacts",
        ])
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode)
        }
        let list = try decode(TaskArtifactsListDTO.self, from: response.data)
        guard list.taskID == taskID else { throw SessionTaskRepositoryError.invalidResponse }
        return list
    }

    func downloadArtifact(
        artifactID: UUID,
        filename: String,
        mediaType: String
    ) async throws -> DownloadedTaskArtifact {
        let normalizedType = B3AttachmentLimits.normalizedMediaType(mediaType)
        guard B3AttachmentLimits.isSafeMediaType(normalizedType),
              B3AttachmentLimits.isSafeArtifactFilenameExtension(filename) else {
            throw SessionTaskRepositoryError.invalidInput
        }
        let response = try await sendRead(pathComponents: [
            "v1", "me", "artifacts", artifactID.uuidString.lowercased(),
        ])
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode)
        }
        let safeFilename = B3AttachmentLimits.safeUploadFilename(filename, mediaType: normalizedType)
        guard B3AttachmentLimits.isSafeArtifactFilenameExtension(safeFilename) else {
            throw SessionTaskRepositoryError.invalidInput
        }
        return DownloadedTaskArtifact(
            artifactID: artifactID,
            filename: safeFilename,
            mediaType: normalizedType,
            data: response.data
        )
    }

    func cancelTask(id: UUID) async throws -> TaskCancelDTO {
        let response: EmberAPIResponse
        do {
            response = try await auth.authorizedRequest(EmberAuthenticatedRequest(
                method: "POST",
                pathComponents: ["v1", "me", "tasks", id.uuidString.lowercased(), "cancel"],
                idempotency: .nonIdempotent(clientSubmissionID: nil)
            ))
        } catch let error as AuthError where error.requiresNewSignIn {
            throw SessionTaskRepositoryError.unauthenticated
        } catch AuthError.requestRejectedBeforeExecution {
            throw SessionTaskRepositoryError.unauthenticated
        } catch {
            throw SessionTaskRepositoryError.unavailable
        }

        guard response.statusCode == 200 || response.statusCode == 202 else {
            throw Self.mapStatusError(response.statusCode)
        }
        let cancelDTO = try decode(TaskCancelDTO.self, from: response.data)
        guard cancelDTO.taskID == id,
              EmberWireDate.parse(cancelDTO.updatedAt) != nil else {
            throw SessionTaskRepositoryError.invalidResponse
        }
        if let requestedAt = cancelDTO.cancelRequestedAt, EmberWireDate.parse(requestedAt) == nil {
            throw SessionTaskRepositoryError.invalidResponse
        }
        if response.statusCode == 200 && !cancelDTO.terminal {
            throw SessionTaskRepositoryError.invalidResponse
        }
        if response.statusCode == 202 && cancelDTO.terminal {
            throw SessionTaskRepositoryError.invalidResponse
        }
        return cancelDTO
    }

    func uploadAttachment(
        filename: String,
        mediaType: String,
        data: Data
    ) async throws -> StagedUploadReceiptDTO {
        let normalizedType = B3AttachmentLimits.normalizedMediaType(mediaType)
        let safeFilename = B3AttachmentLimits.safeUploadFilename(filename, mediaType: normalizedType)
        guard B3AttachmentLimits.isSafeMediaType(normalizedType),
              data.count <= SubmitPythonTaskRequestDTO.maxInlineArtifactBytes else {
            throw SessionTaskRepositoryError.invalidInput
        }
        let response: EmberAPIResponse
        do {
            response = try await LiveB1ConversationClient.sendMultipartUpload(
                using: auth,
                filename: safeFilename,
                mediaType: normalizedType,
                data: data
            )
        } catch let error as AuthError where error.requiresNewSignIn {
            throw SessionTaskRepositoryError.unauthenticated
        } catch AuthError.requestRejectedBeforeExecution {
            throw SessionTaskRepositoryError.unauthenticated
        } catch {
            throw SessionTaskRepositoryError.unavailable
        }
        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw SessionTaskRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.mapWriteStatusError(response.statusCode)
        }
        let receipt = try decode(StagedUploadReceiptDTO.self, from: response.data)
        guard receipt.size == data.count else {
            throw SessionTaskRepositoryError.invalidResponse
        }
        return receipt
    }

    func submitPythonTask(_ request: SubmitPythonTaskRequestDTO) async throws -> PythonTaskSubmitResultDTO {
        let trimmedPrompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty,
              trimmedPrompt.count <= SubmitPythonTaskRequestDTO.promptMaxChars,
              request.attachmentIDs.count <= B3AttachmentLimits.maxAttachmentsPerMessage,
              Set(request.attachmentIDs).count == request.attachmentIDs.count else {
            throw SessionTaskRepositoryError.invalidInput
        }
        if let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines),
           title.count > SubmitPythonTaskRequestDTO.titleMaxChars {
            throw SessionTaskRepositoryError.invalidInput
        }
        if let instructions = request.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
           instructions.count > SubmitPythonTaskRequestDTO.instructionsMaxChars {
            throw SessionTaskRepositoryError.invalidInput
        }

        let body: Data
        do {
            body = try JSONEncoder().encode(request)
        } catch {
            throw SessionTaskRepositoryError.invalidInput
        }

        let response: EmberAPIResponse
        do {
            response = try await auth.authorizedRequest(EmberAuthenticatedRequest(
                method: "POST",
                pathComponents: ["v2", "tasks", "python"],
                body: body,
                contentType: "application/json",
                idempotency: .nonIdempotent(
                    clientSubmissionID: request.clientRequestID.uuidString.lowercased()
                )
            ))
        } catch let error as AuthError where error.requiresNewSignIn {
            throw SessionTaskRepositoryError.unauthenticated
        } catch AuthError.requestRejectedBeforeExecution {
            throw SessionTaskRepositoryError.unauthenticated
        } catch {
            // Transport failures, timeouts, and ambiguous outcomes must allow safe idempotent retry.
            throw SessionTaskRepositoryError.unknownAcknowledgement
        }

        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw SessionTaskRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.mapWriteStatusError(response.statusCode)
        }
        return try decode(PythonTaskSubmitResultDTO.self, from: response.data)
    }

    private func sendRead(
        pathComponents: [String],
        queryItems: [URLQueryItem] = []
    ) async throws -> EmberAPIResponse {
        do {
            return try await auth.authorizedRequest(EmberAuthenticatedRequest(
                method: "GET",
                pathComponents: pathComponents,
                idempotency: .idempotentRead,
                queryItems: queryItems
            ))
        } catch let error as AuthError where error.requiresNewSignIn {
            throw SessionTaskRepositoryError.unauthenticated
        } catch AuthError.requestRejectedBeforeExecution {
            throw SessionTaskRepositoryError.unauthenticated
        } catch {
            throw SessionTaskRepositoryError.unavailable
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw SessionTaskRepositoryError.invalidResponse
        }
    }

    private static func mapStatusError(_ code: Int) -> SessionTaskRepositoryError {
        switch code {
        case 401:
            .unauthenticated
        case 404:
            .notFound
        case 405, 501:
            .endpointNotReady
        case 429, 500...599:
            .unavailable
        default:
            .invalidResponse
        }
    }

    private static func mapWriteStatusError(_ code: Int) -> SessionTaskRepositoryError {
        switch code {
        case 400, 422:
            .invalidInput
        case 401:
            .unauthenticated
        case 409:
            .idempotencyConflict
        case 429:
            .budgetExceeded
        case 500...599:
            .unknownAcknowledgement
        default:
            .invalidResponse
        }
    }
}
