import Foundation

public struct EmberAPIResponse: Sendable {
  public let data: Data
  public let statusCode: Int

  public init(data: Data, statusCode: Int) {
    self.data = data
    self.statusCode = statusCode
  }
}

public struct EmberAPIStreamResponse: @unchecked Sendable {
  public let bytes: URLSession.AsyncBytes
  public let statusCode: Int
  public let contentType: String?

  public init(bytes: URLSession.AsyncBytes, statusCode: Int, contentType: String?) {
    self.bytes = bytes
    self.statusCode = statusCode
    self.contentType = contentType
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

  /// Opens a streaming response without buffering the entire body. Callers still own
  /// endpoint semantics and must validate the response status before consuming bytes.
  public func stream(_ request: URLRequest) async throws -> EmberAPIStreamResponse {
    let (bytes, response) = try await session.bytes(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw EmberAPITransportError.nonHTTPResponse
    }
    return EmberAPIStreamResponse(
      bytes: bytes,
      statusCode: response.statusCode,
      contentType: response.value(forHTTPHeaderField: "Content-Type")
    )
  }
}
