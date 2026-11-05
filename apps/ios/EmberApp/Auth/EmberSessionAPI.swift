import Foundation

/// The frozen B1 session surface (ADR-0004 §5, annex §5.2–§5.4).
///
/// Four operations, no more: mint a session from an Apple assertion, rotate it, revoke it, and read
/// the authoritative bootstrap projection. Nothing here creates a Conversation, an Agent or a
/// consumer locally, and nothing here re-reads an Apple assertion after sign-in (I-7).
public protocol EmberSessionAPI: Sendable {
    /// `POST /v1/auth/session` → 201. Mints a new session; repeat sign-in never creates a second
    /// tenant, Agent or Conversation (I-4).
    func createSession(identityToken: String, nonce: String) async throws -> EmberSessionResponseDTO

    /// `POST /v1/auth/session/refresh` → 200. Rotates the token; the presented token becomes
    /// invalid, and presenting it again is a security event on the server.
    func refreshSession(accessToken: EmberAccessToken) async throws -> EmberSessionResponseDTO

    /// `DELETE /v1/auth/session` → 204. Idempotent, revokes only the presented session, no body.
    func logout(accessToken: EmberAccessToken) async throws

    /// `GET /v1/me` → 200. The single bootstrap call after sign-in and on every cold start.
    func bootstrap(accessToken: EmberAccessToken) async throws -> EmberMeDTO
}

/// The concrete typed client. It owns HTTP semantics only: status validation, strict decoding and
/// sanitized error mapping. Refresh policy, single-flight and Keychain live in the coordinator.
public final class LiveEmberSessionAPI: EmberSessionAPI, @unchecked Sendable {
    /// Fixed route segments. Paths are always assembled from these literals and the injected
    /// origin — never from a string a server returned.
    private enum Route {
        static let createSession = ["v1", "auth", "session"]
        static let refreshSession = ["v1", "auth", "session", "refresh"]
        static let me = ["v1", "me"]
    }

    private let baseURL: URL
    private let client: EmberAPIClient
    private let timeout: TimeInterval

    /// - Parameters:
    ///   - baseURL: An `https` origin with no credentials, query or fragment. `http` is refused so
    ///     a bearer token cannot travel in clear text, and there is no ATS exception anywhere.
    ///   - client: The existing URLSession transport. Tests inject one whose configuration
    ///     carries an intercepting `URLProtocol`.
    public init(baseURL: URL, client: EmberAPIClient = EmberAPIClient(), timeout: TimeInterval = 30)
        throws
    {
        guard Self.isAcceptableBaseURL(baseURL) else { throw AuthError.invalidBaseURL }
        self.baseURL = baseURL
        self.client = client
        self.timeout = timeout
    }

    /// Deliberately strict: session traffic is credential traffic.
    static func isAcceptableBaseURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        return components.scheme?.lowercased() == "https"
            && (components.host?.isEmpty == false)
            && components.user == nil
            && components.password == nil
            && components.query == nil
            && components.fragment == nil
    }

    // MARK: - Operations

    public func createSession(
        identityToken: String,
        nonce: String
    ) async throws -> EmberSessionResponseDTO {
        guard !identityToken.isEmpty, !nonce.isEmpty else { throw AuthError.appleCredentialInvalid }

        var request = try makeRequest(path: Route.createSession, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try encode(EmberSessionCreateRequest.apple(identityToken: identityToken, nonce: nonce))

        let response = try await send(request)
        // 201 is the only acceptable success. A 200 here would mean the server changed the
        // contract, and silently accepting it would hide that from review.
        guard response.statusCode == 201 else { throw Self.error(forStatus: response.statusCode) }
        return try decode(EmberSessionResponseDTO.self, from: response.data)
    }

    public func refreshSession(accessToken: EmberAccessToken) async throws -> EmberSessionResponseDTO {
        var request = try makeRequest(path: Route.refreshSession, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // I-7: refresh authenticates with the Ember token only. No Apple assertion, no nonce,
        // and no request body at all — a smuggled body is rejected by the server.
        request.setValue("Bearer \(accessToken.rawValue)", forHTTPHeaderField: "Authorization")

        let response = try await send(request)
        guard response.statusCode == 200 else { throw Self.error(forStatus: response.statusCode) }
        return try decode(EmberSessionResponseDTO.self, from: response.data)
    }

    public func logout(accessToken: EmberAccessToken) async throws {
        var request = try makeRequest(path: Route.createSession, method: "DELETE")
        request.setValue("Bearer \(accessToken.rawValue)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let response = try await send(request)
        guard response.statusCode == 204 else { throw Self.error(forStatus: response.statusCode) }
        // 204 carries no body. Anything left over is not interpreted: there is nothing to adopt.
    }

    public func bootstrap(accessToken: EmberAccessToken) async throws -> EmberMeDTO {
        var request = try makeRequest(path: Route.me, method: "GET")
        request.setValue("Bearer \(accessToken.rawValue)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let response = try await send(request)
        guard response.statusCode == 200 else { throw Self.error(forStatus: response.statusCode) }
        return try decode(EmberMeDTO.self, from: response.data)
    }

    // MARK: - Request construction

    private func makeRequest(path: [String], method: String) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw AuthError.invalidBaseURL
        }
        let root = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = ([root] + path).joined(separator: "/")
        components.query = nil
        components.fragment = nil

        guard let url = components.url else { throw AuthError.invalidBaseURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        // No cached credential response is ever replayed.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    private func encode(_ body: EmberSessionCreateRequest) throws -> Data {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return try encoder.encode(body)
        } catch {
            throw AuthError.appleCredentialInvalid
        }
    }

    // MARK: - Response handling

    private func send(_ request: URLRequest) async throws -> EmberAPIResponse {
        do {
            return try await client.send(request)
        } catch {
            throw Self.error(for: error)
        }
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        guard !data.isEmpty else { throw AuthError.invalidResponse }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            // The decoding error's message can quote server-provided keys, so it is dropped.
            throw AuthError.invalidResponse
        }
    }

    /// One closed mapping. Every non-success status becomes a typed value; none is ever turned
    /// into a successful authentication state.
    static func error(forStatus status: Int) -> AuthError {
        switch status {
        case 400: .invalidRequest
        case 401: .unauthenticated
        case 404: .notFound
        case 429: .rateLimited
        case 500...599: .serverUnavailable
        default: .unexpectedStatus(status)
        }
    }

    static func error(for error: Error) -> AuthError {
        if let error = error as? AuthError { return error }
        if error as? EmberAPITransportError == .nonHTTPResponse { return .nonHTTPResponse }

        guard let urlError = error as? URLError else { return .transportFailure }
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
            .cannotFindHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff:
            return .offline
        case .timedOut:
            return .timedOut
        case .cancelled:
            return .transportFailure
        default:
            return .transportFailure
        }
    }
}
