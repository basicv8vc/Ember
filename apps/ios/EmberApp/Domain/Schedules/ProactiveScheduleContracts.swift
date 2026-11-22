import Foundation

public enum ProactiveScheduleKind: String, Codable, CaseIterable, Hashable, Sendable {
    case brief
    case followUp = "follow_up"
    case reminder
}

public enum ProactiveDeliveryMode: String, Codable, Hashable, Sendable {
    case directReminder = "direct_reminder"
    case modelBrief = "model_brief"
}

public enum ProactiveScheduleStatus: String, Codable, Hashable, Sendable {
    case active
    case paused
    case completed
    case cancelled

    public var isTerminal: Bool {
        self == .completed || self == .cancelled
    }
}

public enum ProactiveScheduleRecurrenceKind: String, Codable, Hashable, Sendable {
    case once
    case interval
    case cronTZ = "cron_tz"
}

public enum ProactiveMisfirePolicy: String, Codable, Hashable, Sendable {
    case coalesceLatest = "coalesce_latest"
    case fireOnce = "fire_once"
    case skipMissed = "skip_missed"
}

public enum ProactiveScheduleTriggerInput: Equatable, Encodable, Sendable {
    case once(fireAt: String)
    case interval(intervalSeconds: Int, firstFireAt: String? = nil)
    case cron(cronExpr: String, timezone: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case fireAt
        case intervalSeconds
        case firstFireAt
        case cronExpr
        case timezone
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .once(let fireAt):
            try container.encode("once", forKey: .type)
            try container.encode(fireAt, forKey: .fireAt)
        case .interval(let intervalSeconds, let firstFireAt):
            try container.encode("interval", forKey: .type)
            try container.encode(intervalSeconds, forKey: .intervalSeconds)
            try container.encodeIfPresent(firstFireAt, forKey: .firstFireAt)
        case .cron(let cronExpr, let timezone):
            try container.encode("cron", forKey: .type)
            try container.encode(cronExpr, forKey: .cronExpr)
            try container.encode(timezone, forKey: .timezone)
        }
    }
}

public struct CreateProactiveScheduleRequestDTO: Equatable, Encodable, Sendable {
    public let idempotencyKey: String
    public let kind: ProactiveScheduleKind
    public let title: String
    public let prompt: String
    public let trigger: ProactiveScheduleTriggerInput
    public let timezone: String?
    public let misfirePolicy: ProactiveMisfirePolicy?
    public let deliveryMode: ProactiveDeliveryMode?

    public init(
        idempotencyKey: String = UUID().uuidString.lowercased(),
        kind: ProactiveScheduleKind,
        title: String,
        prompt: String,
        trigger: ProactiveScheduleTriggerInput,
        timezone: String? = nil,
        misfirePolicy: ProactiveMisfirePolicy? = nil,
        deliveryMode: ProactiveDeliveryMode? = nil
    ) {
        self.idempotencyKey = idempotencyKey
        self.kind = kind
        self.title = title
        self.prompt = prompt
        self.trigger = trigger
        self.timezone = timezone
        self.misfirePolicy = misfirePolicy
        self.deliveryMode = deliveryMode
    }
}

public struct ProactiveScheduleRunDTO: Equatable, Codable, Sendable {
    public let occurrenceSeq: Int
    public let taskId: String
    public let status: String
    public let summaryText: String?
    public let detailText: String?
    public let reasonCode: String?
    public let resultMessageId: String?
    public let scheduledFor: String
    public let completedAt: String?

    public init(
        occurrenceSeq: Int,
        taskId: String,
        status: String,
        summaryText: String? = nil,
        detailText: String? = nil,
        reasonCode: String? = nil,
        resultMessageId: String? = nil,
        scheduledFor: String,
        completedAt: String? = nil
    ) {
        self.occurrenceSeq = occurrenceSeq
        self.taskId = taskId
        self.status = status
        self.summaryText = summaryText
        self.detailText = detailText
        self.reasonCode = reasonCode
        self.resultMessageId = resultMessageId
        self.scheduledFor = scheduledFor
        self.completedAt = completedAt
    }
}

public struct ProactiveScheduleDTO: Identifiable, Equatable, Codable, Sendable {
    public let scheduleId: UUID
    public let kind: ProactiveScheduleKind
    public let title: String
    public let prompt: String
    public let deliveryMode: ProactiveDeliveryMode
    public let status: ProactiveScheduleStatus
    public let scheduleKind: ProactiveScheduleRecurrenceKind
    public let intervalSeconds: Int?
    public let cronExpr: String?
    public let timezone: String
    public let misfirePolicy: ProactiveMisfirePolicy
    public let nextFireAt: String?
    public let lastFiredAt: String?
    public let occurrenceCount: Int
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
    public let latestRun: ProactiveScheduleRunDTO?
    public let replayed: Bool?

    public var id: UUID { scheduleId }

    public var updatedDate: Date {
        EmberWireDate.parse(updatedAt) ?? .distantPast
    }

    public init(
        scheduleId: UUID,
        kind: ProactiveScheduleKind,
        title: String,
        prompt: String,
        deliveryMode: ProactiveDeliveryMode,
        status: ProactiveScheduleStatus,
        scheduleKind: ProactiveScheduleRecurrenceKind,
        intervalSeconds: Int? = nil,
        cronExpr: String? = nil,
        timezone: String,
        misfirePolicy: ProactiveMisfirePolicy = .coalesceLatest,
        nextFireAt: String? = nil,
        lastFiredAt: String? = nil,
        occurrenceCount: Int = 0,
        version: Int = 1,
        createdAt: String,
        updatedAt: String,
        latestRun: ProactiveScheduleRunDTO? = nil,
        replayed: Bool? = nil
    ) {
        self.scheduleId = scheduleId
        self.kind = kind
        self.title = title
        self.prompt = prompt
        self.deliveryMode = deliveryMode
        self.status = status
        self.scheduleKind = scheduleKind
        self.intervalSeconds = intervalSeconds
        self.cronExpr = cronExpr
        self.timezone = timezone
        self.misfirePolicy = misfirePolicy
        self.nextFireAt = nextFireAt
        self.lastFiredAt = lastFiredAt
        self.occurrenceCount = occurrenceCount
        self.version = version
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.latestRun = latestRun
        self.replayed = replayed
    }
}

public struct ProactiveScheduleListDTO: Equatable, Codable, Sendable {
    public let schedules: [ProactiveScheduleDTO]

    public init(schedules: [ProactiveScheduleDTO]) {
        self.schedules = schedules
    }
}

public enum ProactiveScheduleRepositoryError: Error, Equatable, Sendable {
    case unauthenticated
    case policyDenied
    case notFound
    case endpointNotReady
    case limitReached
    case invalidInput
    case conflict
    case unavailable
    case invalidResponse
}

public protocol ProactiveScheduleRepositoryProtocol: Sendable {
    var isMockOnly: Bool { get }
    func listSchedules() async throws -> ProactiveScheduleListDTO
    func createSchedule(_ request: CreateProactiveScheduleRequestDTO) async throws -> ProactiveScheduleDTO
    func pauseSchedule(id: UUID) async throws -> ProactiveScheduleDTO
    func resumeSchedule(id: UUID) async throws -> ProactiveScheduleDTO
    func cancelSchedule(id: UUID) async throws -> ProactiveScheduleDTO
}
