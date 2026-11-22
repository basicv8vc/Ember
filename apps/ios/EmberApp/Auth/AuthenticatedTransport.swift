import Foundation

/// How a request may be retried.
///
/// The distinction is the whole point of this type: replaying a read after a transport failure is
/// harmless, replaying a Conversation write is not. The B1 contract gives writes exactly one
/// recovery mechanism — the `client_submission_id` lookup — and that belongs to L2, not to a blind
/// retry inside the transport (annex §10.1 N-3, §10.3).
public enum EmberRequestIdempotency: Equatable, Sendable {
    /// Safe to send more than once. A 401 may be followed by one refresh and one replay.
    case idempotentRead
    /// Not safe to replay. Carries the submission identifier the caller must reuse if it chooses
    /// to resubmit after an unknown outcome.
    case nonIdempotent(clientSubmissionID: String?)
}

/// An authenticated request described independently of URLSession, so the coordinator can own
/// authorization without owning HTTP details.
public struct EmberAuthenticatedRequest: Equatable, Sendable {
    public let method: String
    /// Path segments appended to the injected origin. Segments are validated rather than trusted:
    /// several of them will be server-issued ids in L2, and a value containing `/`, `?` or `#` must
    /// never be able to reshape the URL.
    public let pathComponents: [String]
    public let body: Data?
    public let contentType: String?
    public let accept: String?
    public let idempotency: EmberRequestIdempotency
    /// Optional bounded query for B1 ascending history pages (after, limit).
    public let queryItems: [URLQueryItem]

    public init(
        method: String,
        pathComponents: [String],
        body: Data? = nil,
        contentType: String? = nil,
        accept: String? = nil,
        idempotency: EmberRequestIdempotency,
        queryItems: [URLQueryItem] = []
    ) {
        self.method = method
        self.pathComponents = pathComponents
        self.body = body
        self.contentType = contentType
        self.accept = accept
        self.idempotency = idempotency
        self.queryItems = queryItems
    }

    /// Convenience for the common authenticated read.
    public static func read(pathComponents: [String]) -> Self {
        Self(method: "GET", pathComponents: pathComponents, idempotency: .idempotentRead)
    }
}

/// Builds and sends authenticated requests against one injected origin.
///
/// Kept separate from `LiveEmberSessionAPI` because session routes are a closed, unauthenticated-
/// then-authenticated set, whereas this boundary will carry Conversation traffic in L2. Both share
/// the same origin validation, so there is exactly one place where a base URL is accepted.
public struct EmberAuthenticatedTransport: Sendable {
    private let baseURL: URL
    private let client: EmberAPIClient
    private let timeout: TimeInterval

    public init(baseURL: URL, client: EmberAPIClient = EmberAPIClient(), timeout: TimeInterval = 30)
        throws
    {
        guard LiveEmberSessionAPI.isAcceptableBaseURL(baseURL) else { throw AuthError.invalidBaseURL }
        self.baseURL = baseURL
        self.client = client
        self.timeout = timeout
    }

    public func makeRequest(
        _ request: EmberAuthenticatedRequest,
        accessToken: EmberAccessToken
    ) throws -> URLRequest {
        guard !request.pathComponents.isEmpty,
            request.pathComponents.allSatisfy(Self.isSafePathSegment)
        else {
            throw AuthError.invalidRequest
        }

        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw AuthError.invalidBaseURL
        }
        let root = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = ([root] + request.pathComponents).joined(separator: "/")
        // Never allow unreviewed scope-bearing query parameters.
        guard request.queryItems.allSatisfy({
            ($0.name == "after" || $0.name == "limit") && $0.value != nil
        }) else { throw AuthError.invalidRequest }
        components.queryItems = request.queryItems.isEmpty ? nil : request.queryItems
        components.fragment = nil

        guard let url = components.url else { throw AuthError.invalidBaseURL }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.timeoutInterval = timeout
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        // The only place a bearer token enters a URLRequest. It is never placed in a URL, a query
        // item or a log message.
        urlRequest.setValue("Bearer \(accessToken.rawValue)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue(request.accept ?? "application/json", forHTTPHeaderField: "Accept")

        if let contentType = request.contentType {
            urlRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if let body = request.body {
            urlRequest.httpBody = body
        }
        return urlRequest
    }

    public func send(_ urlRequest: URLRequest) async throws -> EmberAPIResponse {
        do {
            return try await client.send(urlRequest)
        } catch {
            throw LiveEmberSessionAPI.error(for: error)
        }
    }

    public func stream(_ urlRequest: URLRequest) async throws -> EmberAPIStreamResponse {
        do {
            return try await client.stream(urlRequest)
        } catch {
            throw LiveEmberSessionAPI.error(for: error)
        }
    }

    /// Rejects anything that could escape its path segment.
    static func isSafePathSegment(_ segment: String) -> Bool {
        guard !segment.isEmpty, segment != ".", segment != ".." else { return false }
        return segment.allSatisfy { character in
            guard character.isASCII else { return false }
            return character.isLetter || character.isNumber || character == "-" || character == "_"
        }
    }
}
