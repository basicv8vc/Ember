import Foundation

/// Safe, mock-only HTTP implementation of the frozen task repository contract.
///
/// The endpoint is required at construction time and must be loopback or a reserved test
/// hostname. This keeps the client useful with URLProtocol/local fixtures without creating
/// a production API default or an authentication path.
public final class MockTaskAPIRepository: TaskRepositoryProtocol, @unchecked Sendable {
  private let client: EmberAPIClient
  private let baseURL: URL

  public init(client: EmberAPIClient, baseURL: URL) throws {
    guard Self.isMockEndpoint(baseURL) else {
      throw TaskAPIRepositoryError.mockEndpointRequired
    }
    self.client = client
    self.baseURL = baseURL
  }

  public func createTask(
    _ request: CreateTaskRequestDTO,
    idempotencyKey: String
  ) async throws -> TaskReceiptDTO {
    guard Self.isValidIdempotencyKey(idempotencyKey) else {
      throw TaskAPIRepositoryError.invalidIdempotencyKey
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let body: Data
    do {
      body = try encoder.encode(request)
    } catch {
      throw TaskAPIRepositoryError.invalidRequest
    }

    var urlRequest = try makeRequest(path: ["v1", "tasks"], method: "POST")
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
    urlRequest.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
    urlRequest.httpBody = body

    // Retrying the exact encoded body with the same key is safe. No other POST is
    // retried, and the raw input is never copied into an error or a persistence record.
    for attempt in 0..<2 {
      let response: EmberAPIResponse
      do {
        response = try await client.send(urlRequest)
      } catch {
        guard attempt == 0, Self.isRetryableTransportFailure(error) else {
          throw Self.mapTransportError(error)
        }
        continue
      }

      if attempt == 0 && (response.statusCode == 503 || response.statusCode == 504) {
        continue
      }

      guard response.statusCode == 200 || response.statusCode == 202 else {
        if response.statusCode == 409 {
          throw TaskAPIRepositoryError.idempotencyConflict
        }
        throw Self.mapHTTPStatus(response.statusCode)
      }

      let receipt = try Self.decode(TaskReceiptDTO.self, from: response.data)
      guard receipt.replayed == (response.statusCode == 200) else {
        throw TaskAPIRepositoryError.invalidResponse
      }
      return receipt
    }

    throw TaskAPIRepositoryError.transportFailure
  }

  public func fetchTask(id: UUID) async throws -> TaskDTO {
    let response = try await sendJSONRequest(path: ["v1", "tasks", id.uuidString])
    guard response.statusCode == 200 else {
      throw Self.mapHTTPStatus(response.statusCode)
    }
    let task = try Self.decode(TaskDTO.self, from: response.data)
    guard task.taskID == id else {
      throw TaskAPIRepositoryError.taskMismatch
    }
    return task
  }

  public func fetchEvents(taskID: UUID, after sequence: Int?) async throws -> TaskEventPageDTO {
    if let sequence, !TaskEventCursorBounds.contains(sequence) {
      throw TaskAPIRepositoryError.invalidCursor
    }
    let response = try await sendJSONRequest(
      path: ["v1", "tasks", taskID.uuidString, "events"],
      query: sequence.map { [URLQueryItem(name: "after", value: String($0))] } ?? []
    )
    guard response.statusCode == 200 else {
      throw Self.mapHTTPStatus(response.statusCode)
    }
    let page = try Self.decode(TaskEventPageDTO.self, from: response.data)
    guard page.taskID == taskID else {
      throw TaskAPIRepositoryError.taskMismatch
    }
    try TaskEventPageValidator.validate(page.events, taskID: taskID, after: sequence ?? 0)
    return page
  }

  public func cancelTask(id: UUID) async throws -> TaskCancelDTO {
    var request = try makeRequest(path: ["v1", "tasks", id.uuidString, "cancel"], method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let response: EmberAPIResponse
    do {
      response = try await client.send(request)
    } catch {
      // Cancellation is intentionally not retried because the server may have
      // accepted it before the connection failed.
      throw Self.mapTransportError(error)
    }
    guard response.statusCode == 200 || response.statusCode == 202 else {
      throw Self.mapHTTPStatus(response.statusCode)
    }
    let cancellation = try Self.decode(TaskCancelDTO.self, from: response.data)
    let statusIsTerminal = [TaskStatus.completed, .failed, .cancelled].contains(cancellation.status)
    guard cancellation.taskID == id,
      cancellation.terminal == (response.statusCode == 200),
      cancellation.terminal == statusIsTerminal,
      cancellation.cancelRequested == (cancellation.cancelRequestedAt != nil)
    else {
      throw TaskAPIRepositoryError.invalidResponse
    }
    return cancellation
  }

  /// One bounded SSE connection. A caller should persist only the last validated sequence,
  /// then reconcile the snapshot and event pages before opening the next stream.
  func streamTaskEvents(taskID: UUID, after sequence: Int) -> AsyncThrowingStream<
    TaskEventDTO, Error
  > {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          guard TaskEventCursorBounds.contains(sequence) else {
            throw TaskAPIRepositoryError.invalidCursor
          }
          var request = try makeRequest(
            path: ["v1", "tasks", taskID.uuidString, "stream"],
            method: "GET"
          )
          request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          // The server rejects mismatched cursor sources. Send only the validated
          // Last-Event-ID header and omit the ?after query parameter.
          request.setValue(String(sequence), forHTTPHeaderField: "Last-Event-ID")

          let response = try await client.stream(request)
          guard response.statusCode == 200 else {
            throw Self.mapHTTPStatus(response.statusCode)
          }
          guard response.contentType?.lowercased().hasPrefix("text/event-stream") == true else {
            throw TaskAPIRepositoryError.invalidResponse
          }

          var parser = ServerSentEventParser()
          var validator = TaskEventStreamValidator(taskID: taskID, lastConfirmedSequence: sequence)
          for try await byte in response.bytes {
            for frame in try parser.append(byte) {
              if let event = try validator.consume(frame) {
                continuation.yield(event)
              }
            }
          }
          // An incomplete final frame is deliberately discarded. The next
          // snapshot/page reconciliation will retrieve it by its uncommitted ID.
          continuation.finish()
        } catch {
          continuation.finish(throwing: Self.mapTransportError(error))
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  private func sendJSONRequest(
    path: [String],
    query: [URLQueryItem] = []
  ) async throws -> EmberAPIResponse {
    var request = try makeRequest(path: path, method: "GET", query: query)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    do {
      return try await client.send(request)
    } catch {
      throw Self.mapTransportError(error)
    }
  }

  private func makeRequest(
    path: [String],
    method: String,
    query: [URLQueryItem] = []
  ) throws -> URLRequest {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw TaskAPIRepositoryError.invalidRequest
    }
    let root = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    components.path = ([root] + path).joined(separator: "/")
    components.queryItems = query.isEmpty ? nil : query
    guard let url = components.url else {
      throw TaskAPIRepositoryError.invalidRequest
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 30
    return request
  }

  private static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value
  {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      // Never include server-provided text or request data in a user-visible error.
      throw TaskAPIRepositoryError.invalidResponse
    }
  }

  private static func mapHTTPStatus(_ status: Int) -> TaskAPIRepositoryError {
    switch status {
    case 400: .badRequest
    case 401: .unauthenticated
    case 403: .forbidden
    case 404: .notFound
    case 409: .conflict
    case 429: .rateLimited
    case 502: .badGateway
    case 503: .serviceUnavailable
    case 504: .gatewayTimeout
    default: .unexpectedStatus(status)
    }
  }

  private static func mapTransportError(_ error: Error) -> TaskAPIRepositoryError {
    if let error = error as? TaskAPIRepositoryError {
      return error
    }
    if error as? EmberAPITransportError == .nonHTTPResponse {
      return .nonHTTPResponse
    }
    return .transportFailure
  }

  private static func isRetryableTransportFailure(_ error: Error) -> Bool {
    guard let error = error as? URLError else { return false }
    return [
      .timedOut,
      .networkConnectionLost,
      .notConnectedToInternet,
      .cannotConnectToHost,
      .cannotFindHost,
      .dnsLookupFailed,
    ].contains(error.code)
  }

  private static func isValidIdempotencyKey(_ key: String) -> Bool {
    let bytes = Array(key.utf8)
    guard (8...128).contains(bytes.count),
      let first = bytes.first,
      isASCIIAlphaNumeric(first)
    else {
      return false
    }
    return bytes.dropFirst().allSatisfy { byte in
      isASCIIAlphaNumeric(byte) || byte == 0x2e || byte == 0x5f || byte == 0x3a || byte == 0x2d
    }
  }

  private static func isASCIIAlphaNumeric(_ byte: UInt8) -> Bool {
    (0x30...0x39).contains(byte) || (0x41...0x5a).contains(byte) || (0x61...0x7a).contains(byte)
  }

  private static func isMockEndpoint(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(),
      ["http", "https"].contains(scheme),
      let host = components.host?.lowercased(),
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil
    else {
      return false
    }
    return host == "localhost"
      || host == "127.0.0.1"
      || host == "::1"
      || host.hasSuffix(".test")
      || host.hasSuffix(".invalid")
  }
}

public enum TaskAPIRepositoryError: Error, Equatable {
  case mockEndpointRequired
  case invalidRequest
  case invalidIdempotencyKey
  case invalidCursor
  case transportFailure
  case nonHTTPResponse
  case invalidResponse
  case taskMismatch
  case eventSequenceGap(expected: Int, received: Int)
  case eventOutOfOrder
  case duplicateEventInPage
  case noCursorProgress
  case badRequest
  case unauthenticated
  case forbidden
  case notFound
  case conflict
  case idempotencyConflict
  case rateLimited
  case badGateway
  case serviceUnavailable
  case gatewayTimeout
  case unexpectedStatus(Int)
}

enum TaskEventPageValidator {
  static func validate(_ events: [TaskEventDTO], taskID: UUID, after cursor: Int) throws {
    guard TaskEventCursorBounds.contains(cursor) else {
      throw TaskAPIRepositoryError.invalidCursor
    }
    var previous = cursor
    for event in events {
      guard event.taskID == taskID else {
        throw TaskAPIRepositoryError.taskMismatch
      }
      guard TaskEventCursorBounds.contains(event.sequence) else {
        throw TaskAPIRepositoryError.invalidResponse
      }
      guard event.sequence > previous else {
        if event.sequence == previous {
          throw TaskAPIRepositoryError.duplicateEventInPage
        }
        throw TaskAPIRepositoryError.eventOutOfOrder
      }
      guard previous < TaskEventCursorBounds.maximum else {
        throw TaskAPIRepositoryError.invalidCursor
      }
      let expected = previous + 1
      guard event.sequence == expected else {
        throw TaskAPIRepositoryError.eventSequenceGap(expected: expected, received: event.sequence)
      }
      previous = event.sequence
    }
  }
}
