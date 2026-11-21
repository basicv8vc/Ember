import CryptoKit
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
                  "deadline_at": null,
                  "result_state": "available"
                }
              ],
              "next_after": null,
              "has_more": false
            }
            """)
        }

        let taskList = try await fixture.repository.listTasks()
        let tasks = taskList.tasks
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(taskList.hasMore, false)
        XCTAssertNil(taskList.nextAfter)
        XCTAssertEqual(tasks[0].kind, .notesActionItems)
        XCTAssertEqual(tasks[0].title, "Q4 Launch Action Items")
        XCTAssertEqual(tasks[0].status, .completed)
        XCTAssertEqual(tasks[0].resultState, .available)

        let req = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.path, "/v1/me/tasks")
        let query = URLComponents(url: try XCTUnwrap(req.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "50")
        XCTAssertNil(query.first(where: { $0.name == "after" }))

        // Strict PR #160 B1TaskListDtoSchema payload (no current_run_id/cancel_requested/next_after/has_more)
        let pr160Payload = Data("""
            {
              "tasks": [
                {
                  "task_id": "\(taskID)",
                  "agent_id": "\(agentID)",
                  "kind": "notes.action_items",
                  "title": "PR160 Summary",
                  "status": "running",
                  "attempt_count": 1,
                  "created_at": "2026-11-15T10:00:00Z",
                  "updated_at": "2026-11-15T10:01:00Z",
                  "deadline_at": null,
                  "result_state": "pending"
                }
              ]
            }
            """.utf8)
        let decodedPR160 = try JSONDecoder().decode(SessionTaskListDTO.self, from: pr160Payload)
        XCTAssertEqual(decodedPR160.tasks.count, 1)
        XCTAssertEqual(decodedPR160.tasks[0].status, .running)
        XCTAssertEqual(decodedPR160.tasks[0].resultState, .pending)
        XCTAssertNil(decodedPR160.hasMore)
        XCTAssertNil(decodedPR160.nextAfter)

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

        let eventRequest = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(eventRequest.url?.path, "/v1/me/tasks/\(taskID.uuidString.lowercased())/events")
        let query = URLComponents(
            url: try XCTUnwrap(eventRequest.url),
            resolvingAgainstBaseURL: false
        )?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "after" })?.value, "3")
    }

    func testFetchTaskDecodesB1DetailWithInlineResultAndEnforcesInvariants() async throws {
        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b311")!
        let agentID = "00000000-0000-4000-8000-00000000b301"

        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: """
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "agent_id": "\(agentID)",
              "kind": "notes.action_items",
              "title": "Q4 Launch Action Items",
              "status": "completed",
              "attempt_count": 1,
              "created_at": "2026-11-15T10:00:00Z",
              "updated_at": "2026-11-15T10:01:00Z",
              "deadline_at": null,
              "result_state": "available",
              "result": {
                "summary_text": "Inline B1 detail summary.",
                "detail_text": "1. Ship B1 detail route",
                "model_label": "ember-notes-v1",
                "simulated": false,
                "produced_at": "2026-11-15T10:01:00Z"
              }
            }
            """)
        }

        let detail = try await fixture.repository.fetchTask(id: taskID)
        XCTAssertEqual(detail.taskID, taskID)
        XCTAssertEqual(detail.resultState, .available)
        XCTAssertEqual(detail.result?.summaryText, "Inline B1 detail summary.")
        XCTAssertEqual(detail.asResultDTO?.resultState, .available)
        XCTAssertEqual(detail.asResultDTO?.result?.detailText, "1. Ship B1 detail route")
        XCTAssertEqual(recorder.requests.first?.url?.path, "/v1/me/tasks/\(taskID.uuidString.lowercased())")

        // Mismatched available state without result payload must fail decoding.
        let missingResult = Data("""
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "agent_id": "\(agentID)",
              "kind": "notes.action_items",
              "title": "Broken Detail",
              "status": "completed",
              "attempt_count": 1,
              "created_at": "2026-11-15T10:00:00Z",
              "updated_at": "2026-11-15T10:01:00Z",
              "deadline_at": null,
              "result_state": "available",
              "result": null
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SessionTaskDetailDTO.self, from: missingResult))

        // Pending result_state on terminal task must fail decoding.
        let pendingOnTerminal = Data("""
            {
              "task_id": "\(taskID.uuidString.lowercased())",
              "agent_id": "\(agentID)",
              "kind": "notes.action_items",
              "title": "Broken Pending Terminal",
              "status": "completed",
              "attempt_count": 1,
              "created_at": "2026-11-15T10:00:00Z",
              "updated_at": "2026-11-15T10:01:00Z",
              "deadline_at": null,
              "result_state": "pending",
              "result": null
            }
            """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SessionTaskDetailDTO.self, from: pendingOnTerminal))
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
        let recorder = RequestRecorder()

        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: """
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
        XCTAssertEqual(recorder.requests.first?.url?.path, "/v1/tasks/\(taskID.uuidString.lowercased())/result")
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

    func testCursorPaginationAndRetryableFailedGroupingInSessionTaskStore() async throws {
        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let agentID = "00000000-0000-4000-8000-00000000b301"
        let retryableID = UUID(uuidString: "00000000-0000-4000-8000-00000000b401")!
        let approvalID = UUID(uuidString: "00000000-0000-4000-8000-00000000b402")!
        let olderCompletedID = UUID(uuidString: "00000000-0000-4000-8000-00000000b403")!
        let stallFlag = LockedBool(false)

        register { request in
            recorder.record(request)
            let url = request.url!
            let path = url.path
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let after = query.first(where: { $0.name == "after" })?.value

            if path == "/v1/me/tasks" {
                if after == "cursor-page-2" && stallFlag.value {
                    return .json(statusCode: 200, body: """
                    {
                      "tasks": [],
                      "next_after": "cursor-page-2",
                      "has_more": true
                    }
                    """)
                }
                if after == "cursor-page-2" {
                    return .json(statusCode: 200, body: """
                    {
                      "tasks": [
                        {
                          "task_id": "\(approvalID.uuidString.lowercased())",
                          "agent_id": "\(agentID)",
                          "kind": "sandbox.python",
                          "title": "Approve CSV export",
                          "status": "waiting_approval",
                          "attempt_count": 1,
                          "cancel_requested": false,
                          "created_at": "2026-11-15T10:01:00Z",
                          "updated_at": "2026-11-15T10:02:00Z"
                        },
                        {
                          "task_id": "\(olderCompletedID.uuidString.lowercased())",
                          "agent_id": "\(agentID)",
                          "kind": "notes.action_items",
                          "title": "Older meeting digest",
                          "status": "completed",
                          "attempt_count": 1,
                          "cancel_requested": false,
                          "created_at": "2026-11-15T09:00:00Z",
                          "updated_at": "2026-11-15T09:05:00Z"
                        }
                      ],
                      "next_after": null,
                      "has_more": false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {
                  "tasks": [
                    {
                      "task_id": "\(retryableID.uuidString.lowercased())",
                      "agent_id": "\(agentID)",
                      "kind": "notes.action_items",
                      "title": "Retryable notes extraction",
                      "status": "retryable_failed",
                      "attempt_count": 1,
                      "cancel_requested": false,
                      "created_at": "2026-11-15T10:03:00Z",
                      "updated_at": "2026-11-15T10:04:00Z"
                    },
                    {
                      "task_id": "\(approvalID.uuidString.lowercased())",
                      "agent_id": "\(agentID)",
                      "kind": "sandbox.python",
                      "title": "Approve CSV export",
                      "status": "waiting_approval",
                      "attempt_count": 1,
                      "cancel_requested": false,
                      "created_at": "2026-11-15T10:01:00Z",
                      "updated_at": "2026-11-15T10:02:00Z"
                    }
                  ],
                  "next_after": "cursor-page-2",
                  "has_more": true
                }
                """)
            }

            if path == "/v1/tasks/\(olderCompletedID.uuidString.lowercased())/result" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(olderCompletedID.uuidString.lowercased())",
                  "task_status": "completed",
                  "result_state": "available",
                  "result": {
                    "summary_text": "Older digest complete.",
                    "detail_text": null,
                    "model_label": "ember-notes-v1",
                    "simulated": false,
                    "produced_at": "2026-11-15T09:05:00Z"
                  }
                }
                """)
            }

            return .json(statusCode: 404, body: "{}")
        }

        let store = SessionTaskStore(repository: fixture.repository, pageSize: 2)
        await store.refreshAll()

        XCTAssertTrue(store.hasMoreTasks)
        XCTAssertEqual(store.nextTasksCursor, "cursor-page-2")
        XCTAssertEqual(store.orderedTasks.map(\.taskID), [retryableID, approvalID])

        // P2-1: retryable_failed belongs in .inProgress, not .needsIntervention badge count
        XCTAssertEqual(TaskStatus.retryableFailed.sessionGroup, .inProgress)
        XCTAssertEqual(store.tasks(in: .inProgress).map(\.taskID), [retryableID])
        XCTAssertEqual(store.tasks(in: .needsIntervention).map(\.taskID), [approvalID])
        XCTAssertEqual(store.inProgressCount, 1)
        XCTAssertEqual(store.needsInterventionCount, 1)

        // Load second page with overlapping approvalID and new olderCompletedID
        await store.loadMoreTasks()

        XCTAssertFalse(store.hasMoreTasks)
        XCTAssertNil(store.nextTasksCursor)
        XCTAssertEqual(store.orderedTasks.map(\.taskID), [retryableID, approvalID, olderCompletedID])
        XCTAssertEqual(store.resultsByTaskID[olderCompletedID]?.result?.summaryText, "Older digest complete.")

        let taskRequests = recorder.requests.filter { $0.url?.path == "/v1/me/tasks" }
        XCTAssertEqual(taskRequests.count, 2)
        let firstQuery = URLComponents(url: taskRequests[0].url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let secondQuery = URLComponents(url: taskRequests[1].url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(firstQuery.first(where: { $0.name == "after" }))
        XCTAssertEqual(firstQuery.first(where: { $0.name == "limit" })?.value, "2")
        XCTAssertEqual(secondQuery.first(where: { $0.name == "after" })?.value, "cursor-page-2")
        XCTAssertEqual(secondQuery.first(where: { $0.name == "limit" })?.value, "2")

        // Verify stalled cursor (empty page with identical cursor and has_more=true) stops pagination safely
        stallFlag.value = true
        await store.refreshAll()
        XCTAssertTrue(store.hasMoreTasks)
        await store.loadMoreTasks()
        XCTAssertFalse(store.hasMoreTasks)
        XCTAssertNil(store.nextTasksCursor)

        let mockRepo = MockSessionTaskRepository()
        let fullCount = try await mockRepo.listTasks(after: nil, limit: 10).tasks.count
        XCTAssertEqual(fullCount, 4)
        let firstMockPage = try await mockRepo.listTasks(after: nil, limit: 2)
        XCTAssertEqual(firstMockPage.hasMore, true)
        XCTAssertNotNil(firstMockPage.nextAfter)
        let secondMockPage = try await mockRepo.listTasks(after: firstMockPage.nextAfter, limit: 2)
        XCTAssertEqual(secondMockPage.hasMore, false)
        XCTAssertEqual(Set(firstMockPage.tasks.map(\.taskID)).intersection(secondMockPage.tasks.map(\.taskID)).count, 0)
    }

    func testStoreDegradesGracefullyWhenEventsAndCancelEndpointsReturn404() async throws {
        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b499")!
        let agentID = "00000000-0000-4000-8000-00000000b301"

        register { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            if path == "/v1/me/tasks/\(taskID.uuidString.lowercased())" && request.httpMethod == "GET" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "agent_id": "\(agentID)",
                  "kind": "notes.action_items",
                  "title": "Pending Consumer Cancel/Events",
                  "status": "completed",
                  "attempt_count": 1,
                  "created_at": "2026-11-15T10:00:00Z",
                  "updated_at": "2026-11-15T10:01:00Z",
                  "deadline_at": null,
                  "result_state": "available",
                  "result": {
                    "summary_text": "Loaded inline without /result roundtrip.",
                    "detail_text": null,
                    "model_label": "ember-notes-v1",
                    "simulated": false,
                    "produced_at": "2026-11-15T10:01:00Z"
                  }
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let store = SessionTaskStore(repository: fixture.repository)
        await store.loadDetail(taskID: taskID)

        XCTAssertEqual(store.tasksByID[taskID]?.title, "Pending Consumer Cancel/Events")
        XCTAssertFalse(store.missingTaskIDs.contains(taskID))
        XCTAssertTrue(store.eventsUnavailableTaskIDs.contains(taskID))
        XCTAssertNil(store.detailErrorByTaskID[taskID])
        XCTAssertEqual(store.resultsByTaskID[taskID]?.result?.summaryText, "Loaded inline without /result roundtrip.")
        XCTAssertFalse(recorder.requests.contains { $0.url?.path == "/v1/tasks/\(taskID.uuidString.lowercased())/result" })

        await store.cancelTask(taskID: taskID)
        XCTAssertEqual(
            store.cancelErrorByTaskID[taskID],
            String(localized: "tasks.error.cancel_unavailable", table: "Conversation")
        )
        XCTAssertTrue(recorder.requests.contains {
            $0.httpMethod == "POST" && $0.url?.path == "/v1/me/tasks/\(taskID.uuidString.lowercased())/cancel"
        })
    }

    func testPythonAgentKindAndTaskArtifactsListAndDownload() async throws {
        XCTAssertEqual(
            SessionTaskKind.pythonAgent.localizedDisplayTitle,
            SessionTaskKind.pythonSandbox.localizedDisplayTitle
        )
        XCTAssertEqual(
            B3AttachmentLimits.safeUploadFilename("../Sales Q4 (final).csv", mediaType: "text/csv"),
            "Sales_Q4__final_.csv"
        )

        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b555")!
        let artifactID = UUID(uuidString: "00000000-0000-4000-8000-00000000a555")!
        let agentID = "00000000-0000-4000-8000-00000000b301"
        let csvContent = "item,total\nAlpha,42\n"
        let sha = SHA256.hash(data: Data(csvContent.utf8))
            .map { String(format: "%02x", $0) }
            .joined()

        register { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            if path == "/v1/me/tasks/\(taskID.uuidString.lowercased())" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "agent_id": "\(agentID)",
                  "kind": "python.agent",
                  "title": "CSV Summary",
                  "status": "completed",
                  "attempt_count": 2,
                  "created_at": "2026-11-16T10:00:00Z",
                  "updated_at": "2026-11-16T10:01:00Z",
                  "deadline_at": null,
                  "result_state": "available",
                  "result": {
                    "summary_text": "Generated summary.csv with Alpha total 42.",
                    "detail_text": "CSV processed successfully.",
                    "model_label": "python-agent-v1",
                    "simulated": false,
                    "produced_at": "2026-11-16T10:01:00Z"
                  }
                }
                """)
            }
            if path == "/v1/tasks/\(taskID.uuidString.lowercased())/result" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "task_status": "completed",
                  "result_state": "available",
                  "result": {
                    "summary_text": "Generated summary.csv with Alpha total 42.",
                    "detail_text": "CSV processed successfully.",
                    "model_label": "python-agent-v1",
                    "simulated": false,
                    "produced_at": "2026-11-16T10:01:00Z"
                  }
                }
                """)
            }
            if path == "/v1/me/tasks/\(taskID.uuidString.lowercased())/artifacts" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "artifacts": [
                    {
                      "artifact_id": "\(artifactID.uuidString.lowercased())",
                      "filename": "summary.csv",
                      "media_type": "text/csv",
                      "size": \(csvContent.utf8.count),
                      "sha256": "\(sha)",
                      "created_by": "run",
                      "created_at": "2026-11-16T10:01:00Z"
                    }
                  ]
                }
                """)
            }
            if path == "/v1/me/artifacts/\(artifactID.uuidString.lowercased())" {
                return URLProtocolStubResponse(
                    statusCode: 200,
                    headers: ["Content-Type": "text/csv; charset=utf-8"],
                    body: Data(csvContent.utf8)
                )
            }
            return .json(statusCode: 404, body: "{}")
        }

        let store = SessionTaskStore(repository: fixture.repository)
        await store.loadDetail(taskID: taskID)

        XCTAssertEqual(store.tasksByID[taskID]?.kind, .pythonAgent)
        let artifacts = try XCTUnwrap(store.artifactsByTaskID[taskID])
        XCTAssertEqual(artifacts.count, 1)
        XCTAssertEqual(artifacts[0].displayFilename, "summary.csv")
        XCTAssertEqual(artifacts[0].createdBy, .run)

        await store.downloadArtifact(artifacts[0])
        let fileURL = try XCTUnwrap(store.downloadedArtifactFileByID[artifactID])
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), csvContent)
        XCTAssertEqual(store.downloadedArtifactPreviewByID[artifactID], csvContent)

        store.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testDownloadArtifactRejectsSHA256Mismatch() async throws {
        let fixture = try makeRepository()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000b556")!
        let artifactID = UUID(uuidString: "00000000-0000-4000-8000-00000000a556")!
        let agentID = "00000000-0000-4000-8000-00000000b301"
        let csvContent = "item,total\nAlpha,42\n"
        let wrongSHA = String(repeating: "c", count: 64)

        register { request in
            let path = request.url?.path ?? ""
            if path == "/v1/me/tasks/\(taskID.uuidString.lowercased())" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "agent_id": "\(agentID)",
                  "kind": "python.agent",
                  "title": "Corrupted Artifact Task",
                  "status": "completed",
                  "attempt_count": 1,
                  "created_at": "2026-11-16T10:00:00Z",
                  "updated_at": "2026-11-16T10:01:00Z",
                  "deadline_at": null,
                  "result_state": "unavailable"
                }
                """)
            }
            if path == "/v1/me/tasks/\(taskID.uuidString.lowercased())/artifacts" {
                return .json(statusCode: 200, body: """
                {
                  "task_id": "\(taskID.uuidString.lowercased())",
                  "artifacts": [
                    {
                      "artifact_id": "\(artifactID.uuidString.lowercased())",
                      "filename": "summary.csv",
                      "media_type": "text/csv",
                      "size": \(csvContent.utf8.count),
                      "sha256": "\(wrongSHA)",
                      "created_by": "run",
                      "created_at": "2026-11-16T10:01:00Z"
                    }
                  ]
                }
                """)
            }
            if path == "/v1/me/artifacts/\(artifactID.uuidString.lowercased())" {
                return URLProtocolStubResponse(
                    statusCode: 200,
                    headers: ["Content-Type": "text/csv"],
                    body: Data(csvContent.utf8)
                )
            }
            return .json(statusCode: 404, body: "{}")
        }

        let store = SessionTaskStore(repository: fixture.repository)
        await store.loadDetail(taskID: taskID)
        let artifacts = try XCTUnwrap(store.artifactsByTaskID[taskID])
        await store.downloadArtifact(artifacts[0])

        XCTAssertNil(store.downloadedArtifactFileByID[artifactID])
        XCTAssertNotNil(store.artifactDownloadErrorByID[artifactID])
    }

    func testUploadAndSubmitPythonTaskSupportsCreateReplayAndErrorMapping() async throws {
        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let uploadID = UUID(uuidString: "00000000-0000-4000-8000-00000000f101")!
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000f202")!
        let agentID = UUID(uuidString: "00000000-0000-4000-8000-00000000b301")!
        let clientRequestID = UUID(uuidString: "00000000-0000-4000-8000-00000000f303")!
        let csvData = Data("col,val\na,1\n".utf8)
        let sha = SHA256.hash(data: csvData).map { String(format: "%02x", $0) }.joined()
        let failNextSubmitWith500 = LockedBool(true)

        register { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" && path == "/v1/me/uploads" {
                return .json(statusCode: 201, body: """
                {
                  "upload_id": "\(uploadID.uuidString.lowercased())",
                  "filename": "data.csv",
                  "media_type": "text/csv",
                  "size": \(csvData.count),
                  "sha256": "\(sha)",
                  "expires_at": "2026-11-22T00:00:00Z",
                  "created_at": "2026-11-21T00:00:00Z"
                }
                """)
            }
            if request.httpMethod == "POST" && path == "/v2/tasks/python" {
                if failNextSubmitWith500.value {
                    failNextSubmitWith500.value = false
                    return .json(statusCode: 503, body: "{}")
                }
                return .json(statusCode: 201, body: """
                {
                  "task": {
                    "task_id": "\(taskID.uuidString.lowercased())",
                    "agent_id": "\(agentID.uuidString.lowercased())",
                    "kind": "python.agent",
                    "title": "Sales Summary",
                    "status": "queued",
                    "current_run_id": null,
                    "attempt_count": 0,
                    "cancel_requested": false,
                    "created_at": "2026-11-21T00:00:00Z",
                    "updated_at": "2026-11-21T00:00:00Z",
                    "deadline_at": "2026-11-21T00:02:00Z"
                  },
                  "created": true
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let store = SessionTaskStore(repository: fixture.repository)
        let uploadReceipt = try await store.uploadTaskAttachment(
            filename: "data.csv",
            mediaType: "text/csv",
            data: csvData
        )
        XCTAssertEqual(uploadReceipt.uploadID, uploadID)

        let submitRequest = SubmitPythonTaskRequestDTO(
            title: "Sales Summary",
            prompt: "Summarize data.csv",
            attachmentIDs: [uploadID],
            clientRequestID: clientRequestID
        )
        let firstOutcome = await store.submitPythonTask(submitRequest)
        XCTAssertEqual(firstOutcome, .unknownAcknowledgement)

        let secondOutcome = await store.submitPythonTask(submitRequest)
        guard case .submitted(let submittedTask, let created) = secondOutcome else {
            return XCTFail("Expected submitted outcome on idempotent retry")
        }
        XCTAssertTrue(created)
        XCTAssertEqual(submittedTask.taskID, taskID)
        XCTAssertEqual(submittedTask.kind, .pythonAgent)
        XCTAssertEqual(store.tasksByID[taskID]?.title, "Sales Summary")

        let submitRequests = recorder.requests.filter { $0.url?.path == "/v2/tasks/python" }
        XCTAssertEqual(submitRequests.count, 2)
    }

    func testTaskArtifactRejectsBlockedActiveWebMimeTypesAndExtensions() async throws {
        let fixture = try makeRepository()
        let recorder = RequestRecorder()
        let taskID = UUID(uuidString: "00000000-0000-4000-8000-00000000f401")!
        let htmlArtifactID = UUID(uuidString: "00000000-0000-4000-8000-00000000f402")!
        let smuggledArtifactID = UUID(uuidString: "00000000-0000-4000-8000-00000000f403")!
        let sha = String(repeating: "a", count: 64)

        let htmlPayload = Data("""
        {
          "artifact_id": "\(htmlArtifactID.uuidString.lowercased())",
          "filename": "report.html",
          "media_type": "text/html",
          "size": 12,
          "sha256": "\(sha)",
          "created_by": "run",
          "created_at": "2026-11-21T00:00:00Z"
        }
        """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(TaskArtifactItemDTO.self, from: htmlPayload))

        let svgPayload = Data("""
        {
          "artifact_id": "\(htmlArtifactID.uuidString.lowercased())",
          "filename": "vector.svg",
          "media_type": "image/svg+xml",
          "size": 12,
          "sha256": "\(sha)",
          "created_by": "run",
          "created_at": "2026-11-21T00:00:00Z"
        }
        """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(TaskArtifactItemDTO.self, from: svgPayload))

        let smuggledExtensionPayload = Data("""
        {
          "artifact_id": "\(smuggledArtifactID.uuidString.lowercased())",
          "filename": "payload.html",
          "media_type": "text/plain",
          "size": 12,
          "sha256": "\(sha)",
          "created_by": "run",
          "created_at": "2026-11-21T00:00:00Z"
        }
        """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(TaskArtifactItemDTO.self, from: smuggledExtensionPayload))

        register { request in
            recorder.record(request)
            return .json(statusCode: 200, body: "{}")
        }

        let store = SessionTaskStore(repository: fixture.repository)
        let directItem = TaskArtifactItemDTO(
            artifactID: smuggledArtifactID,
            filename: "smuggled.html",
            mediaType: "text/plain",
            size: 12,
            sha256: sha,
            createdBy: .run,
            createdAt: "2026-11-21T00:00:00Z"
        )
        await store.downloadArtifact(directItem)

        XCTAssertNil(store.downloadedArtifactFileByID[smuggledArtifactID])
        XCTAssertNotNil(store.artifactDownloadErrorByID[smuggledArtifactID])
        XCTAssertTrue(recorder.requests.isEmpty, "Blocked artifact must not be fetched or cached on disk")
        XCTAssertEqual(taskID, taskID)
    }

    func testUploadAttachmentMapsPreExecution401RejectionToUnauthenticated() async throws {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let fakeAPI = FakeEmberSessionAPI()
        fakeAPI.setRefreshResults([.failure(.offline)])
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: fakeAPI,
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let repository = LiveB1SessionTaskRepository(auth: auth)

        register { _ in
            .json(statusCode: 401, body: "{}")
        }

        do {
            _ = try await repository.uploadAttachment(
                filename: "sales.csv",
                mediaType: "text/csv",
                data: Data("a,b\n1,2\n".utf8)
            )
            XCTFail("Expected unauthenticated on pre-execution 401 upload rejection")
        } catch let error as SessionTaskRepositoryError {
            XCTAssertEqual(error, .unauthenticated)
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

private final class LockedBool: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Bool

    init(_ initial: Bool) {
        self.storage = initial
    }

    var value: Bool {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}
