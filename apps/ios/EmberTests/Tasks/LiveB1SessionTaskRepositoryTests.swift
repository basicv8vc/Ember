import Foundation
import XCTest
@testable import Ember

/// Verifies B1 consumer-session Task contracts and HTTP repository against StubURLProtocol.
@MainActor
final class LiveB1SessionTaskRepositoryTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []

    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        sessions.removeAll()
        registrations.removeAll()
        try await super.tearDown()
    }

    func testListTasksDecodesWrappedAndArrayPayloadsIncludingNotesActionItems() async throws {
        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let taskID = "00000000-0000-4000-8000-00000000b311"
        let agentID = "00000000-0000-4000-8000-00000000b301"

        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: """
            {
              "tasks": [
                {
                  "task_id": "\(taskID)",
                  "agent_id": "\(agentID)",
                  "kind": "notes.action_items",
                  "title": "Q4 Launch Action Items",
                  "status": "completed",
                  "current_run_id": null,
                  "attempt_count": 1,
                  "cancel_requested": false,
                  "created_at": "2026-11-15T10:00:00Z",
                  "updated_at": "2026-11-15T10:01:00Z",
                  "deadline_at": null
                }
              ],
              "next_after": null,
              "has_more": false
            }
            """)
        }

        let tasks = try await fixture.repository.listTasks()
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].kind, .notesActionItems)
        XCTAssertEqual(tasks[0].title, "Q4 Launch Action Items")
        XCTAssertEqual(tasks[0].status, .completed)

        let req = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.path, "/v1/tasks")
        let query = URLComponents(url: try XCTUnwrap(req.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "50")

        let bareArray = Data("""
            [
              {
                "task_id": "\(taskID)",
                "agent_id": "\(agentID)",
                "kind": "notes.action_items",
                "status": "running",
                "attempt_count": 1,
                "cancel_requested": false,
                "created_at": "2026-11-15T10:00:00Z",
                "updated_at": "2026-11-15T10:01:00Z"
              }
            ]
            """.utf8)
        let decodedBare = try JSONDecoder().decode(SessionTaskListDTO.self, from: bareArray)
        XCTAssertEqual(decodedBare.tasks.count, 1)
        XCTAssertEqual(decodedBare.tasks[0].status, .running)
    }

    func testTaskContractRejectsExtraTenantOrRawInputFields() throws {
        let data = Data("""
            {
              "task_id": "00000000-0000-4000-8000-00000000b311",
              "agent_id": "00000000-0000-4000-8000-00000000b301",
              "kind": "notes.action_items",
              "status": "completed",
              "attempt_count": 1,
              "cancel_requested": false,
              "created_at": "2026-11-15T10:00:00Z",
              "updated_at": "2026-11-15T10:01:00Z",
              "tenant_id": "secret-tenant",
              "input": {"raw": "secret"}
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SessionTaskDTO.self, from: data))
    }

    func testListEndpoint404MapsToEndpointNotReadyWhileFetchTask404MapsToNotFound() async throws {
        let fixture = try makeRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b311")!
        register { _ in .json(statusCode: 404, body: "{}") }

        do {
            _ = try await fixture.repository.listTasks()
            XCTFail("expected endpointNotReady")
        } catch let error as SessionTaskRepositoryError {
            XCTAssertEqual(error, .endpointNotReady)
        }

        do {
            _ = try await fixture.repository.fetchTask(id: taskID)
            XCTFail("expected notFound")
        } catch let error as SessionTaskRepositoryError {
            XCTAssertEqual(error, .notFound)
        }
    }

    func testFetchEventsValidatesMonotonicSequenceAndNotesTaskKind() async throws {
        let fixture = try makeRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b311")!
        let traceID = "00000000-0000-4000-8000-00000000b388"
        let recorder = RequestRecorder()

        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "events": [
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "sequence": 4,
                  "phase": "accepted",
                  "occurred_at": "2026-11-15T10:00:00Z",
                  "trace_id": "\(traceID)",
                  "payload": {
                    "taskKind": "notes.action_items",
                    "toStatus": "queued",
                    "simulated": false
                  }
                },
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "sequence": 5,
                  "phase": "completed",
                  "occurred_at": "2026-11-15T10:01:00Z",
                  "trace_id": "\(traceID)",
                  "payload": {
                    "taskKind": "notes.action_items",
                    "fromStatus": "running",
                    "toStatus": "completed",
                    "attempt": 1,
                    "route": "standard",
                    "simulated": false
                  }
                }
              ]
            }
            """)
        }

        let page = try await fixture.repository.fetchEvents(taskID: taskID, after: 3)
        XCTAssertEqual(page.events.map(\.sequence), [4, 5])
        XCTAssertEqual(page.events[1].payload.taskKind, .notesActionItems)
        XCTAssertEqual(page.events[1].payload.route, .standard)

        let query = URLComponents(
            url: try XCTUnwrap(recorder.requests.first?.url),
            resolvingAgainstBaseURL: false
        )?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "after" })?.value, "3")
    }

    func testFetchEventsRejectsStaleOrNonMonotonicSequence() async throws {
        let fixture = try makeRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b311")!
        let traceID = "00000000-0000-4000-8000-00000000b388"

        register { _ in
            .json(statusCode: 200, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "events": [
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "sequence": 3,
                  "phase": "accepted",
                  "occurred_at": "2026-11-15T10:00:00Z",
                  "trace_id": "\(traceID)",
                  "payload": {
                    "taskKind": "notes.action_items",
                    "toStatus": "queued",
                    "simulated": false
                  }
                }
              ]
            }
            """)
        }

        do {
            _ = try await fixture.repository.fetchEvents(taskID: taskID, after: 3)
            XCTFail("expected invalidResponse on stale sequence")
        } catch let error as SessionTaskRepositoryError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }

    func testFetchResultEnforcesB1ResultInvariantsAndDecodesAvailableResult() async throws {
        let fixture = try makeRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b311")!

        register { _ in
            .json(statusCode: 200, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "task_status": "completed",
              "result_state": "available",
              "result": {
                "summary_text": "Extracted 2 action items from meeting notes.",
                "detail_text": "1. Send TestFlight build (Owner: Sam)\\n2. Confirm B1 cutover (Owner: Alex)",
                "model_label": "ember-notes-v1",
                "simulated": false,
                "produced_at": "2026-11-15T10:01:00Z"
              }
            }
            """)
        }

        let result = try await fixture.repository.fetchResult(taskID: taskID)
        XCTAssertEqual(result.resultState, .available)
        XCTAssertEqual(result.result?.summaryText, "Extracted 2 action items from meeting notes.")
        XCTAssertEqual(result.result?.simulated, false)

        let invalidCompletedPending = Data("""
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "task_status": "completed",
              "result_state": "pending",
              "result": null
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SessionTaskResultDTO.self, from: invalidCompletedPending))

        let invalidRunningAvailable = Data("""
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "task_status": "running",
              "result_state": "available",
              "result": {
                "summary_text": "Premature",
                "detail_text": null,
                "model_label": "ember-notes-v1",
                "simulated": false,
                "produced_at": "2026-11-15T10:01:00Z"
              }
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SessionTaskResultDTO.self, from: invalidRunningAvailable))
    }

    func testCancelTaskEnforces202NonTerminalAnd200TerminalContract() async throws {
        let fixture = try makeRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b312")!

        register { _ in
            .json(statusCode: 202, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "status": "running",
              "cancel_requested": true,
              "cancel_requested_at": "2026-11-15T10:02:00Z",
              "terminal": false,
              "updated_at": "2026-11-15T10:02:00Z"
            }
            """)
        }
        let pendingCancel = try await fixture.repository.cancelTask(id: taskID)
        XCTAssertFalse(pendingCancel.terminal)
        XCTAssertTrue(pendingCancel.cancelRequested)
        XCTAssertEqual(pendingCancel.status, .running)

        registrations.forEach { $0.remove() }
        registrations.removeAll()

        register { _ in
            .json(statusCode: 200, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "status": "cancelled",
              "cancel_requested": true,
              "cancel_requested_at": "2026-11-15T10:02:00Z",
              "terminal": true,
              "updated_at": "2026-11-15T10:02:05Z"
            }
            """)
        }
        let terminalCancel = try await fixture.repository.cancelTask(id: taskID)
        XCTAssertTrue(terminalCancel.terminal)
        XCTAssertEqual(terminalCancel.status, .cancelled)

        registrations.forEach { $0.remove() }
        registrations.removeAll()

        // 200 with terminal == false violates contract
        register { _ in
            .json(statusCode: 200, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "status": "running",
              "cancel_requested": true,
              "cancel_requested_at": "2026-11-15T10:02:00Z",
              "terminal": false,
              "updated_at": "2026-11-15T10:02:00Z"
            }
            """)
        }
        do {
            _ = try await fixture.repository.cancelTask(id: taskID)
            XCTFail("expected invalidResponse on 200 with terminal=false")
        } catch let error as SessionTaskRepositoryError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }

    private func makeRepository() throws -> (repository: LiveB1SessionTaskRepository, session: URLSession) {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        return (LiveB1SessionTaskRepository(auth: auth), session)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}
