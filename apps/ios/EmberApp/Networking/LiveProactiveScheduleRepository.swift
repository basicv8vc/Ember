import Foundation

/// Live consumer-session client for V2 Proactive Schedules (`/v2/schedules`).
/// Gracefully reports `.endpointNotReady` on V1 backends that do not expose `/v2/schedules`.
struct LiveProactiveScheduleRepository: ProactiveScheduleRepositoryProtocol {
    let auth: LiveAuthSessionCoordinator
    let isMockOnly: Bool = false

    func listSchedules() async throws -> ProactiveScheduleListDTO {
        let response = try await sendRequest(
            method: "GET",
            pathComponents: ["v2", "schedules"],
            idempotency: .idempotentRead,
            body: nil
        )
        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw ProactiveScheduleRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        return try decode(ProactiveScheduleListDTO.self, from: response.data)
    }

    func createSchedule(_ request: CreateProactiveScheduleRequestDTO) async throws -> ProactiveScheduleDTO {
        let bodyData: Data
        do {
            bodyData = try JSONEncoder().encode(request)
        } catch {
            throw ProactiveScheduleRepositoryError.invalidInput
        }

        let response = try await sendRequest(
            method: "POST",
            pathComponents: ["v2", "schedules"],
            idempotency: .nonIdempotent(clientSubmissionID: request.idempotencyKey),
            body: bodyData
        )
        if response.statusCode == 404 || response.statusCode == 405 || response.statusCode == 501 {
            throw ProactiveScheduleRepositoryError.endpointNotReady
        }
        guard response.statusCode == 200 || response.statusCode == 201 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        return try decode(ProactiveScheduleDTO.self, from: response.data)
    }

    func pauseSchedule(id: UUID) async throws -> ProactiveScheduleDTO {
        try await sendTransition(id: id, action: "pause")
    }

    func resumeSchedule(id: UUID) async throws -> ProactiveScheduleDTO {
        try await sendTransition(id: id, action: "resume")
    }

    func cancelSchedule(id: UUID) async throws -> ProactiveScheduleDTO {
        try await sendTransition(id: id, action: "cancel")
    }

    private func sendTransition(id: UUID, action: String) async throws -> ProactiveScheduleDTO {
        let response = try await sendRequest(
            method: "POST",
            pathComponents: ["v2", "schedules", id.uuidString.lowercased(), action],
            idempotency: .nonIdempotent(clientSubmissionID: nil),
            body: nil
        )
        guard response.statusCode == 200 else {
            throw Self.mapStatusError(response.statusCode, data: response.data)
        }
        return try decode(ProactiveScheduleDTO.self, from: response.data)
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
            throw ProactiveScheduleRepositoryError.unauthenticated
        } catch {
            throw ProactiveScheduleRepositoryError.unavailable
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw ProactiveScheduleRepositoryError.invalidResponse
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

    private static func mapStatusError(_ code: Int, data: Data) -> ProactiveScheduleRepositoryError {
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
            .conflict
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
actor InMemoryProactiveScheduleRepository: ProactiveScheduleRepositoryProtocol {
    nonisolated let isMockOnly: Bool = true
    private var items: [ProactiveScheduleDTO]

    init(items: [ProactiveScheduleDTO] = InMemoryProactiveScheduleRepository.defaultSamples) {
        self.items = items
    }

    func listSchedules() async throws -> ProactiveScheduleListDTO {
        ProactiveScheduleListDTO(schedules: items)
    }

    func createSchedule(_ request: CreateProactiveScheduleRequestDTO) async throws -> ProactiveScheduleDTO {
        let trimmedTitle = request.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPrompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty, !trimmedPrompt.isEmpty else {
            throw ProactiveScheduleRepositoryError.invalidInput
        }
        let now = Date().ISO8601Format()
        let scheduleKind: ProactiveScheduleRecurrenceKind
        let intervalSeconds: Int?
        let cronExpr: String?
        let timezone: String
        let nextFireAt: String?

        switch request.trigger {
        case .once(let fireAt):
            scheduleKind = .once
            intervalSeconds = nil
            cronExpr = nil
            timezone = request.timezone ?? TimeZone.current.identifier
            nextFireAt = fireAt
        case .interval(let seconds, let firstFireAt):
            scheduleKind = .interval
            intervalSeconds = seconds
            cronExpr = nil
            timezone = request.timezone ?? TimeZone.current.identifier
            nextFireAt = firstFireAt ?? Date().addingTimeInterval(TimeInterval(seconds)).ISO8601Format()
        case .cron(let expr, let tz):
            scheduleKind = .cronTZ
            intervalSeconds = nil
            cronExpr = expr
            timezone = tz
            nextFireAt = Date().addingTimeInterval(3600).ISO8601Format()
        }

        let created = ProactiveScheduleDTO(
            scheduleId: UUID(),
            kind: request.kind,
            title: trimmedTitle,
            prompt: trimmedPrompt,
            deliveryMode: request.deliveryMode ?? (request.kind == .brief ? .modelBrief : .directReminder),
            status: .active,
            scheduleKind: scheduleKind,
            intervalSeconds: intervalSeconds,
            cronExpr: cronExpr,
            timezone: timezone,
            misfirePolicy: request.misfirePolicy ?? .coalesceLatest,
            nextFireAt: nextFireAt,
            createdAt: now,
            updatedAt: now,
            replayed: false
        )
        items.insert(created, at: 0)
        return created
    }

    func pauseSchedule(id: UUID) async throws -> ProactiveScheduleDTO {
        try updateStatus(id: id, to: .paused)
    }

    func resumeSchedule(id: UUID) async throws -> ProactiveScheduleDTO {
        try updateStatus(id: id, to: .active)
    }

    func cancelSchedule(id: UUID) async throws -> ProactiveScheduleDTO {
        try updateStatus(id: id, to: .cancelled)
    }

    private func updateStatus(id: UUID, to newStatus: ProactiveScheduleStatus) throws -> ProactiveScheduleDTO {
        guard let index = items.firstIndex(where: { $0.scheduleId == id }) else {
            throw ProactiveScheduleRepositoryError.notFound
        }
        let existing = items[index]
        let updated = ProactiveScheduleDTO(
            scheduleId: existing.scheduleId,
            kind: existing.kind,
            title: existing.title,
            prompt: existing.prompt,
            deliveryMode: existing.deliveryMode,
            status: newStatus,
            scheduleKind: existing.scheduleKind,
            intervalSeconds: existing.intervalSeconds,
            cronExpr: existing.cronExpr,
            timezone: existing.timezone,
            misfirePolicy: existing.misfirePolicy,
            nextFireAt: newStatus == .active ? existing.nextFireAt : nil,
            lastFiredAt: existing.lastFiredAt,
            occurrenceCount: existing.occurrenceCount,
            version: existing.version + 1,
            createdAt: existing.createdAt,
            updatedAt: Date().ISO8601Format(),
            latestRun: existing.latestRun
        )
        items[index] = updated
        return updated
    }

    static var defaultSamples: [ProactiveScheduleDTO] {
        [
            ProactiveScheduleDTO(
                scheduleId: UUID(uuidString: "00000000-0000-4000-8000-00000000e501")!,
                kind: .brief,
                title: "Morning Brief",
                prompt: "Summarize today's priorities and open follow-ups in 3 concise bullets.",
                deliveryMode: .modelBrief,
                status: .active,
                scheduleKind: .cronTZ,
                cronExpr: "0 8 * * *",
                timezone: TimeZone.current.identifier,
                nextFireAt: "2026-11-21T00:00:00Z",
                occurrenceCount: 1,
                version: 1,
                createdAt: "2026-11-20T08:00:00Z",
                updatedAt: "2026-11-20T08:00:00Z"
            )
        ]
    }
}
