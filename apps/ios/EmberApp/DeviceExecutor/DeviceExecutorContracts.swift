import Foundation

public enum DeviceWireDate {
    public static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    public static func parse(_ raw: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}

/// Built-in native tool identifiers supported by the iPhone Device Executor.
public struct DeviceToolName: RawRepresentable, Hashable, Codable, Sendable {
    public static let textProcess = DeviceToolName(rawValue: "device.text.process")!
    public static let jsonProcess = DeviceToolName(rawValue: "device.json.process")!
    public static let fileGenerate = DeviceToolName(rawValue: "device.file.generate")!

    public let rawValue: String

    public init?(rawValue: String) {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed == rawValue, trimmed.count <= 128 else {
            return nil
        }
        self.rawValue = trimmed
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let value = Self(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid device tool name.")
        }
        self = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Strictly Sendable JSON value representation for deterministic tool inputs and outputs.
public enum DeviceJSONValue: Equatable, Codable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([DeviceJSONValue])
    case object([String: DeviceJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let intValue = try? container.decode(Int64.self) {
            self = .int(intValue)
        } else if let doubleValue = try? container.decode(Double.self) {
            guard doubleValue.isFinite else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Non-finite number.")
            }
            self = .double(doubleValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else if let arrayValue = try? container.decode([DeviceJSONValue].self) {
            self = .array(arrayValue)
        } else if let objectValue = try? container.decode([String: DeviceJSONValue].self) {
            self = .object(objectValue)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value.")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case .int(let value): Int(exactly: value)
        case .double(let value) where value.rounded() == value: Int(exactly: Int64(value))
        default: nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case .int(let value): Double(value)
        case .double(let value): value
        default: nil
        }
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var arrayValue: [DeviceJSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: DeviceJSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var maxDepth: Int {
        switch self {
        case .null, .bool, .int, .double, .string:
            return 1
        case .array(let items):
            return 1 + (items.map(\.maxDepth).max() ?? 0)
        case .object(let dict):
            return 1 + (dict.values.map(\.maxDepth).max() ?? 0)
        }
    }

    public func canonicalJSONString(prettyPrinted: Bool = false) throws -> String {
        let encoder = JSONEncoder()
        var formatting: JSONEncoder.OutputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if prettyPrinted {
            formatting.insert(.prettyPrinted)
        }
        encoder.outputFormatting = formatting
        let data = try encoder.encode(self)
        guard let string = String(data: data, encoding: .utf8) else {
            throw DeviceExecutorError.invalidArgument("Unable to encode JSON as UTF-8.")
        }
        return string
    }

    public static func parse(from string: String, maxBytes: Int, maxDepth: Int) throws -> DeviceJSONValue {
        let data = Data(string.utf8)
        guard data.count <= maxBytes else {
            throw DeviceExecutorError.payloadTooLarge("JSON input exceeds \(maxBytes) bytes.")
        }
        return try parse(from: data, maxDepth: maxDepth)
    }

    public static func parse(from data: Data, maxDepth: Int) throws -> DeviceJSONValue {
        let decoded: DeviceJSONValue
        do {
            decoded = try JSONDecoder().decode(DeviceJSONValue.self, from: data)
        } catch {
            throw DeviceExecutorError.invalidArgument("Invalid JSON payload: \(error.localizedDescription)")
        }
        guard decoded.maxDepth <= maxDepth else {
            throw DeviceExecutorError.jsonDepthExceeded("JSON nesting depth \(decoded.maxDepth) exceeds limit \(maxDepth).")
        }
        return decoded
    }
}

/// A single native tool invocation step within a device task.
public struct DeviceToolStep: Codable, Equatable, Sendable {
    public let stepID: String
    public let tool: DeviceToolName
    public let arguments: [String: DeviceJSONValue]

    public init(
        stepID: String = "step-1",
        tool: DeviceToolName,
        arguments: [String: DeviceJSONValue] = [:]
    ) {
        self.stepID = stepID
        self.tool = tool
        self.arguments = arguments
    }
}

/// Submission payload for executing a native task on the iPhone node.
public struct DeviceTaskSubmission: Codable, Equatable, Sendable {
    public static let defaultAgentID = UUID(uuidString: "00000000-0000-4000-8000-00000000c101")!
    public static let deviceTaskKind = SessionTaskKind(rawValue: "device.native.run")!

    public let idempotencyKey: String
    public let agentID: UUID
    public let title: String?
    public let steps: [DeviceToolStep]
    public let deadlineSeconds: TimeInterval
    public let maxAttempts: Int

    public init(
        idempotencyKey: String,
        agentID: UUID = DeviceTaskSubmission.defaultAgentID,
        title: String? = nil,
        steps: [DeviceToolStep],
        deadlineSeconds: TimeInterval = 30,
        maxAttempts: Int = 2
    ) {
        self.idempotencyKey = idempotencyKey
        self.agentID = agentID
        self.title = title
        self.steps = steps
        self.deadlineSeconds = min(max(deadlineSeconds, 1), 120)
        self.maxAttempts = min(max(maxAttempts, 1), 3)
    }

    public func canonicalDigest() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(self)
        return DeviceSandboxCrypto.sha256Hex(data)
    }
}

/// Safety and resource bounds enforced by the iOS Device Sandbox.
public struct DeviceSandboxPolicy: Codable, Equatable, Sendable {
    public let maxInputBytes: Int
    public let maxOutputTextBytes: Int
    public let maxGeneratedFileBytes: Int
    public let maxWorkspaceBytes: Int
    public let maxStepsPerTask: Int
    public let maxJSONDepth: Int
    public let stepTimeoutMs: Int
    public let maxConcurrentTasks: Int
    public let rejectOnCriticalThermalState: Bool

    public static let `default` = DeviceSandboxPolicy(
        maxInputBytes: 2 * 1024 * 1024,
        maxOutputTextBytes: 256 * 1024,
        maxGeneratedFileBytes: 4 * 1024 * 1024,
        maxWorkspaceBytes: 16 * 1024 * 1024,
        maxStepsPerTask: 16,
        maxJSONDepth: 32,
        stepTimeoutMs: 10_000,
        maxConcurrentTasks: 1,
        rejectOnCriticalThermalState: true
    )

    public init(
        maxInputBytes: Int,
        maxOutputTextBytes: Int,
        maxGeneratedFileBytes: Int,
        maxWorkspaceBytes: Int,
        maxStepsPerTask: Int,
        maxJSONDepth: Int,
        stepTimeoutMs: Int,
        maxConcurrentTasks: Int,
        rejectOnCriticalThermalState: Bool
    ) {
        self.maxInputBytes = max(1024, maxInputBytes)
        self.maxOutputTextBytes = max(1024, maxOutputTextBytes)
        self.maxGeneratedFileBytes = max(1024, maxGeneratedFileBytes)
        self.maxWorkspaceBytes = max(4096, maxWorkspaceBytes)
        self.maxStepsPerTask = max(1, maxStepsPerTask)
        self.maxJSONDepth = max(4, maxJSONDepth)
        self.stepTimeoutMs = max(100, stepTimeoutMs)
        self.maxConcurrentTasks = max(1, maxConcurrentTasks)
        self.rejectOnCriticalThermalState = rejectOnCriticalThermalState
    }
}

public enum DeviceThermalLevel: String, Codable, Equatable, Sendable {
    case nominal
    case fair
    case serious
    case critical
    case unknown

    public init(_ state: ProcessInfo.ThermalState) {
        switch state {
        case .nominal: self = .nominal
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        @unknown default: self = .unknown
        }
    }
}

/// Hardware, thermal, CPU, and memory telemetry recorded per execution.
public struct DeviceExecutionMetrics: Codable, Equatable, Sendable {
    public let wallDurationMs: Int
    public let cpuUserMs: Double
    public let cpuSystemMs: Double
    public let memoryFootprintBeforeBytes: UInt64
    public let memoryFootprintAfterBytes: UInt64
    public let memoryDeltaBytes: Int64
    public let thermalState: DeviceThermalLevel
    public let isLowPowerModeEnabled: Bool
    public let batteryLevel: Float?
    public let stepsCompleted: Int
    public let artifactsGenerated: Int
    public let deviceModelIdentifier: String
    public let osVersion: String
}

/// Metadata for a file atomically published inside the task's App Sandbox workspace.
public struct DeviceGeneratedArtifact: Codable, Equatable, Identifiable, Sendable {
    public let artifactID: UUID
    public let taskID: UUID
    public let filename: String
    public let mediaType: String
    public let sizeBytes: Int
    public let sha256: String
    public let relativePath: String
    public let createdAt: String

    public var id: UUID { artifactID }

    public func asTaskArtifactItemDTO() -> TaskArtifactItemDTO {
        TaskArtifactItemDTO(
            artifactID: artifactID,
            filename: filename,
            mediaType: mediaType,
            size: sizeBytes,
            sha256: sha256,
            createdBy: .run,
            createdAt: createdAt
        )
    }
}

/// Output produced by an individual native tool step.
public struct NativeToolOutput: Codable, Equatable, Sendable {
    public let summaryText: String
    public let outputText: String
    public let structuredData: DeviceJSONValue?
    public let generatedArtifacts: [DeviceGeneratedArtifact]

    public init(
        summaryText: String,
        outputText: String,
        structuredData: DeviceJSONValue? = nil,
        generatedArtifacts: [DeviceGeneratedArtifact] = []
    ) {
        self.summaryText = summaryText
        self.outputText = outputText
        self.structuredData = structuredData
        self.generatedArtifacts = generatedArtifacts
    }
}

/// Final outcome returned for an on-device task execution.
public struct DeviceTaskOutcome: Codable, Equatable, Sendable {
    public let taskID: UUID
    public let runID: UUID
    public let attemptCount: Int
    public let leaseEpoch: Int
    public let status: TaskStatus
    public let summaryText: String
    public let detailText: String
    public let structuredOutput: DeviceJSONValue?
    public let artifacts: [DeviceGeneratedArtifact]
    public let metrics: DeviceExecutionMetrics?
    public let errorCode: TaskErrorCode?
    public let errorMessage: String?
    public let producedAt: String
}

/// Summary of durable local state restoration on app launch or foreground resume.
public struct DeviceRecoveryReport: Equatable, Sendable {
    public let recoveredQueuedCount: Int
    public let recoveredInterruptedCount: Int
    public let convergedCancelledCount: Int
    public let expiredCount: Int
    public let restoredTerminalCount: Int

    public var totalRecoveredCount: Int {
        recoveredQueuedCount + recoveredInterruptedCount + convergedCancelledCount + expiredCount
    }
}

public enum DeviceExecutorError: Error, Equatable, LocalizedError, Sendable {
    case invalidArgument(String)
    case unsupportedTool(String)
    case sandboxPathViolation(String)
    case blockedMediaType(String)
    case payloadTooLarge(String)
    case jsonDepthExceeded(String)
    case executionTimeout(String)
    case cancelled
    case backgroundSuspended
    case thermalThrottled(DeviceThermalLevel)
    case storageUnavailable(String)
    case idempotencyConflict
    case taskNotFound(UUID)

    public var taskErrorCode: TaskErrorCode {
        switch self {
        case .invalidArgument, .unsupportedTool, .jsonDepthExceeded:
            .invalidArgument
        case .sandboxPathViolation, .blockedMediaType, .payloadTooLarge, .thermalThrottled:
            .policyDenied
        case .executionTimeout:
            .executionTimeout
        case .cancelled:
            .cancelled
        case .backgroundSuspended:
            .staleLease
        case .storageUnavailable:
            .databaseUnavailable
        case .idempotencyConflict:
            .idempotencyConflict
        case .taskNotFound:
            .notFound
        }
    }

    public var errorDescription: String? {
        switch self {
        case .invalidArgument(let message): message
        case .unsupportedTool(let name): "Unsupported native tool: \(name)"
        case .sandboxPathViolation(let path): "Sandbox path violation: \(path)"
        case .blockedMediaType(let mediaType): "Blocked output media type: \(mediaType)"
        case .payloadTooLarge(let message): message
        case .jsonDepthExceeded(let message): message
        case .executionTimeout(let message): message
        case .cancelled: "Task execution was cancelled."
        case .backgroundSuspended: "Execution interrupted before completion due to background suspension."
        case .thermalThrottled(let level): "Device thermal state (\(level.rawValue)) throttled execution."
        case .storageUnavailable(let message): message
        case .idempotencyConflict: "Idempotency key reused with a different payload."
        case .taskNotFound(let id): "Task not found: \(id.uuidString.lowercased())"
        }
    }
}
