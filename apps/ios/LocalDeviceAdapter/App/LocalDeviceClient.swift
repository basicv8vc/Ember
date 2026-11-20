import Foundation

struct NativeTextStats: Codable, Equatable {
    let utf8Bytes: Int
    let unicodeScalars: Int
    let lines: Int

    init(text: String) {
        utf8Bytes = text.utf8.count
        unicodeScalars = text.unicodeScalars.count
        lines = text.isEmpty ? 0 : 1 + text.utf8.reduce(0) { count, byte in
            byte == 0x0A ? count + 1 : count
        }
    }
}

struct LocalDeviceFence: Codable {
    let operationId: UUID
    let runId: UUID
    let leaseEpoch: Int
}

struct LocalDeviceSubmission: Codable {
    let operationId: UUID
    let runId: UUID
    let leaseEpoch: Int
    let status: String
    let output: NativeTextStats

    init(fence: LocalDeviceFence, output: NativeTextStats) {
        operationId = fence.operationId
        runId = fence.runId
        leaseEpoch = fence.leaseEpoch
        status = "completed"
        self.output = output
    }
}

struct LocalDeviceOffer: Decodable {
    struct Input: Decodable {
        let operation: String
        let text: String
    }

    let taskId: UUID
    let operationId: UUID
    let runId: UUID
    let leaseEpoch: Int
    let leaseExpiresAtMs: Int64
    let deadlineAtMs: Int64
    let capability: String
    let version: Int
    let input: Input

    var fence: LocalDeviceFence {
        .init(operationId: operationId, runId: runId, leaseEpoch: leaseEpoch)
    }
}

private enum LocalDeviceClaim: Decodable {
    case idle
    case claimed(LocalDeviceOffer)

    private enum CodingKeys: CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "idle": self = .idle
        case "claimed": self = .claimed(try LocalDeviceOffer(from: decoder))
        default: throw LocalDeviceError.invalidResponse
        }
    }
}

private final class LocalDeviceRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct LocalDeviceClient {
    static let capability = "device.text.process"
    static let version = 1

    private struct Empty: Encodable {}

    private struct RegistrationRequest: Encodable {
        let capability = LocalDeviceClient.capability
        let version = LocalDeviceClient.version
    }

    private struct Registration: Decodable {
        let deviceId: UUID
        let capability: String
        let version: Int
    }

    private struct Receipt: Decodable {
        let kind: String
        let replayed: Bool?
        let leaseExpiresAtMs: Int64?
    }

    enum Result {
        case committed(replayed: Bool)
        case fenced
    }

    private let configuration: LocalDeviceConfiguration
    private let credential: LocalDeviceCredential
    private let session: URLSession

    init(configuration: LocalDeviceConfiguration, credential: LocalDeviceCredential) {
        self.configuration = configuration
        self.credential = credential
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 5
        settings.timeoutIntervalForResource = 7
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(
            configuration: settings, delegate: LocalDeviceRedirectPolicy(), delegateQueue: nil
        )
    }

    func register() async throws {
        let (status, data) = try await post("register", body: RegistrationRequest())
        guard status == 200 else { throw LocalDeviceError.http(status) }
        let registered = try Self.decode(Registration.self, data)
        guard registered.deviceId == credential.id, registered.capability == Self.capability,
              registered.version == Self.version
        else { throw LocalDeviceError.invalidResponse }
    }

    func claim() async throws -> LocalDeviceOffer? {
        let (status, data) = try await post("claim", body: Empty())
        guard status == 200 else { throw LocalDeviceError.http(status) }
        switch try Self.decode(LocalDeviceClaim.self, data) {
        case .idle: return nil
        case .claimed(let offer):
            guard offer.capability == Self.capability, offer.version == Self.version,
                  offer.input.operation == "stats", offer.leaseEpoch > 0,
                  offer.leaseExpiresAtMs <= offer.deadlineAtMs
            else { throw LocalDeviceError.invalidResponse }
            return offer
        }
    }

    func renew(_ offer: LocalDeviceOffer) async throws -> Int64? {
        let (status, data) = try await post(path(offer.taskId, "renew"), body: offer.fence)
        if status == 409, (try? Self.decode(Receipt.self, data).kind) == "fenced" { return nil }
        guard status == 200 else { throw LocalDeviceError.http(status) }
        let receipt = try Self.decode(Receipt.self, data)
        guard receipt.kind == "renewed", let expires = receipt.leaseExpiresAtMs,
              expires >= offer.leaseExpiresAtMs, expires <= offer.deadlineAtMs
        else { throw LocalDeviceError.invalidResponse }
        return expires
    }

    func commit(_ pending: LocalDevicePendingResult) async throws -> Result {
        let (status, data) = try await post(path(pending.taskID, "result"), body: pending.submission)
        return try Self.decodeCommitReceipt(status: status, data: data)
    }

    static func decodeCommitReceipt(status: Int, data: Data) throws -> Result {
        if status == 409 {
            guard (try? decode(Receipt.self, data).kind) == "fenced" else {
                throw LocalDeviceError.resultConflict
            }
            return .fenced
        }
        guard status == 200 else { throw LocalDeviceError.http(status) }
        let receipt = try decode(Receipt.self, data)
        guard receipt.kind == "committed", let replayed = receipt.replayed else {
            throw LocalDeviceError.invalidResponse
        }
        return .committed(replayed: replayed)
    }

    private func path(_ taskID: UUID, _ action: String) -> String {
        "tasks/\(taskID.uuidString.lowercased())/\(action)"
    }

    private func post(_ suffix: String, body: some Encodable) async throws -> (Int, Data) {
        try Task.checkCancellation()
        let id = credential.id.uuidString.lowercased()
        let url = configuration.origin.appending(path: "/v2/devices/\(id)/\(suffix)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(configuration.sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue(credential.token, forHTTPHeaderField: "X-Device-Token")
        request.setValue(configuration.accessSecret, forHTTPHeaderField: "X-Ember-Local-Access")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw LocalDeviceError.invalidResponse }
        return (http.statusCode, data)
    }

    private static func decode<V: Decodable>(_ type: V.Type, _ data: Data) throws -> V {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw LocalDeviceError.invalidResponse
        }
    }
}
