import Foundation
import XCTest
@testable import Ember

/// Verifies Chat + Tasks integration on LiveConversationHostModel and SessionTaskStore,
/// including card rendering slots for task/outcome references, relaunch reload, cancellation, and sign-out clearing.
@MainActor
final class LiveConversationHostTasksTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []
    private var directories: [URL] = []
    private var models: [LiveConversationHostModel] = []

    override func tearDown() async throws {
        for model in models {
            model.suspendForDisappearance()
        }
        models.removeAll()
        try await Task.sleep(nanoseconds: 50_000_000)

        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        sessions.removeAll()
        registrations.removeAll()
        directories.removeAll()
        try await super.tearDown()
    }

    func testTaskAndOutcomeReferencesRenderInlineCardsAndReloadAcrossRelaunch() async throws {
        let taskID = "00000000-0000-4000-8000-00000000b311"
        let runningID = "00000000-0000-4000-8000-00000000b312"
        let approvalID = "00000000-0000-4000-8000-00000000b313"
        let agentID = "00000000-0000-4000-8000-00000000b301"

        register { request in
            let path = request.url?.path ?? ""
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[
                    {"message_id":"55555555-5555-4555-8555-555555555501",
                     "sequence":1,"created_at":"2026-11-15T10:00:00Z",
                     "kind":"user","text":"Extract action items",
                     "client_submission_id":"66666666-6666-4666-8666-666666666601"},
                    {"message_id":"55555555-5555-4555-8555-555555555502",
                     "sequence":2,"created_at":"2026-11-15T10:00:05Z",
                     "kind":"task_reference","task_id":"\(taskID)"},
                    {"message_id":"55555555-5555-4555-8555-555555555503",
                     "sequence":3,"created_at":"2026-11-15T10:01:00Z",
                     "kind":"outcome_reference",
                     "outcome":{"outcome_kind":"meaningful_change","task_id":"\(taskID)"}}
                  ],
                  "next_after":3,"has_more":false
                }
                """)
            }
            if path == "/v1/tasks" {
                return .json(statusCode: 200, body: """
                {
                  "tasks":[
                    {"task_id":"\(taskID)","agent_id":"\(agentID)","kind":"notes.action_items",
                     "title":"Q4 Launch Action Items","status":"completed","current_run_id":null,
                     "attempt_count":1,"cancel_requested":false,
                     "created_at":"2026-11-15T10:00:05Z","updated_at":"2026-11-15T10:01:00Z","deadline_at":null},
                    {"task_id":"\(runningID)","agent_id":"\(agentID)","kind":"notes.action_items",
                     "title":"Interview Summary","status":"running","current_run_id":"00000000-0000-4000-8000-00000000b351",
                     "attempt_count":1,"cancel_requested":false,
                     "created_at":"2026-11-15T10:02:00Z","updated_at":"2026-11-15T10:02:30Z","deadline_at":null},
                    {"task_id":"\(approvalID)","agent_id":"\(agentID)","kind":"sandbox.python",
                     "title":"Export CSV","status":"waiting_approval","current_run_id":"00000000-0000-4000-8000-00000000b352",
                     "attempt_count":1,"cancel_requested":false,
                     "created_at":"2026-11-15T09:50:00Z","updated_at":"2026-11-15T09:55:00Z","deadline_at":null}
                  ],
                  "next_after":null,"has_more":false
                }
                """)
            }
            if path == "/v1/tasks/\(taskID)/result" {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(taskID)",
                  "task_status":"completed",
                  "result_state":"available",
                  "result":{
                    "summary_text":"Extracted 2 action items",
                    "detail_text":"1. Ship beta\\n2. Review telemetry",
                    "model_label":"ember-notes-v1",
                    "simulated":false,
                    "produced_at":"2026-11-15T10:01:00Z"
                  }
                }
                """)
            }
            if path == "/v1/tasks/\(taskID)/events" {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(taskID)",
                  "events":[
                    {
                      "task_id":"\(taskID)",
                      "sequence":1,
                      "phase":"completed",
                      "occurred_at":"2026-11-15T10:01:00Z",
                      "trace_id":"00000000-0000-4000-8000-00000000b388",
                      "payload":{"taskKind":"notes.action_items","toStatus":"completed","simulated":false}
                    }
                  ]
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let directory = makeTempDirectory()
        let first = try makeHostModel(directory: directory)
        await first.start()

        XCTAssertEqual(first.selectedTab, .chat)
        XCTAssertEqual(first.screen.timeline.count, 3)

        // task_reference & outcome_reference MUST render as inlineContent cards, not plain activity text
        guard case .inlineContent = first.screen.timeline[1] else {
            return XCTFail("Expected task_reference to render as inline card content")
        }
        guard case .inlineContent = first.screen.timeline[2] else {
            return XCTFail("Expected outcome_reference to render as inline card content")
        }

        let notesUUID = UUID(uuidString: taskID)!
        XCTAssertEqual(first.taskStore.tasksByID[notesUUID]?.kind, .notesActionItems)
        XCTAssertEqual(first.taskStore.resultsByTaskID[notesUUID]?.resultState, .available)
        XCTAssertEqual(first.taskStore.tasks(in: .needsIntervention).count, 1)
        XCTAssertEqual(first.taskStore.tasks(in: .inProgress).count, 1)
        XCTAssertEqual(first.taskStore.tasks(in: .completed).count, 1)
        XCTAssertEqual(first.taskStore.needsInterventionCount, 1)

        // Cold relaunch stand-in: new host instance with no in-memory state must restore tasks & results from Cloud
        let relaunched = try makeHostModel(directory: directory)
        await relaunched.start()

        XCTAssertEqual(relaunched.screen.timeline.count, 3)
        XCTAssertEqual(relaunched.taskStore.tasksByID[notesUUID]?.title, "Q4 Launch Action Items")
        XCTAssertEqual(
            relaunched.taskStore.resultsByTaskID[notesUUID]?.result?.summaryText,
            "Extracted 2 action items"
        )
        await relaunched.taskStore.loadDetail(taskID: notesUUID)
        XCTAssertEqual(relaunched.taskStore.eventsByTaskID[notesUUID]?.count, 1)
    }

    func testCancelAndSignOutClearTaskStoreAndNavigationState() async throws {
        let directory = makeTempDirectory()
        let mockTasks = MockSessionTaskRepository()
        let mockRepo = MockB3ConversationRepository(taskRepository: mockTasks)
        let auth = MockAuthController()
        let model = LiveConversationHostModel(
            repository: mockRepo,
            auth: auth,
            taskRepository: mockTasks,
            isMockMode: true
        )
        models.append(model)

        await model.start()
        XCTAssertEqual(model.taskStore.tasks(in: .inProgress).count, 1)
        XCTAssertEqual(model.taskStore.tasks(in: .needsIntervention).count, 1)
        XCTAssertEqual(model.taskStore.tasks(in: .completed).count, 2)

        model.openTaskFromInbox(MockSessionTaskRepository.runningTaskID)
        XCTAssertEqual(model.selectedTab, .tasks)
        XCTAssertEqual(model.tasksNavigationPath, [MockSessionTaskRepository.runningTaskID])

        await model.taskStore.cancelTask(taskID: MockSessionTaskRepository.runningTaskID)
        XCTAssertEqual(
            model.taskStore.tasksByID[MockSessionTaskRepository.runningTaskID]?.status,
            .cancelled
        )
        XCTAssertEqual(model.taskStore.tasks(in: .inProgress).count, 0)
        XCTAssertEqual(model.taskStore.tasks(in: .completed).count, 3)

        await model.signOut()
        XCTAssertTrue(model.requiresSignIn)
        XCTAssertEqual(model.selectedTab, .chat)
        XCTAssertTrue(model.chatNavigationPath.isEmpty)
        XCTAssertTrue(model.tasksNavigationPath.isEmpty)
        XCTAssertTrue(model.taskStore.orderedTasks.isEmpty)
    }

    private func makeHostModel(directory: URL) throws -> LiveConversationHostModel {
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
        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: LiveConversationJournal(directory: directory)
        )
        let taskRepo = LiveB1SessionTaskRepository(auth: auth)
        let model = LiveConversationHostModel(
            repository: repo,
            auth: auth,
            taskRepository: taskRepo
        )
        models.append(model)
        return model
    }

    private func makeTempDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("b3-host-tasks-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        directories.append(dir)
        return dir
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}
