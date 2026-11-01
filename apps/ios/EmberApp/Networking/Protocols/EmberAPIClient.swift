import Foundation

public struct EmberAPIResponse: Sendable {
    public let data: Data
    public let statusCode: Int

    public init(data: Data, statusCode: Int) {
        self.data = data
        self.statusCode = statusCode
    }
}

public enum EmberAPITransportError: Error, Equatable {
    case nonHTTPResponse
}

/// URLSession transport only. It does not encode task policy, auth, or repository behavior.
public final class EmberAPIClient: @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> EmberAPIResponse {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw EmberAPITransportError.nonHTTPResponse
        }
        return EmberAPIResponse(data: data, statusCode: response.statusCode)
    }
}
