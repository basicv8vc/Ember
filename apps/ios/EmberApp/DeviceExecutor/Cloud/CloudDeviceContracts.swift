import Foundation

/// Wire constants shared with Agent F's M2-F2 Cloud Device Execution contract.
public enum CloudDeviceContract {
    public static let textCapability = "device.text.process"
    public static let capabilityVersion = 1
    public static let statsOperation = "stats"
    public static let defaultReadyTTLMs: Int64 = 30_000
    public static let defaultLeaseTTLMs: Int64 = 30_000
    public static let maxTextUTF16Units = 4_096
    public static let maxTextUTF8Bytes = 12_288
    public static let maxLinesCount = 4_097
    public static let deviceTokenHeader = "X-Device-Token"
    public static let localAccessHeader = "X-Ember-Local-Access"
}

/// Time source abstraction enabling deterministic deadline/lease testing alongside live execution.
public protocol CloudDeviceClock: Sendable {
    var nowMs: Int64 { get }
    func sleep(for duration: Duration) async throws
}

public struct SystemCloudDeviceClock: CloudDeviceClock {
    public init() {}

    public var nowMs: Int64 {
        Int64((Date().timeIntervalSince1970 * 1_000.0).rounded())
    }

    public func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: duration)
    }
}

/// Errors emitted by the Cloud Device Adapter and wire client.
public enum CloudDeviceError: Error, Equatable, Sendable {
    case invalidConfiguration
    case unauthenticated
    case sessionUnavailable
    case unavailableStorage
    case invalidResponse
    case deviceRevoked
    case capabilityConflict
    case resultConflict
    case httpStatus(Int)
    case deadlineExpired
    case fenced

    public var canRetry: Bool {
        switch self {
        case .httpStatus(let code):
            return code == 408 || code == 429 || code >= 500
        case .sessionUnavailable:
            return true
        case .unavailableStorage:
            return false
        case .invalidConfiguration, .unauthenticated, .invalidResponse,
             .deviceRevoked, .capabilityConflict, .resultConflict,
             .deadlineExpired, .fenced:
            return false
        }
    }

    public var statusDescription: String {
        switch self {
        case .invalidConfiguration:
            return "Cloud device endpoint configuration is invalid."
        case .unauthenticated:
            return "Ember bearer session unavailable."
        case .sessionUnavailable:
            return "Ember bearer session temporarily unavailable; retrying."
        case .unavailableStorage:
            return "Protected storage unavailable on device."
        case .invalidResponse:
            return "Invalid response from Cloud AgentHead."
        case .deviceRevoked:
            return "Device credential was revoked by Cloud AgentHead."
        case .capabilityConflict:
            return "Device ID is already registered with an incompatible capability."
        case .resultConflict:
            return "Pending result conflict; local journal retains pending submission."
        case .httpStatus(let code):
            return "Cloud AgentHead returned HTTP \(code)."
        case .deadlineExpired:
            return "Cloud-assigned task deadline expired prior to completion."
        case .fenced:
            return "Task run fence was superseded, expired, or cancelled by Cloud."
        }
    }
}

/// Origin and timing policy for connecting to Ember Cloud / local V2 Worker / LAN relay.
public struct CloudDeviceEndpointConfiguration: Equatable, Sendable {
    public let origin: URL
    public let accountID: UUID
    public let capability: String
    public let version: Int
    public let localAccessSecret: String?
    public let heartbeatInterval: Duration
    public let idlePollInterval: Duration
    public let simulatedWorkDelay: Duration
    public let requestTimeout: TimeInterval
    public let resourceTimeout: TimeInterval

    public init(
        origin: URL,
        accountID: UUID,
        capability: String = CloudDeviceContract.textCapability,
        version: Int = CloudDeviceContract.capabilityVersion,
        localAccessSecret: String? = nil,
        heartbeatInterval: Duration = .seconds(10),
        idlePollInterval: Duration = .seconds(1),
        simulatedWorkDelay: Duration = .zero,
        requestTimeout: TimeInterval = 5,
        resourceTimeout: TimeInterval = 7
    ) throws {
        guard let normalizedOrigin = Self.validatedOrigin(origin),
              capability == CloudDeviceContract.textCapability,
              version == CloudDeviceContract.capabilityVersion,
              localAccessSecret.map(Self.isValidHeaderValue) ?? true
        else {
            throw CloudDeviceError.invalidConfiguration
        }
        self.origin = normalizedOrigin
        self.accountID = accountID
        self.capability = capability
        self.version = version
        self.localAccessSecret = localAccessSecret
        self.heartbeatInterval = heartbeatInterval
        self.idlePollInterval = idlePollInterval
        self.simulatedWorkDelay = simulatedWorkDelay
        self.requestTimeout = requestTimeout
        self.resourceTimeout = resourceTimeout
    }

    /// Unique deterministic Keychain/journal scope key bound to `(origin, accountID)`.
    public var scopeIdentifier: String {
        "\(origin.absoluteString)|\(accountID.uuidString.lowercased())"
    }

    /// Accepts `https://` generally, and `http://` strictly for loopback/local-LAN V2 QA origins.
    public static func validatedOrigin(_ url: URL) -> URL? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let rawHost = components.host?.lowercased(),
              !rawHost.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else {
            return nil
        }
        switch scheme {
        case "https":
            var clean = components
            clean.scheme = "https"
            clean.host = rawHost
            clean.path = ""
            return clean.url
        case "http":
            guard isLoopbackOrPrivateLANHost(rawHost) else { return nil }
            var clean = components
            clean.scheme = "http"
            clean.host = rawHost
            clean.path = ""
            return clean.url
        default:
            return nil
        }
    }

    public static func isValidHeaderValue(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 1_024 && value.utf8.allSatisfy { (33...126).contains($0) }
    }

    private static func isLoopbackOrPrivateLANHost(_ host: String) -> Bool {
        if host == "localhost" || host == "::1" || host == "[::1]" || host.hasSuffix(".local") {
            return true
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { UInt8($0) }
        guard parts.count == 4, octets.count == 4,
              octets.map(String.init).joined(separator: ".") == host
        else {
            return false
        }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 169 && octets[1] == 254)
    }
}

/// Static bearer token bridge for Agent F local QA harnesses (`AuthSessionProvider` conformer).
public struct StaticCloudDeviceAuthProvider: AuthSessionProvider {
    private let session: AuthSessionState

    public init(bearerToken: String) throws {
        guard CloudDeviceEndpointConfiguration.isValidHeaderValue(bearerToken),
              let authSession = AuthSession(accessToken: bearerToken)
        else {
            throw CloudDeviceError.invalidConfiguration
        }
        self.session = .authenticated(authSession)
    }

    public func currentSession() async -> AuthSessionState {
        session
    }
}

/// Exact Cloud-authoritative execution fence for a leased run.
public struct CloudDeviceFence: Codable, Equatable, Sendable {
    public let operationId: UUID
    public let runId: UUID
    public let leaseEpoch: Int

    public init(operationId: UUID, runId: UUID, leaseEpoch: Int) {
        self.operationId = operationId
        self.runId = runId
        self.leaseEpoch = leaseEpoch
    }

    enum CodingKeys: String, CodingKey {
        case operationId
        case runId
        case leaseEpoch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        operationId = try container.decode(UUID.self, forKey: .operationId)
        runId = try container.decode(UUID.self, forKey: .runId)
        leaseEpoch = try container.decode(Int.self, forKey: .leaseEpoch)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operationId.uuidString.lowercased(), forKey: .operationId)
        try container.encode(runId.uuidString.lowercased(), forKey: .runId)
        try container.encode(leaseEpoch, forKey: .leaseEpoch)
    }
}

public struct CloudDeviceTextInput: Codable, Equatable, Sendable {
    public let operation: String
    public let text: String

    public init(operation: String, text: String) {
        self.operation = operation
        self.text = text
    }
}

/// Exact Cloud AgentHead task offer returned by `POST /v2/devices/{deviceId}/claim`.
/// Cloud AgentHead owns `taskId`, `operationId`, `runId`, `leaseEpoch`, `leaseExpiresAtMs`, and `deadlineAtMs`.
public struct CloudDeviceClaimOffer: Codable, Equatable, Sendable {
    public let taskId: UUID
    public let operationId: UUID
    public let runId: UUID
    public let leaseEpoch: Int
    public let leaseExpiresAtMs: Int64
    public let deadlineAtMs: Int64
    public let capability: String
    public let version: Int
    public let input: CloudDeviceTextInput

    public var fence: CloudDeviceFence {
        CloudDeviceFence(operationId: operationId, runId: runId, leaseEpoch: leaseEpoch)
    }

    public init(
        taskId: UUID,
        operationId: UUID,
        runId: UUID,
        leaseEpoch: Int,
        leaseExpiresAtMs: Int64,
        deadlineAtMs: Int64,
        capability: String,
        version: Int,
        input: CloudDeviceTextInput
    ) {
        self.taskId = taskId
        self.operationId = operationId
        self.runId = runId
        self.leaseEpoch = leaseEpoch
        self.leaseExpiresAtMs = leaseExpiresAtMs
        self.deadlineAtMs = deadlineAtMs
        self.capability = capability
        self.version = version
        self.input = input
    }
}

public enum CloudDeviceClaimResponse: Equatable, Sendable, Decodable {
    case idle
    case claimed(CloudDeviceClaimOffer)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "idle":
            self = .idle
        case "claimed":
            self = .claimed(try CloudDeviceClaimOffer(from: decoder))
        default:
            throw CloudDeviceError.invalidResponse
        }
    }
}

public struct CloudDeviceRegistrationReceipt: Codable, Equatable, Sendable {
    public let deviceId: UUID
    public let capability: String
    public let version: Int
    public let readyUntilMs: Int64

    public init(deviceId: UUID, capability: String, version: Int, readyUntilMs: Int64) {
        self.deviceId = deviceId
        self.capability = capability
        self.version = version
        self.readyUntilMs = readyUntilMs
    }
}

public enum CloudDeviceRenewOutcome: Equatable, Sendable {
    case renewed(leaseExpiresAtMs: Int64)
    case fenced
}

public enum CloudDeviceCommitOutcome: Equatable, Sendable {
    case committed(replayed: Bool)
    case fenced
}

/// Wire output payload for `device.text.process` v1 (`operation: "stats"`).
/// Counts UTF-8 bytes and Unicode scalars without normalization; empty text has 0 lines,
/// otherwise 1 + count of LF (`0x0A`) bytes.
public struct CloudDeviceTextStats: Codable, Equatable, Sendable {
    public let utf8Bytes: Int
    public let unicodeScalars: Int
    public let lines: Int

    public init(utf8Bytes: Int, unicodeScalars: Int, lines: Int) {
        self.utf8Bytes = utf8Bytes
        self.unicodeScalars = unicodeScalars
        self.lines = lines
    }

    public init(text: String) {
        self.utf8Bytes = text.utf8.count
        self.unicodeScalars = text.unicodeScalars.count
        self.lines = text.isEmpty ? 0 : 1 + text.utf8.reduce(0) { count, byte in
            byte == 0x0A ? count + 1 : count
        }
    }

    public init(nativeToolOutput: NativeToolOutput) throws {
        guard let obj = nativeToolOutput.structuredData?.objectValue,
              let utf8Bytes = obj["utf8_bytes"]?.intValue,
              let unicodeScalars = obj["unicode_scalars"]?.intValue,
              let lines = obj["lf_line_count"]?.intValue,
              (0...CloudDeviceContract.maxTextUTF8Bytes).contains(utf8Bytes),
              (0...CloudDeviceContract.maxTextUTF16Units).contains(unicodeScalars),
              (0...CloudDeviceContract.maxLinesCount).contains(lines)
        else {
            throw CloudDeviceError.invalidResponse
        }
        self.utf8Bytes = utf8Bytes
        self.unicodeScalars = unicodeScalars
        self.lines = lines
    }
}

public enum CloudDeviceSubmissionStatus: String, Codable, Equatable, Sendable {
    case completed
    case failed
}

/// Strictly fenced wire submission sent to `POST /v2/devices/{deviceId}/tasks/{taskId}/result`.
/// Uses Cloud AgentHead authoritative `operationId`, `runId`, and `leaseEpoch`.
public struct CloudDeviceResultSubmission: Codable, Equatable, Sendable {
    public let operationId: UUID
    public let runId: UUID
    public let leaseEpoch: Int
    public let status: CloudDeviceSubmissionStatus
    public let output: CloudDeviceTextStats?

    public init(fence: CloudDeviceFence, output: CloudDeviceTextStats) {
        self.operationId = fence.operationId
        self.runId = fence.runId
        self.leaseEpoch = fence.leaseEpoch
        self.status = .completed
        self.output = output
    }

    public init(failedWithFence fence: CloudDeviceFence) {
        self.operationId = fence.operationId
        self.runId = fence.runId
        self.leaseEpoch = fence.leaseEpoch
        self.status = .failed
        self.output = nil
    }

    enum CodingKeys: String, CodingKey {
        case operationId
        case runId
        case leaseEpoch
        case status
        case output
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operationId.uuidString.lowercased(), forKey: .operationId)
        try container.encode(runId.uuidString.lowercased(), forKey: .runId)
        try container.encode(leaseEpoch, forKey: .leaseEpoch)
        try container.encode(status, forKey: .status)
        if status == .completed, let output {
            try container.encode(output, forKey: .output)
        }
    }
}

#if DEBUG
/// Request payload for `POST /v2/device-tasks` (`deviceDispatchSchema`, `device.text.process` v1).
public struct CloudDeviceTaskDispatchRequest: Encodable, Equatable, Sendable {
    public let deviceId: String
    public let operationId: String
    public let capability: String
    public let version: Int
    public let input: CloudDeviceTextInput
    public let deadlineMs: Int

    public init(
        deviceID: UUID,
        operationID: UUID = UUID(),
        text: String,
        deadlineMs: Int = 60_000
    ) {
        self.deviceId = deviceID.uuidString.lowercased()
        self.operationId = operationID.uuidString.lowercased()
        self.capability = CloudDeviceContract.textCapability
        self.version = CloudDeviceContract.capabilityVersion
        self.input = CloudDeviceTextInput(operation: CloudDeviceContract.statsOperation, text: text)
        self.deadlineMs = deadlineMs
    }
}

/// Snapshot returned by `POST /v2/device-tasks` and `GET /v2/device-tasks/{taskId}`.
public struct CloudDeviceTaskSnapshot: Decodable, Equatable, Sendable {
    public let taskId: UUID
    public let operationId: UUID
    public let deviceId: UUID
    public let status: String
    public let availability: String
    public let reason: String?
    public let result: CloudDeviceTextStats?
    public let replayed: Bool?

    public var isTerminal: Bool {
        status == "completed" || status == "failed" || status == "cancelled"
    }
}

public protocol CloudDeviceTaskDispatching: Sendable {
    func dispatchTextTask(
        deviceID: UUID,
        operationID: UUID,
        text: String,
        deadlineMs: Int
    ) async throws -> CloudDeviceTaskSnapshot
    func fetchDeviceTaskStatus(taskID: UUID) async throws -> CloudDeviceTaskSnapshot
}
#endif
