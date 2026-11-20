import Foundation

public protocol CloudDeviceAPITransporting: Sendable {
    func register(credential: CloudDeviceCredential) async throws -> CloudDeviceRegistrationReceipt
    func claim(credential: CloudDeviceCredential) async throws -> CloudDeviceClaimResponse
    func renew(
        credential: CloudDeviceCredential,
        taskID: UUID,
        fence: CloudDeviceFence,
        previousLeaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> CloudDeviceRenewOutcome
    func submitResult(
        credential: CloudDeviceCredential,
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome
}

private final class CloudDeviceRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
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

/// Typed wire client implementing the M2-F2 Cloud Device Adapter HTTP contract:
/// - `POST /v2/devices/{deviceId}/register`
/// - `POST /v2/devices/{deviceId}/claim`
/// - `POST /v2/devices/{deviceId}/tasks/{taskId}/renew`
/// - `POST /v2/devices/{deviceId}/tasks/{taskId}/result`
public final class CloudDeviceAPIClient: CloudDeviceAPITransporting, @unchecked Sendable {
    private struct EmptyBody: Encodable {}

    private struct RegistrationBody: Encodable {
        let capability: String
        let version: Int
    }

    private struct WireReceipt: Decodable {
        let kind: String
        let replayed: Bool?
        let leaseExpiresAtMs: Int64?
    }

    private let configuration: CloudDeviceEndpointConfiguration
    private let authProvider: AuthSessionProvider
    private let session: URLSession

    public init(
        configuration: CloudDeviceEndpointConfiguration,
        authProvider: AuthSessionProvider,
        session: URLSession? = nil
    ) {
        self.configuration = configuration
        self.authProvider = authProvider
        if let session {
            self.session = session
        } else {
            let urlConfig = URLSessionConfiguration.ephemeral
            urlConfig.timeoutIntervalForRequest = configuration.requestTimeout
            urlConfig.timeoutIntervalForResource = configuration.resourceTimeout
            urlConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(
                configuration: urlConfig,
                delegate: CloudDeviceRedirectBlocker(),
                delegateQueue: nil
            )
        }
    }

    public func register(credential: CloudDeviceCredential) async throws -> CloudDeviceRegistrationReceipt {
        let (status, data) = try await post(
            pathComponents: ["v2", "devices", credential.normalizedDeviceID, "register"],
            credential: credential,
            body: RegistrationBody(capability: configuration.capability, version: configuration.version)
        )
        if status == 409 {
            throw CloudDeviceError.capabilityConflict
        }
        if status == 403 {
            throw CloudDeviceError.deviceRevoked
        }
        if status == 401 {
            throw CloudDeviceError.unauthenticated
        }
        guard status == 200 else {
            throw CloudDeviceError.httpStatus(status)
        }
        let receipt = try decode(CloudDeviceRegistrationReceipt.self, from: data)
        guard receipt.deviceId == credential.id,
              receipt.capability == configuration.capability,
              receipt.version == configuration.version
        else {
            throw CloudDeviceError.invalidResponse
        }
        return receipt
    }

    public func claim(credential: CloudDeviceCredential) async throws -> CloudDeviceClaimResponse {
        let (status, data) = try await post(
            pathComponents: ["v2", "devices", credential.normalizedDeviceID, "claim"],
            credential: credential,
            body: EmptyBody()
        )
        if status == 403 {
            throw CloudDeviceError.deviceRevoked
        }
        if status == 401 {
            throw CloudDeviceError.unauthenticated
        }
        guard status == 200 else {
            throw CloudDeviceError.httpStatus(status)
        }
        let response = try decode(CloudDeviceClaimResponse.self, from: data)
        if case .claimed(let offer) = response {
            guard offer.leaseEpoch > 0, offer.leaseExpiresAtMs <= offer.deadlineAtMs else {
                throw CloudDeviceError.invalidResponse
            }
        }
        return response
    }

    public func renew(
        credential: CloudDeviceCredential,
        taskID: UUID,
        fence: CloudDeviceFence,
        previousLeaseExpiresAtMs: Int64,
        deadlineAtMs: Int64
    ) async throws -> CloudDeviceRenewOutcome {
        let (status, data) = try await post(
            pathComponents: [
                "v2", "devices", credential.normalizedDeviceID,
                "tasks", taskID.uuidString.lowercased(), "renew",
            ],
            credential: credential,
            body: fence
        )
        if status == 409 {
            if (try? decode(WireReceipt.self, from: data).kind) == "fenced" {
                return .fenced
            }
            throw CloudDeviceError.resultConflict
        }
        if status == 403 {
            throw CloudDeviceError.deviceRevoked
        }
        if status == 401 {
            throw CloudDeviceError.unauthenticated
        }
        guard status == 200 else {
            throw CloudDeviceError.httpStatus(status)
        }
        let receipt = try decode(WireReceipt.self, from: data)
        guard receipt.kind == "renewed",
              let expires = receipt.leaseExpiresAtMs,
              expires >= previousLeaseExpiresAtMs,
              expires <= deadlineAtMs
        else {
            throw CloudDeviceError.invalidResponse
        }
        return .renewed(leaseExpiresAtMs: expires)
    }

    public func submitResult(
        credential: CloudDeviceCredential,
        taskID: UUID,
        submission: CloudDeviceResultSubmission
    ) async throws -> CloudDeviceCommitOutcome {
        let (status, data) = try await post(
            pathComponents: [
                "v2", "devices", credential.normalizedDeviceID,
                "tasks", taskID.uuidString.lowercased(), "result",
            ],
            credential: credential,
            body: submission
        )
        if status == 409 {
            guard (try? decode(WireReceipt.self, from: data).kind) == "fenced" else {
                throw CloudDeviceError.resultConflict
            }
            return .fenced
        }
        if status == 403 {
            throw CloudDeviceError.deviceRevoked
        }
        if status == 401 {
            throw CloudDeviceError.unauthenticated
        }
        guard status == 200 else {
            throw CloudDeviceError.httpStatus(status)
        }
        let receipt = try decode(WireReceipt.self, from: data)
        guard receipt.kind == "committed", let replayed = receipt.replayed else {
            throw CloudDeviceError.invalidResponse
        }
        return .committed(replayed: replayed)
    }

    // MARK: - Helpers

    private func post<Body: Encodable>(
        pathComponents: [String],
        credential: CloudDeviceCredential,
        body: Body
    ) async throws -> (Int, Data) {
        try Task.checkCancellation()
        guard case .authenticated(let authSession) = await authProvider.currentSession() else {
            throw CloudDeviceError.unauthenticated
        }
        guard credential.isValidTokenFormat else {
            throw CloudDeviceError.invalidConfiguration
        }

        var url = configuration.origin
        for segment in pathComponents {
            guard !segment.isEmpty, segment != ".", segment != ".." else {
                throw CloudDeviceError.invalidConfiguration
            }
            url.appendPathComponent(segment, isDirectory: false)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = configuration.requestTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(authSession.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(credential.token, forHTTPHeaderField: CloudDeviceContract.deviceTokenHeader)
        if let localAccess = configuration.localAccessSecret {
            request.setValue(localAccess, forHTTPHeaderField: CloudDeviceContract.localAccessHeader)
        }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else {
            throw CloudDeviceError.invalidResponse
        }
        return (http.statusCode, data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw CloudDeviceError.invalidResponse
        }
    }
}
