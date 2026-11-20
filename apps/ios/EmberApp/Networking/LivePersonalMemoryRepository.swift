import Foundation

/// Live consumer-session client for V2 Personal Memory (`/v2/memories`).
/// Gracefully reports `.endpointNotReady` when talking to V1 backends that do not yet expose `/v2/memories`.
struct LivePersonalMemoryRepository: PersonalMemoryRepositoryProtocol {
    let auth: LiveAuthSessionCoordinator
    let isMockOnly: Bool = false

    func listMemories() async throws -> PersonalMemoryListDTO {
        let response = try await sendRequest(
            method: "GET",
            pathComponents: ["v2", "memories"],
            idempotency: .idempotentRead,
            body: nil
        )
        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw PersonalMemoryRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        return try decode(PersonalMemoryListDTO.self, from: response.data)
    }

    func saveMemory(_ request: SavePersonalMemoryRequestDTO) async throws -> PersonalMemorySaveResultDTO {
        let bodyData: Data
        do {
            bodyData = try JSONEncoder().encode(request)
        } catch {
            throw PersonalMemoryRepositoryError.invalidInput
        }

        let response = try await sendRequest(
            method: "POST",
            pathComponents: ["v2", "memories"],
            idempotency: .nonIdempotent(clientSubmissionID: nil),
            body: bodyData
        )
        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw PersonalMemoryRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        return try decode(PersonalMemorySaveResultDTO.self, from: response.data)
    }

    func updateMemory(
        id: UUID,
        _ request: UpdatePersonalMemoryRequestDTO
    ) async throws -> PersonalMemoryUpdateResultDTO {
        let bodyData: Data
        do {
            bodyData = try JSONEncoder().encode(request)
        } catch {
            throw PersonalMemoryRepositoryError.invalidInput
        }

        let response = try await sendRequest(
            method: "PATCH",
            pathComponents: ["v2", "memories", id.uuidString.lowercased()],
            idempotency: .nonIdempotent(clientSubmissionID: nil),
            body: bodyData
        )
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        return try decode(PersonalMemoryUpdateResultDTO.self, from: response.data)
    }

    func deleteMemory(id: UUID) async throws -> PersonalMemoryDeleteResultDTO {
        let response = try await sendRequest(
            method: "DELETE",
            pathComponents: ["v2", "memories", id.uuidString.lowercased()],
            idempotency: .nonIdempotent(clientSubmissionID: nil),
            body: nil
        )
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        let result = try decode(PersonalMemoryDeleteResultDTO.self, from: response.data)
        guard result.deleted, result.memoryID == id else {
            throw PersonalMemoryRepositoryError.invalidResponse
        }
        return result
    }

    private func sendRequest(
        method: String,
        pathComponents: [String],
        idempotency: EmberRequestIdempotency,
        body: Data?
    ) async throws -> EmberAPIResponse {
        do {
            return try await auth.authorizedRequest(EmberAuthenticatedRequest(
                method: method,
                pathComponents: pathComponents,
                body: body,
                contentType: body != nil ? "application/json" : nil,
                idempotency: idempotency
            ))
        } catch let error as AuthError where error.requiresNewSignIn {
            throw PersonalMemoryRepositoryError.unauthenticated
        } catch {
            throw PersonalMemoryRepositoryError.unavailable
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw PersonalMemoryRepositoryError.invalidResponse
        }
    }

    private struct APIErrorEnvelope: Decodable {
        struct ErrorDetail: Decodable {
            let code: String?
        }

        let code: String?
        let error: ErrorDetail?

        var resolvedCode: String? {
            error?.code ?? code
        }
    }

    private static func mapStatusError(_ code: Int, data: Data) -> PersonalMemoryRepositoryError {
        switch code {
        case 400, 422:
            .invalidInput
        case 401:
            .unauthenticated
        case 404:
            .notFound
        case 405, 501:
            .endpointNotReady
        case 409:
            .limitReached
        case 429:
            if let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data),
               envelope.resolvedCode == "BUDGET_EXCEEDED" {
                .limitReached
            } else {
                .unavailable
            }
        case 500...599:
            .unavailable
        default:
            .invalidResponse
        }
    }
}

/// Local fixture repository used in `--ember-mock-chat-tasks` and unit tests.
actor InMemoryPersonalMemoryRepository: PersonalMemoryRepositoryProtocol {
    nonisolated let isMockOnly: Bool = true
    private let limits: PersonalMemoryLimitsDTO
    private var items: [PersonalMemoryItemDTO]

    init(
        items: [PersonalMemoryItemDTO] = InMemoryPersonalMemoryRepository.defaultSamples,
        limits: PersonalMemoryLimitsDTO = .default
    ) {
        self.items = items
        self.limits = limits
    }

    func listMemories() async throws -> PersonalMemoryListDTO {
        let sorted = items.sorted { lhs, rhs in
            if lhs.updatedDate != rhs.updatedDate {
                return lhs.updatedDate > rhs.updatedDate
            }
            return lhs.memoryID.uuidString < rhs.memoryID.uuidString
        }
        return PersonalMemoryListDTO(items: sorted, limits: limits)
    }

    func saveMemory(_ request: SavePersonalMemoryRequestDTO) async throws -> PersonalMemorySaveResultDTO {
        let trimmed = request.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= limits.maxContentChars else {
            throw PersonalMemoryRepositoryError.invalidInput
        }
        let now = Date().ISO8601Format()
        let normalizedKey = request.key?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        if let normalizedKey, !normalizedKey.isEmpty,
           let index = items.firstIndex(where: { $0.key == normalizedKey }) {
            let existing = items[index]
            let updated = PersonalMemoryItemDTO(
                memoryID: existing.memoryID,
                kind: request.kind,
                key: normalizedKey,
                content: trimmed,
                provenance: request.provenance,
                createdAt: existing.createdAt,
                updatedAt: now
            )
            items[index] = updated
            return PersonalMemorySaveResultDTO(item: updated, created: false)
        }

        guard items.count < limits.maxItems else {
            throw PersonalMemoryRepositoryError.limitReached
        }

        let created = PersonalMemoryItemDTO(
            memoryID: UUID(),
            kind: request.kind,
            key: normalizedKey?.isEmpty == false ? normalizedKey : nil,
            content: trimmed,
            provenance: request.provenance,
            createdAt: now,
            updatedAt: now
        )
        items.insert(created, at: 0)
        return PersonalMemorySaveResultDTO(item: created, created: true)
    }

    func updateMemory(
        id: UUID,
        _ request: UpdatePersonalMemoryRequestDTO
    ) async throws -> PersonalMemoryUpdateResultDTO {
        guard let index = items.firstIndex(where: { $0.memoryID == id }) else {
            throw PersonalMemoryRepositoryError.notFound
        }
        let existing = items[index]
        let nextContent: String
        if let rawContent = request.content {
            let trimmed = rawContent.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed.count <= limits.maxContentChars else {
                throw PersonalMemoryRepositoryError.invalidInput
            }
            nextContent = trimmed
        } else {
            nextContent = existing.content
        }
        let updated = PersonalMemoryItemDTO(
            memoryID: existing.memoryID,
            kind: request.kind ?? existing.kind,
            key: existing.key,
            content: nextContent,
            provenance: existing.provenance,
            createdAt: existing.createdAt,
            updatedAt: Date().ISO8601Format()
        )
        items[index] = updated
        return PersonalMemoryUpdateResultDTO(item: updated)
    }

    func deleteMemory(id: UUID) async throws -> PersonalMemoryDeleteResultDTO {
        guard let index = items.firstIndex(where: { $0.memoryID == id }) else {
            throw PersonalMemoryRepositoryError.notFound
        }
        items.remove(at: index)
        return PersonalMemoryDeleteResultDTO(deleted: true, memoryID: id)
    }

    static var defaultSamples: [PersonalMemoryItemDTO] {
        [
            PersonalMemoryItemDTO(
                memoryID: UUID(uuidString: "00000000-0000-4000-8000-00000000b901")!,
                kind: .preference,
                key: "response.style",
                content: "Keep morning briefs concise with bullet points and clear next steps.",
                provenance: PersonalMemoryProvenanceDTO(source: .explicitUserRequest),
                createdAt: "2026-11-20T08:00:00Z",
                updatedAt: "2026-11-20T08:00:00Z"
            )
        ]
    }
}
