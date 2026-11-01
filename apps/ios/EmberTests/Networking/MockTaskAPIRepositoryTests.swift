import Foundation
import XCTest

@testable import Ember

final class MockTaskAPIRepositoryTests: XCTestCase {
  private let taskID = UUID(uuidString: "00000000-0000-4000-8000-000000000102")!
  private let agentID = UUID(uuidString: "00000000-0000-4000-8000-000000000201")!

  override func tearDown() {
    StubTaskURLProtocol.setHandler(nil)
    super.tearDown()
  }

  func testCreateUsesExplicitIdempotencyHeaderAndAccepts202() async throws {
    let requests = LockedBox<[(URLRequest, Data?)]>([])
    let repository = try makeRepository { request in
      requests.update { $0.append((request, self.bodyData(from: request))) }
      return .json(status: 202, data: self.receiptData(taskID: self.taskID, replayed: false))
    }
    let request = CreateTaskRequestDTO.chat(
      agentID: agentID,
      prompt: "fixture note",
      maxOutputTokens: 32,
      deadlineAt: nil
    )

    let receipt = try await repository.createTask(request, idempotencyKey: "fixture-key-01")
    let (posted, bodyValue) = try XCTUnwrap(requests.value.first)
    let body = try XCTUnwrap(bodyValue)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])

    XCTAssertEqual(receipt.taskID, taskID)
    XCTAssertFalse(receipt.replayed)
    XCTAssertEqual(posted.url?.path, "/v1/tasks")
    XCTAssertEqual(posted.httpMethod, "POST")
    XCTAssertEqual(posted.value(forHTTPHeaderField: "Idempotency-Key"), "fixture-key-01")
    XCTAssertNil(posted.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(object["idempotency_key"])
    XCTAssertNil(object["tenant_id"])
    XCTAssertTrue(String(data: body, encoding: .utf8)?.contains("fixture note") == true)
  }

  func testLostCreateAckRetriesTheExactKeyAndPayloadAndAcceptsReplay() async throws {
    let requests = LockedBox<[(URLRequest, Data?)]>([])
    let repository = try makeRepository { request in
      requests.update { $0.append((request, self.bodyData(from: request))) }
      if requests.value.count == 1 {
        return StubTaskResponse(status: 0, error: URLError(.networkConnectionLost))
      }
      return .json(status: 200, data: self.receiptData(taskID: self.taskID, replayed: true))
    }
    let request = CreateTaskRequestDTO.compute(
      agentID: agentID,
      text: "private source text",
      deadlineAt: nil
    )

    let receipt = try await repository.createTask(request, idempotencyKey: "retry-key-0001")
    let recorded = requests.value

    XCTAssertEqual(recorded.count, 2)
    XCTAssertEqual(recorded[0].1, recorded[1].1)
    XCTAssertEqual(
      recorded[0].0.value(forHTTPHeaderField: "Idempotency-Key"),
      recorded[1].0.value(forHTTPHeaderField: "Idempotency-Key")
    )
    XCTAssertTrue(receipt.replayed)
  }

  func testCreateConflictIsExplicitAndNeverEchoesRequestText() async throws {
    let repository = try makeRepository { _ in
      .json(
        status: 409,
        data: Data(
          #"{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"private source text"}}"#.utf8))
    }
    let request = CreateTaskRequestDTO.compute(
      agentID: agentID,
      text: "private source text",
      deadlineAt: nil
    )

    do {
      _ = try await repository.createTask(request, idempotencyKey: "conflict-key-01")
      XCTFail("Expected an idempotency conflict")
    } catch let error as TaskAPIRepositoryError {
      XCTAssertEqual(error, .idempotencyConflict)
      XCTAssertFalse(String(describing: error).contains("private source text"))
    }
  }

  func testRequiredHTTPStatusesHaveDistinctErrors() async throws {
    let cases: [(Int, TaskAPIRepositoryError)] = [
      (401, .unauthenticated),
      (404, .notFound),
      (409, .conflict),
      (429, .rateLimited),
      (503, .serviceUnavailable),
      (504, .gatewayTimeout),
    ]

    for (status, expected) in cases {
      let repository = try makeRepository { _ in StubTaskResponse(status: status) }
      do {
        _ = try await repository.fetchTask(id: taskID)
        XCTFail("Expected HTTP \(status) to fail")
      } catch let error as TaskAPIRepositoryError {
        XCTAssertEqual(error, expected)
      }
    }
  }

  func testCancelPostIsNotBlindlyRetriedAfterTransportFailure() async throws {
    let requests = LockedBox<[URLRequest]>([])
    let repository = try makeRepository { request in
      requests.update { $0.append(request) }
      return StubTaskResponse(status: 0, error: URLError(.networkConnectionLost))
    }

    do {
      _ = try await repository.cancelTask(id: taskID)
      XCTFail("Expected cancellation transport failure")
    } catch let error as TaskAPIRepositoryError {
      XCTAssertEqual(error, .transportFailure)
    }

    XCTAssertEqual(requests.value.count, 1)
    XCTAssertEqual(requests.value.first?.httpMethod, "POST")
    XCTAssertTrue(requests.value.first?.url?.path.hasSuffix("/cancel") == true)
  }

  func testProductionHostIsRejectedAtConstruction() throws {
    let client = makeClient()
    XCTAssertThrowsError(
      try MockTaskAPIRepository(
        client: client,
        baseURL: URL(string: "https://api.ember.example")!
      )
    ) { error in
      XCTAssertEqual(error as? TaskAPIRepositoryError, .mockEndpointRequired)
    }
  }

  func testSSEParserHandlesSplitUTF8CommentsCRLFAndMultilineData() throws {
    let input = Data(
      ": heartbeat\r\nevent: task\r\nid: 7\r\ndata: {\"note\":\r\ndata: \"雪\"}\r\n\r\n".utf8
    )
    let bytes = Array(input)
    let split = try XCTUnwrap(bytes.firstIndex(of: 0xe9)).advanced(by: 1)
    var parser = ServerSentEventParser()

    let first = try parser.append(Data(bytes[..<split]))
    let second = try parser.append(Data(bytes[split...]))

    XCTAssertTrue(first.isEmpty)
    XCTAssertEqual(
      second, [ServerSentEventFrame(event: "task", id: "7", data: "{\"note\":\n\"雪\"}")])
  }

  func testStreamValidatorDropsDuplicatesAndRejectsGapsAndOutOfOrderEvents() throws {
    var validator = TaskEventStreamValidator(taskID: taskID, lastConfirmedSequence: 1)

    XCTAssertNil(try validator.consume(frame(sequence: 1)))
    XCTAssertEqual(try validator.consume(frame(sequence: 2))?.sequence, 2)
    XCTAssertNil(try validator.consume(frame(sequence: 2)))
    XCTAssertThrowsError(try validator.consume(frame(sequence: 4))) { error in
      XCTAssertEqual(error as? TaskAPIRepositoryError, .eventSequenceGap(expected: 3, received: 4))
    }

    var outOfOrder = TaskEventStreamValidator(taskID: taskID, lastConfirmedSequence: 1)
    _ = try outOfOrder.consume(frame(sequence: 2))
    XCTAssertThrowsError(try outOfOrder.consume(frame(sequence: 1))) { error in
      XCTAssertEqual(error as? TaskAPIRepositoryError, .eventOutOfOrder)
    }

    var wrongTask = TaskEventStreamValidator(taskID: taskID, lastConfirmedSequence: 0)
    XCTAssertThrowsError(try wrongTask.consume(frame(sequence: 1, taskID: agentID))) { error in
      XCTAssertEqual(error as? TaskAPIRepositoryError, .taskMismatch)
    }
  }

  func testSSERequestUsesOnlyValidatedLastEventIDHeader() async throws {
    let requests = LockedBox<[URLRequest]>([])
    let repository = try makeRepository { request in
      requests.update { $0.append(request) }
      return StubTaskResponse(
        status: 200,
        headers: ["Content-Type": "text/event-stream; charset=utf-8"],
        chunks: [Data(": keep-alive\n\n".utf8), Data(try self.sseFrame(sequence: 2).utf8)]
      )
    }

    var events: [TaskEventDTO] = []
    for try await event in repository.streamTaskEvents(taskID: taskID, after: 1) {
      events.append(event)
    }

    let request = try XCTUnwrap(requests.value.first)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Last-Event-ID"), "1")
    XCTAssertNil(
      URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.query)
    XCTAssertEqual(events.map(\.sequence), [2])
  }

  func testStreamDisconnectReconcilesSnapshotAndBackfillsAfterConfirmedCursor() async throws {
    let observedRequests = LockedBox<[URLRequest]>([])
    let repository = try makeRepository { request in
      observedRequests.update { $0.append(request) }
      let path = request.url?.path ?? ""
      if path.hasSuffix("/stream") {
        return StubTaskResponse(
          status: 200,
          headers: ["Content-Type": "text/event-stream"],
          chunks: [Data(": ping\n\n".utf8), Data(try self.sseFrame(sequence: 1).utf8)],
          error: URLError(.networkConnectionLost)
        )
      }
      if path.hasSuffix("/events") {
        XCTAssertEqual(
          URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
            .queryItems,
          [URLQueryItem(name: "after", value: "1")])
        return .json(status: 200, data: try self.eventPageData(sequences: [2, 3]))
      }
      return .json(status: 200, data: try self.taskData(status: "running"))
    }
    let suite = "ember-m2-b-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    let store = TaskResumeIndexStore(defaults: defaults)
    let initialIndex = try TaskResumeIndex(taskID: taskID, lastConfirmedSequence: 1)
    let coordinator = TaskStateCoordinator(
      repository: repository,
      resumeIndexStore: store,
      initialIndex: initialIndex
    )

    let recovered = try await coordinator.consumeAndRecover(taskID: taskID)
    let streamRequest = try XCTUnwrap(
      observedRequests.value.first { $0.url?.path.hasSuffix("/stream") == true })
    let state = await coordinator.presentationState()

    XCTAssertEqual(streamRequest.value(forHTTPHeaderField: "Last-Event-ID"), "1")
    XCTAssertEqual(recovered.events.map(\.sequence), [2, 3])
    XCTAssertEqual(recovered.lastConfirmedSequence, 3)
    XCTAssertEqual(recovered.task.status, .running)
    XCTAssertEqual(state.connectionPhase, .connected)
    XCTAssertEqual(state.taskStatus, .running)
    XCTAssertEqual(state.capability, .mockOnly)
    XCTAssertEqual(store.load()?.taskID, taskID)
    XCTAssertEqual(store.load()?.lastConfirmedSequence, 3)
    defaults.removePersistentDomain(forName: suite)
  }

  func testRecoveryPaginatesThroughTheServerPageLimit() async throws {
    let pages = LockedBox<[Int]>([])
    let repository = try makeRepository { request in
      if request.url?.path.hasSuffix("/events") == true {
        let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
          .queryItems
        let cursor = Int(query?.first(where: { $0.name == "after" })?.value ?? "0") ?? 0
        pages.update { $0.append(cursor) }
        let start = cursor + 1
        let end = min(cursor + 100, 101)
        return .json(status: 200, data: try self.eventPageData(sequences: Array(start...end)))
      }
      return .json(status: 200, data: try self.taskData(status: "running"))
    }
    let coordinator = TaskStateCoordinator(repository: repository)

    let recovered = try await coordinator.recover(taskID: taskID)

    XCTAssertEqual(pages.value, [0, 100])
    XCTAssertEqual(recovered.events.count, 101)
    XCTAssertEqual(recovered.lastConfirmedSequence, 101)
  }

  func testCancel202DoesNotInventCancelledAndCompletionRaceWins() async throws {
    let acceptedRepository = try makeRepository { _ in
      .json(
        status: 202,
        data: self.cancelData(status: "running", terminal: false, cancelRequested: true))
    }
    let acceptedCoordinator = TaskStateCoordinator(repository: acceptedRepository)
    let accepted = try await acceptedCoordinator.cancel(taskID: taskID)
    let acceptedState = await acceptedCoordinator.presentationState()

    XCTAssertFalse(accepted.terminal)
    XCTAssertEqual(accepted.status, .running)
    XCTAssertEqual(acceptedState.taskStatus, .running)
    XCTAssertEqual(acceptedState.capability, .mockOnly)

    let completedRepository = try makeRepository { _ in
      .json(
        status: 200,
        data: self.cancelData(status: "completed", terminal: true, cancelRequested: false))
    }
    let completedCoordinator = TaskStateCoordinator(repository: completedRepository)
    let completed = try await completedCoordinator.cancel(taskID: taskID)
    let completedState = await completedCoordinator.presentationState()

    XCTAssertTrue(completed.terminal)
    XCTAssertEqual(completed.status, .completed)
    XCTAssertEqual(completedState.taskStatus, .completed)
    XCTAssertNil(completedState.commandInFlight)
  }

  func testUnauthenticatedCapabilityIsUnavailableAndNoCredentialIsSent() async throws {
    let requestBox = LockedBox<URLRequest?>(nil)
    let repository = try makeRepository { request in
      requestBox.update { $0 = request }
      return StubTaskResponse(status: 401)
    }
    let coordinator = TaskStateCoordinator(repository: repository)

    do {
      _ = try await coordinator.recover(taskID: taskID)
      XCTFail("Expected unauthenticated access to remain unavailable")
    } catch let error as TaskAPIRepositoryError {
      XCTAssertEqual(error, .unauthenticated)
    }
    let state = await coordinator.presentationState()

    XCTAssertNil(requestBox.value?.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(state.taskStatus)
    XCTAssertEqual(state.connectionPhase, .disconnected)
    XCTAssertEqual(state.capability, .mockOnly)
  }

  func testResumeIndexStoresOnlyTaskIdentifierAndCursor() throws {
    let suite = "ember-resume-index-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    let store = TaskResumeIndexStore(defaults: defaults)
    let index = try TaskResumeIndex(taskID: taskID, lastConfirmedSequence: 7)

    try store.save(index)
    let stored = try XCTUnwrap(defaults.data(forKey: "ember.task.resume-index.v1"))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: stored) as? [String: Any])

    XCTAssertEqual(object["taskID"] as? String, taskID.uuidString)
    XCTAssertEqual(object["lastConfirmedSequence"] as? Int, 7)
    XCTAssertEqual(store.load(), index)
    XCTAssertThrowsError(try TaskResumeIndex(taskID: taskID, lastConfirmedSequence: -1))
    defaults.removePersistentDomain(forName: suite)
  }

  private func makeRepository(
    handler: @escaping (URLRequest) throws -> StubTaskResponse
  ) throws -> MockTaskAPIRepository {
    StubTaskURLProtocol.setHandler(handler)
    return try MockTaskAPIRepository(
      client: makeClient(),
      baseURL: URL(string: "https://fixture.invalid")!
    )
  }

  private func makeClient() -> EmberAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubTaskURLProtocol.self]
    return EmberAPIClient(session: URLSession(configuration: configuration))
  }

  private func receiptData(taskID: UUID, replayed: Bool) -> Data {
    Data(
      """
      {"task_id":"\(taskID.uuidString)","status":"queued","accepted_at":"2026-11-01T00:00:00Z","replayed":\(replayed)}
      """.utf8)
  }

  private func taskData(status: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "task_id": taskID.uuidString,
      "agent_id": agentID.uuidString,
      "kind": "mock.compute",
      "status": status,
      "current_run_id": NSNull(),
      "attempt_count": 1,
      "created_at": "2026-11-01T00:00:00Z",
      "updated_at": "2026-11-01T00:00:02Z",
      "deadline_at": NSNull(),
    ])
  }

  private func event(sequence: Int, taskID: UUID? = nil) -> TaskEventDTO {
    TaskEventDTO(
      taskID: taskID ?? self.taskID,
      sequence: sequence,
      phase: sequence == 1 ? .accepted : .progress,
      occurredAt: "2026-11-01T00:00:0\(min(sequence, 9))Z",
      traceID: agentID,
      payload: TaskEventPayloadDTO(simulated: true)
    )
  }

  private func frame(sequence: Int, taskID: UUID? = nil) throws -> ServerSentEventFrame {
    let data = try JSONEncoder().encode(event(sequence: sequence, taskID: taskID))
    return ServerSentEventFrame(
      event: "task",
      id: String(sequence),
      data: try XCTUnwrap(String(data: data, encoding: .utf8))
    )
  }

  private func sseFrame(sequence: Int) throws -> String {
    let data = try JSONEncoder().encode(event(sequence: sequence))
    return
      "event: task\nid: \(sequence)\ndata: \(try XCTUnwrap(String(data: data, encoding: .utf8)))\n\n"
  }

  private func eventPageData(sequences: [Int]) throws -> Data {
    try JSONEncoder().encode(
      TaskEventPageDTO(taskID: taskID, events: sequences.map { event(sequence: $0) }))
  }

  private func cancelData(status: String, terminal: Bool, cancelRequested: Bool) -> Data {
    let requestedAt = cancelRequested ? "\"2026-11-01T00:00:03Z\"" : "null"
    return Data(
      """
      {"task_id":"\(taskID.uuidString)","status":"\(status)","cancel_requested":\(cancelRequested),"cancel_requested_at":\(requestedAt),"terminal":\(terminal),"updated_at":"2026-11-01T00:00:03Z"}
      """.utf8)
  }

  private func bodyData(from request: URLRequest) -> Data? {
    if let body = request.httpBody {
      return body
    }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      data.append(contentsOf: buffer.prefix(count))
    }
    return data
  }
}

private struct StubTaskResponse {
  let status: Int
  var headers: [String: String] = ["Content-Type": "application/json"]
  var chunks: [Data] = []
  var error: Error?

  static func json(status: Int, data: Data) -> StubTaskResponse {
    StubTaskResponse(status: status, chunks: [data])
  }
}

private final class StubTaskURLProtocol: URLProtocol {
  private static let lock = NSLock()
  private static var requestHandler: ((URLRequest) throws -> StubTaskResponse)?

  static func setHandler(_ handler: ((URLRequest) throws -> StubTaskResponse)?) {
    lock.lock()
    requestHandler = handler
    lock.unlock()
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lock.lock()
    let handler = Self.requestHandler
    Self.lock.unlock()
    guard let handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }

    do {
      let stub = try handler(request)
      if let error = stub.error {
        if stub.status > 0,
          let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: stub.headers
          )
        {
          client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
          for chunk in stub.chunks {
            client?.urlProtocol(self, didLoad: chunk)
          }
        }
        client?.urlProtocol(self, didFailWithError: error)
        return
      }

      guard
        let response = HTTPURLResponse(
          url: request.url!,
          statusCode: stub.status,
          httpVersion: "HTTP/1.1",
          headerFields: stub.headers
        )
      else {
        client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
        return
      }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      for chunk in stub.chunks {
        client?.urlProtocol(self, didLoad: chunk)
      }
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

private final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var storedValue: Value

  init(_ value: Value) { storedValue = value }

  var value: Value {
    lock.lock()
    defer { lock.unlock() }
    return storedValue
  }

  func update(_ body: (inout Value) -> Void) {
    lock.lock()
    defer { lock.unlock() }
    body(&storedValue)
  }
}
